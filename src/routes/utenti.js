const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const QRCode = require('qrcode');
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const { sendMail } = require('../services/google');
const { writeAudit } = require('../services/audit');

router.use(authMiddleware);

try { db.exec(`ALTER TABLE utenti ADD COLUMN telefono TEXT`); } catch {}
try { db.exec(`ALTER TABLE utenti ADD COLUMN qualifica TEXT`); } catch {}
try { db.exec(`ALTER TABLE utenti ADD COLUMN reparto TEXT`); } catch {}
try { db.exec(`ALTER TABLE utenti ADD COLUMN linkedin TEXT`); } catch {}
try { db.exec(`ALTER TABLE utenti ADD COLUMN note_biglietto TEXT`); } catch {}

const s = (v) => (v === undefined || v === '' || v === null) ? null : v;

async function sendCredentialsEmail(senderUserId, user, plainPassword) {
  const loginUrl = process.env.APP_URL || 'https://crm.horygon.it';
  const subject = 'Credenziali di accesso Horygon CRM';
  const text = [
    `Ciao ${user.nome || ''},`,
    '',
    'ti abbiamo creato un accesso al CRM Horygon.',
    '',
    `URL: ${loginUrl}`,
    `Email: ${user.email}`,
    `Password temporanea: ${plainPassword}`,
    '',
    'Al primo accesso ti verra richiesto di cambiare subito la password.',
    '',
    'Questo messaggio e generato dalla piattaforma Horygon.'
  ].join('\n');
  await sendMail(senderUserId, user.email, subject, text);
}

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
    SELECT u.id, u.nome, u.email, u.ruolo_id, u.tema, u.attivo, u.force_password_change, u.credentials_sent_at, u.creato_il,
           u.telefono, u.qualifica, u.reparto, u.linkedin, u.note_biglietto,
           r.nome as ruolo_nome
    FROM utenti u LEFT JOIN ruoli r ON r.id = u.ruolo_id ORDER BY u.nome
  `).all();
  res.json(rows);
});

router.post('/', requirePermesso('utenti', 'admin'), async (req, res) => {
  const {
    nome, email, password, ruolo_id, tema, telefono, qualifica, reparto, linkedin, note_biglietto,
    send_credentials_email, force_password_change
  } = req.body;
  try {
    console.error('[utenti.create] start', { nome, email, ruolo_id: Number(ruolo_id || 1), send_credentials_email: !!send_credentials_email });
    if (req.user.ruolo_id !== 4 && Number(ruolo_id) === 4) {
      return res.status(403).json({ error: 'Solo un SuperAdmin può creare un altro SuperAdmin' });
    }
    if (!password) return res.status(400).json({ error: 'Password obbligatoria per nuovo utente' });
    const hash = await bcrypt.hash(password, 10);
    console.error('[utenti.create] hash-ok', { email });
    const r = db.prepare(
      'INSERT INTO utenti (nome, email, password_hash, ruolo_id, tema, telefono, qualifica, reparto, linkedin, note_biglietto, force_password_change) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).run(nome, email, hash, ruolo_id || 1, tema || 'dark', s(telefono), s(qualifica), s(reparto), s(linkedin), s(note_biglietto), force_password_change ? 1 : 0);
    const userId = Number(r.lastInsertRowid);
    console.error('[utenti.create] insert-ok', { userId, email });
    let email_sent = false;
    let email_error = null;
    if (send_credentials_email) {
      try {
        await sendCredentialsEmail(req.user.id, { nome, email }, password);
        db.prepare(`UPDATE utenti SET credentials_sent_at = datetime('now') WHERE id = ?`).run(userId);
        email_sent = true;
        console.error('[utenti.create] credentials-email-ok', { userId, email });
      } catch (err) {
        email_error = err.message;
        console.error('[utenti.create] credentials-email-fail', { userId, email, error: err.message });
      }
    }
    const responsePayload = { id: userId, email_sent: !!email_sent, email_error: email_error || null };
    console.error('[utenti.create] sending-response', responsePayload);
    res.status(201).type('application/json').send(JSON.stringify(responsePayload));
    setImmediate(() => {
      writeAudit({
        utente_id: req.user.id,
        azione: 'utente.create',
        entita_tipo: 'utente',
        entita_id: userId,
        dettagli: { nome, email, ruolo_id: Number(ruolo_id || 1), email_sent: !!email_sent, force_password_change: !!force_password_change }
      });
      console.error('[utenti.create] audit-ok', { userId });
    });
    return;
  } catch (e) {
    console.error('[utenti.create] catch', e);
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', requirePermesso('utenti', 'admin'), async (req, res) => {
  const {
    nome, email, password, ruolo_id, tema, attivo, telefono, qualifica, reparto, linkedin, note_biglietto,
    send_credentials_email, force_password_change
  } = req.body;
  const current = db.prepare('SELECT ruolo_id FROM utenti WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Utente non trovato' });
  if (req.user.ruolo_id !== 4 && (Number(ruolo_id) === 4 || Number(current.ruolo_id) === 4)) {
    return res.status(403).json({ error: 'Solo un SuperAdmin può modificare un SuperAdmin' });
  }
  if (send_credentials_email && !password) {
    return res.status(400).json({ error: 'Per inviare nuove credenziali devi impostare una password temporanea' });
  }
  if (password) {
    const hash = await bcrypt.hash(password, 10);
    db.prepare('UPDATE utenti SET nome=?,email=?,password_hash=?,ruolo_id=?,tema=?,attivo=?,telefono=?,qualifica=?,reparto=?,linkedin=?,note_biglietto=?,force_password_change=? WHERE id=?')
      .run(nome, email, hash, ruolo_id, tema, attivo, s(telefono), s(qualifica), s(reparto), s(linkedin), s(note_biglietto), force_password_change ? 1 : 0, req.params.id);
  } else {
    db.prepare('UPDATE utenti SET nome=?,email=?,ruolo_id=?,tema=?,attivo=?,telefono=?,qualifica=?,reparto=?,linkedin=?,note_biglietto=?,force_password_change=? WHERE id=?')
      .run(nome, email, ruolo_id, tema, attivo, s(telefono), s(qualifica), s(reparto), s(linkedin), s(note_biglietto), force_password_change ? 1 : 0, req.params.id);
  }
  let email_sent = false;
  let email_error = null;
  if (send_credentials_email) {
    try {
      await sendCredentialsEmail(req.user.id, { nome, email }, password);
      db.prepare(`UPDATE utenti SET credentials_sent_at = datetime('now') WHERE id = ?`).run(req.params.id);
      email_sent = true;
    } catch (err) {
      email_error = err.message;
    }
  }
  writeAudit({
    utente_id: req.user.id,
    azione: 'utente.update',
    entita_tipo: 'utente',
    entita_id: req.params.id,
    dettagli: { nome, email, ruolo_id, attivo, email_sent, force_password_change: !!force_password_change }
  });
  res.json({ ok: true, email_sent, email_error });
});

router.delete('/:id', requirePermesso('utenti', 'admin'), (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Non puoi eliminare te stesso' });
  const current = db.prepare('SELECT ruolo_id FROM utenti WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Utente non trovato' });
  if (req.user.ruolo_id !== 4 && Number(current.ruolo_id) === 4) {
    return res.status(403).json({ error: 'Solo un SuperAdmin può disabilitare un SuperAdmin' });
  }
  db.prepare('UPDATE utenti SET attivo = 0 WHERE id = ?').run(req.params.id);
  writeAudit({ utente_id: req.user.id, azione: 'utente.disable', entita_tipo: 'utente', entita_id: req.params.id });
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
  writeAudit({ utente_id: req.user.id, azione: 'permessi.update', entita_tipo: 'ruolo', entita_id: req.params.ruolo_id, dettagli: { count: permessi.length } });
  res.json({ ok: true });
});

module.exports = router;
