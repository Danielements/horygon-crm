const { XMLParser } = require('fast-xml-parser');

// Pre-controlli applicativi allineati a "Elenco dei controlli effettuati sul file
// fattura del Sistema di Interscambio" versione 2.0 (31/01/2025).
//
// Servono a intercettare in locale gli scarti piu' frequenti prima di occupare un
// progressivo e un nome file, che con il SdI si bruciano in modo definitivo.
// Non sostituiscono i controlli SdI: restano fuori portata le verifiche che
// richiedono Anagrafe Tributaria o IndicePA (00300-00324, 00311, 00312).

// Tolleranze dichiarate nell'Elenco dei controlli.
const TOLLERANZA_IMPOSTA = 0.01;        // 00421
const TOLLERANZA_IMPONIBILE = 1.00;     // 00422
const TOLLERANZA_PREZZO_TOTALE = 0.01;  // 00423

const NATURE_GENERICHE_VIETATE = new Set(['N2', 'N3', 'N6']);

function runSdiFiscalChecks(xml, { format, today = new Date() } = {}) {
  const errors = [];
  const add = (code, message) => errors.push({ code, message });

  let root;
  try {
    root = parseRoot(xml);
  } catch (error) {
    return [{ code: 'PARSE', message: `XML non analizzabile per i controlli fiscali: ${error.message}` }];
  }
  if (!root) return errors;

  const header = root.FatturaElettronicaHeader || {};
  const trasmissione = header.DatiTrasmissione || {};
  checkCodiceDestinatario(trasmissione, format, add);
  checkPecDestinatario(trasmissione, format, add);
  checkCessionarioIdentificativi(header.CessionarioCommittente, format, add);

  asArray(root.FatturaElettronicaBody).forEach((body, index) => {
    const position = asArray(root.FatturaElettronicaBody).length > 1 ? ` (corpo ${index + 1})` : '';
    checkDocumentoGenerale(body, position, today, add);
    if (format === 'FSM10') checkSimplifiedBody(body, position, add);
    else checkOrdinaryBody(body, position, add);
  });

  return errors;
}

// --- header -------------------------------------------------------------

function checkCodiceDestinatario(trasmissione, format, add) {
  const codice = text(trasmissione.CodiceDestinatario);
  if (!codice) return;
  if (format === 'FPA12' && codice.length !== 6) {
    add('00427', `CodiceDestinatario "${codice}" di ${codice.length} caratteri non ammesso con FormatoTrasmissione FPA12: per la PA sono richiesti 6 caratteri`);
  }
  if ((format === 'FPR12' || format === 'FSM10') && codice.length !== 7) {
    add('00427', `CodiceDestinatario "${codice}" di ${codice.length} caratteri non ammesso con FormatoTrasmissione ${format}: sono richiesti 7 caratteri`);
  }
}

function checkPecDestinatario(trasmissione, format, add) {
  const pec = text(trasmissione.PECDestinatario);
  if (!pec) return;
  const codice = text(trasmissione.CodiceDestinatario);
  if (format === 'FPA12') {
    add('PEC_DESTINATARIO', 'PECDestinatario non ammesso verso la Pubblica Amministrazione (Specifiche formato FatturaPA 1.4 par. 1.1)');
    return;
  }
  if (codice !== '0000000') {
    add('PEC_DESTINATARIO', `PECDestinatario puo' essere valorizzato solo se CodiceDestinatario e' 0000000, trovato "${codice}" (Specifiche formato FatturaPA 1.4 par. 1.1)`);
  }
}

function checkCessionarioIdentificativi(cessionario, format, add) {
  if (!cessionario) return;
  const anagrafica = format === 'FSM10'
    ? cessionario.IdentificativiFiscali || {}
    : cessionario.DatiAnagrafici || {};
  const hasVat = Boolean(text(anagrafica.IdFiscaleIVA?.IdCodice));
  const hasFiscalCode = Boolean(text(anagrafica.CodiceFiscale));
  if (!hasVat && !hasFiscalCode) {
    add('00417', 'IdFiscaleIVA e CodiceFiscale del cessionario/committente non valorizzati: almeno uno dei due e obbligatorio');
  }
}

// --- corpo fattura ordinaria -------------------------------------------

function checkDocumentoGenerale(body, position, today, add) {
  const documento = body?.DatiGenerali?.DatiGeneraliDocumento || {};
  const numero = text(documento.Numero);
  if (numero && !/\d/.test(numero)) {
    add('00425', `Numero documento "${numero}"${position} non contiene caratteri numerici`);
  }
  const data = text(documento.Data);
  if (data && /^\d{4}-\d{2}-\d{2}$/.test(data)) {
    const documentDate = Date.parse(`${data}T00:00:00Z`);
    const limit = Date.parse(`${new Date(today).toISOString().slice(0, 10)}T23:59:59Z`);
    if (Number.isFinite(documentDate) && documentDate > limit) {
      add('00403', `Data documento ${data}${position} successiva alla data odierna`);
    }
  }
}

function checkOrdinaryBody(body, position, add) {
  const beniServizi = body?.DatiBeniServizi || {};
  const lines = asArray(beniServizi.DettaglioLinee);
  const summaries = asArray(beniServizi.DatiRiepilogo);

  lines.forEach((line) => {
    const numeroLinea = text(line.NumeroLinea) || '?';
    const label = `linea ${numeroLinea}${position}`;
    const aliquota = number(line.AliquotaIVA);
    const natura = text(line.Natura);

    if (aliquota === 0 && !natura) {
      add('00400', `Natura non presente sulla ${label} a fronte di AliquotaIVA pari a zero`);
    }
    if (aliquota !== 0 && natura) {
      add('00401', `Natura "${natura}" presente sulla ${label} a fronte di AliquotaIVA ${formatNumber(aliquota)} diversa da zero`);
    }
    if (natura && NATURE_GENERICHE_VIETATE.has(natura.toUpperCase())) {
      add('00445', `Natura generica "${natura}" non piu ammessa sulla ${label}: usare la codifica di dettaglio (es. N3.5)`);
    }
    checkScontoMaggiorazione(line, label, add);
    checkPrezzoTotale(line, label, add);
  });

  summaries.forEach((row, index) => {
    const label = `riepilogo ${index + 1}${position}`;
    const aliquota = number(row.AliquotaIVA);
    const natura = text(row.Natura);

    if (aliquota === 0 && !natura) {
      add('00429', `Natura non presente nel ${label} a fronte di AliquotaIVA pari a zero`);
    }
    if (aliquota !== 0 && natura) {
      add('00430', `Natura "${natura}" presente nel ${label} a fronte di AliquotaIVA ${formatNumber(aliquota)} diversa da zero`);
    }
    if (natura && NATURE_GENERICHE_VIETATE.has(natura.toUpperCase())) {
      add('00445', `Natura generica "${natura}" non piu ammessa nel ${label}`);
    }

    const imponibile = number(row.ImponibileImporto);
    const imposta = number(row.Imposta);
    const attesa = roundTo(aliquota * imponibile / 100, 2);
    if (Math.abs(imposta - attesa) > TOLLERANZA_IMPOSTA + 1e-9) {
      add('00421', `Imposta ${formatNumber(imposta)} nel ${label} non coerente: attesa ${formatNumber(attesa)} (AliquotaIVA ${formatNumber(aliquota)} su imponibile ${formatNumber(imponibile)})`);
    }
  });

  checkRiepilogoCoverage(lines, summaries, position, add);
  checkImponibiliPerAliquota(lines, summaries, position, add);
}

function checkScontoMaggiorazione(line, label, add) {
  asArray(line.ScontoMaggiorazione).forEach((entry) => {
    const tipo = text(entry.Tipo);
    if (!tipo) return;
    const hasPercentuale = entry.Percentuale !== undefined && entry.Percentuale !== null && text(entry.Percentuale) !== '';
    const hasImporto = entry.Importo !== undefined && entry.Importo !== null && text(entry.Importo) !== '';
    if (!hasPercentuale && !hasImporto) {
      add('00437', `ScontoMaggiorazione sulla ${label} ha Tipo "${tipo}" ma ne Percentuale ne Importo valorizzati`);
    }
  });
}

// Controllo 00423, con la regola a cascata descritta nell'Elenco dei controlli:
// gli importi si sommano, le percentuali si applicano al prezzo via via ridotto o
// aumentato; se su uno stesso blocco sono presenti sia Importo sia Percentuale si
// considera solo l'Importo.
function checkPrezzoTotale(line, label, add) {
  const prezzoUnitario = number(line.PrezzoUnitario);
  const quantita = line.Quantita === undefined || line.Quantita === null || text(line.Quantita) === ''
    ? 1
    : number(line.Quantita);
  const prezzoTotale = number(line.PrezzoTotale);

  let running = prezzoUnitario;
  let adjustment = 0;
  asArray(line.ScontoMaggiorazione).forEach((entry) => {
    const tipo = String(text(entry.Tipo) || 'SC').toUpperCase();
    const hasImporto = entry.Importo !== undefined && entry.Importo !== null && text(entry.Importo) !== '';
    const hasPercentuale = entry.Percentuale !== undefined && entry.Percentuale !== null && text(entry.Percentuale) !== '';
    let delta = null;
    if (hasImporto) delta = number(entry.Importo);
    else if (hasPercentuale) delta = running * number(entry.Percentuale) / 100;
    if (delta === null) return;
    if (tipo === 'MG') {
      adjustment += delta;
      running += delta;
    } else {
      adjustment -= delta;
      running -= delta;
    }
  });

  const atteso = (prezzoUnitario + adjustment) * quantita;
  if (Math.abs(prezzoTotale - atteso) > TOLLERANZA_PREZZO_TOTALE + 1e-9) {
    add('00423', `PrezzoTotale ${formatNumber(prezzoTotale)} sulla ${label} non coerente: atteso ${formatNumber(atteso)} (PrezzoUnitario ${formatNumber(prezzoUnitario)}${adjustment ? ` rettificato di ${formatNumber(adjustment)}` : ''} per quantita ${formatNumber(quantita)})`);
  }
}

function checkRiepilogoCoverage(lines, summaries, position, add) {
  const aliquoteRiepilogo = new Set(summaries.map((row) => normalizeRate(row.AliquotaIVA)));
  const natureRiepilogo = new Set(summaries.map((row) => text(row.Natura).toUpperCase()).filter(Boolean));

  const aliquoteMancanti = new Set();
  const natureMancanti = new Set();
  lines.forEach((line) => {
    const aliquota = normalizeRate(line.AliquotaIVA);
    if (!aliquoteRiepilogo.has(aliquota)) aliquoteMancanti.add(aliquota);
    const natura = text(line.Natura).toUpperCase();
    if (natura && !natureRiepilogo.has(natura)) natureMancanti.add(natura);
  });

  aliquoteMancanti.forEach((aliquota) => {
    add('00443', `Nessun DatiRiepilogo${position} per l'AliquotaIVA ${aliquota} presente nelle linee di dettaglio`);
  });
  natureMancanti.forEach((natura) => {
    add('00444', `Nessun DatiRiepilogo${position} con Natura "${natura}" presente nelle linee di dettaglio`);
  });
}

function checkImponibiliPerAliquota(lines, summaries, position, add) {
  const perAliquota = new Map();
  summaries.forEach((row) => {
    const key = normalizeRate(row.AliquotaIVA);
    const entry = perAliquota.get(key) || { imponibile: 0, righe: 0, arrotondamento: 0 };
    entry.imponibile += number(row.ImponibileImporto);
    entry.arrotondamento += number(row.Arrotondamento);
    perAliquota.set(key, entry);
  });
  lines.forEach((line) => {
    const key = normalizeRate(line.AliquotaIVA);
    const entry = perAliquota.get(key);
    if (!entry) return;
    entry.righe += number(line.PrezzoTotale);
  });

  perAliquota.forEach((entry, aliquota) => {
    const atteso = entry.righe + entry.arrotondamento;
    if (Math.abs(entry.imponibile - atteso) > TOLLERANZA_IMPONIBILE + 1e-9) {
      add('00422', `ImponibileImporto ${formatNumber(entry.imponibile)} per l'aliquota ${aliquota}${position} non coerente con la somma dei PrezzoTotale di riga ${formatNumber(atteso)}`);
    }
  });
}

// --- corpo fattura semplificata ----------------------------------------

function checkSimplifiedBody(body, position, add) {
  asArray(body?.DatiBeniServizi).forEach((row, index) => {
    const label = `riga ${index + 1}${position}`;
    const natura = text(row.Natura);
    if (natura && NATURE_GENERICHE_VIETATE.has(natura.toUpperCase())) {
      add('00445', `Natura generica "${natura}" non piu ammessa sulla ${label}`);
    }
    const aliquota = row.DatiIVA?.Aliquota;
    if (aliquota !== undefined && aliquota !== null && text(aliquota) !== '') {
      if (number(aliquota) === 0 && !natura) {
        add('00400', `Natura non presente sulla ${label} a fronte di Aliquota pari a zero`);
      }
      if (number(aliquota) !== 0 && natura) {
        add('00401', `Natura "${natura}" presente sulla ${label} a fronte di Aliquota diversa da zero`);
      }
    }
  });
}

// --- utilita' -----------------------------------------------------------

function parseRoot(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true
  });
  const parsed = parser.parse(String(xml || ''));
  const rootName = Object.keys(parsed || {}).find((key) => key !== '?xml');
  return rootName ? parsed[rootName] : null;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return '';
  return String(value).trim();
}

function number(value) {
  const parsed = Number(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRate(value) {
  return number(value).toFixed(2);
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function formatNumber(value) {
  return Number(value).toFixed(2);
}

module.exports = {
  TOLLERANZA_IMPONIBILE,
  TOLLERANZA_IMPOSTA,
  TOLLERANZA_PREZZO_TOTALE,
  runSdiFiscalChecks
};
