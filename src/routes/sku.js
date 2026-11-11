const express = require('express');
const router = express.Router();
const db = require('../db/database');

// Lista tutti gli SKU
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM sku ORDER BY categoria, nome').all();
  res.json(rows);
});

// Singolo SKU
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM sku WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'SKU non trovato' });
  res.json(row);
});

// Crea SKU
router.post('/', (req, res) => {
  const { codice, nome, cpv, prezzo_mepa, costo_landed, categoria, note } = req.body;
  try {
    const result = db.prepare(`
      INSERT INTO sku (codice, nome, cpv, prezzo_mepa, costo_landed, categoria, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(codice, nome, cpv, prezzo_mepa, costo_landed, categoria, note);
    res.json({ id: result.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Aggiorna SKU
router.put('/:id', (req, res) => {
  const { codice, nome, cpv, prezzo_mepa, costo_landed, categoria, note, attivo } = req.body;
  db.prepare(`
    UPDATE sku SET codice=?, nome=?, cpv=?, prezzo_mepa=?, costo_landed=?, categoria=?, note=?, attivo=?
    WHERE id=?
  `).run(codice, nome, cpv, prezzo_mepa, costo_landed, categoria, note, attivo, req.params.id);
  res.json({ ok: true });
});

// Elimina SKU
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM sku WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;