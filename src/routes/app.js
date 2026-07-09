'use strict';

// Endpoint per l'app mobile (APK). Client sottile: auth clienti separata dagli
// operatori CRM, chat ricambi (riusa il motore esistente via processAppChatMessage),
// profilo con P.IVA/dati di fatturazione (anagrafica collegata), preventivi.

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/database');
const { processAppChatMessage } = require('./parts');
const { createPreventivoPdfBuffer } = require('../services/document-pdf');

const router = express.Router();

function s(v) { return v === undefined || v === null || v === '' ? null : String(v).trim(); }
function jwtSecret() { return process.env.SESSION_SECRET || 'horygon_dev_secret'; }

function signAppToken(customer) {
  return jwt.sign({ customerId: customer.id, scope: 'app', email: customer.email }, jwtSecret(), { expiresIn: '30d' });
}

// Middleware: verifica JWT app e carica il cliente.
function appAuth(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Non autenticato' });
  let payload;
  try { payload = jwt.verify(token, jwtSecret()); } catch { return res.status(401).json({ error: 'Token non valido' }); }
  if (payload.scope !== 'app' || !payload.customerId) return res.status(401).json({ error: 'Token non valido per l\'app' });
  const customer = db.prepare('SELECT * FROM app_clienti WHERE id = ? AND attivo = 1 LIMIT 1').get(payload.customerId);
  if (!customer) return res.status(401).json({ error: 'Account non trovato' });
  req.appCustomer = customer;
  next();
}

// --- AUTH ---
router.post('/auth/register', async (req, res) => {
  const email = s(req.body?.email);
  const password = s(req.body?.password);
  if (!email || !password) return res.status(400).json({ error: 'email e password obbligatorie' });
  if (String(password).length < 6) return res.status(400).json({ error: 'La password deve avere almeno 6 caratteri' });
  const existing = db.prepare('SELECT id FROM app_clienti WHERE email = ? LIMIT 1').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Email gia registrata' });

  const hash = await bcrypt.hash(password, 10);
  // Crea un'anagrafica cliente collegata (dati fatturazione compilabili dopo).
  const anaIns = db.prepare(`
    INSERT INTO anagrafiche (tipo, ragione_sociale, email, telefono, attivo)
    VALUES ('cliente', ?, ?, ?, 1)
  `).run(s(req.body?.ragione_sociale) || email, email.toLowerCase(), s(req.body?.telefono));
  const anagraficaId = Number(anaIns.lastInsertRowid);
  const custIns = db.prepare(`
    INSERT INTO app_clienti (email, password_hash, anagrafica_id, telefono, ultimo_accesso)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(email.toLowerCase(), hash, anagraficaId, s(req.body?.telefono));
  const customer = db.prepare('SELECT * FROM app_clienti WHERE id = ?').get(Number(custIns.lastInsertRowid));
  return res.json({ token: signAppToken(customer), customer: { id: customer.id, email: customer.email } });
});

router.post('/auth/login', async (req, res) => {
  const email = s(req.body?.email);
  const password = s(req.body?.password);
  if (!email || !password) return res.status(400).json({ error: 'email e password obbligatorie' });
  const customer = db.prepare('SELECT * FROM app_clienti WHERE email = ? AND attivo = 1 LIMIT 1').get(email.toLowerCase());
  if (!customer) return res.status(401).json({ error: 'Credenziali non valide' });
  const ok = await bcrypt.compare(password, customer.password_hash);
  if (!ok) return res.status(401).json({ error: 'Credenziali non valide' });
  db.prepare('UPDATE app_clienti SET ultimo_accesso = datetime(\'now\') WHERE id = ?').run(customer.id);
  return res.json({ token: signAppToken(customer), customer: { id: customer.id, email: customer.email } });
});

// --- PROFILO (anagrafica con P.IVA / dati fatturazione) ---
const PROFILE_FIELDS = ['ragione_sociale', 'piva', 'cf', 'indirizzo', 'cap', 'citta', 'provincia', 'paese', 'email', 'pec', 'telefono', 'sito_web', 'codice_sdi'];

router.get('/profile', appAuth, (req, res) => {
  const anagraficaId = req.appCustomer.anagrafica_id;
  const ana = anagraficaId ? db.prepare('SELECT * FROM anagrafiche WHERE id = ? LIMIT 1').get(anagraficaId) : null;
  const out = {};
  PROFILE_FIELDS.forEach((f) => { out[f] = ana ? (ana[f] || '') : ''; });
  return res.json({ email: req.appCustomer.email, profile: out });
});

router.put('/profile', appAuth, (req, res) => {
  const anagraficaId = req.appCustomer.anagrafica_id;
  if (!anagraficaId) return res.status(400).json({ error: 'Anagrafica non collegata' });
  const body = req.body || {};
  const sets = [];
  const vals = [];
  PROFILE_FIELDS.forEach((f) => {
    if (Object.prototype.hasOwnProperty.call(body, f)) { sets.push(`${f} = ?`); vals.push(s(body[f])); }
  });
  if (!sets.length) return res.status(400).json({ error: 'Nessun campo da aggiornare' });
  vals.push(anagraficaId);
  db.prepare(`UPDATE anagrafiche SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  const ana = db.prepare('SELECT * FROM anagrafiche WHERE id = ? LIMIT 1').get(anagraficaId);
  const out = {};
  PROFILE_FIELDS.forEach((f) => { out[f] = ana ? (ana[f] || '') : ''; });
  return res.json({ profile: out });
});

// --- CHAT ricambi ---
router.post('/chat', appAuth, async (req, res) => {
  try {
    const userKey = `app:${req.appCustomer.id}`;
    const text = s(req.body?.text);
    const imageBase64 = s(req.body?.imageBase64);
    if (!text && !imageBase64) return res.status(400).json({ error: 'text o imageBase64 obbligatorio' });

    const result = await processAppChatMessage({ userKey, text: text || '', imageBase64: imageBase64 || null });

    // Collega richieste/preventivi del cliente alla sua anagrafica (per la fatturazione).
    const anagraficaId = req.appCustomer.anagrafica_id;
    if (anagraficaId) {
      try {
        db.prepare('UPDATE parts_requests SET customer_id = ? WHERE user_phone = ? AND (customer_id IS NULL)').run(anagraficaId, userKey);
        db.prepare(`
          UPDATE preventivi SET anagrafica_id = ?
          WHERE anagrafica_id IS NULL AND id IN (SELECT linked_preventivo_id FROM parts_requests WHERE user_phone = ? AND linked_preventivo_id IS NOT NULL)
        `).run(anagraficaId, userKey);
      } catch (e) { /* non bloccare la chat */ }
    }

    return res.json({ reply: result.reply, options: result.options, quoteGenerated: !!result.quoteGenerated });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Errore chat' });
  }
});

// --- PREVENTIVI del cliente ---
function customerQuotesQuery(userKey) {
  return db.prepare(`
    SELECT DISTINCT p.id, p.codice_preventivo, p.data_preventivo, p.imponibile, p.iva, p.totale, p.stato, p.public_token,
      (SELECT COUNT(*) FROM preventivi_righe r WHERE r.preventivo_id = p.id) AS num_righe
    FROM preventivi p
    JOIN parts_requests pr ON pr.linked_preventivo_id = p.id
    WHERE pr.user_phone = ?
    ORDER BY p.id DESC
  `).all(userKey);
}

router.get('/quotes', appAuth, (req, res) => {
  const rows = customerQuotesQuery(`app:${req.appCustomer.id}`);
  return res.json({ quotes: rows.map((r) => ({
    id: r.id, codice: r.codice_preventivo, data: r.data_preventivo,
    imponibile: r.imponibile, iva: r.iva, totale: r.totale, stato: r.stato, numRighe: r.num_righe
  })) });
});

router.get('/quotes/:id', appAuth, (req, res) => {
  const userKey = `app:${req.appCustomer.id}`;
  const id = parseInt(req.params.id, 10);
  const owns = db.prepare('SELECT 1 FROM parts_requests WHERE user_phone = ? AND linked_preventivo_id = ? LIMIT 1').get(userKey, id);
  if (!owns) return res.status(404).json({ error: 'Preventivo non trovato' });
  const p = db.prepare('SELECT id, codice_preventivo, data_preventivo, imponibile, iva, totale, stato FROM preventivi WHERE id = ?').get(id);
  const righe = db.prepare('SELECT descrizione, quantita, prezzo_unitario, totale_riga FROM preventivi_righe WHERE preventivo_id = ? ORDER BY id').all(id);
  return res.json({ quote: { ...p, codice: p.codice_preventivo, righe } });
});

router.get('/quotes/:id/pdf', appAuth, async (req, res) => {
  const userKey = `app:${req.appCustomer.id}`;
  const id = parseInt(req.params.id, 10);
  const owns = db.prepare('SELECT 1 FROM parts_requests WHERE user_phone = ? AND linked_preventivo_id = ? LIMIT 1').get(userKey, id);
  if (!owns) return res.status(404).json({ error: 'Preventivo non trovato' });
  try {
    const pdf = await createPreventivoPdfBuffer(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${pdf.filename || 'preventivo.pdf'}"`);
    return res.send(pdf.buffer);
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Errore generazione PDF' });
  }
});

module.exports = router;
