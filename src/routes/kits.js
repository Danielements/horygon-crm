const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');

const s = (v) => (v === undefined || v === '' || v === null) ? null : v;
const n = (v) => {
  const parsed = parseFloat(v);
  return Number.isFinite(parsed) ? parsed : null;
};
const i = (v) => {
  const parsed = parseInt(v, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

function getGiacenza(prodottoId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE
      WHEN tipo = 'carico' THEN quantita
      WHEN tipo IN ('scarico', 'reso') THEN -quantita
      WHEN tipo = 'rettifica' THEN quantita
      ELSE 0
    END), 0) AS giacenza
    FROM magazzino_movimenti
    WHERE prodotto_id = ?
  `).get(prodottoId);
  return Number(row?.giacenza || 0);
}

function normalizeComponenti(righe = []) {
  return (righe || [])
    .map((riga, index) => ({
      prodotto_id: i(riga.prodotto_id),
      quantita: n(riga.quantita),
      ordine: i(riga.ordine) ?? index,
      note: s(riga.note)
    }))
    .filter((riga) => riga.prodotto_id && riga.quantita && riga.quantita > 0);
}

function loadKitComponenti(kitId) {
  const componenti = db.prepare(`
    SELECT kc.*, p.codice_interno, p.nome, p.descrizione AS prodotto_descrizione, p.unita_misura,
      c.nome AS categoria_nome,
      (
        SELECT pl.prezzo
        FROM prodotti_listini pl
        WHERE pl.prodotto_id = p.id
        ORDER BY CASE pl.canale WHEN 'diretto' THEN 0 WHEN 'entrambi' THEN 1 ELSE 2 END, pl.id DESC
        LIMIT 1
      ) AS prezzo_predefinito
    FROM kit_componenti kc
    JOIN prodotti p ON p.id = kc.prodotto_id
    LEFT JOIN categorie c ON c.id = p.categoria_id
    WHERE kc.kit_id = ?
    ORDER BY kc.ordine ASC, kc.id ASC
  `).all(kitId);
  return componenti.map((componente) => {
    const giacenza = getGiacenza(componente.prodotto_id);
    const quantitaRichiesta = Number(componente.quantita || 0);
    const producibili = quantitaRichiesta > 0 ? Math.floor(giacenza / quantitaRichiesta) : 0;
    return {
      ...componente,
      giacenza,
      producibili
    };
  });
}

function enrichKit(row) {
  const componenti = loadKitComponenti(row.id);
  const disponibilita = componenti.length
    ? componenti.reduce((min, componente) => Math.min(min, componente.producibili), Number.POSITIVE_INFINITY)
    : 0;
  const prezzo_calcolato = componenti.reduce((sum, componente) => {
    const prezzo = Number(componente.prezzo_predefinito || 0);
    const quantita = Number(componente.quantita || 0);
    return sum + (prezzo * quantita);
  }, 0);
  return {
    ...row,
    componenti,
    componenti_count: componenti.length,
    componenti_totale: componenti.reduce((sum, componente) => sum + Number(componente.quantita || 0), 0),
    disponibilita_kit: Number.isFinite(disponibilita) ? disponibilita : 0,
    prezzo_vendita: prezzo_calcolato,
    prezzo_calcolato
  };
}

router.use(authMiddleware);

router.get('/', requirePermesso('prodotti', 'read'), (req, res) => {
  const q = (req.query.q || '').trim();
  let sql = `
    SELECT k.*, c.nome AS categoria_nome
    FROM kit k
    LEFT JOIN categorie c ON c.id = k.categoria_id
    WHERE k.attivo = 1
  `;
  const params = [];
  if (q) {
    sql += ` AND (
      k.codice_kit LIKE ?
      OR k.nome LIKE ?
      OR IFNULL(k.descrizione, '') LIKE ?
      OR IFNULL(k.note, '') LIKE ?
    )`;
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY k.nome COLLATE NOCASE, k.id DESC';
  const rows = db.prepare(sql).all(...params).map(enrichKit);
  res.json(rows);
});

router.get('/:id', requirePermesso('prodotti', 'read'), (req, res) => {
  const row = db.prepare(`
    SELECT k.*, c.nome AS categoria_nome
    FROM kit k
    LEFT JOIN categorie c ON c.id = k.categoria_id
    WHERE k.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Kit non trovato' });
  res.json(enrichKit(row));
});

router.post('/', requirePermesso('prodotti', 'edit'), (req, res) => {
  const body = req.body || {};
  const componenti = normalizeComponenti(body.componenti);
  try {
    db.exec('BEGIN');
    const result = db.prepare(`
      INSERT INTO kit (codice_kit, nome, descrizione, categoria_id, prezzo_vendita, attivo, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      s(body.codice_kit),
      s(body.nome),
      s(body.descrizione),
      i(body.categoria_id),
      0,
      body.attivo === undefined ? 1 : (i(body.attivo) ?? 1),
      s(body.note)
    );
    const kitId = Number(result.lastInsertRowid);
    if (componenti.length) {
      const insertComponente = db.prepare(`
        INSERT INTO kit_componenti (kit_id, prodotto_id, quantita, ordine, note)
        VALUES (?, ?, ?, ?, ?)
      `);
      componenti.forEach((componente, index) => {
        insertComponente.run(kitId, componente.prodotto_id, componente.quantita, componente.ordine ?? index, componente.note);
      });
    }
    db.exec('COMMIT');
    res.json({ id: kitId });
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    res.status(400).json({ error: error.message });
  }
});

router.put('/:id', requirePermesso('prodotti', 'edit'), (req, res) => {
  const body = req.body || {};
  const componenti = normalizeComponenti(body.componenti);
  const kitId = Number(req.params.id);
  const existing = db.prepare('SELECT id FROM kit WHERE id = ?').get(kitId);
  if (!existing) return res.status(404).json({ error: 'Kit non trovato' });
  try {
    db.exec('BEGIN');
    db.prepare(`
      UPDATE kit
      SET codice_kit = ?, nome = ?, descrizione = ?, categoria_id = ?, prezzo_vendita = ?, attivo = ?, note = ?
      WHERE id = ?
    `).run(
      s(body.codice_kit),
      s(body.nome),
      s(body.descrizione),
      i(body.categoria_id),
      0,
      body.attivo === undefined ? 1 : (i(body.attivo) ?? 1),
      s(body.note),
      kitId
    );
    db.prepare('DELETE FROM kit_componenti WHERE kit_id = ?').run(kitId);
    if (componenti.length) {
      const insertComponente = db.prepare(`
        INSERT INTO kit_componenti (kit_id, prodotto_id, quantita, ordine, note)
        VALUES (?, ?, ?, ?, ?)
      `);
      componenti.forEach((componente, index) => {
        insertComponente.run(kitId, componente.prodotto_id, componente.quantita, componente.ordine ?? index, componente.note);
      });
    }
    db.exec('COMMIT');
    res.json({ ok: true, id: kitId });
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    res.status(400).json({ error: error.message });
  }
});

router.delete('/:id', requirePermesso('prodotti', 'delete'), (req, res) => {
  const kitId = Number(req.params.id);
  const row = db.prepare('SELECT id FROM kit WHERE id = ?').get(kitId);
  if (!row) return res.status(404).json({ error: 'Kit non trovato' });
  db.prepare('UPDATE kit SET attivo = 0 WHERE id = ?').run(kitId);
  res.json({ ok: true });
});

module.exports = router;
