const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const stripe = require('../src/services/stripe-client');
const musa = require('../src/services/musa-service');

// --- encoding form stile Stripe --------------------------------------------

test('encodeForm: annidati e array in stile Stripe', () => {
  const s = stripe.encodeForm({ a: 1, meta: { piva: 'IT123' }, items: [{ price: 'p1', quantity: 2 }] });
  assert.ok(s.includes('a=1'));
  assert.ok(s.includes('meta%5Bpiva%5D=IT123'));            // meta[piva]=IT123
  assert.ok(s.includes('items%5B0%5D%5Bprice%5D=p1'));      // items[0][price]=p1
  assert.ok(s.includes('items%5B0%5D%5Bquantity%5D=2'));
});

test('encodeForm: salta null/undefined', () => {
  const s = stripe.encodeForm({ a: 'x', b: null, c: undefined });
  assert.equal(s, 'a=x');
});

// --- verifica firma webhook ------------------------------------------------

function firma(payload, secret, t) {
  const ts = t != null ? t : Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  return `t=${ts},v1=${v1}`;
}

test('verifyWebhook: firma valida -> ritorna evento', () => {
  const secret = 'whsec_test';
  const payload = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', livemode: false });
  const header = firma(payload, secret);
  const ev = stripe.verifyWebhook(payload, header, secret);
  assert.equal(ev.id, 'evt_1');
  assert.equal(ev.type, 'invoice.paid');
});

test('verifyWebhook: firma manomessa -> lancia', () => {
  const secret = 'whsec_test';
  const payload = '{"id":"evt_1"}';
  const header = firma(payload, secret).replace(/v1=.*/, 'v1=deadbeef');
  assert.throws(() => stripe.verifyWebhook(payload, header, secret));
});

test('verifyWebhook: payload alterato dopo la firma -> lancia', () => {
  const secret = 'whsec_test';
  const header = firma('{"id":"evt_1"}', secret);
  assert.throws(() => stripe.verifyWebhook('{"id":"evt_2"}', header, secret));
});

test('verifyWebhook: timestamp troppo vecchio -> lancia', () => {
  const secret = 'whsec_test';
  const payload = '{"id":"evt_1"}';
  const header = firma(payload, secret, Math.floor(Date.now() / 1000) - 10000);
  assert.throws(() => stripe.verifyWebhook(payload, header, secret, 300));
});

// --- conversioni e mapper --------------------------------------------------

test('toCents/toEuro: round-trip in centesimi interi', () => {
  assert.equal(musa.toCents(12.5), 1250);
  assert.equal(musa.toCents(0.1), 10);
  assert.equal(musa.toEuro(1250), 12.5);
});

test('mapInvoice: mappa stato e importi in euro', () => {
  const inv = musa.mapInvoice({ id: 'in_1', number: 'MUSA-1', status: 'open', total: 12200, amount_due: 12200, amount_paid: 0, currency: 'eur', created: 1750000000, customer_email: 'x@y.it' });
  assert.equal(inv.stato_label, 'Da pagare');
  assert.equal(inv.totale, 122);
  assert.equal(inv.valuta, 'EUR');
});

test('mode: dedotto dal prefisso della chiave', () => {
  const prev = process.env.MUSA_STRIPE_SECRET_KEY;
  process.env.MUSA_STRIPE_SECRET_KEY = 'sk_test_abc';
  assert.equal(stripe.mode(), 'test');
  assert.equal(stripe.isConfigured(), true);
  process.env.MUSA_STRIPE_SECRET_KEY = '';
  assert.equal(stripe.mode(), 'non_configurato');
  assert.equal(stripe.isConfigured(), false);
  if (prev) process.env.MUSA_STRIPE_SECRET_KEY = prev;
});
