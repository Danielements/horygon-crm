const express = require('express');
const router = express.Router();
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const { writeAudit } = require('../services/audit');
const svc = require('../services/stamp-duty-service');

router.use(authMiddleware);

// Il bollo lavora sulle fatture: uso il permesso 'fatture'. Quando esistera' la
// sezione 'contabilita' a se', il permesso si sposta la'.

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
