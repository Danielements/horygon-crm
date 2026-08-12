const db = require('../db/database');

// Motore IVA unico del ciclo commerciale.
//
// Qui dentro sta l'unica copia delle formule: preventivi, ordini, fatture, PDF
// e XML chiamano queste funzioni invece di rifare il conto ognuno a modo suo.
// Prima di questo file la stessa moltiplicazione esisteva in quattro posti
// leggermente diversi, e il frontend ne aveva una quinta.

const TIPO_TRATTAMENTO = 'VAT_TREATMENT';
const TIPO_ESIGIBILITA = 'VAT_DUE';
const ESIGIBILITA_AMMESSE = ['I', 'D', 'S'];

// --- denaro ---------------------------------------------------------------
//
// I centesimi si contano in interi. `0.1 + 0.2` in virgola mobile non fa 0.3,
// e su un documento con molte righe l'errore si accumula fino a farsi vedere
// nel totale. Il progetto non ha una libreria decimale: si arrotonda a
// centesimi a ogni passo, che e' anche il modo in cui la FatturaPA esprime gli
// importi.

function toCents(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100);
}

function fromCents(cents) {
  return Math.round(cents) / 100;
}

function round2(value) {
  return fromCents(toCents(value));
}

// --- lettura delle regole -------------------------------------------------

function mapRegola(row) {
  if (!row) return null;
  return {
    ...row,
    attiva: Number(row.attiva) === 1,
    revisione_manuale: Number(row.revisione_manuale) === 1,
    // Etichetta pronta per l'operatore: mai il solo id, mai il solo numero.
    etichetta: buildEtichettaRegola(row)
  };
}

function buildEtichettaRegola(row) {
  if (!row) return '';
  const descrizione = row.descrizione || row.etichetta_fattura || '';
  return `${row.codice} — ${descrizione}`.trim();
}

function listRegoleIva(filters = {}) {
  const where = [];
  const params = [];
  if (filters.tipo_regola) { where.push('tipo_regola = ?'); params.push(String(filters.tipo_regola)); }
  if (filters.attiva !== undefined && filters.attiva !== null && filters.attiva !== '') {
    where.push('attiva = ?');
    params.push(filters.attiva === true || filters.attiva === 'true' || Number(filters.attiva) === 1 ? 1 : 0);
  }
  if (filters.natura_iva) { where.push('natura_iva = ?'); params.push(String(filters.natura_iva).toUpperCase()); }
  if (filters.aliquota_iva !== undefined && filters.aliquota_iva !== null && filters.aliquota_iva !== '') {
    where.push('aliquota_iva = ?');
    params.push(Number(filters.aliquota_iva));
  }
  if (filters.esigibilita_iva) { where.push('esigibilita_iva = ?'); params.push(String(filters.esigibilita_iva).toUpperCase()); }
  if (filters.q) {
    where.push('(codice LIKE ? OR descrizione LIKE ? OR etichetta_fattura LIKE ? OR riferimento_normativo LIKE ?)');
    const like = `%${String(filters.q).trim()}%`;
    params.push(like, like, like, like);
  }
  // Validita' temporale: una regola scaduta non va proposta su un documento
  // di oggi, ma resta interrogabile per i documenti di allora.
  if (filters.valida_al) {
    where.push("(valido_dal IS NULL OR valido_dal = '' OR valido_dal <= ?)");
    params.push(String(filters.valida_al));
    where.push("(valido_al IS NULL OR valido_al = '' OR valido_al >= ?)");
    params.push(String(filters.valida_al));
  }
  const sql = `
    SELECT * FROM regole_iva
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY tipo_regola ASC, priorita DESC, codice ASC
  `;
  return db.prepare(sql).all(...params).map(mapRegola);
}

function getRegolaIvaById(id) {
  if (!id) return null;
  return mapRegola(db.prepare('SELECT * FROM regole_iva WHERE id = ?').get(Number(id)));
}

function getRegolaIvaByCodice(codice) {
  const text = String(codice || '').trim();
  if (!text) return null;
  return mapRegola(db.prepare('SELECT * FROM regole_iva WHERE codice = ?').get(text));
}

// Regole proponibili per un documento nuovo: attive e valide alla sua data.
// Quelle disattivate restano leggibili altrove, perche' i documenti storici le
// citano e nasconderle renderebbe illeggibile il loro passato.
function listRegoleSelezionabili(dataDocumento = null) {
  return listRegoleIva({
    attiva: 1,
    tipo_regola: TIPO_TRATTAMENTO,
    valida_al: dataDocumento || new Date().toISOString().slice(0, 10)
  });
}

// --- validazione ----------------------------------------------------------
//
// Le due regole che contano, e che valgono sia per una regola IVA sia per lo
// snapshot di una riga: un'aliquota positiva esclude la Natura, e una Natura
// impone aliquota zero. Sono i controlli SdI 00400/00401 e 00429/00430, qui
// applicati prima che il documento nasca invece che al momento dell'invio.

function validateTrattamento({ aliquota_iva, natura_iva }) {
  const errors = [];
  const rate = aliquota_iva === null || aliquota_iva === undefined || aliquota_iva === ''
    ? null
    : Number(aliquota_iva);
  const natura = String(natura_iva || '').trim().toUpperCase() || null;

  if (rate !== null && !Number.isFinite(rate)) errors.push('Aliquota IVA non numerica');
  if (rate !== null && Number.isFinite(rate) && rate < 0) errors.push('Aliquota IVA negativa');
  if (natura && !/^N[1-7](\.\d)?$/.test(natura)) errors.push(`Natura IVA "${natura}" non riconosciuta`);
  if (rate !== null && rate > 0 && natura) {
    errors.push(`Con aliquota ${rate}% la Natura IVA deve essere assente: ${natura} vale solo a IVA zero`);
  }
  if (natura && rate !== null && rate !== 0) {
    errors.push(`La Natura ${natura} richiede aliquota 0, non ${rate}`);
  }
  return errors;
}

function validateRegolaIva(payload = {}, { isUpdate = false } = {}) {
  const errors = [];
  const codice = String(payload.codice || '').trim();
  const tipo = String(payload.tipo_regola || TIPO_TRATTAMENTO).trim();

  if (!isUpdate && !codice) errors.push('Il codice della regola e obbligatorio');
  if (![TIPO_TRATTAMENTO, TIPO_ESIGIBILITA].includes(tipo)) {
    errors.push(`Tipo regola non ammesso: ${tipo}`);
  }
  const esigibilita = String(payload.esigibilita_iva || '').trim().toUpperCase();
  if (esigibilita && !ESIGIBILITA_AMMESSE.includes(esigibilita)) {
    errors.push(`Esigibilita IVA non ammessa: ${esigibilita} (attese I, D, S)`);
  }
  if (tipo === TIPO_ESIGIBILITA) {
    if (!esigibilita) errors.push('Una regola di esigibilita deve indicare I, D o S');
    if (payload.natura_iva) errors.push('Una regola di esigibilita non porta Natura IVA');
  } else {
    errors.push(...validateTrattamento(payload));
  }
  if (payload.valido_dal && payload.valido_al && String(payload.valido_dal) > String(payload.valido_al)) {
    errors.push('Il periodo di validita finisce prima di cominciare');
  }
  return errors;
}

// --- snapshot sulla riga --------------------------------------------------
//
// **Il cuore del meccanismo.** Una riga di documento non tiene un riferimento
// vivo alla regola: ne tiene una copia. Se domani l'articolo passa dal 22% al
// 10%, l'ordine di ieri resta al 22% perche' il 22 e' scritto sulla sua riga,
// non dedotto ogni volta dall'articolo.
//
// `regola_iva_id` sopravvive solo come tracciatura della provenienza: dice da
// dove veniva il dato, non come ricalcolarlo.
function buildSnapshotIva(input = {}) {
  const esplicitaNatura = input.natura_iva !== undefined && input.natura_iva !== null && input.natura_iva !== '';
  const esplicitaAliquota = input.aliquota_iva !== undefined && input.aliquota_iva !== null && input.aliquota_iva !== '';

  // Una regola indicata per id o per codice vince: e' la scelta dell'operatore
  // nella tendina. I valori sciolti servono per le righe che arrivano da
  // import, da API esterne o da documenti vecchi.
  const regola = input.regola_iva_id
    ? getRegolaIvaById(input.regola_iva_id)
    : (input.codice_iva ? getRegolaIvaByCodice(input.codice_iva) : null);

  if (regola && regola.tipo_regola === TIPO_TRATTAMENTO) {
    return {
      regola_iva_id: regola.id,
      codice_iva: regola.codice,
      aliquota_iva: Number(regola.aliquota_iva || 0),
      natura_iva: regola.natura_iva || null,
      riferimento_normativo: input.riferimento_normativo || regola.riferimento_normativo || null
    };
  }

  const natura = esplicitaNatura ? String(input.natura_iva).trim().toUpperCase() : null;
  const aliquota = natura ? 0 : (esplicitaAliquota ? Number(input.aliquota_iva) : null);
  return {
    regola_iva_id: null,
    codice_iva: input.codice_iva || null,
    aliquota_iva: aliquota,
    natura_iva: natura,
    riferimento_normativo: input.riferimento_normativo || null
  };
}

// Trattamento predefinito di un articolo. E' un default per la riga nuova, non
// una fonte a cui tornare dopo: chi lo chiama ne fa subito uno snapshot.
function snapshotIvaPerProdotto(prodottoId) {
  if (!prodottoId) return null;
  const row = db.prepare('SELECT regola_iva_id FROM prodotti WHERE id = ?').get(Number(prodottoId));
  if (!row?.regola_iva_id) return null;
  return buildSnapshotIva({ regola_iva_id: row.regola_iva_id });
}

// --- calcolo ---------------------------------------------------------------

function calcolaRiga(riga = {}) {
  const snapshot = buildSnapshotIva(riga);
  const quantita = Number(riga.quantita || 0) || 0;
  const prezzo = Number(riga.prezzo_unitario || 0) || 0;
  const sconto = Number(riga.sconto || 0) || 0;
  const maggiorazione = Number(riga.maggiorazione || 0) || 0;

  const lordoCents = Math.round(quantita * prezzo * 100);
  const nettoCents = Math.max(0, lordoCents - toCents(sconto) + toCents(maggiorazione));
  // Una riga con Natura non produce imposta: l'operazione e' esente, non
  // imponibile o non soggetta, e "aliquota 0%" non e' un modo per dirlo.
  const aliquota = snapshot.natura_iva ? 0 : Number(snapshot.aliquota_iva || 0) || 0;
  const ivaCents = snapshot.natura_iva ? 0 : Math.round(nettoCents * aliquota / 100);

  const imponibile = fromCents(nettoCents);
  const importoIva = fromCents(ivaCents);
  return {
    ...snapshot,
    quantita,
    prezzo_unitario: prezzo,
    sconto,
    imponibile,
    importo_iva: importoIva,
    totale_riga: round2(imponibile + importoIva)
  };
}

// Chiave di raggruppamento del riepilogo.
//
// Non e' la sola percentuale: 0% N4, 0% N3.1 e 0% N2.1 sono tre trattamenti
// fiscali diversi e vanno in tre righe diverse del riepilogo. L'esigibilita'
// entra nella chiave perche' la stessa aliquota in scissione dei pagamenti e
// in esigibilita' immediata non si somma.
function chiaveRiepilogo(row) {
  return [
    Number(row.aliquota_iva || 0).toFixed(2),
    row.natura_iva || '',
    row.esigibilita_iva || ''
  ].join('|');
}

function calcolaTotaliDocumento(righe = [], options = {}) {
  const esigibilitaDocumento = options.esigibilita_iva
    ? String(options.esigibilita_iva).trim().toUpperCase()
    : null;

  const calcolate = (righe || []).map((riga) => calcolaRiga(riga));
  const gruppi = new Map();

  for (const riga of calcolate) {
    // L'esigibilita' e' una proprieta' del documento, non della riga: dipende
    // dal cliente (PA in scissione) e dalla scelta di chi emette. Entra qui
    // solo per tenere separati i gruppi.
    const esigibilita = riga.natura_iva ? null : esigibilitaDocumento;
    const chiave = chiaveRiepilogo({ ...riga, esigibilita_iva: esigibilita });
    if (!gruppi.has(chiave)) {
      gruppi.set(chiave, {
        codice_iva: riga.codice_iva || null,
        aliquota_iva: Number(riga.aliquota_iva || 0) || 0,
        natura_iva: riga.natura_iva || null,
        esigibilita_iva: esigibilita,
        riferimento_normativo: riga.riferimento_normativo || null,
        imponibile: 0,
        imposta: 0
      });
    }
    const gruppo = gruppi.get(chiave);
    gruppo.imponibile = round2(gruppo.imponibile + riga.imponibile);
    // Se righe diverse dello stesso gruppo citano riferimenti normativi
    // diversi si tiene il primo: il tracciato ne ammette uno solo per
    // riepilogo, e inventarne uno unito sarebbe peggio.
    if (!gruppo.riferimento_normativo && riga.riferimento_normativo) {
      gruppo.riferimento_normativo = riga.riferimento_normativo;
    }
  }

  // **L'imposta del riepilogo si calcola sull'imponibile del gruppo, non
  // sommando le imposte di riga.** Sono due numeri diversi: 300 righe da 0,10
  // al 22% danno 0,02 ciascuna per arrotondamento, cioe' 6,00, mentre il
  // gruppo vale 30,00 x 22% = 6,60. Il controllo SdI 00421 confronta proprio
  // Imposta con ImponibileImporto x AliquotaIVA, con tolleranza di un
  // centesimo: la somma delle righe farebbe scartare la fattura.
  const riepilogo = [...gruppi.values()].map((gruppo) => ({
    ...gruppo,
    imposta: gruppo.natura_iva ? 0 : round2(gruppo.imponibile * gruppo.aliquota_iva / 100)
  }));
  const imponibile = round2(riepilogo.reduce((sum, row) => sum + row.imponibile, 0));
  const iva = round2(riepilogo.reduce((sum, row) => sum + row.imposta, 0));

  return {
    righe: calcolate,
    imponibile,
    iva,
    totale: round2(imponibile + iva),
    riepilogo
  };
}

module.exports = {
  ESIGIBILITA_AMMESSE,
  TIPO_ESIGIBILITA,
  TIPO_TRATTAMENTO,
  buildEtichettaRegola,
  buildSnapshotIva,
  calcolaRiga,
  calcolaTotaliDocumento,
  chiaveRiepilogo,
  getRegolaIvaByCodice,
  getRegolaIvaById,
  listRegoleIva,
  listRegoleSelezionabili,
  round2,
  snapshotIvaPerProdotto,
  validateRegolaIva,
  validateTrattamento
};
