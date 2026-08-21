// Adapter AI minimale e riusabile (estratti conto ora, scontrini/ricevute poi).
// Chiave SOLO da ENV OPENAI_API_KEY (mai frontend/DB in chiaro). Kill-switch
// AI_DOCUMENT_AI_ENABLED. Il modello e' configurabile. Nessuna dipendenza:
// usa fetch globale (Node 24). L'AI e' sempre un suggerimento, mai fonte
// fiscale: chi chiama valida (es. contro i totali del riepilogo).

const DEFAULT_MODEL = process.env.AI_DOCUMENT_MODEL || 'gpt-4o';
const OPENAI_URL = 'https://api.openai.com/v1/responses';

function isConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

function isEnabled() {
  return isConfigured() && process.env.AI_DOCUMENT_AI_ENABLED !== '0';
}

// Estrae il testo utile da una risposta della Responses API di OpenAI, in modo
// tollerante alle varianti di forma.
function extractOutputText(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text;
  const parts = [];
  const out = Array.isArray(data.output) ? data.output : [];
  for (const item of out) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const c of content) {
      if (typeof c.text === 'string') parts.push(c.text);
      else if (c.text && typeof c.text.value === 'string') parts.push(c.text.value);
    }
  }
  return parts.join('\n').trim();
}

// Chiama il modello con un documento (PDF/immagine) in base64 + un prompt, e
// chiede una risposta JSON. Ritorna il testo grezzo del modello.
async function askWithDocument({ prompt, dataBase64, mime = 'application/pdf', filename = 'documento.pdf', model, timeoutMs = 90000 }) {
  if (!isConfigured()) throw new Error('OPENAI_API_KEY non configurata');
  const isImage = String(mime).startsWith('image/');
  const filePart = isImage
    ? { type: 'input_image', image_url: `data:${mime};base64,${dataBase64}` }
    : { type: 'input_file', filename, file_data: `data:${mime};base64,${dataBase64}` };

  const body = {
    model: model || DEFAULT_MODEL,
    input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, filePart] }]
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  const raw = await res.text();
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${raw.slice(0, 300)}`);
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('Risposta OpenAI non JSON'); }
  return extractOutputText(data);
}

module.exports = { isConfigured, isEnabled, askWithDocument, extractOutputText, DEFAULT_MODEL };
