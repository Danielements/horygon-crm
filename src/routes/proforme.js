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
    SELECT p.*, a.ragione_sociale AS fornitore_nome
    FROM proforme_invoice p
    LEFT JOIN anagrafiche a ON a.id = p.fornitore_id
    ORDER BY COALESCE(p.data, p.creato_il) DESC, p.id DESC
  `).all();
  res.json(rows);
});

router.get('/:id', requirePermesso('ordini', 'read'), (req, res) => {
  const row = db.prepare(`
    SELECT p.*, a.ragione_sociale AS fornitore_nome
    FROM proforme_invoice p
    LEFT JOIN anagrafiche a ON a.id = p.fornitore_id
    WHERE p.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Proforma non trovata' });
  row.righe = db.prepare(`SELECT * FROM proforme_righe WHERE proforma_id = ? ORDER BY id`).all(req.params.id);
  row.alert = db.prepare(`SELECT * FROM proforme_alert WHERE proforma_id = ? ORDER BY creato_il DESC`).all(req.params.id);
  res.json(row);
});

router.post('/', requirePermesso('ordini', 'edit'), (req, res) => {
  const b = req.body || {};
  try {
    const r = db.prepare(`
      INSERT INTO proforme_invoice (
        numero_proforma,data,fornitore_id,valuta,importo_merce,importo_trasporto,assicurazione,altri_costi,totale,
        acconto_richiesto,saldo_richiesto,scadenza_acconto,scadenza_saldo,incoterm,porto_partenza,porto_arrivo,
        metodo_spedizione,stato,pdf_path,excel_path,packing_list_path,ordine_cliente_id,ordine_fornitore_id,spedizione_id,note
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      s(b.numero_proforma), s(b.data), i(b.fornitore_id), s(b.valuta) || 'USD',
      n(b.importo_merce) || 0, n(b.importo_trasporto) || 0, n(b.assicurazione) || 0, n(b.altri_costi) || 0, n(b.totale) || 0,
      n(b.acconto_richiesto) || 0, n(b.saldo_richiesto) || 0, s(b.scadenza_acconto), s(b.scadenza_saldo), s(b.incoterm),
      s(b.porto_partenza), s(b.porto_arrivo), s(b.metodo_spedizione), s(b.stato) || 'ricevuta', s(b.pdf_path), s(b.excel_path),
      s(b.packing_list_path), i(b.ordine_cliente_id), i(b.ordine_fornitore_id), i(b.spedizione_id), s(b.note)
    );
    const id = r.lastInsertRowid;
    saveProformaRows(id, b.righe);
    createProformaAlerts(id, b);
    writeAudit({ utente_id: req.user.id, azione: 'proforma.create', entita_tipo: 'proforma', entita_id: id, dettagli: { numero: b.numero_proforma } });
    res.json({ id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/:id', requirePermesso('ordini', 'edit'), (req, res) => {
  const b = req.body || {};
  try {
    db.prepare(`
      UPDATE proforme_invoice SET
        numero_proforma=?,data=?,fornitore_id=?,valuta=?,importo_merce=?,importo_trasporto=?,assicurazione=?,altri_costi=?,totale=?,
        acconto_richiesto=?,saldo_richiesto=?,scadenza_acconto=?,scadenza_saldo=?,incoterm=?,porto_partenza=?,porto_arrivo=?,
        metodo_spedizione=?,stato=?,pdf_path=?,excel_path=?,packing_list_path=?,ordine_cliente_id=?,ordine_fornitore_id=?,spedizione_id=?,note=?
      WHERE id=?
    `).run(
      s(b.numero_proforma), s(b.data), i(b.fornitore_id), s(b.valuta) || 'USD',
      n(b.importo_merce) || 0, n(b.importo_trasporto) || 0, n(b.assicurazione) || 0, n(b.altri_costi) || 0, n(b.totale) || 0,
      n(b.acconto_richiesto) || 0, n(b.saldo_richiesto) || 0, s(b.scadenza_acconto), s(b.scadenza_saldo), s(b.incoterm),
      s(b.porto_partenza), s(b.porto_arrivo), s(b.metodo_spedizione), s(b.stato) || 'ricevuta', s(b.pdf_path), s(b.excel_path),
      s(b.packing_list_path), i(b.ordine_cliente_id), i(b.ordine_fornitore_id), i(b.spedizione_id), s(b.note), req.params.id
    );
    db.prepare('DELETE FROM proforme_righe WHERE proforma_id = ?').run(req.params.id);
    db.prepare('DELETE FROM proforme_alert WHERE proforma_id = ?').run(req.params.id);
    saveProformaRows(req.params.id, b.righe);
    createProformaAlerts(req.params.id, b);
    writeAudit({ utente_id: req.user.id, azione: 'proforma.update', entita_tipo: 'proforma', entita_id: req.params.id, dettagli: { numero: b.numero_proforma } });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/:id/stato', requirePermesso('ordini', 'edit'), (req, res) => {
  db.prepare('UPDATE proforme_invoice SET stato = ? WHERE id = ?').run(s(req.body.stato), req.params.id);
  writeAudit({ utente_id: req.user.id, azione: 'proforma.status', entita_tipo: 'proforma', entita_id: req.params.id, dettagli: { stato: req.body.stato } });
  res.json({ ok: true });
});

function saveProformaRows(proformaId, righe = []) {
  if (!Array.isArray(righe) || !righe.length) return;
  const ins = db.prepare(`
    INSERT INTO proforme_righe (proforma_id, prodotto_id, descrizione, quantita, prezzo_unitario, totale_riga)
    VALUES (?,?,?,?,?,?)
  `);
  righe.forEach(riga => ins.run(proformaId, i(riga.prodotto_id), s(riga.descrizione), n(riga.quantita), n(riga.prezzo_unitario), n(riga.totale_riga)));
}

function createProformaAlerts(proformaId, b) {
  const alerts = [];
  if (!b.pdf_path) alerts.push(['proforma_senza_pdf', 'Proforma senza PDF']);
  if (!b.incoterm) alerts.push(['incoterm_mancante', 'Incoterm mancante']);
  if (!b.packing_list_path) alerts.push(['packing_list_mancante', 'Packing list mancante']);
  if (!b.spedizione_id) alerts.push(['spedizione_mancante', 'Proforma non collegata a spedizione']);
  if (!b.ordine_cliente_id) alerts.push(['ordine_cliente_mancante', 'Proforma non collegata a ordine cliente']);
  const ins = db.prepare(`INSERT INTO proforme_alert (proforma_id, tipo, messaggio) VALUES (?,?,?)`);
  alerts.forEach(([tipo, messaggio]) => ins.run(proformaId, tipo, messaggio));
}

module.exports = router;
