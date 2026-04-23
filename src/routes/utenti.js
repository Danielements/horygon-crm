const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const QRCode = require('qrcode');
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');

router.use(authMiddleware);

try { db.exec(`ALTER TABLE utenti ADD COLUMN telefono TEXT`); } catch {}
try { db.exec(`ALTER TABLE utenti ADD COLUMN qualifica TEXT`); } catch {}
try { db.exec(`ALTER TABLE utenti ADD COLUMN reparto TEXT`); } catch {}
try { db.exec(`ALTER TABLE utenti ADD COLUMN linkedin TEXT`); } catch {}
try { db.exec(`ALTER TABLE utenti ADD COLUMN note_biglietto TEXT`); } catch {}

const s = (v) => (v === undefined || v === '' || v === null) ? null : v;

function buildVCard(u) {
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${u.nome || ''}`,
    `ORG:Horygon${u.reparto ? ';' + u.reparto : ''}`,
    u.qualifica ? `TITLE:${u.qualifica}` : '',
    u.telefono ? `TEL;TYPE=CELL:${u.telefono}` : '',
    u.email ? `EMAIL:${u.email}` : '',
    u.linkedin ? `URL:${u.linkedin}` : '',
    u.note_biglietto ? `NOTE:${u.note_biglietto}` : '',
    'END:VCARD',
  ].filter(Boolean).join('\n');
}

router.get('/', requirePermesso('utenti', 'read'), (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.nome, u.email, u.ruolo_id, u.tema, u.attivo, u.creato_il,
           u.telefono, u.qualifica, u.reparto, u.linkedin, u.note_biglietto,
           r.nome as ruolo_nome
    FROM utenti u LEFT JOIN ruoli r ON r.id = u.ruolo_id ORDER BY u.nome
  `).all();
  res.json(rows);
});

router.post('/', requirePermesso('utenti', 'admin'), async (req, res) => {
  const { nome, email, password, ruolo_id, tema, telefono, qualifica, reparto, linkedin, note_biglietto } = req.body;
  try {
    if (req.user.ruolo_id !== 4 && Number(ruolo_id) === 4) {
      return res.status(403).json({ error: 'Solo un SuperAdmin può creare un altro SuperAdmin' });
    }
    if (!password) return res.status(400).json({ error: 'Password obbligatoria per nuovo utente' });
    const hash = await bcrypt.hash(password, 10);
    const r = db.prepare(
      'INSERT INTO utenti (nome, email, password_hash, ruolo_id, tema, telefono, qualifica, reparto, linkedin, note_biglietto) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(nome, email, hash, ruolo_id || 1, tema || 'dark', s(telefono), s(qualifica), s(reparto), s(linkedin), s(note_biglietto));
    res.json({ id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/:id', requirePermesso('utenti', 'admin'), async (req, res) => {
  const { nome, email, password, ruolo_id, tema, attivo, telefono, qualifica, reparto, linkedin, note_biglietto } = req.body;
  const current = db.prepare('SELECT ruolo_id FROM utenti WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Utente non trovato' });
  if (req.user.ruolo_id !== 4 && (Number(ruolo_id) === 4 || Number(current.ruolo_id) === 4)) {
    return res.status(403).json({ error: 'Solo un SuperAdmin può modificare un SuperAdmin' });
  }
  if (password) {
    const hash = await bcrypt.hash(password, 10);
    db.prepare('UPDATE utenti SET nome=?,email=?,password_hash=?,ruolo_id=?,tema=?,attivo=?,telefono=?,qualifica=?,reparto=?,linkedin=?,note_biglietto=? WHERE id=?')
      .run(nome, email, hash, ruolo_id, tema, attivo, s(telefono), s(qualifica), s(reparto), s(linkedin), s(note_biglietto), req.params.id);
  } else {
    db.prepare('UPDATE utenti SET nome=?,email=?,ruolo_id=?,tema=?,attivo=?,telefono=?,qualifica=?,reparto=?,linkedin=?,note_biglietto=? WHERE id=?')
      .run(nome, email, ruolo_id, tema, attivo, s(telefono), s(qualifica), s(reparto), s(linkedin), s(note_biglietto), req.params.id);
  }
  res.json({ ok: true });
});

router.delete('/:id', requirePermesso('utenti', 'admin'), (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Non puoi eliminare te stesso' });
  const current = db.prepare('SELECT ruolo_id FROM utenti WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Utente non trovato' });
  if (req.user.ruolo_id !== 4 && Number(current.ruolo_id) === 4) {
    return res.status(403).json({ error: 'Solo un SuperAdmin può disabilitare un SuperAdmin' });
  }
  db.prepare('UPDATE utenti SET attivo = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/ruoli', requirePermesso('utenti', 'read'), (req, res) => {
  res.json(db.prepare('SELECT * FROM ruoli').all());
});

router.get('/:id/biglietto', requirePermesso('utenti', 'read'), async (req, res) => {
  const u = db.prepare(`SELECT u.id, u.nome, u.email, u.telefono, u.qualifica, u.reparto,
      u.linkedin, u.note_biglietto, r.nome as ruolo_nome
    FROM utenti u LEFT JOIN ruoli r ON r.id = u.ruolo_id WHERE u.id = ?`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Utente non trovato' });
  const vcard = buildVCard(u);
  const qr = await QRCode.toDataURL(vcard);
  res.json({ ...u, azienda: 'Horygon', vcard, qr });
});

router.get('/permessi/:ruolo_id', requirePermesso('utenti', 'read'), (req, res) => {
  res.json(db.prepare('SELECT * FROM permessi WHERE ruolo_id = ?').all(req.params.ruolo_id));
});

router.put('/permessi/:ruolo_id', requirePermesso('utenti', 'admin'), (req, res) => {
  if (req.user.ruolo_id !== 4 && Number(req.params.ruolo_id) === 4) {
    return res.status(403).json({ error: 'Solo un SuperAdmin può modificare i permessi del SuperAdmin' });
  }
  const { permessi } = req.body;
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO permessi (ruolo_id, sezione, can_read, can_edit, can_delete, can_admin)
    VALUES (?,?,?,?,?,?)
  `);
  permessi.forEach(p => upsert.run(req.params.ruolo_id, p.sezione, p.can_read, p.can_edit, p.can_delete, p.can_admin));
  res.json({ ok: true });
});

module.exports = router;
