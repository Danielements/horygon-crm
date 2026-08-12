process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-iva';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../src/db/database');
const {
  buildSnapshotIva,
  calcolaRiga,
  calcolaTotaliDocumento,
  getRegolaIvaByCodice,
  listRegoleSelezionabili,
  validateRegolaIva
} = require('../src/services/iva');
const { backfillSnapshotIva } = require('../src/db/backfill-iva');
const { nextNumeroFattura } = require('../src/services/fattura-numerazione');
const { createFatturaPdfBuffer, renderFatturaPdf } = require('../src/services/document-pdf');

// --- ambiente ---------------------------------------------------------------
//
// I test scrivono sul database vero, come gli altri di questo progetto, e si
// riconoscono da un prefisso. La pulizia sta in testa: se una corsa precedente
// e' morta a meta', la successiva riparte pulita lo stesso.

const MARKER = 'TESTIVA';

// Si cancella in ordine di dipendenza: gli articoli di prova sono referenziati
// da righe e movimenti, e con le foreign key attive vanno tolti per ultimi.
function cleanup() {
  const prodotti = db.prepare(`SELECT id FROM prodotti WHERE codice_interno LIKE '${MARKER}%'`).all().map((row) => row.id);
  const inProdotti = prodotti.length ? `(${prodotti.join(',')})` : '(0)';

  db.prepare(`DELETE FROM fatture_righe WHERE fattura_id IN (SELECT id FROM fatture WHERE numero LIKE '%${MARKER}%') OR prodotto_id IN ${inProdotti}`).run();
  db.prepare(`DELETE FROM fatture_iva_riepilogo WHERE fattura_id IN (SELECT id FROM fatture WHERE numero LIKE '%${MARKER}%')`).run();
  db.prepare(`DELETE FROM fatture WHERE numero LIKE '%${MARKER}%'`).run();
  db.prepare(`DELETE FROM ordini_righe WHERE ordine_id IN (SELECT id FROM ordini WHERE codice_ordine LIKE '%${MARKER}%') OR prodotto_id IN ${inProdotti}`).run();
  db.prepare(`DELETE FROM ordini WHERE codice_ordine LIKE '%${MARKER}%'`).run();
  db.prepare(`DELETE FROM preventivi_righe WHERE preventivo_id IN (SELECT id FROM preventivi WHERE codice_preventivo LIKE '%${MARKER}%') OR prodotto_id IN ${inProdotti}`).run();
  db.prepare(`DELETE FROM preventivi WHERE codice_preventivo LIKE '%${MARKER}%'`).run();
  db.prepare(`DELETE FROM magazzino_movimenti WHERE prodotto_id IN ${inProdotti}`).run();
  db.prepare(`DELETE FROM ddt_righe WHERE prodotto_id IN ${inProdotti}`).run();
  db.prepare(`DELETE FROM prodotti WHERE id IN ${inProdotti}`).run();
}
cleanup();

const IVA22 = getRegolaIvaByCodice('IVA22');
const IVA10 = getRegolaIvaByCodice('IVA10');
const N4 = getRegolaIvaByCodice('N4');
const N31 = getRegolaIvaByCodice('N3.1');

// L'app di prova monta le rotte vere: le conversioni vanno provate come le usa
// il CRM, non reimplementandole nel test.
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/preventivi', require('../src/routes/preventivi'));
  app.use('/api/ordini', require('../src/routes/ordini'));
  return app;
}

let server;
let baseUrl;
const token = jwt.sign({ id: 1, ruolo_id: 4, email: 'test@horygon.it' }, process.env.SESSION_SECRET);

test.before(async () => {
  server = makeApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  cleanup();
  server?.close();
});

async function call(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return payload;
}

function creaProdotto(suffix, regolaIvaId) {
  const result = db.prepare(`
    INSERT INTO prodotti (codice_interno, nome, unita_misura, attivo, regola_iva_id)
    VALUES (?,?,?,1,?)
  `).run(`${MARKER}-${suffix}`, `Articolo di prova ${suffix}`, 'pz', regolaIvaId);
  const id = Number(result.lastInsertRowid);
  // Le righe ordine controllano la giacenza prima di scaricare il magazzino.
  db.prepare(`
    INSERT INTO magazzino_movimenti (prodotto_id, tipo, quantita, riferimento_tipo, note)
    VALUES (?,'carico',?, 'test', ?)
  `).run(id, 1000, `${MARKER} giacenza di prova`);
  return id;
}

// --- il seed ---------------------------------------------------------------

test('il seed porta tutti i codici richiesti, trattamenti ed esigibilita', () => {
  const attesi = [
    'IVA22', 'IVA10', 'IVA5', 'IVA4',
    'N1', 'N2.1', 'N2.2', 'N3.1', 'N3.2', 'N3.3', 'N3.4', 'N3.5', 'N3.6',
    'N4', 'N5', 'N6.1', 'N6.2', 'N6.3', 'N6.4', 'N6.5', 'N6.6', 'N6.7', 'N6.8', 'N6.9', 'N7',
    'ESIG_I', 'ESIG_D', 'ESIG_S'
  ];
  const presenti = db.prepare('SELECT codice FROM regole_iva').all().map((row) => row.codice);
  const mancanti = attesi.filter((codice) => !presenti.includes(codice));
  assert.deepEqual(mancanti, [], `codici mancanti dal seed: ${mancanti.join(', ')}`);
});

test('le regole di sola esigibilita non finiscono fra i trattamenti proponibili', () => {
  const selezionabili = listRegoleSelezionabili('2026-08-12').map((rule) => rule.codice);
  assert.equal(selezionabili.includes('IVA22'), true);
  assert.equal(selezionabili.includes('ESIG_S'), false);
});

// --- casi di calcolo richiesti ---------------------------------------------

test('caso A: una riga da 100 al 22% fa 100 + 22 = 122', () => {
  const totali = calcolaTotaliDocumento([
    { quantita: 1, prezzo_unitario: 100, regola_iva_id: IVA22.id }
  ]);
  assert.equal(totali.imponibile, 100);
  assert.equal(totali.iva, 22);
  assert.equal(totali.totale, 122);
  assert.equal(totali.riepilogo.length, 1);
});

test('caso B: 100 al 22% e 100 al 10% fanno 200 + 32 = 232 in due riepiloghi', () => {
  const totali = calcolaTotaliDocumento([
    { quantita: 1, prezzo_unitario: 100, regola_iva_id: IVA22.id },
    { quantita: 1, prezzo_unitario: 100, regola_iva_id: IVA10.id }
  ]);
  assert.equal(totali.imponibile, 200);
  assert.equal(totali.iva, 32);
  assert.equal(totali.totale, 232);
  assert.deepEqual(
    totali.riepilogo.map((row) => [row.codice_iva, row.imponibile, row.imposta]),
    [['IVA22', 100, 22], ['IVA10', 100, 10]]
  );
});

test('caso C: 100 al 22% e 200 in N4 fanno 300 di importi e 22 di imposta', () => {
  const totali = calcolaTotaliDocumento([
    { quantita: 1, prezzo_unitario: 100, regola_iva_id: IVA22.id },
    { quantita: 1, prezzo_unitario: 200, regola_iva_id: N4.id }
  ]);
  assert.equal(totali.imponibile, 300);
  assert.equal(totali.iva, 22);
  assert.equal(totali.totale, 322);
  assert.equal(totali.riepilogo.length, 2);
  const esente = totali.riepilogo.find((row) => row.natura_iva === 'N4');
  assert.equal(esente.imponibile, 200);
  assert.equal(esente.imposta, 0);
  // Una riga esente non porta esigibilita': non c'e' imposta da esigere.
  assert.equal(esente.esigibilita_iva, null);
});

test('caso G: N3.1, N4 e IVA22 restano tre gruppi distinti', () => {
  const totali = calcolaTotaliDocumento([
    { quantita: 1, prezzo_unitario: 100, regola_iva_id: N31.id },
    { quantita: 1, prezzo_unitario: 100, regola_iva_id: N4.id },
    { quantita: 1, prezzo_unitario: 100, regola_iva_id: IVA22.id }
  ]);
  assert.equal(totali.riepilogo.length, 3);
  assert.deepEqual(
    totali.riepilogo.map((row) => row.natura_iva || `${row.aliquota_iva}%`).sort(),
    ['22%', 'N3.1', 'N4']
  );
});

test('due nature diverse a zero non si sommano nello stesso riepilogo', () => {
  const totali = calcolaTotaliDocumento([
    { quantita: 1, prezzo_unitario: 50, natura_iva: 'N4', aliquota_iva: 0 },
    { quantita: 1, prezzo_unitario: 50, natura_iva: 'N3.1', aliquota_iva: 0 }
  ]);
  assert.equal(totali.riepilogo.length, 2);
});

test('la stessa aliquota in scissione dei pagamenti resta separata da quella immediata', () => {
  const conScissione = calcolaTotaliDocumento(
    [{ quantita: 1, prezzo_unitario: 100, regola_iva_id: IVA22.id }],
    { esigibilita_iva: 'S' }
  );
  assert.equal(conScissione.riepilogo[0].esigibilita_iva, 'S');
  assert.equal(conScissione.iva, 22);
});

test('sconto e maggiorazione entrano nell imponibile, e l imposta si arrotonda al centesimo', () => {
  const riga = calcolaRiga({
    quantita: 3, prezzo_unitario: 33.33, sconto: 10, maggiorazione: 2, regola_iva_id: IVA22.id
  });
  assert.equal(riga.imponibile, 91.99);
  assert.equal(riga.importo_iva, 20.24);
  assert.equal(riga.totale_riga, 112.23);
});

// Controllo SdI 00421: Imposta deve valere ImponibileImporto x AliquotaIVA con
// un centesimo di tolleranza. Sommare le imposte di riga gia' arrotondate non
// lo soddisfa: 300 righe da 0,10 al 22% danno 0,02 ciascuna, cioe' 6,00, mentre
// il riepilogo vale 30,00 x 22% = 6,60. Sessanta centesimi di scarto, sessanta
// volte la tolleranza.
test('l imposta del riepilogo si calcola sull imponibile del gruppo, non sommando le righe', () => {
  const righe = Array.from({ length: 300 }, () => ({
    quantita: 1, prezzo_unitario: 0.1, regola_iva_id: IVA22.id
  }));
  const totali = calcolaTotaliDocumento(righe);
  assert.equal(totali.imponibile, 30);
  assert.equal(totali.iva, 6.6);
  assert.equal(totali.totale, 36.6);
  // La riga presa da sola resta arrotondata al centesimo, com'e' giusto.
  assert.equal(totali.righe[0].importo_iva, 0.02);
  const gruppo = totali.riepilogo[0];
  assert.equal(gruppo.imposta, Math.round(gruppo.imponibile * gruppo.aliquota_iva) / 100);
});

// --- validazioni -----------------------------------------------------------

test('aliquota positiva e Natura non possono convivere', () => {
  const errors = validateRegolaIva({ codice: 'X', aliquota_iva: 22, natura_iva: 'N4' });
  assert.equal(errors.length > 0, true);
  assert.match(errors.join(' '), /Natura IVA deve essere assente/);
});

test('una Natura impone aliquota zero', () => {
  assert.equal(validateRegolaIva({ codice: 'X', aliquota_iva: 0, natura_iva: 'N4' }).length, 0);
  assert.match(validateRegolaIva({ codice: 'X', aliquota_iva: 10, natura_iva: 'N4' }).join(' '), /Natura/);
});

test('una regola di esigibilita ammette solo I, D o S', () => {
  assert.equal(validateRegolaIva({ codice: 'E', tipo_regola: 'VAT_DUE', esigibilita_iva: 'S' }).length, 0);
  assert.match(validateRegolaIva({ codice: 'E', tipo_regola: 'VAT_DUE', esigibilita_iva: 'X' }).join(' '), /Esigibilita/);
});

test('una riga con Natura non produce imposta anche se le si passa un aliquota', () => {
  const riga = calcolaRiga({ quantita: 1, prezzo_unitario: 100, natura_iva: 'N4', aliquota_iva: 22 });
  assert.equal(riga.aliquota_iva, 0);
  assert.equal(riga.importo_iva, 0);
});

test('lo snapshot da regola porta con se codice e riferimento normativo', () => {
  const snapshot = buildSnapshotIva({ regola_iva_id: IVA10.id });
  assert.equal(snapshot.codice_iva, 'IVA10');
  assert.equal(snapshot.aliquota_iva, 10);
  assert.equal(snapshot.natura_iva, null);
  assert.match(snapshot.riferimento_normativo || '', /633/);
});

// --- la catena dello snapshot, sulle rotte vere -----------------------------

test('caso D: cambiare l IVA dell articolo non tocca un ordine gia creato', async () => {
  const prodottoId = creaProdotto('D', IVA22.id);
  const ordine = await call('POST', '/api/ordini', {
    codice_ordine: `${MARKER}-ORD-D`,
    tipo: 'vendita',
    data_ordine: '2026-08-12',
    righe: [{ prodotto_id: prodottoId, quantita: 1, prezzo_unitario: 100 }]
  });

  // L'articolo passa al 10% dopo la creazione dell'ordine.
  db.prepare('UPDATE prodotti SET regola_iva_id = ? WHERE id = ?').run(IVA10.id, prodottoId);

  const riga = db.prepare('SELECT * FROM ordini_righe WHERE ordine_id = ?').get(ordine.id);
  assert.equal(riga.aliquota_iva, 22, 'la riga ordine deve restare al 22%');
  assert.equal(riga.codice_iva, 'IVA22');
  assert.equal(riga.importo_iva, 22);
});

test('caso E: il preventivo detta l IVA dell ordine, e l articolo modificato dopo non la cambia', async () => {
  const prodottoId = creaProdotto('E', IVA22.id);
  const preventivo = await call('POST', '/api/preventivi', {
    codice_preventivo: `${MARKER}-PRE-E`,
    data_preventivo: '2026-08-12',
    righe: [{ prodotto_id: prodottoId, descrizione: 'Riga E', quantita: 1, prezzo_unitario: 100 }]
  });
  const rigaPreventivo = db.prepare('SELECT * FROM preventivi_righe WHERE preventivo_id = ?').get(preventivo.id);
  assert.equal(rigaPreventivo.aliquota_iva, 22, 'il preventivo prende il default dell articolo');
  assert.equal(rigaPreventivo.codice_iva, 'IVA22');

  const ordine = await call('POST', `/api/preventivi/${preventivo.id}/convert-to-order`, {});
  // Solo ora l'articolo cambia aliquota.
  db.prepare('UPDATE prodotti SET regola_iva_id = ? WHERE id = ?').run(IVA10.id, prodottoId);

  const rigaOrdine = db.prepare('SELECT * FROM ordini_righe WHERE ordine_id = ?').get(ordine.ordine_id);
  assert.equal(rigaOrdine.aliquota_iva, 22, 'l ordine conserva la condizione approvata nel preventivo');
  assert.equal(rigaOrdine.codice_iva, 'IVA22');
  assert.equal(rigaOrdine.descrizione, 'Riga E', 'la conversione non deve perdere la descrizione');
});

test('caso F: l IVA corretta a mano sulla riga ordine e quella che finisce in fattura', async () => {
  const prodottoId = creaProdotto('F', IVA22.id);
  const ordine = await call('POST', '/api/ordini', {
    codice_ordine: `${MARKER}-ORD-F`,
    tipo: 'vendita',
    data_ordine: '2026-08-12',
    righe: [{ prodotto_id: prodottoId, quantita: 1, prezzo_unitario: 100 }]
  });

  // L'operatore corregge il trattamento della sola riga ordine, prima di
  // fatturare: l'articolo resta al 22%.
  await call('PUT', `/api/ordini/${ordine.id}`, {
    codice_ordine: `${MARKER}-ORD-F`,
    tipo: 'vendita',
    data_ordine: '2026-08-12',
    righe: [{ prodotto_id: prodottoId, quantita: 1, prezzo_unitario: 100, regola_iva_id: IVA10.id }]
  });
  assert.equal(
    db.prepare('SELECT regola_iva_id FROM prodotti WHERE id = ?').get(prodottoId).regola_iva_id,
    IVA22.id,
    'modificare la riga non deve toccare l anagrafica articolo'
  );

  await call('PATCH', `/api/ordini/${ordine.id}/stato`, { stato: 'confermato' });
  const fattura = await call('POST', `/api/ordini/${ordine.id}/convert-to-fattura`, {});

  const rigaFattura = db.prepare('SELECT * FROM fatture_righe WHERE fattura_id = ?').get(fattura.fattura_id);
  assert.equal(rigaFattura.aliquota_iva, 10, 'la fattura eredita l IVA della riga ordine');
  assert.equal(rigaFattura.codice_iva, 'IVA10');
  assert.equal(rigaFattura.importo_iva, 10);

  const testata = db.prepare('SELECT imponibile, iva, totale FROM fatture WHERE id = ?').get(fattura.fattura_id);
  assert.deepEqual(
    [testata.imponibile, testata.iva, testata.totale],
    [100, 10, 110]
  );
});

// --- numerazione fiscale ---------------------------------------------------

test('il numero fattura continua la serie dell anno, non copia il codice ordine', () => {
  const anno = '2091'; // anno senza fatture, per non dipendere dallo storico
  const primo = nextNumeroFattura({ data: `${anno}-03-01` });
  assert.equal(primo.numero, '1');

  db.prepare(`
    INSERT INTO fatture (numero, numero_documento, tipo, direzione, data, imponibile, iva, totale)
    VALUES (?,?,'emessa','attiva',?,0,0,0)
  `).run(`7`, `7`, `${anno}-05-01`);
  try {
    const dopo = nextNumeroFattura({ data: `${anno}-06-01` });
    assert.equal(dopo.numero, '8', 'riparte dal massimo della serie, non dal conteggio');
    // Un numero occupato non produce un duplicato.
    db.prepare(`
      INSERT INTO fatture (numero, numero_documento, tipo, direzione, data, imponibile, iva, totale)
      VALUES (?,?,'emessa','attiva',?,0,0,0)
    `).run('8', '8', `${anno}-07-01`);
    assert.equal(nextNumeroFattura({ data: `${anno}-08-01` }).numero, '9');
  } finally {
    db.prepare("DELETE FROM fatture WHERE data LIKE ?").run(`${anno}-%`);
  }
});

test('la fattura generata da un ordine prende un numero della serie', async () => {
  const prodottoId = creaProdotto('NUM', IVA22.id);
  const ordine = await call('POST', '/api/ordini', {
    codice_ordine: `${MARKER}-ORD-NUMERAZIONE-LUNGHISSIMO-2026`,
    tipo: 'vendita',
    data_ordine: '2026-08-12',
    righe: [{ prodotto_id: prodottoId, quantita: 1, prezzo_unitario: 100 }]
  });
  await call('PATCH', `/api/ordini/${ordine.id}/stato`, { stato: 'confermato' });
  const fattura = await call('POST', `/api/ordini/${ordine.id}/convert-to-fattura`, {});
  // Prima usciva "FAT-2026-RD-PREV-...", cioe' il codice dell'ordine troncato.
  assert.match(String(fattura.numero), /^\d+$/, `numero non progressivo: ${fattura.numero}`);
  assert.equal(String(fattura.numero).includes('ORD'), false);
  db.prepare('DELETE FROM fatture_righe WHERE fattura_id = ?').run(fattura.fattura_id);
  db.prepare('DELETE FROM fatture_iva_riepilogo WHERE fattura_id = ?').run(fattura.fattura_id);
  db.prepare('DELETE FROM fatture WHERE id = ?').run(fattura.fattura_id);
});

// --- migrazione dello storico ----------------------------------------------

test('la migrazione deduce l aliquota dalla testata, lascia vuoto quando non e deducibile e non tocca i totali', () => {
  const prodottoId = creaProdotto('MIGR', null);

  // Ordine storico "sano": testata a IVA unica, righe senza dati fiscali.
  const sano = db.prepare(`
    INSERT INTO ordini (codice_ordine, tipo, data_ordine, imponibile, iva, totale)
    VALUES (?,'vendita','2026-01-10',?,?,?)
  `).run(`${MARKER}-MIGR-OK`, 100, 22, 122);
  const sanoId = Number(sano.lastInsertRowid);
  db.prepare('INSERT INTO ordini_righe (ordine_id, prodotto_id, quantita, prezzo_unitario, sconto) VALUES (?,?,?,?,0)')
    .run(sanoId, prodottoId, 1, 100);

  // Ordine storico a IVA mista: dal rapporto testata esce un 16% che non e'
  // l'aliquota di nessuna riga, quindi non si deve dedurre niente.
  const misto = db.prepare(`
    INSERT INTO ordini (codice_ordine, tipo, data_ordine, imponibile, iva, totale)
    VALUES (?,'vendita','2026-01-11',?,?,?)
  `).run(`${MARKER}-MIGR-MIX`, 200, 32, 232);
  const mistoId = Number(misto.lastInsertRowid);
  db.prepare('INSERT INTO ordini_righe (ordine_id, prodotto_id, quantita, prezzo_unitario, sconto) VALUES (?,?,?,?,0)')
    .run(mistoId, prodottoId, 1, 200);

  const primaSano = db.prepare('SELECT imponibile, iva, totale FROM ordini WHERE id = ?').get(sanoId);
  const primaMisto = db.prepare('SELECT imponibile, iva, totale FROM ordini WHERE id = ?').get(mistoId);

  const esito = backfillSnapshotIva(db);

  const rigaSana = db.prepare('SELECT * FROM ordini_righe WHERE ordine_id = ?').get(sanoId);
  assert.equal(rigaSana.aliquota_iva, 22, 'aliquota dedotta dalla testata a IVA unica');
  assert.equal(rigaSana.codice_iva, 'IVA22');
  assert.equal(rigaSana.imponibile, 100);
  assert.equal(rigaSana.importo_iva, 22);

  const rigaMista = db.prepare('SELECT * FROM ordini_righe WHERE ordine_id = ?').get(mistoId);
  assert.equal(rigaMista.aliquota_iva, null, 'meglio vuoto che un 16% inventato');
  assert.equal(rigaMista.imponibile, 200, 'l imponibile di riga si ricostruisce comunque');

  // Il requisito che conta: i totali storici non si muovono.
  assert.deepEqual(db.prepare('SELECT imponibile, iva, totale FROM ordini WHERE id = ?').get(sanoId), primaSano);
  assert.deepEqual(db.prepare('SELECT imponibile, iva, totale FROM ordini WHERE id = ?').get(mistoId), primaMisto);

  // E lo scarto viene segnalato invece che nascosto.
  const segnalato = (esito.ordini.mismatched || []).some((row) => row.ordine_id === mistoId);
  assert.equal(segnalato, true, 'l ordine che non quadra deve comparire fra gli scarti');
  assert.equal(esito.ordini.unresolved >= 1, true);
});

test('la migrazione non ripassa sulle righe gia allineate', () => {
  const prodottoId = creaProdotto('IDEMP', null);
  const ordine = db.prepare(`
    INSERT INTO ordini (codice_ordine, tipo, data_ordine, imponibile, iva, totale)
    VALUES (?,'vendita','2026-01-12',?,?,?)
  `).run(`${MARKER}-MIGR-IDEMP`, 100, 22, 122);
  const ordineId = Number(ordine.lastInsertRowid);
  db.prepare('INSERT INTO ordini_righe (ordine_id, prodotto_id, quantita, prezzo_unitario, sconto) VALUES (?,?,?,?,0)')
    .run(ordineId, prodottoId, 1, 100);

  backfillSnapshotIva(db);
  // Correzione a mano dopo la migrazione: la passata successiva non deve
  // sovrascriverla tornando a dedurre dalla testata.
  db.prepare("UPDATE ordini_righe SET aliquota_iva = 10, codice_iva = 'IVA10' WHERE ordine_id = ?").run(ordineId);
  backfillSnapshotIva(db);

  const riga = db.prepare('SELECT aliquota_iva, codice_iva FROM ordini_righe WHERE ordine_id = ?').get(ordineId);
  assert.equal(riga.aliquota_iva, 10);
  assert.equal(riga.codice_iva, 'IVA10');
});

// Il PDF si misura, non si guarda.
//
// La prima versione aveva le colonne oltre il bordo del foglio e, a pagina
// due, la tabella sopra l'intestazione: difetti che si vedono solo aprendo il
// file, e che quindi tornano. Qui si intercetta ogni `doc.text` e si controlla
// dove finisce davvero.
function misuraPdf(disegna) {
  const PDFDocument = require('pdfkit');
  const originaleText = PDFDocument.prototype.text;
  const originaleAddPage = PDFDocument.prototype.addPage;
  const scritte = [];
  // Il costruttore di PDFDocument chiama gia' addPage per la prima pagina:
  // il contatore parte da zero e non da uno.
  let pagina = 0;
  PDFDocument.prototype.addPage = function (...args) { pagina += 1; return originaleAddPage.apply(this, args); };
  PDFDocument.prototype.text = function (testo, x, y, opzioni) {
    if (typeof x === 'number' && typeof y === 'number') {
      const larghezza = opzioni && opzioni.width ? opzioni.width : this.widthOfString(String(testo));
      scritte.push({
        pagina, x, y,
        testo: String(testo).replace(/\s+/g, ' ').slice(0, 40),
        destra: x + larghezza,
        basso: y + this.heightOfString(String(testo), opzioni || {})
      });
    }
    return originaleText.apply(this, arguments);
  };
  return disegna().then((risultato) => {
    PDFDocument.prototype.text = originaleText;
    PDFDocument.prototype.addPage = originaleAddPage;
    return { risultato, scritte, pagine: pagina };
  }, (errore) => {
    PDFDocument.prototype.text = originaleText;
    PDFDocument.prototype.addPage = originaleAddPage;
    throw errore;
  });
}

function fatturaFinta(numeroRighe) {
  const righe = Array.from({ length: numeroRighe }, (unused, i) => ({
    codice_articolo: `COD${i}`,
    descrizione: `Articolo di prova numero ${i} con una descrizione lunga che deve andare a capo`,
    quantita: 100 + i, prezzo_unitario: 12345.67, imponibile: 12345.67,
    aliquota_iva: 22, natura_iva: null, importo_iva: 2716.05, totale_riga: 15061.72
  }));
  return {
    // Numero volutamente lungo: e' quello che mandava a capo l'intestazione.
    row: {
      id: 1, numero: 'FAT-2026-RD-PREV-20260625-354', numero_documento: 'FAT-2026-RD-PREV-20260625-354',
      tipo: 'emessa', data: '2026-06-25', scadenza: '2026-08-24',
      imponibile: 160493.71, iva: 35308.62, totale: 195802.33, valuta: 'EUR',
      ragione_sociale: 'AERONAUTICA MILITARE 70 STORMO', indirizzo: "Via dell'Aeroporto, 1",
      cap: '04013', citta: 'Latina', provincia: 'LT', codice_fiscale: '80007090592',
      codice_ordine: 'ORD-PREV-20260625-354', cig: 'B1C2D3E4F5', cup: 'F81B26000000001',
      note: 'Consegna presso magazzino, orario 8-13.'
    },
    righe,
    riepilogo: [
      { aliquota_iva: 22, natura_iva: null, imponibile: 160493.71, imposta: 35308.62 },
      { aliquota_iva: 10, natura_iva: null, imponibile: 1000, imposta: 100 },
      { aliquota_iva: 0, natura_iva: 'N4', imponibile: 500, imposta: 0 },
      { aliquota_iva: 0, natura_iva: 'N3.1', imponibile: 250, imposta: 0 }
    ]
  };
}

test('il PDF della fattura sta dentro i margini e non scrive sopra l intestazione', async () => {
  const dati = fatturaFinta(13);
  const { scritte, pagine } = await misuraPdf(() => renderFatturaPdf(dati));
  assert.equal(pagine > 1, true, 'con tredici righe il documento deve andare a capo pagina');

  const BORDO_DESTRO = 555;   // margine 40 + larghezza utile 515
  const BANDA_PIEDE = 786;    // sotto questa riga c'e' solo il pie' di pagina
  const contenuto = scritte.filter((s) => s.y < BANDA_PIEDE);

  const fuori = contenuto.filter((s) => s.destra > BORDO_DESTRO + 0.5);
  assert.deepEqual(fuori.map((s) => `${s.testo} @${Math.round(s.destra)}`), [], 'testo oltre il margine destro');

  const sotto = contenuto.filter((s) => s.basso > BANDA_PIEDE + 1);
  assert.deepEqual(sotto.map((s) => `${s.testo} @${Math.round(s.basso)}`), [], 'testo sotto il pie di pagina');

  // Il riquadro dell'intestazione arriva a 138 abbondanti: nessun contenuto
  // deve cominciare li' dentro, su nessuna pagina.
  const perPagina = new Map();
  contenuto.filter((s) => s.y > 150).forEach((s) => {
    if (!perPagina.has(s.pagina) || s.y < perPagina.get(s.pagina)) perPagina.set(s.pagina, s.y);
  });
  for (const [numero, primaY] of perPagina) {
    assert.equal(primaY > 150, true, `pagina ${numero}: il contenuto comincia a ${primaY}, sull intestazione`);
  }
});

test('le righe dell intestazione non si sovrappongono nemmeno con un numero lungo', async () => {
  const { scritte } = await misuraPdf(() => renderFatturaPdf(fatturaFinta(2)));
  // Le tre voci del riquadro in alto a destra, sulla prima pagina disegnata.
  const primaPagina = Math.min(...scritte.map((s) => s.pagina));
  const voci = scritte
    .filter((s) => s.pagina === primaPagina && s.y >= 88 && s.y < 160 && s.x > 250)
    .sort((a, b) => a.y - b.y);
  assert.equal(voci.length >= 3, true, 'il riquadro deve riportare numero, data e scadenza');
  for (let i = 1; i < voci.length; i += 1) {
    if (Math.abs(voci[i].x - voci[i - 1].x) > 0.5) continue;
    assert.equal(
      voci[i].y >= voci[i - 1].basso - 0.5,
      true,
      `"${voci[i - 1].testo}" finisce a ${Math.round(voci[i - 1].basso)} e "${voci[i].testo}" comincia a ${Math.round(voci[i].y)}`
    );
  }
});

test('la copia di cortesia in PDF si genera e riporta i totali', async () => {
  const prodotto22 = creaProdotto('PDF22', IVA22.id);
  const prodottoN4 = creaProdotto('PDFN4', N4.id);
  const ordine = await call('POST', '/api/ordini', {
    codice_ordine: `${MARKER}-ORD-PDF`,
    tipo: 'vendita',
    data_ordine: '2026-08-12',
    righe: [
      { prodotto_id: prodotto22, quantita: 1, prezzo_unitario: 100 },
      { prodotto_id: prodottoN4, quantita: 1, prezzo_unitario: 200 }
    ]
  });
  await call('PATCH', `/api/ordini/${ordine.id}/stato`, { stato: 'confermato' });
  const fattura = await call('POST', `/api/ordini/${ordine.id}/convert-to-fattura`, {});

  const pdf = await createFatturaPdfBuffer(fattura.fattura_id);
  assert.equal(pdf.buffer.subarray(0, 5).toString('latin1'), '%PDF-', 'non e un PDF');
  assert.equal(pdf.buffer.length > 1000, true);
  assert.match(pdf.filename, /^fattura-.*\.pdf$/);
});

test('una fattura da ordine a IVA mista produce un riepilogo per trattamento', async () => {
  const prodotto22 = creaProdotto('MIX22', IVA22.id);
  const prodotto10 = creaProdotto('MIX10', IVA10.id);
  const prodottoN4 = creaProdotto('MIXN4', N4.id);

  const ordine = await call('POST', '/api/ordini', {
    codice_ordine: `${MARKER}-ORD-MIX`,
    tipo: 'vendita',
    data_ordine: '2026-08-12',
    righe: [
      { prodotto_id: prodotto22, quantita: 1, prezzo_unitario: 100 },
      { prodotto_id: prodotto10, quantita: 1, prezzo_unitario: 200 },
      { prodotto_id: prodottoN4, quantita: 1, prezzo_unitario: 300 }
    ]
  });
  await call('PATCH', `/api/ordini/${ordine.id}/stato`, { stato: 'confermato' });
  const fattura = await call('POST', `/api/ordini/${ordine.id}/convert-to-fattura`, {});

  const testata = db.prepare('SELECT imponibile, iva, totale FROM fatture WHERE id = ?').get(fattura.fattura_id);
  assert.deepEqual([testata.imponibile, testata.iva, testata.totale], [600, 42, 642]);

  const riepilogo = db.prepare(`
    SELECT aliquota_iva, natura_iva, imponibile, imposta
    FROM fatture_iva_riepilogo WHERE fattura_id = ? ORDER BY aliquota_iva DESC, natura_iva
  `).all(fattura.fattura_id);
  assert.equal(riepilogo.length, 3);
  assert.deepEqual(riepilogo.map((row) => [row.aliquota_iva, row.natura_iva, row.imponibile, row.imposta]), [
    [22, null, 100, 22],
    [10, null, 200, 20],
    [0, 'N4', 300, 0]
  ]);
});
