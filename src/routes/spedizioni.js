const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const { writeAudit } = require('../services/audit');

const s = (v) => (v === undefined || v === null || v === '' ? null : v);
const n = (v) => { const p = parseFloat(v); return Number.isFinite(p) ? p : null; };
const i = (v) => { const p = parseInt(v, 10); return Number.isFinite(p) ? p : null; };

router.use(authMiddleware);

router.get('/', requirePermesso('ordini', 'read'), (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, f.ragione_sociale AS fornitore_nome, c.ragione_sociale AS cliente_nome
    FROM spedizioni s
    LEFT JOIN anagrafiche f ON f.id = s.fornitore_id
    LEFT JOIN anagrafiche c ON c.id = s.cliente_id
    ORDER BY COALESCE(s.etd, s.creato_il) DESC, s.id DESC
  `).all();
  res.json(rows.map(row => ({ ...row, alert: buildShipmentAlerts(row) })));
});

router.get('/:id', requirePermesso('ordini', 'read'), (req, res) => {
  const row = db.prepare(`
    SELECT s.*, f.ragione_sociale AS fornitore_nome, c.ragione_sociale AS cliente_nome
    FROM spedizioni s
    LEFT JOIN anagrafiche f ON f.id = s.fornitore_id
    LEFT JOIN anagrafiche c ON c.id = s.cliente_id
    WHERE s.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Spedizione non trovata' });
  row.documenti = db.prepare('SELECT * FROM spedizioni_documenti WHERE spedizione_id = ? ORDER BY creato_il DESC').all(req.params.id);
  row.costi = db.prepare('SELECT * FROM spedizioni_costi WHERE spedizione_id = ? ORDER BY id').all(req.params.id);
  row.alert = buildShipmentAlerts(row);
  res.json(row);
});

router.post('/', requirePermesso('ordini', 'edit'), (req, res) => {
  const b = req.body || {};
  try {
    const r = db.prepare(`
      INSERT INTO spedizioni (
        codice_spedizione, fornitore_id, cliente_id, ordine_cliente_id, ordine_fornitore_id, proforma_id, fattura_id,
        metodo_spedizione, incoterm, forwarder, referente_forwarder, partenza, arrivo, etd, eta, data_ritiro_merce,
        data_partenza_effettiva, data_arrivo_effettiva, tracking_number, container_number, seal_number, numero_bl_awb,
        numero_colli, peso_lordo, peso_netto, volume_cbm, valore_merce, valuta, assicurazione, stato_spedizione,
        landed_cost, margine_previsto, margine_reale, note
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      s(b.codice_spedizione), i(b.fornitore_id), i(b.cliente_id), i(b.ordine_cliente_id), i(b.ordine_fornitore_id), i(b.proforma_id), i(b.fattura_id),
      s(b.metodo_spedizione), s(b.incoterm), s(b.forwarder), s(b.referente_forwarder), s(b.partenza), s(b.arrivo), s(b.etd), s(b.eta), s(b.data_ritiro_merce),
      s(b.data_partenza_effettiva), s(b.data_arrivo_effettiva), s(b.tracking_number), s(b.container_number), s(b.seal_number), s(b.numero_bl_awb),
      i(b.numero_colli), n(b.peso_lordo), n(b.peso_netto), n(b.volume_cbm), n(b.valore_merce) || 0, s(b.valuta) || 'USD', n(b.assicurazione) || 0,
      s(b.stato_spedizione) || 'in_preparazione', calculateLandedCost(b.costi), n(b.margine_previsto) || 0, n(b.margine_reale) || 0, s(b.note)
    );
    const id = r.lastInsertRowid;
    saveShipmentDocs(id, b.documenti);
    saveShipmentCosts(id, b.costi);
    writeAudit({ utente_id: req.user.id, azione: 'spedizione.create', entita_tipo: 'spedizione', entita_id: id, dettagli: { codice: b.codice_spedizione } });
    res.json({ id, landed_cost: calculateLandedCost(b.costi) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/:id', requirePermesso('ordini', 'edit'), (req, res) => {
  const b = req.body || {};
  try {
    db.prepare(`
      UPDATE spedizioni SET
        codice_spedizione=?, fornitore_id=?, cliente_id=?, ordine_cliente_id=?, ordine_fornitore_id=?, proforma_id=?, fattura_id=?,
        metodo_spedizione=?, incoterm=?, forwarder=?, referente_forwarder=?, partenza=?, arrivo=?, etd=?, eta=?, data_ritiro_merce=?,
        data_partenza_effettiva=?, data_arrivo_effettiva=?, tracking_number=?, container_number=?, seal_number=?, numero_bl_awb=?,
        numero_colli=?, peso_lordo=?, peso_netto=?, volume_cbm=?, valore_merce=?, valuta=?, assicurazione=?, stato_spedizione=?,
        landed_cost=?, margine_previsto=?, margine_reale=?, note=?
      WHERE id=?
    `).run(
      s(b.codice_spedizione), i(b.fornitore_id), i(b.cliente_id), i(b.ordine_cliente_id), i(b.ordine_fornitore_id), i(b.proforma_id), i(b.fattura_id),
      s(b.metodo_spedizione), s(b.incoterm), s(b.forwarder), s(b.referente_forwarder), s(b.partenza), s(b.arrivo), s(b.etd), s(b.eta), s(b.data_ritiro_merce),
      s(b.data_partenza_effettiva), s(b.data_arrivo_effettiva), s(b.tracking_number), s(b.container_number), s(b.seal_number), s(b.numero_bl_awb),
      i(b.numero_colli), n(b.peso_lordo), n(b.peso_netto), n(b.volume_cbm), n(b.valore_merce) || 0, s(b.valuta) || 'USD', n(b.assicurazione) || 0,
      s(b.stato_spedizione) || 'in_preparazione', calculateLandedCost(b.costi), n(b.margine_previsto) || 0, n(b.margine_reale) || 0, s(b.note), req.params.id
    );
    db.prepare('DELETE FROM spedizioni_documenti WHERE spedizione_id = ?').run(req.params.id);
    db.prepare('DELETE FROM spedizioni_costi WHERE spedizione_id = ?').run(req.params.id);
    saveShipmentDocs(req.params.id, b.documenti);
    saveShipmentCosts(req.params.id, b.costi);
    writeAudit({ utente_id: req.user.id, azione: 'spedizione.update', entita_tipo: 'spedizione', entita_id: req.params.id, dettagli: { codice: b.codice_spedizione } });
    res.json({ ok: true, landed_cost: calculateLandedCost(b.costi) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/:id/stato', requirePermesso('ordini', 'edit'), (req, res) => {
  db.prepare('UPDATE spedizioni SET stato_spedizione = ? WHERE id = ?').run(s(req.body.stato_spedizione || req.body.stato), req.params.id);
  writeAudit({ utente_id: req.user.id, azione: 'spedizione.status', entita_tipo: 'spedizione', entita_id: req.params.id, dettagli: { stato: req.body.stato_spedizione || req.body.stato } });
  res.json({ ok: true });
});

function saveShipmentDocs(spedizioneId, documenti = []) {
  if (!Array.isArray(documenti) || !documenti.length) return;
  const ins = db.prepare('INSERT INTO spedizioni_documenti (spedizione_id, tipo, nome_file, path, note) VALUES (?,?,?,?,?)');
  documenti.forEach(doc => ins.run(spedizioneId, s(doc.tipo), s(doc.nome_file), s(doc.path), s(doc.note)));
}

function saveShipmentCosts(spedizioneId, costi = []) {
  if (!Array.isArray(costi) || !costi.length) return;
  const ins = db.prepare('INSERT INTO spedizioni_costi (spedizione_id, tipo, importo, valuta, note) VALUES (?,?,?,?,?)');
  costi.forEach(costo => ins.run(spedizioneId, s(costo.tipo), n(costo.importo) || 0, s(costo.valuta) || 'EUR', s(costo.note)));
}

function calculateLandedCost(costi = []) {
  if (!Array.isArray(costi)) return 0;
  return costi.reduce((sum, costo) => sum + (parseFloat(costo.importo || 0) || 0), 0);
}

function buildShipmentAlerts(row) {
  const alerts = [];
  const eta = row.eta ? new Date(row.eta) : null;
  if (eta && eta < new Date() && !['consegnata', 'chiusa'].includes(String(row.stato_spedizione || '').toLowerCase())) alerts.push('ETA superata');
  if (!row.tracking_number) alerts.push('Tracking mancante');
  if (!row.container_number && String(row.metodo_spedizione || '').toLowerCase().includes('mare')) alerts.push('Container mancante');
  if (String(row.stato_spedizione || '').toLowerCase() === 'in_dogana') alerts.push('Spedizione ferma in dogana');
  return alerts;
}

module.exports = router;
