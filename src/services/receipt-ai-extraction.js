// Estrazione AI dei dati da scontrini/ricevute/fatture (foto o PDF) per
// autocompilare una spesa. L'AI e' un SUGGERIMENTO: l'utente rivede e conferma
// sempre prima di salvare. Chiave solo da ENV (vedi ai-provider), disattivabile.

const aiProvider = require('./ai-provider');

function round2(n) { if (n == null) return null; const v = Number(n); return Number.isNaN(v) ? null : Math.round(v * 100) / 100; }

// Numero da valore misto (italiano "1.234,56" o "1234.56").
function toNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  let s = String(v).trim().replace(/\s|€|EUR/gi, '');
  let sign = /^-|-$/.test(s) ? -1 : 1;
  s = s.replace(/[+-]/g, '');
  if (s.includes('.') && s.includes(',')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isNaN(n) ? null : sign * n;
}

function buildPrompt() {
  return [
    'Sei un estrattore di dati da scontrini, ricevute e fatture italiane.',
    'Restituisci SOLO un oggetto JSON valido, senza testo attorno:',
    '{ "data": "YYYY-MM-DD", "fornitore_nome": string, "fornitore_piva": string,',
    '  "numero_documento": string, "imponibile": number, "iva": number,',
    '  "totale": number, "valuta": "EUR" }',
    'Regole:',
    '- totale = importo totale pagato (documento). imponibile e iva solo se',
    '  chiaramente indicati; altrimenti null (NON dedurli).',
    '- data del documento in formato YYYY-MM-DD.',
    '- fornitore_nome = esercente/emittente; fornitore_piva = partita IVA se presente.',
    '- numero_documento = numero scontrino/ricevuta/fattura se presente.',
    '- se un campo non e leggibile mettilo null. Non inventare.'
  ].join('\n');
}

// Estrae il JSON dal testo del modello (tollerante ai fences). Puro.
function parseReceiptJson(text) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Documento non riconosciuto come scontrino/ricevuta: compila i campi a mano');
  s = s.slice(start, end + 1);
  let d;
  try { d = JSON.parse(s); } catch { throw new Error('Documento non riconosciuto come scontrino/ricevuta: compila i campi a mano'); }
  const str = (v) => { const t = (v == null ? '' : String(v)).trim(); return t || null; };
  return {
    data: str(d.data) ? String(d.data).slice(0, 10) : null,
    fornitore_nome: str(d.fornitore_nome),
    fornitore_piva: str(d.fornitore_piva),
    numero_documento: str(d.numero_documento),
    imponibile: round2(toNumber(d.imponibile)),
    iva: round2(toNumber(d.iva)),
    totale: round2(toNumber(d.totale)),
    valuta: str(d.valuta) || 'EUR'
  };
}

async function extractReceipt(buffer, options = {}) {
  const callFn = options.callFn || aiProvider.askWithDocument;
  const text = await callFn({
    prompt: buildPrompt(),
    dataBase64: Buffer.isBuffer(buffer) ? buffer.toString('base64') : String(buffer),
    mime: options.mime || 'image/jpeg',
    filename: options.filename || 'ricevuta.jpg',
    model: options.model
  });
  return parseReceiptJson(text);
}

module.exports = { toNumber, buildPrompt, parseReceiptJson, extractReceipt };
