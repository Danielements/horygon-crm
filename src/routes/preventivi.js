const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');

const s = (v) => (v === undefined || v === '' || v === null) ? null : v;
const n = (v) => { const p = parseFloat(v); return Number.isFinite(p) ? p : null; };
const i = (v) => { const p = parseInt(v, 10); return Number.isFinite(p) ? p : null; };

router.use(authMiddleware);

router.get('/', requirePermesso('ordini', 'read'), (req, res) => {
  const { stato, anagrafica_id } = req.query;
  let sql = `
    SELECT p.*, a.ragione_sociale
    FROM preventivi p
    LEFT JOIN anagrafiche a ON a.id = p.anagrafica_id
    WHERE 1=1
  `;
  const params = [];
  if (stato) { sql += ' AND p.stato = ?'; params.push(stato); }
  if (anagrafica_id) { sql += ' AND p.anagrafica_id = ?'; params.push(anagrafica_id); }
  sql += ' ORDER BY COALESCE(p.data_preventivo, p.creato_il) DESC, p.id DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', requirePermesso('ordini', 'read'), (req, res) => {
  const row = db.prepare(`
    SELECT p.*, a.ragione_sociale
    FROM preventivi p
    LEFT JOIN anagrafiche a ON a.id = p.anagrafica_id
    WHERE p.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Preventivo non trovato' });
  row.righe = db.prepare(`
    SELECT r.*, pr.nome, pr.codice_interno
    FROM preventivi_righe r
    LEFT JOIN prodotti pr ON pr.id = r.prodotto_id
    WHERE r.preventivo_id = ?
    ORDER BY r.id
  `).all(req.params.id);
  res.json(row);
});

router.post('/', requirePermesso('ordini', 'edit'), (req, res) => {
  const b = req.body || {};
  try {
    const r = db.prepare(`
      INSERT INTO preventivi (codice_preventivo, anagrafica_id, stato, data_preventivo, data_scadenza, imponibile, iva, totale, valuta, note)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      s(b.codice_preventivo),
      i(b.anagrafica_id),
      s(b.stato) || 'bozza',
      s(b.data_preventivo),
      s(b.data_scadenza),
      n(b.imponibile),
      n(b.iva),
      n(b.totale),
      s(b.valuta) || 'EUR',
      s(b.note)
    );
    const id = r.lastInsertRowid;
    if (b.righe?.length) {
      const ins = db.prepare(`
        INSERT INTO preventivi_righe (preventivo_id, prodotto_id, descrizione, quantita, prezzo_unitario, sconto, imponibile, aliquota_iva, natura_iva, importo_iva, totale_riga)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `);
      b.righe.forEach(riga => {
        ins.run(
          id,
          i(riga.prodotto_id),
          s(riga.descrizione),
          n(riga.quantita),
          n(riga.prezzo_unitario),
          n(riga.sconto) || 0,
          n(riga.imponibile),
          n(riga.aliquota_iva),
          s(riga.natura_iva),
          n(riga.importo_iva),
          n(riga.totale_riga)
        );
      });
    }
    res.json({ id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', requirePermesso('ordini', 'edit'), (req, res) => {
  const b = req.body || {};
  try {
    db.prepare(`
      UPDATE preventivi
      SET codice_preventivo=?, anagrafica_id=?, stato=?, data_preventivo=?, data_scadenza=?, imponibile=?, iva=?, totale=?, valuta=?, note=?
      WHERE id=?
    `).run(
      s(b.codice_preventivo),
      i(b.anagrafica_id),
      s(b.stato) || 'bozza',
      s(b.data_preventivo),
      s(b.data_scadenza),
      n(b.imponibile),
      n(b.iva),
      n(b.totale),
      s(b.valuta) || 'EUR',
      s(b.note),
      req.params.id
    );
    db.prepare('DELETE FROM preventivi_righe WHERE preventivo_id = ?').run(req.params.id);
    if (b.righe?.length) {
      const ins = db.prepare(`
        INSERT INTO preventivi_righe (preventivo_id, prodotto_id, descrizione, quantita, prezzo_unitario, sconto, imponibile, aliquota_iva, natura_iva, importo_iva, totale_riga)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `);
      b.righe.forEach(riga => {
        ins.run(
          req.params.id,
          i(riga.prodotto_id),
          s(riga.descrizione),
          n(riga.quantita),
          n(riga.prezzo_unitario),
          n(riga.sconto) || 0,
          n(riga.imponibile),
          n(riga.aliquota_iva),
          s(riga.natura_iva),
          n(riga.importo_iva),
          n(riga.totale_riga)
        );
      });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/:id/stato', requirePermesso('ordini', 'edit'), (req, res) => {
  db.prepare('UPDATE preventivi SET stato = ? WHERE id = ?').run(s(req.body.stato), req.params.id);
  res.json({ ok: true });
});

module.exports = router;
