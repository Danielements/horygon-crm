const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const XLSX = require('xlsx');

const extract = promisify(execFile);
const pythonCode = [
  'import sys, io, json',
  'from pypdf import PdfReader',
  'r = PdfReader(io.BytesIO(sys.stdin.buffer.read()))',
  'assert 0 < len(r.pages) <= 8',
  'print(json.dumps("\\n".join(p.extract_text() or "" for p in r.pages)))'
].join('\n');

async function readPdf(buffer) {
  if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Selezionare un PDF valido');
  const task = extract(process.env.PDF_PYTHON || 'python3', ['-c', pythonCode], { timeout: 12000, maxBuffer: 1024 * 1024 });
  task.child.stdin.on('error', () => {});
  task.child.stdin.end(buffer);
  try { return JSON.parse((await task).stdout); }
  catch { throw new Error('Impossibile leggere il testo del PDF (massimo 8 pagine).'); }
}

function recognize(text, companyVat) {
  const clean = text.replace(/[\u0000\u2010-\u2014]/g, '-').replace(/\s+/g, ' ');
  const number = clean.match(/Invoice number ([A-Z0-9]+-[A-Z0-9]+)\b/i)?.[1];
  const dateText = clean.match(/Date of issue ([A-Za-z]+ \d{1,2}, \d{4})/i)?.[1];
  const date = new Date(dateText + ' 00:00:00 GMT');
  const amount = clean.match(/Amount due \$([\d,]+\.\d{2}) USD/i)?.[1];
  const total = clean.match(/\bTotal \$([\d,]+\.\d{2})\b/i)?.[1];
  if (!number || !Number.isFinite(date.getTime()) || !amount || total !== amount ||
      !/OpenAI OpCo, LLC/i.test(clean) || !/EU OSS VAT EU372041333/i.test(clean) ||
      !/ChatGPT Plus Subscription/i.test(clean) || !/reverse charge/i.test(clean) ||
      !/United States/i.test(clean)) throw new Error('Formato non riconosciuto: occorre una fattura PDF OpenAI per ChatGPT Plus in USD con reverse charge.');
  const vat = clean.match(/Bill to .*?IT VAT IT(\d{11})\b/i)?.[1];
  if (!vat || vat !== String(companyVat || '').replace(/^IT/i, '')) throw new Error('La partita IVA del cliente non coincide con quella aziendale configurata per SdI.');
  const address = clean.match(/OpenAI OpCo, LLC (.+?) San Francisco, California (\d{5}) United States/i);
  if (!address) throw new Error('Indirizzo del fornitore non riconosciuto');
  return { number, date: date.toISOString().slice(0, 10), amount: Number(amount.replaceAll(',', '')),
    currency: 'USD', supplier: 'OpenAI OpCo, LLC', vat: 'EU372041333', address: address[1], cap: address[2] };
}

const dailyRates = new Map();

async function getRate(date) {
  if (dailyRates.has(date)) return dailyRates.get(date);
  const source = new URL('https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A');
  source.search = new URLSearchParams({ startPeriod: date, endPeriod: date, format: 'csvdata' });
  const response = await fetch(source, { signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error('Cambio BCE non disponibile per la data del documento');
  const book = XLSX.read(await response.text(), { type: 'string', raw: true });
  const rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]]);
  const row = rows.find(r => r.TIME_PERIOD === date && r.CURRENCY === 'USD' && r.CURRENCY_DENOM === 'EUR');
  const value = Number(row?.OBS_VALUE);
  if (!(value > 0 && Number.isFinite(value))) throw new Error('Cambio BCE assente per la data del documento');
  const rate = { value, source: source.href };
  if (dailyRates.size >= 256) dailyRates.delete(dailyRates.keys().next().value);
  dailyRates.set(date, rate);
  return rate;
}

module.exports = { readPdf, recognize, getRate };
