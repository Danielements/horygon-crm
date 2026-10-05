// Modulo MUSA (societa' separata) — gestione Stripe: pagamenti, fatture,
// clienti, payment link, rimborsi. Sezione/permesso 'musa' (admin/superadmin).
// Il webhook Stripe e' in musa-webhook.js (body raw, nessuna auth).

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const google = require('../services/google');
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const { writeAudit } = require('../services/audit');
const stripe = require('../services/stripe-client');
const musa = require('../services/musa-service');
const editori = require('../services/musa-editori-service');
const abb = require('../services/musa-abbonamenti-service');

router.use(authMiddleware);

const canRead = requirePermesso('musa', 'read');
const canEdit = requirePermesso('musa', 'edit');
const canDelete = requirePermesso('musa', 'delete');

function fail(res, e) {
  try { require('../services/system-log').writeSystemLog('error', 'musa-stripe', e.message, {}); } catch {}
  res.status(400).json({ error: e.message });
}

// Destinatario delle notifiche: MUSA_NOTIFY_EMAIL o, in mancanza, l'email
// dell'utente che ha lanciato il sync.
function recipientEmail(req) {
  if (process.env.MUSA_NOTIFY_EMAIL) return process.env.MUSA_NOTIFY_EMAIL;
  try { const u = db.prepare('SELECT email FROM utenti WHERE id = ?').get(req.user.id); return u && u.email ? u.email : null; } catch { return null; }
}

// Email di riepilogo dei cambiamenti rilevati nel sync (via Gmail del mittente).
async function notificaEventi(req, r) {
  try {
    if (!r || !r.eventi || !r.eventi.length) return;
    const to = recipientEmail(req);
    if (!to) return;
    const righe = r.eventi.map(e => `• [${e.tipo}] ${e.editore_nome}${e.dettaglio ? ': ' + e.dettaglio : ''}`).join('\n');
    const subject = `MUSA — ${r.eventi.length} novità sugli abbonamenti editori`;
    const text = `Sincronizzazione editori MUSA (${new Date().toLocaleString('it-IT')}).\n\nCambiamenti rilevati:\n${righe}\n\nAvvisi: ${(r.warnings || []).length}${(r.warnings || []).length ? '\n- ' + r.warnings.join('\n- ') : ''}`;
    await google.sendMailToRecipients(req.user.id, [to], subject, text);
  } catch (e) {
    try { require('../services/system-log').writeSystemLog('warn', 'musa-notifica', e.message, {}); } catch {}
  }
}

// Stato configurazione (il frontend mostra il modulo solo se abilitato).
router.get('/stato', canRead, (req, res) => {
  res.json({ configurato: stripe.isConfigured(), abilitato: stripe.isEnabled(), mode: stripe.mode(), iva_configurata: !!process.env.MUSA_STRIPE_TAX_RATE_ID, portale_configurato: abb.portaleConfigurato() });
});

// Crea una volta l'aliquota IVA 22% (esclusiva) su Stripe e restituisce l'id da
// mettere in MUSA_STRIPE_TAX_RATE_ID nel .env. Niente di distruttivo.
router.post('/iva/setup', canEdit, async (req, res) => {
  try {
    const perc = (req.body && req.body.percentuale) || 22;
    const rate = await stripe.createTaxRate({ display_name: `IVA ${perc}%`, description: `IVA ${perc}%`, percentage: perc, inclusive: false, country: 'IT' });
    writeAudit({ utente_id: req.user.id, azione: 'musa.iva.setup', entita_tipo: 'stripe_tax_rate', entita_id: null, dettagli: { id: rate.id, perc } });
    res.json({ id: rate.id, percentuale: perc, istruzioni: `Metti nel .env: MUSA_STRIPE_TAX_RATE_ID=${rate.id} e riavvia.` });
  } catch (e) { fail(res, e); }
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

// ===========================================================================
// ABBONAMENTI MUSA — fasce a consumo, ISBN dal portale, calcolo trimestrale
// ===========================================================================

// --- Fasce (modificabili) --------------------------------------------------
router.get('/abbonamenti/fasce', canRead, (req, res) => {
  try { res.json({ fasce: abb.listFasce() }); } catch (e) { fail(res, e); }
});
router.post('/abbonamenti/fasce', canEdit, (req, res) => {
  try {
    const r = abb.createFascia(req.body || {});
    writeAudit({ utente_id: req.user.id, azione: 'musa.fascia.crea', entita_tipo: 'musa_fascia', entita_id: r.id, dettagli: {} });
    res.json(r);
  } catch (e) { fail(res, e); }
});
router.put('/abbonamenti/fasce/:id', canEdit, (req, res) => {
  try { res.json(abb.updateFascia(Number(req.params.id), req.body || {})); } catch (e) { fail(res, e); }
});
router.delete('/abbonamenti/fasce/:id', canDelete, (req, res) => {
  try { res.json(abb.deleteFascia(Number(req.params.id))); } catch (e) { fail(res, e); }
});

// --- ISBN dell'editore (ingestione dal portale MUSA o manuale) -------------
router.get('/editori/:id/isbn', canRead, (req, res) => {
  try { res.json({ isbn: abb.loadIsbn(Number(req.params.id)) }); } catch (e) { fail(res, e); }
});

// Upsert ISBN: accetta un singolo record o un array (push del portale).
// Body: { isbn:"...", inserito_il, rimosso_il, approvato, approvato_il } oppure
// { records: [ {...}, ... ] }.
router.post('/editori/:id/isbn', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    const records = Array.isArray(b.records) ? b.records : (b.isbn ? [b] : []);
    if (!records.length) throw new Error('Nessun ISBN da salvare');
    let n = 0;
    for (const rec of records) { abb.upsertIsbn(Number(req.params.id), rec); n++; }
    writeAudit({ utente_id: req.user.id, azione: 'musa.isbn.upsert', entita_tipo: 'musa_editore', entita_id: Number(req.params.id), dettagli: { conteggio: n, fonte: b.fonte || 'manuale' } });
    res.json({ salvati: n });
  } catch (e) { fail(res, e); }
});

// Sync da payload incollato: ingoia { generato_il, editori:[...] }.
router.post('/portale/sync', canEdit, async (req, res) => {
  try {
    const r = abb.syncPortale(req.body || {});
    writeAudit({ utente_id: req.user.id, azione: 'musa.portale.sync', entita_tipo: 'musa', entita_id: null, dettagli: { editori: r.editori, warnings: r.warnings.length, eventi: r.eventi.length } });
    await notificaEventi(req, r);
    res.json(r);
  } catch (e) { fail(res, e); }
});

// Pull server-side: scarica dal portale MUSA (URL+chiave in ENV) e sincronizza.
router.post('/portale/pull', canEdit, async (req, res) => {
  try {
    const r = await abb.pullDalPortale();
    writeAudit({ utente_id: req.user.id, azione: 'musa.portale.pull', entita_tipo: 'musa', entita_id: null, dettagli: { editori: r.editori, warnings: r.warnings.length, eventi: r.eventi.length } });
    await notificaEventi(req, r);
    res.json(r);
  } catch (e) { fail(res, e); }
});

// Registro eventi di governance (cosa e' cambiato, piu' recenti prima).
router.get('/abbonamenti/eventi', canRead, (req, res) => {
  try { res.json({ eventi: abb.listEventi(Number(req.query.limit) || 100) }); } catch (e) { fail(res, e); }
});

// Calcolo (senza fatturare) del trimestre per un editore.
router.get('/editori/:id/trimestre', canRead, (req, res) => {
  try {
    const anno = Number(req.query.anno) || new Date().getFullYear();
    const trimestre = Number(req.query.trimestre) || (Math.floor(new Date().getMonth() / 3) + 1);
    res.json(abb.calcolaTrimestre(Number(req.params.id), anno, trimestre));
  } catch (e) { fail(res, e); }
});

module.exports = router;
