// Modulo MUSA (societa' separata) — gestione Stripe: pagamenti, fatture,
// clienti, payment link, rimborsi. Sezione/permesso 'musa' (admin/superadmin).
// Il webhook Stripe e' in musa-webhook.js (body raw, nessuna auth).

const express = require('express');
const router = express.Router();
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const { writeAudit } = require('../services/audit');
const stripe = require('../services/stripe-client');
const musa = require('../services/musa-service');
const editori = require('../services/musa-editori-service');

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

router.get('/prodotti', canRead, async (req, res) => {
  try { res.json({ prodotti: await musa.listProdotti() }); } catch (e) { fail(res, e); }
});
router.post('/prodotti', canEdit, async (req, res) => {
  try {
    const p = await musa.createProdotto(req.body || {});
    writeAudit({ utente_id: req.user.id, azione: 'musa.prodotto.crea', entita_tipo: 'stripe_product', entita_id: null, dettagli: { id: p.id } });
    res.json(p);
  } catch (e) { fail(res, e); }
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

// ===========================================================================
// EDITORI MUSA — tariffe a scaglioni, conteggi mensili, storico
// ===========================================================================

// --- Tariffe (modificabili) ------------------------------------------------
router.get('/tariffe', canRead, (req, res) => {
  try { res.json({ tariffe: editori.listTariffe() }); } catch (e) { fail(res, e); }
});
router.post('/tariffe', canEdit, (req, res) => {
  try {
    const r = editori.createTariffa(req.body || {});
    writeAudit({ utente_id: req.user.id, azione: 'musa.tariffa.crea', entita_tipo: 'musa_tariffa', entita_id: r.id, dettagli: {} });
    res.json(r);
  } catch (e) { fail(res, e); }
});
router.put('/tariffe/:id', canEdit, (req, res) => {
  try { res.json(editori.updateTariffa(Number(req.params.id), req.body || {})); } catch (e) { fail(res, e); }
});
router.delete('/tariffe/:id', canDelete, (req, res) => {
  try { res.json(editori.deleteTariffa(Number(req.params.id))); } catch (e) { fail(res, e); }
});

// --- Editori ---------------------------------------------------------------
router.get('/editori', canRead, (req, res) => {
  try { res.json({ editori: editori.listEditori() }); } catch (e) { fail(res, e); }
});
router.post('/editori', canEdit, (req, res) => {
  try {
    const r = editori.createEditore(req.body || {});
    writeAudit({ utente_id: req.user.id, azione: 'musa.editore.crea', entita_tipo: 'musa_editore', entita_id: r.id, dettagli: {} });
    res.json(r);
  } catch (e) { fail(res, e); }
});
router.put('/editori/:id', canEdit, (req, res) => {
  try { res.json(editori.updateEditore(Number(req.params.id), req.body || {})); } catch (e) { fail(res, e); }
});
router.get('/editori/:id/storico', canRead, (req, res) => {
  try { res.json({ storico: editori.storicoEditore(Number(req.params.id)) }); } catch (e) { fail(res, e); }
});

// --- Conteggi mensili ------------------------------------------------------
// Vista di un mese con tutti gli editori attivi (anche a zero).
router.get('/editori-conteggi', canRead, (req, res) => {
  try {
    const periodo = req.query.periodo || new Date().toISOString().slice(0, 7);
    res.json({ periodo, righe: editori.vistaMensile(periodo) });
  } catch (e) { fail(res, e); }
});

// Upsert conteggio (UI manuale o push dal portale MUSA).
router.post('/editori-conteggi', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    const r = editori.upsertConteggio({ editore_id: b.editore_id, periodo: b.periodo, caricati: b.caricati, approvati: b.approvati, fonte: b.fonte });
    writeAudit({ utente_id: req.user.id, azione: 'musa.conteggio.upsert', entita_tipo: 'musa_editore', entita_id: Number(b.editore_id), dettagli: { periodo: b.periodo, approvati: b.approvati } });
    res.json(r);
  } catch (e) { fail(res, e); }
});

// Hook fatturazione: crea la fattura Stripe per un conteggio (editore+mese).
router.post('/editori-conteggi/:id/fattura', canEdit, async (req, res) => {
  try {
    const inv = await editori.fatturaConteggio(Number(req.params.id), { invia: !!(req.body || {}).invia });
    writeAudit({ utente_id: req.user.id, azione: 'musa.conteggio.fattura', entita_tipo: 'musa_conteggio', entita_id: Number(req.params.id), dettagli: { invoice: inv.id } });
    res.json(inv);
  } catch (e) { fail(res, e); }
});

module.exports = router;
