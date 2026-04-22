const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/', requirePermesso('utenti', 'read'), (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.nome, u.email, u.ruolo_id, u.tema, u.attivo, u.creato_il, r.nome as ruolo_nome
    FROM utenti u LEFT JOIN ruoli r ON r.id = u.ruolo_id ORDER BY u.nome
  `).all();
  res.json(rows);
});

router.post('/', requirePermesso('utenti', 'admin'), async (req, res) => {
  const { nome, email, password, ruolo_id, tema } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = db.prepare(
      'INSERT INTO utenti (nome, email, password_hash, ruolo_id, tema) VALUES (?,?,?,?,?)'
    ).run(nome, email, hash, ruolo_id || 1, tema || 'dark');
    res.json({ id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/:id', requirePermesso('utenti', 'admin'), async (req, res) => {
  const { nome, email, password, ruolo_id, tema, attivo } = req.body;
  if (password) {
    const hash = await bcrypt.hash(password, 10);
    db.prepare('UPDATE utenti SET nome=?,email=?,password_hash=?,ruolo_id=?,tema=?,attivo=? WHERE id=?')
      .run(nome, email, hash, ruolo_id, tema, attivo, req.params.id);
  } else {
    db.prepare('UPDATE utenti SET nome=?,email=?,ruolo_id=?,tema=?,attivo=? WHERE id=?')
      .run(nome, email, ruolo_id, tema, attivo, req.params.id);
  }
  res.json({ ok: true });
});

router.delete('/:id', requirePermesso('utenti', 'admin'), (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Non puoi eliminare te stesso' });
  db.prepare('UPDATE utenti SET attivo = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/ruoli', requirePermesso('utenti', 'read'), (req, res) => {
  res.json(db.prepare('SELECT * FROM ruoli').all());
});

router.get('/permessi/:ruolo_id', requirePermesso('utenti', 'read'), (req, res) => {
  res.json(db.prepare('SELECT * FROM permessi WHERE ruolo_id = ?').all(req.params.ruolo_id));
});

router.put('/permessi/:ruolo_id', requirePermesso('utenti', 'admin'), (req, res) => {
  const { permessi } = req.body;
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO permessi (ruolo_id, sezione, can_read, can_edit, can_delete, can_admin)
    VALUES (?,?,?,?,?,?)
  `);
  permessi.forEach(p => upsert.run(req.params.ruolo_id, p.sezione, p.can_read, p.can_edit, p.can_delete, p.can_admin));
  res.json({ ok: true });
});

module.exports = router;
