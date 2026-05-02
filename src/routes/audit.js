const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/', requirePermesso('utenti', 'read'), (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10), 1), 1000);
    const where = [];
    const params = [];

    if (req.query.utente_id) {
      where.push('a.utente_id = ?');
      params.push(Number(req.query.utente_id));
    }
    if (req.query.azione) {
      where.push('LOWER(a.azione) LIKE ?');
      params.push(`%${String(req.query.azione).toLowerCase()}%`);
    }
    if (req.query.entita_tipo) {
      where.push('LOWER(COALESCE(a.entita_tipo, \'\')) LIKE ?');
      params.push(`%${String(req.query.entita_tipo).toLowerCase()}%`);
    }
    if (req.query.date_from) {
      where.push('datetime(a.creato_il) >= datetime(?)');
      params.push(String(req.query.date_from));
    }
    if (req.query.date_to) {
      where.push('datetime(a.creato_il) <= datetime(?)');
      params.push(String(req.query.date_to) + ' 23:59:59');
    }
    if (req.query.q) {
      const q = `%${String(req.query.q).toLowerCase()}%`;
      where.push(`(
        LOWER(COALESCE(a.azione, '')) LIKE ?
        OR LOWER(COALESCE(a.entita_tipo, '')) LIKE ?
        OR LOWER(COALESCE(a.dettagli, '')) LIKE ?
        OR LOWER(COALESCE(u.nome, '')) LIKE ?
        OR LOWER(COALESCE(u.email, '')) LIKE ?
      )`);
      params.push(q, q, q, q, q);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT
        a.id,
        a.utente_id,
        a.azione,
        a.entita_tipo,
        a.entita_id,
        a.dettagli,
        a.creato_il,
        u.nome AS utente_nome,
        u.email AS utente_email
      FROM audit_log a
      LEFT JOIN utenti u ON u.id = a.utente_id
      ${whereSql}
      ORDER BY datetime(a.creato_il) DESC, a.id DESC
      LIMIT ?
    `).all(...params, limit);

    const stats = db.prepare(`
      SELECT
        COUNT(*) AS totale,
        COUNT(DISTINCT a.utente_id) AS utenti_coinvolti,
        COUNT(DISTINCT a.azione) AS azioni_distinte,
        COUNT(DISTINCT COALESCE(a.entita_tipo, '')) AS entita_distinte
      FROM audit_log a
      LEFT JOIN utenti u ON u.id = a.utente_id
      ${whereSql}
    `).get(...params);

    res.json({ rows, stats, limit });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
