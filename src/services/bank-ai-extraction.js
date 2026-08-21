// Estrazione AI dei movimenti da un PDF di estratto conto, con VERIFICA contro i
// totali del riepilogo (rete di sicurezza: l'AI e' un suggerimento, non fonte
// fiscale). Se la somma dei movimenti non torna con entrate/uscite dichiarate,
// lo segnaliamo e non si importa alla cieca.

const aiProvider = require('./ai-provider');

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
const EPS = 0.02;

// Numero da valore misto: accetta number, "1.234,56", "1234.56", "-72,00".
function toNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  let s = String(v).trim().replace(/\s|€|EUR/gi, '');
  let sign = /^-|-$/.test(s) ? -1 : 1;
  s = s.replace(/[+-]/g, '');
  // se ha sia '.' che ',', l'ultimo separatore e' il decimale
  if (s.includes('.') && s.includes(',')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isNaN(n) ? null : sign * n;
}

function buildPrompt() {
  return [
    'Sei un estrattore di dati da estratti conto bancari italiani.',
    'Restituisci SOLO un oggetto JSON valido, senza testo attorno, con questa forma:',
    '{',
    '  "riepilogo": { "saldo_iniziale": number, "uscite": number, "entrate": number, "saldo_finale": number },',
    '  "movimenti": [ { "data": "YYYY-MM-DD", "importo": number, "descrizione": string, "controparte": string } ]',
    '}',
    'Regole:',
    '- importo negativo per le uscite/addebiti, positivo per le entrate/accrediti.',
    '- data operazione in formato YYYY-MM-DD.',
    '- descrizione: la causale completa; controparte: ordinante/beneficiario se presente, altrimenti "".',
    '- includi TUTTI i movimenti elencati, non i saldi.',
    '- non inventare valori: se un importo non e leggibile, ometti la riga.',
    '- i totali del riepilogo prendili dalla sezione RIEPILOGO GENERALE dell estratto.'
  ].join('\n');
}

// Estrae il JSON dal testo del modello (tollerante a fences markdown). Puro.
function parseAiJson(text) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  const data = JSON.parse(s);

  const riepilogo = data.riepilogo || {};
  const movimenti = (Array.isArray(data.movimenti) ? data.movimenti : []).map((m) => ({
    data_operazione: String(m.data || m.data_operazione || '').slice(0, 10) || null,
    importo: round2(toNumber(m.importo)),
    descrizione: (m.descrizione || '').toString().trim() || null,
    controparte: (m.controparte || '').toString().trim() || null
  })).filter((m) => m.importo != null && m.data_operazione);

  return {
    riepilogo: {
      saldo_iniziale: toNumber(riepilogo.saldo_iniziale),
      uscite: toNumber(riepilogo.uscite),
      entrate: toNumber(riepilogo.entrate),
      saldo_finale: toNumber(riepilogo.saldo_finale)
    },
    movimenti
  };
}

// Verifica la coerenza tra movimenti e totali dichiarati. Pura.
function verifyAgainstTotals(movimenti, riepilogo) {
  const sommaUscite = round2((movimenti || []).filter((m) => m.importo < 0).reduce((s, m) => s + Math.abs(m.importo), 0));
  const sommaEntrate = round2((movimenti || []).filter((m) => m.importo > 0).reduce((s, m) => s + m.importo, 0));
  const r = riepilogo || {};
  const check = (dichiarato, calcolato) => (dichiarato == null ? null : Math.abs(round2(dichiarato) - calcolato) <= EPS);

  const usciteOk = check(r.uscite, sommaUscite);
  const entrateOk = check(r.entrate, sommaEntrate);
  // saldo iniziale + entrate - uscite == saldo finale?
  let saldoOk = null;
  if (r.saldo_iniziale != null && r.saldo_finale != null) {
    saldoOk = Math.abs(round2(round2(r.saldo_iniziale) + sommaEntrate - sommaUscite) - round2(r.saldo_finale)) <= EPS;
  }
  const coerente = usciteOk !== false && entrateOk !== false && saldoOk !== false;
  return {
    coerente,
    somma_uscite: sommaUscite,
    somma_entrate: sommaEntrate,
    dichiarato: { uscite: r.uscite != null ? round2(r.uscite) : null, entrate: r.entrate != null ? round2(r.entrate) : null },
    verifiche: { uscite: usciteOk, entrate: entrateOk, saldo: saldoOk },
    differenze: {
      uscite: r.uscite != null ? round2(round2(r.uscite) - sommaUscite) : null,
      entrate: r.entrate != null ? round2(round2(r.entrate) - sommaEntrate) : null
    }
  };
}

// Estrae i movimenti da un PDF (buffer). callFn iniettabile per i test.
async function extractBankStatement(pdfBuffer, options = {}) {
  const callFn = options.callFn || aiProvider.askWithDocument;
  const text = await callFn({
    prompt: buildPrompt(),
    dataBase64: Buffer.isBuffer(pdfBuffer) ? pdfBuffer.toString('base64') : String(pdfBuffer),
    mime: options.mime || 'application/pdf',
    filename: options.filename || 'estratto.pdf',
    model: options.model
  });
  const parsed = parseAiJson(text);
  const verifica = verifyAgainstTotals(parsed.movimenti, parsed.riepilogo);
  return { ...parsed, verifica };
}

module.exports = { toNumber, buildPrompt, parseAiJson, verifyAgainstTotals, extractBankStatement };
