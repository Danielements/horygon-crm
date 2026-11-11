const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const db = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const { writeAudit } = require('../services/audit');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'openid', 'email', 'profile'
];

function getCalendarOwnerEmail() {
  return process.env.GOOGLE_CALENDAR_OWNER_EMAIL || 'info@horygon.com';
}

function makeToken(user) {
  return jwt.sign(
    { id: user.id, nome: user.nome, ruolo_id: user.ruolo_id, tema: user.tema },
    process.env.SESSION_SECRET,
    { expiresIn: '7d' }
  );
}

function hasAnyUser() {
  return (db.prepare('SELECT COUNT(*) as n FROM utenti').get()?.n || 0) > 0;
}

function looksLikeBcryptHash(value = '') {
  return /^\$2[aby]\$\d{2}\$/.test(String(value || ''));
}

function ensureUtentiAuthColumns() {
  try { db.exec(`ALTER TABLE utenti ADD COLUMN force_password_change INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE utenti ADD COLUMN password_changed_il TEXT`); } catch {}
  try { db.exec(`ALTER TABLE utenti ADD COLUMN credentials_sent_at TEXT`); } catch {}
}

ensureUtentiAuthColumns();

router.post('/setup', async (req, res) => {
  if (hasAnyUser()) return res.status(403).json({ error: 'Setup già completato' });
  const { nome, email, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  const r = db.prepare(
    'INSERT INTO utenti (nome, email, password_hash, ruolo_id, tema) VALUES (?,?,?,4,?)'
  ).run(nome, email, hash, 'dark');
  writeAudit({ utente_id: r.lastInsertRowid, azione: 'auth.setup', entita_tipo: 'utente', entita_id: r.lastInsertRowid, dettagli: { email } });
  res.json({ id: r.lastInsertRowid });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM utenti WHERE email = ? AND attivo = 1').get(email);
  if (!user) return res.status(401).json({ error: 'Credenziali non valide' });
  let ok = false;
  if (looksLikeBcryptHash(user.password_hash)) {
    ok = await bcrypt.compare(password, user.password_hash);
  } else {
    ok = String(password || '') === String(user.password_hash || '');
    if (ok) {
      const newHash = await bcrypt.hash(password, 10);
      db.prepare('UPDATE utenti SET password_hash = ? WHERE id = ?').run(newHash, user.id);
    }
  }
  if (!ok) return res.status(401).json({ error: 'Credenziali non valide' });
  writeAudit({ utente_id: user.id, azione: 'auth.login', entita_tipo: 'utente', entita_id: user.id, dettagli: { email: user.email } });
  res.json({
    token: makeToken(user),
    user: {
      id: user.id,
      nome: user.nome,
      email: user.email,
      ruolo_id: user.ruolo_id,
      tema: user.tema,
      force_password_change: !!user.force_password_change
    }
  });
});

router.post('/tema', authMiddleware, (req, res) => {
  const { tema } = req.body;
  db.prepare('UPDATE utenti SET tema = ? WHERE id = ?').run(tema, req.user.id);
  const user = db.prepare('SELECT * FROM utenti WHERE id = ?').get(req.user.id);
  res.json({ token: makeToken(user) });
});

router.post('/change-password', authMiddleware, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!new_password || String(new_password).length < 8) {
    return res.status(400).json({ error: 'La nuova password deve avere almeno 8 caratteri' });
  }
  const user = db.prepare('SELECT * FROM utenti WHERE id = ? AND attivo = 1').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Utente non trovato' });
  if (!user.force_password_change) {
    const ok = await bcrypt.compare(String(current_password || ''), user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Password attuale non valida' });
  }
  const hash = await bcrypt.hash(new_password, 10);
  db.prepare(`
    UPDATE utenti
    SET password_hash = ?, force_password_change = 0, password_changed_il = datetime('now')
    WHERE id = ?
  `).run(hash, req.user.id);
  writeAudit({ utente_id: req.user.id, azione: 'auth.password.change', entita_tipo: 'utente', entita_id: req.user.id });
  res.json({ ok: true });
});

router.get('/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  res.redirect(url);
});

router.get('/google/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    let user = db.prepare('SELECT * FROM utenti WHERE email = ?').get(data.email);
    if (!user) {
      const isFirstUser = !hasAnyUser();
      const hash = await bcrypt.hash(Math.random().toString(36), 10);
      const r = db.prepare(
        'INSERT INTO utenti (nome, email, password_hash, ruolo_id) VALUES (?,?,?,?)'
      ).run(data.name, data.email, hash, isFirstUser ? 4 : 2);
      user = db.prepare('SELECT * FROM utenti WHERE id = ?').get(r.lastInsertRowid);
      writeAudit({ utente_id: user.id, azione: 'auth.google.autocreate', entita_tipo: 'utente', entita_id: user.id, dettagli: { email: data.email } });
    }
    db.prepare(`INSERT OR REPLACE INTO google_tokens (utente_id, access_token, refresh_token, scadenza, scope)
      VALUES (?,?,?,?,?)`).run(
      user.id, tokens.access_token, tokens.refresh_token,
      tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      SCOPES.join(' ')
    );
    writeAudit({ utente_id: user.id, azione: 'auth.google.connect', entita_tipo: 'utente', entita_id: user.id, dettagli: { email: user.email } });
    const token = makeToken(user);
    res.redirect(`/?token=${token}`);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id,nome,email,ruolo_id,tema,force_password_change FROM utenti WHERE id = ?').get(req.user.id);
  if (!user) return res.status(401).json({ error: 'Utente non trovato o non piu attivo' });
  const permessi = db.prepare('SELECT * FROM permessi WHERE ruolo_id = ?').all(user.ruolo_id);
  const ownGoogle = !!db.prepare('SELECT id FROM google_tokens WHERE utente_id = ?').get(user.id);
  const ownerGoogle = !!db.prepare(`
    SELECT gt.id
    FROM google_tokens gt
    JOIN utenti u ON u.id = gt.utente_id
    WHERE LOWER(u.email) = LOWER(?)
    LIMIT 1
  `).get(getCalendarOwnerEmail());
  const hasGoogle = ownGoogle || ownerGoogle;
  res.json({ ...user, force_password_change: !!user.force_password_change, permessi, hasGoogle });
});

module.exports = router;
