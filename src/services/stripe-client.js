// Client Stripe minimale via REST (nessuna dipendenza: fetch globale di Node 24
// + crypto per la verifica firma webhook). Modulo MUSA, separato da Horygon.
// La secret key sta SOLO in ENV (MUSA_STRIPE_SECRET_KEY), mai nel frontend/DB.
// L'ambiente (test/live) e' dedotto dal prefisso della chiave. Le operazioni
// che muovono denaro (rimborsi, pay, send) le invoca il backend solo su azione
// esplicita dell'utente.

const crypto = require('crypto');

const API_BASE = 'https://api.stripe.com/v1';

function secretKey() { return process.env.MUSA_STRIPE_SECRET_KEY || ''; }
function webhookSecret() { return process.env.MUSA_STRIPE_WEBHOOK_SECRET || ''; }
function isConfigured() { return /^sk_(test|live)_/.test(secretKey()); }
function mode() { return /^sk_live_/.test(secretKey()) ? 'live' : (/^sk_test_/.test(secretKey()) ? 'test' : 'non_configurato'); }
function isEnabled() { return isConfigured() && process.env.MUSA_STRIPE_ENABLED !== '0'; }

// Codifica form in stile Stripe: oggetti annidati -> a[b][c], array -> a[0][b].
// Puro.
function encodeForm(obj, prefix) {
  const parts = [];
  const enc = encodeURIComponent;
  const add = (key, val) => {
    if (val === undefined || val === null) return;
    if (Array.isArray(val)) {
      val.forEach((v, i) => add(`${key}[${i}]`, v));
    } else if (typeof val === 'object') {
      Object.keys(val).forEach((k) => add(`${key}[${k}]`, val[k]));
    } else {
      parts.push(`${enc(key)}=${enc(String(val))}`);
    }
  };
  Object.keys(obj || {}).forEach((k) => add(prefix ? `${prefix}[${k}]` : k, obj[k]));
  return parts.join('&');
}

// Chiamata REST a Stripe. `params` -> query (GET) o body form (POST).
async function request(method, path, params = {}, options = {}) {
  if (!isConfigured()) throw new Error('Stripe non configurato (MUSA_STRIPE_SECRET_KEY assente)');
  let url = `${API_BASE}${path}`;
  const headers = {
    Authorization: `Bearer ${secretKey()}`,
    'Stripe-Version': process.env.MUSA_STRIPE_API_VERSION || '2024-06-20'
  };
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const init = { method, headers };
  if (method === 'GET') {
    const qs = encodeForm(params);
    if (qs) url += `?${qs}`;
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = encodeForm(params);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
  init.signal = controller.signal;
  let res;
  try { res = await fetch(url, init); } finally { clearTimeout(timer); }
  const raw = await res.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`Risposta Stripe non JSON (${res.status})`); }
  if (!res.ok) {
    const msg = data && data.error ? (data.error.message || data.error.type) : `HTTP ${res.status}`;
    throw new Error(`Stripe: ${msg}`);
  }
  return data;
}

// --- letture --------------------------------------------------------------
const getBalance = () => request('GET', '/balance');
const listPaymentIntents = (limit = 20) => request('GET', '/payment_intents', { limit });
const listCharges = (limit = 20) => request('GET', '/charges', { limit });
const listInvoices = (limit = 20, params = {}) => request('GET', '/invoices', { limit, ...params });
const getInvoice = (id) => request('GET', `/invoices/${id}`);
const listCustomers = (limit = 50) => request('GET', '/customers', { limit });
// Articoli = Prodotti Stripe (+ Prezzi).
const listProducts = (limit = 100) => request('GET', '/products', { limit, active: true, expand: ['data.default_price'] });
const listPrices = (limit = 100) => request('GET', '/prices', { limit, active: true });
const createProduct = (data) => request('POST', '/products', data);
const updateProduct = (id, data) => request('POST', `/products/${id}`, data);
const createPrice = (data) => request('POST', '/prices', data);

// --- scritture ------------------------------------------------------------
const createCustomer = (data) => request('POST', '/customers', data);
const createInvoiceItem = (data) => request('POST', '/invoiceitems', data);
const createInvoice = (data) => request('POST', '/invoices', data);
const finalizeInvoice = (id) => request('POST', `/invoices/${id}/finalize`);
const sendInvoice = (id) => request('POST', `/invoices/${id}/send`);
const payInvoice = (id, data = {}) => request('POST', `/invoices/${id}/pay`, data);
const voidInvoice = (id) => request('POST', `/invoices/${id}/void`);
const createPaymentLink = (data) => request('POST', '/payment_links', data);
const createRefund = (data, idemKey) => request('POST', '/refunds', data, { idempotencyKey: idemKey });

// --- webhook --------------------------------------------------------------
// Verifica la firma di un webhook Stripe. rawBody = Buffer/stringa ESATTA
// ricevuta; header = valore di 'Stripe-Signature'. Ritorna l'evento (JSON) se
// valido, altrimenti lancia. Puro (a parte Date.now per la tolleranza).
function verifyWebhook(rawBody, header, secret, toleranceSec = 300) {
  const whsec = secret || webhookSecret();
  if (!whsec) throw new Error('Webhook secret non configurato');
  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const parts = {};
  String(header || '').split(',').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > 0) { const k = kv.slice(0, i).trim(); (parts[k] = parts[k] || []).push(kv.slice(i + 1).trim()); }
  });
  const t = parts.t && parts.t[0];
  const sigs = parts.v1 || [];
  if (!t || !sigs.length) throw new Error('Firma webhook malformata');
  const expected = crypto.createHmac('sha256', whsec).update(`${t}.${payload}`).digest('hex');
  const ok = sigs.some((s) => {
    try { return s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)); }
    catch { return false; }
  });
  if (!ok) throw new Error('Firma webhook non valida');
  if (toleranceSec > 0 && Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > toleranceSec) {
    throw new Error('Timestamp webhook fuori tolleranza');
  }
  return JSON.parse(payload);
}

module.exports = {
  isConfigured, isEnabled, mode, secretKey, webhookSecret, encodeForm, request, verifyWebhook,
  getBalance, listPaymentIntents, listCharges, listInvoices, getInvoice, listCustomers,
  listProducts, listPrices, createProduct, updateProduct, createPrice,
  createCustomer, createInvoiceItem, createInvoice, finalizeInvoice, sendInvoice, payInvoice, voidInvoice,
  createPaymentLink, createRefund
};
