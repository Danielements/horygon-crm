// Modulo MUSA (societa' separata) — gestione Stripe: pagamenti, fatture,
// clienti, payment link, rimborsi. Sezione/permesso 'musa' (admin/superadmin).
// Il webhook Stripe e' in musa-webhook.js (body raw, nessuna auth).

const express = require('express');
const router = express.Router();
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const { writeAudit } = require('../services/audit');
const stripe = require('../services/stripe-client');
const musa = require('../services/musa-service');

router.use(authMiddleware);

const canRead = requirePermesso('musa', 'read');
const canEdit = requirePermesso('musa', 'edit');
const canDelete = requirePermesso('musa', 'delete');

function fail(res, e) {
  try { require('../services/system-log').writeSystemLog('error', 'musa-stripe', e.message, {}); } catch {}
  res.status(400).json({ error: e.message });
}

// Stato configurazione (il frontend mostra il modulo solo se abilitato).
router.get('/stato', canRead, (req, res) => {
  res.json({ configurato: stripe.isConfigured(), abilitato: stripe.isEnabled(), mode: stripe.mode() });
});

router.get('/dashboard', canRead, async (req, res) => {
  try { res.json(await musa.dashboard()); } catch (e) { fail(res, e); }
});
router.get('/fatture', canRead, async (req, res) => {
  try { res.json({ fatture: await musa.listInvoices() }); } catch (e) { fail(res, e); }
});
router.get('/pagamenti', canRead, async (req, res) => {
  try { res.json({ pagamenti: await musa.listPayments() }); } catch (e) { fail(res, e); }
});
router.get('/clienti', canRead, async (req, res) => {
  try { res.json({ clienti: await musa.listCustomers() }); } catch (e) { fail(res, e); }
});

router.post('/clienti', canEdit, async (req, res) => {
  try {
    const c = await musa.createCustomer(req.body || {});
    writeAudit({ utente_id: req.user.id, azione: 'musa.cliente.crea', entita_tipo: 'stripe_customer', entita_id: null, dettagli: { id: c.id } });
    res.json(c);
  } catch (e) { fail(res, e); }
});

router.post('/fatture', canEdit, async (req, res) => {
  try {
    const inv = await musa.createInvoice(req.body || {});
    writeAudit({ utente_id: req.user.id, azione: 'musa.fattura.crea', entita_tipo: 'stripe_invoice', entita_id: null, dettagli: { id: inv.id, inviata: !!(req.body || {}).invia } });
    res.json(inv);
  } catch (e) { fail(res, e); }
});

// Finalizza e invia una bozza di fattura (manda l'email al cliente).
router.post('/fatture/:id/invia', canEdit, async (req, res) => {
  try {
    const inv = await musa.finalizeAndSend(req.params.id);
    writeAudit({ utente_id: req.user.id, azione: 'musa.fattura.invia', entita_tipo: 'stripe_invoice', entita_id: null, dettagli: { id: req.params.id } });
    res.json(inv);
  } catch (e) { fail(res, e); }
});

// Segna pagata "fuori banda" (incasso avvenuto fuori da Stripe).
router.post('/fatture/:id/paga', canEdit, async (req, res) => {
  try {
    const inv = await musa.payInvoice(req.params.id);
    writeAudit({ utente_id: req.user.id, azione: 'musa.fattura.paga', entita_tipo: 'stripe_invoice', entita_id: null, dettagli: { id: req.params.id } });
    res.json(inv);
  } catch (e) { fail(res, e); }
});

router.post('/fatture/:id/annulla', canDelete, async (req, res) => {
  try {
    const inv = await musa.voidInvoice(req.params.id);
    writeAudit({ utente_id: req.user.id, azione: 'musa.fattura.annulla', entita_tipo: 'stripe_invoice', entita_id: null, dettagli: { id: req.params.id } });
    res.json(inv);
  } catch (e) { fail(res, e); }
});

router.post('/payment-link', canEdit, async (req, res) => {
  try {
    const link = await musa.createPaymentLink(req.body || {});
    writeAudit({ utente_id: req.user.id, azione: 'musa.payment-link.crea', entita_tipo: 'stripe_payment_link', entita_id: null, dettagli: { id: link.id } });
    res.json(link);
  } catch (e) { fail(res, e); }
});

// Rimborso (muove denaro): permesso delete + conferma lato UI.
router.post('/rimborsi', canDelete, async (req, res) => {
  try {
    const r = await musa.refund(req.body || {});
    writeAudit({ utente_id: req.user.id, azione: 'musa.rimborso', entita_tipo: 'stripe_refund', entita_id: null, dettagli: r });
    res.json(r);
  } catch (e) { fail(res, e); }
});

module.exports = router;
