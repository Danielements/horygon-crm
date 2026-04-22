const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const db = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

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
  'openid', 'email', 'profile'
];

function makeToken(user) {
  return jwt.sign(
    { id: user.id, nome: user.nome, ruolo_id: user.ruolo_id, tema: user.tema },
    process.env.SESSION_SECRET,
    { expiresIn: '7d' }
  );
}

// Setup primo admin
router.post('/setup', async (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as n FROM utenti').get();
  if (count.n > 0) return res.status(403).json({ error: 'Setup già completato' });
  const { nome, email, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  const r = db.prepare(
    'INSERT INTO utenti (nome, email, password_hash, ruolo_id, tema) VALUES (?,?,?,4,?)'
  ).run(nome, email, hash, 'dark');
  res.json({ id: r.lastInsertRowid });
});

// Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM utenti WHERE email = ? AND attivo = 1').get(email);
  if (!user) return res.status(401).json({ error: 'Credenziali non valide' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Credenziali non valide' });
  res.json({ token: makeToken(user), user: { id: user.id, nome: user.nome, email: user.email, ruolo_id: user.ruolo_id, tema: user.tema } });
});

// Aggiorna tema
router.post('/tema', authMiddleware, (req, res) => {
  const { tema } = req.body;
  db.prepare('UPDATE utenti SET tema = ? WHERE id = ?').run(tema, req.user.id);
  const user = db.prepare('SELECT * FROM utenti WHERE id = ?').get(req.user.id);
  res.json({ token: makeToken(user) });
});

// Google OAuth
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
      const hash = await bcrypt.hash(Math.random().toString(36), 10);
      const r = db.prepare(
        'INSERT INTO utenti (nome, email, password_hash, ruolo_id) VALUES (?,?,?,2)'
      ).run(data.name, data.email, hash);
      user = db.prepare('SELECT * FROM utenti WHERE id = ?').get(r.lastInsertRowid);
    }
    db.prepare(`INSERT OR REPLACE INTO google_tokens (utente_id, access_token, refresh_token, scadenza, scope)
      VALUES (?,?,?,?,?)`).run(
      user.id, tokens.access_token, tokens.refresh_token,
      tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      SCOPES.join(' ')
    );
    const token = makeToken(user);
    res.redirect(`/?token=${token}`);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Info utente corrente + permessi
router.get('/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id,nome,email,ruolo_id,tema FROM utenti WHERE id = ?').get(req.user.id);
  const permessi = db.prepare('SELECT * FROM permessi WHERE ruolo_id = ?').all(user.ruolo_id);
  const hasGoogle = !!db.prepare('SELECT id FROM google_tokens WHERE utente_id = ?').get(user.id);
  res.json({ ...user, permessi, hasGoogle });
});

module.exports = router;
