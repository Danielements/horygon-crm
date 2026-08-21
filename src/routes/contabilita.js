const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const { writeAudit } = require('../services/audit');
const svc = require('../services/stamp-duty-service');
const cont = require('../services/contabilita-service');

router.use(authMiddleware);

// ===========================================================================
// Fase A — Fondamenta contabilita gestionale
// ===========================================================================

const canRead = requirePermesso('contabilita', 'read');
const canEdit = requirePermesso('contabilita', 'edit');
const canDelete = requirePermesso('contabilita', 'delete');

// --- Dashboard ------------------------------------------------------------
router.get('/dashboard', canRead, (req, res) => {
  try { res.json(cont.dashboard({ anno: req.query.anno })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Vista contabile fatture (riusa le fatture SdI, non le duplica) --------
router.get('/fatture', canRead, (req, res) => {
  try {
    res.json({ fatture: cont.listInvoicesContabile({
      direzione: req.query.direzione,
      tipo_documento: req.query.tipo_documento,
      stato_pagamento: req.query.stato_pagamento,
      dal: req.query.dal,
      al: req.query.al,
      limit: req.query.limit
    }) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/fatture/:id/dettaglio', canRead, (req, res) => {
  try {
    const id = Number(req.params.id);
    res.json({
      pagamenti: cont.listPaymentsForInvoice(id),
      classificazione: cont.getClassification('fattura', id),
      stato: cont.recomputeInvoicePaymentStatus(id)
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Pagamenti / incassi ---------------------------------------------------
router.post('/fatture/:id/pagamenti', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    const id = Number(req.params.id);
    const r = cont.registerPayment({
      verso: b.verso,
      data: b.data,
      importo: b.importo,
      metodo: b.metodo,
      anagrafica_id: b.anagrafica_id,
      note: b.note,
      allocazioni: [{ fattura_id: id, importo_quota: b.importo_quota != null ? b.importo_quota : b.importo }]
    }, req.user.id);
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.pagamento.registra', entita_tipo: 'fattura', entita_id: id, dettagli: { pagamento_id: r.id, importo: r.importo } });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/pagamenti', canEdit, (req, res) => {
  try {
    const r = cont.registerPayment(req.body || {}, req.user.id);
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.pagamento.registra', entita_tipo: 'pagamento', entita_id: r.id, dettagli: { importo: r.importo, verso: r.verso, allocazioni: r.allocazioni.length } });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/pagamenti/:id', canDelete, (req, res) => {
  try {
    const r = cont.deletePayment(Number(req.params.id));
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.pagamento.elimina', entita_tipo: 'pagamento', entita_id: Number(req.params.id), dettagli: r });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Classificazione (split categoria/centro/commessa) ---------------------
router.post('/classifica', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    if (!b.entita_tipo || !b.entita_id) throw new Error('entita_tipo ed entita_id obbligatori');
    const r = cont.saveClassification(b.entita_tipo, Number(b.entita_id), b.righe || b.rows || [], req.user.id);
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.classifica', entita_tipo: b.entita_tipo, entita_id: Number(b.entita_id), dettagli: { quote: r.length } });
    res.json({ classificazione: r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- CRUD categorie --------------------------------------------------------
router.get('/categorie', canRead, (req, res) => {
  try { res.json({ categorie: cont.listCategorie() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/categorie', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    if (!b.nome) throw new Error('Nome obbligatorio');
    const info = db.prepare(`INSERT INTO cont_categorie (nome, tipo, parent_id, colore, ordine, attiva)
      VALUES (?, ?, ?, ?, ?, ?)`).run(b.nome, b.tipo || 'COST', b.parent_id || null, b.colore || null, b.ordine || 0, b.attiva === 0 ? 0 : 1);
    res.json({ id: Number(info.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/categorie/:id', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    db.prepare(`UPDATE cont_categorie SET nome = COALESCE(?, nome), tipo = COALESCE(?, tipo),
      parent_id = ?, colore = ?, ordine = COALESCE(?, ordine), attiva = COALESCE(?, attiva) WHERE id = ?`)
      .run(b.nome ?? null, b.tipo ?? null, b.parent_id ?? null, b.colore ?? null, b.ordine ?? null, b.attiva ?? null, Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/categorie/:id', canDelete, (req, res) => {
  try {
    // Soft: disattiva, non cancella (le classificazioni storiche restano valide).
    db.prepare('UPDATE cont_categorie SET attiva = 0 WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- CRUD centri di costo --------------------------------------------------
router.get('/centri-costo', canRead, (req, res) => {
  try { res.json({ centri: cont.listCentri() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/centri-costo', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    if (!b.nome) throw new Error('Nome obbligatorio');
    const info = db.prepare(`INSERT INTO cont_centri_costo (nome, codice, parent_id, note, attivo)
      VALUES (?, ?, ?, ?, ?)`).run(b.nome, b.codice || null, b.parent_id || null, b.note || null, b.attivo === 0 ? 0 : 1);
    res.json({ id: Number(info.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/centri-costo/:id', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    db.prepare(`UPDATE cont_centri_costo SET nome = COALESCE(?, nome), codice = ?, parent_id = ?,
      note = ?, attivo = COALESCE(?, attivo) WHERE id = ?`)
      .run(b.nome ?? null, b.codice ?? null, b.parent_id ?? null, b.note ?? null, b.attivo ?? null, Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/centri-costo/:id', canDelete, (req, res) => {
  try {
    db.prepare('UPDATE cont_centri_costo SET attivo = 0 WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- CRUD commesse ---------------------------------------------------------
router.get('/commesse', canRead, (req, res) => {
  try { res.json({ commesse: cont.listCommesse() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/commesse', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    if (!b.nome) throw new Error('Nome obbligatorio');
    const info = db.prepare(`INSERT INTO cont_commesse
      (nome, codice, anagrafica_id, valore_previsto, budget, data_inizio, data_fine, stato, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(b.nome, b.codice || null, b.anagrafica_id || null,
        b.valore_previsto != null ? Number(b.valore_previsto) : null,
        b.budget != null ? Number(b.budget) : null,
        b.data_inizio || null, b.data_fine || null, b.stato || 'aperta', b.note || null);
    res.json({ id: Number(info.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/commesse/:id', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    db.prepare(`UPDATE cont_commesse SET nome = COALESCE(?, nome), codice = ?, anagrafica_id = ?,
      valore_previsto = ?, budget = ?, data_inizio = ?, data_fine = ?, stato = COALESCE(?, stato), note = ? WHERE id = ?`)
      .run(b.nome ?? null, b.codice ?? null, b.anagrafica_id ?? null,
        b.valore_previsto != null ? Number(b.valore_previsto) : null,
        b.budget != null ? Number(b.budget) : null,
        b.data_inizio ?? null, b.data_fine ?? null, b.stato ?? null, b.note ?? null, Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/commesse/:id', canDelete, (req, res) => {
  try {
    db.prepare("UPDATE cont_commesse SET stato = 'chiusa' WHERE id = ?").run(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ===========================================================================
// Bollo (Fase 3) — il bollo lavora sulle fatture: usa il permesso 'fatture'.
// ===========================================================================

// Ricalcola il bollo su tutte le fatture (popola le esistenti).
router.post('/bollo/ricalcola', requirePermesso('fatture', 'edit'), (req, res) => {
  try {
    const r = svc.recomputeAllInvoices({});
    writeAudit({ utente_id: req.user.id, azione: 'bollo.ricalcola', entita_tipo: 'fattura', entita_id: null, dettagli: r });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/bollo/dashboard', requirePermesso('fatture', 'read'), (req, res) => {
  try { res.json({ settlements: svc.getBolloDashboard({}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/bollo/settlement/:id/fatture', requirePermesso('fatture', 'read'), (req, res) => {
  try { res.json({ fatture: svc.settlementInvoices(Number(req.params.id)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Registra il pagamento del settlement trimestrale (un solo versamento, non 2 EUR
// a fattura). Handoff manuale: portale AdE / dati F24 / registrazione.
router.post('/bollo/settlement/:id/paga', requirePermesso('fatture', 'edit'), (req, res) => {
  const b = req.body || {};
  try {
    const s = svc.paySettlement(Number(req.params.id), {
      method: b.method || null,
      taxCode: b.taxCode || b.tax_code || null,
      paidAt: b.paidAt || b.paid_at || null,
      receiptPath: b.receiptPath || null,
      officialAmount: (b.officialAmount != null && b.officialAmount !== '') ? Number(b.officialAmount) : null,
      notes: b.notes || null
    });
    writeAudit({ utente_id: req.user.id, azione: 'bollo.settlement.paga', entita_tipo: 'stamp_duty_settlement', entita_id: Number(req.params.id), dettagli: { method: b.method, taxCode: b.taxCode } });
    res.json(s);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/bollo/settlement/:id/riconcilia', requirePermesso('fatture', 'edit'), (req, res) => {
  try {
    const s = svc.reconcileSettlement(Number(req.params.id));
    writeAudit({ utente_id: req.user.id, azione: 'bollo.settlement.riconcilia', entita_tipo: 'stamp_duty_settlement', entita_id: Number(req.params.id), dettagli: {} });
    res.json(s);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
