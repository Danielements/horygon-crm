const { google } = require('googleapis');
const db = require('../db/database');
const { writeSystemLog } = require('./system-log');

db.exec(`
  CREATE TABLE IF NOT EXISTS mepa_mail_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    utente_id INTEGER NOT NULL,
    gmail_message_id TEXT NOT NULL UNIQUE,
    mittente TEXT,
    oggetto TEXT,
    categoria TEXT,
    gara_id TEXT,
    nome_gara TEXT,
    ente TEXT,
    data_pubblicazione TEXT,
    scadenza_offerte TEXT,
    termine_chiarimenti TEXT,
    corpo TEXT,
    letto INTEGER DEFAULT 0,
    creato_il TEXT DEFAULT (datetime('now'))
  );
`);
try { db.exec(`ALTER TABLE mepa_mail_alerts ADD COLUMN stato TEXT DEFAULT 'nuova'`); } catch {}
try { db.exec(`ALTER TABLE mepa_mail_alerts ADD COLUMN sync_attiva INTEGER DEFAULT 1`); } catch {}
try { db.exec(`ALTER TABLE mepa_mail_alerts ADD COLUMN google_event_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE mepa_mail_alerts ADD COLUMN attivita_id INTEGER`); } catch {}
try { db.exec(`ALTER TABLE mepa_mail_alerts ADD COLUMN anagrafica_id INTEGER`); } catch {}
try { db.exec(`ALTER TABLE mepa_mail_alerts ADD COLUMN attivita_disattivata INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE mepa_mail_alerts ADD COLUMN notificata_3g INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE mepa_mail_alerts ADD COLUMN notificata_1g INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE mepa_mail_alerts ADD COLUMN eliminata_il TEXT`); } catch {}
try { db.exec(`ALTER TABLE anagrafiche ADD COLUMN tipologia_cliente TEXT DEFAULT 'privato'`); } catch {}
try { db.exec(`ALTER TABLE anagrafiche ADD COLUMN pa_mepa INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE anagrafiche ADD COLUMN pa_sda INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE anagrafiche ADD COLUMN pa_rdo INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE anagrafiche ADD COLUMN canale_cliente TEXT DEFAULT 'privato'`); } catch {}
try { db.exec(`ALTER TABLE notifiche_app ADD COLUMN pinned INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE notifiche_app ADD COLUMN eliminata INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE notifiche_app ADD COLUMN livello_urgenza TEXT DEFAULT 'media'`); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS notifiche_app (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    utente_id INTEGER NOT NULL,
    tipo TEXT,
    titolo TEXT NOT NULL,
    messaggio TEXT,
    livello_urgenza TEXT DEFAULT 'media',
    entita_tipo TEXT,
    entita_id INTEGER,
    unique_key TEXT UNIQUE,
    letta INTEGER DEFAULT 0,
    invio_email_tentato INTEGER DEFAULT 0,
    invio_email_ok INTEGER DEFAULT 0,
    creato_il TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (utente_id) REFERENCES utenti(id)
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    type TEXT DEFAULT 'string',
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

const seedSetting = db.prepare(`
  INSERT OR IGNORE INTO app_settings (key, value, type, updated_at)
  VALUES (?, ?, ?, datetime('now'))
`);
seedSetting.run('notifications.email_enabled', '0', 'boolean');
seedSetting.run('notifications.deadline_days', '3,1', 'string');
seedSetting.run('notifications.recipient_mode', 'all_active_users', 'string');
seedSetting.run('company.notification_sender_name', 'Horygon CRM', 'string');
seedSetting.run('automation.email_users_activity_assignments', '1', 'boolean');
seedSetting.run('automation.email_users_activity_updates', '1', 'boolean');
seedSetting.run('automation.email_users_order_status', '1', 'boolean');
seedSetting.run('automation.email_clients_order_status', '0', 'boolean');
seedSetting.run('automation.email_clients_activity_updates', '0', 'boolean');

function getClient(utente_id) {
  const tokens = db.prepare('SELECT * FROM google_tokens WHERE utente_id = ?').get(utente_id);
  if (!tokens) return null;
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  client.setCredentials({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
  // Auto-refresh token
  client.on('tokens', (newTokens) => {
    if (newTokens.access_token) {
      db.prepare('UPDATE google_tokens SET access_token=?, scadenza=? WHERE utente_id=?')
        .run(newTokens.access_token, newTokens.expiry_date ? new Date(newTokens.expiry_date).toISOString() : null, utente_id);
    }
  });
  return client;
}

function getCalendarId() {
  return process.env.GOOGLE_SHARED_CALENDAR_ID || 'info@horygon.com';
}

function getCalendarOwnerEmail() {
  return process.env.GOOGLE_CALENDAR_OWNER_EMAIL || 'info@horygon.com';
}

function getCalendarClient(utente_id) {
  const ownerEmail = getCalendarOwnerEmail();
  const ownerUser = db.prepare('SELECT id FROM utenti WHERE LOWER(email) = LOWER(?) LIMIT 1').get(ownerEmail);
  if (ownerUser?.id) {
    const ownerClient = getClient(ownerUser.id);
    if (ownerClient) return ownerClient;
  }
  return getClient(utente_id);
}

function logGoogleError(origine, error, dettagli = {}) {
  writeSystemLog({
    livello: 'error',
    origine,
    messaggio: error?.message || String(error),
    stack: error?.stack || null,
    dettagli
  });
}

// ═══════════════════════════════
// CALENDAR
// ═══════════════════════════════
async function getEvents(utente_id, timeMin, timeMax) {
  const client = getCalendarClient(utente_id);
  if (!client) return [];
  const calendar = google.calendar({ version: 'v3', auth: client });
  try {
    const res = await calendar.events.list({
      calendarId: getCalendarId(),
      timeMin: timeMin || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      timeMax: timeMax || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      maxResults: 250,
      singleEvents: true,
      orderBy: 'startTime'
    });
    return res.data.items || [];
  } catch (e) {
    console.error('Calendar getEvents error:', e.message);
    logGoogleError('google.calendar.getEvents', e, { utente_id, timeMin, timeMax });
    return [];
  }
}

async function createEvent(utente_id, evento) {
  const client = getCalendarClient(utente_id);
  if (!client) throw new Error('Google non connesso');
  const calendar = google.calendar({ version: 'v3', auth: client });
  try {
    const res = await calendar.events.insert({ calendarId: getCalendarId(), requestBody: evento });
    return res.data;
  } catch (e) {
    logGoogleError('google.calendar.createEvent', e, { utente_id, calendarId: getCalendarId(), summary: evento?.summary });
    throw e;
  }
}

async function updateEvent(utente_id, eventId, evento) {
  const client = getCalendarClient(utente_id);
  if (!client) throw new Error('Google non connesso');
  const calendar = google.calendar({ version: 'v3', auth: client });
  try {
    const res = await calendar.events.update({ calendarId: getCalendarId(), eventId, requestBody: evento });
    return res.data;
  } catch (e) {
    logGoogleError('google.calendar.updateEvent', e, { utente_id, calendarId: getCalendarId(), eventId });
    throw e;
  }
}

async function deleteEvent(utente_id, eventId) {
  const client = getCalendarClient(utente_id);
  if (!client) throw new Error('Google non connesso');
  const calendar = google.calendar({ version: 'v3', auth: client });
  try {
    await calendar.events.delete({ calendarId: getCalendarId(), eventId });
  } catch (e) {
    logGoogleError('google.calendar.deleteEvent', e, { utente_id, calendarId: getCalendarId(), eventId });
    throw e;
  }
}

// ═══════════════════════════════
// DRIVE
// ═══════════════════════════════
async function getDriveFiles(utente_id, folderName) {
  const client = getClient(utente_id);
  if (!client) return [];
  const drive = google.drive({ version: 'v3', auth: client });
  try {
    // Trova la cartella
    const folderRes = await drive.files.list({
      q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id,name)'
    });
    const folders = folderRes.data.files || [];
    if (!folders.length) return { error: `Cartella "${folderName}" non trovata su Drive` };
    const folderId = folders[0].id;
    // Lista file nella cartella
    const filesRes = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,webContentLink,iconLink)',
      orderBy: 'modifiedTime desc'
    });
    return { folderId, files: filesRes.data.files || [] };
  } catch (e) {
    console.error('Drive error:', e.message);
    logGoogleError('google.drive.getFiles', e, { utente_id, folderName });
    return { error: e.message };
  }
}

async function uploadToDrive(utente_id, folderName, fileName, mimeType, buffer) {
  const client = getClient(utente_id);
  if (!client) throw new Error('Google non connesso');
  const drive = google.drive({ version: 'v3', auth: client });
  const { Readable } = require('stream');
  // Trova/crea cartella
  let folderRes = await drive.files.list({
    q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)'
  });
  let folderId;
  if (folderRes.data.files?.length) {
    folderId = folderRes.data.files[0].id;
  } else {
    const f = await drive.files.create({
      requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id'
    });
    folderId = f.data.id;
  }
  const stream = Readable.from(buffer);
  try {
    const res = await drive.files.create({
      requestBody: { name: fileName, parents: [folderId] },
      media: { mimeType, body: stream },
      fields: 'id,webViewLink,webContentLink'
    });
    return res.data;
  } catch (e) {
    logGoogleError('google.drive.upload', e, { utente_id, folderName, fileName, mimeType });
    throw e;
  }
}

async function deleteFromDrive(utente_id, fileId) {
  const client = getClient(utente_id);
  if (!client) throw new Error('Google non connesso');
  const drive = google.drive({ version: 'v3', auth: client });
  try {
    await drive.files.delete({ fileId });
  } catch (e) {
    logGoogleError('google.drive.delete', e, { utente_id, fileId });
    throw e;
  }
}

async function getGoogleContacts(utente_id) {
  const client = getClient(utente_id);
  if (!client) throw new Error('Google non connesso');
  const people = google.people({ version: 'v1', auth: client });
  const res = await people.people.connections.list({
    resourceName: 'people/me',
    personFields: 'names,emailAddresses,phoneNumbers,organizations',
    pageSize: 200
  });
  return (res.data.connections || []).map(c => ({
    id: c.resourceName,
    nome: c.names?.[0]?.displayName || '',
    email: c.emailAddresses?.[0]?.value || '',
    telefono: c.phoneNumbers?.[0]?.value || '',
    organizzazione: c.organizations?.[0]?.name || ''
  }));
}

function buildGoogleContactPayload(c) {
  const displayName = [c.nome, c.cognome].filter(Boolean).join(' ').trim();
  const names = (c.nome || c.cognome) ? [{ givenName: c.nome || displayName, familyName: c.cognome || undefined, displayName }] : undefined;
  const emailAddresses = c.email ? [{ value: c.email }] : undefined;
  const phoneNumbers = c.telefono ? [{ value: c.telefono }] : undefined;
  const organizations = c.organizzazione ? [{ name: c.organizzazione, title: c.ruolo || undefined }] : undefined;
  const biographies = c.note ? [{ value: c.note }] : undefined;
  return { names, emailAddresses, phoneNumbers, organizations, biographies };
}

async function syncSingleContactToGoogle(utente_id, contattoId) {
  const client = getClient(utente_id);
  if (!client) throw new Error('Google non connesso');
  const people = google.people({ version: 'v1', auth: client });
  const c = db.prepare(`
    SELECT c.*, a.ragione_sociale as organizzazione
    FROM anagrafiche_contatti c
    LEFT JOIN anagrafiche a ON a.id = c.anagrafica_id
    WHERE c.id = ? AND COALESCE(c.attivo, 1) = 1
  `).get(contattoId);
  if (!c) throw new Error('Contatto non trovato');
  if (c.google_resource_name) return { ok: true, resourceName: c.google_resource_name, skipped: true };
  const requestBody = buildGoogleContactPayload(c);
  const created = await people.people.createContact({ requestBody });
  const resourceName = created.data.resourceName;
  db.prepare('UPDATE anagrafiche_contatti SET google_resource_name = ? WHERE id = ?').run(resourceName, contattoId);
  return { ok: true, resourceName };
}

async function syncLocalContactsToGoogle(utente_id) {
  const client = getClient(utente_id);
  if (!client) throw new Error('Google non connesso');
  const people = google.people({ version: 'v1', auth: client });
  const locals = [
    ...db.prepare(`
      SELECT c.id, c.nome, c.cognome, c.email, c.telefono, c.ruolo, c.note, c.google_resource_name,
             COALESCE(a.ragione_sociale, 'Contatto CRM') AS organizzazione
      FROM anagrafiche_contatti c
      LEFT JOIN anagrafiche a ON a.id = c.anagrafica_id
      WHERE COALESCE(c.attivo, 1) = 1 AND (c.email IS NOT NULL OR c.telefono IS NOT NULL)
    `).all(),
    ...db.prepare(`SELECT ragione_sociale as nome, email, telefono, 'Anagrafica' as organizzazione FROM anagrafiche WHERE attivo = 1 AND (email IS NOT NULL OR telefono IS NOT NULL)`).all(),
    ...db.prepare(`SELECT nome, email, telefono, 'Horygon' as organizzazione FROM utenti WHERE attivo = 1`).all()
  ];
  let created = 0;
  let updated = 0;
  for (const c of locals.slice(0, 150)) {
    try {
      if (c.id) {
        const result = await syncSingleContactToGoogle(utente_id, c.id);
        if (result?.resourceName) {
          if (c.google_resource_name) updated += 1;
          else created += 1;
        }
      } else {
        await people.people.createContact({ requestBody: buildGoogleContactPayload(c) });
        created += 1;
      }
    } catch {}
  }
  return { created, updated, total: locals.length };
}

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function listSettings() {
  return db.prepare('SELECT * FROM app_settings ORDER BY key').all();
}

function saveSettings(items = []) {
  const upsert = db.prepare(`
    INSERT INTO app_settings (key, value, type, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, type = excluded.type, updated_at = datetime('now')
  `);
  items.forEach(item => upsert.run(String(item.key), String(item.value ?? ''), String(item.type || 'string')));
  return listSettings();
}

function decodeBase64Url(data) {
  return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function decodeGmailBody(payload) {
  const plainParts = [];
  const htmlParts = [];
  const visit = (node) => {
    if (!node) return;
    const mime = node.mimeType || '';
    if ((mime === 'text/plain' || mime === 'text/html') && node.body?.data) {
      const decoded = decodeBase64Url(node.body.data);
      if (mime === 'text/plain') plainParts.push(decoded);
      else htmlParts.push(decoded);
    }
    (node.parts || []).forEach(visit);
  };
  visit(payload);
  if (!plainParts.length && !htmlParts.length && payload?.body?.data) {
    plainParts.push(decodeBase64Url(payload.body.data));
  }
  return (plainParts.length ? plainParts : htmlParts).join('\n');
}

function cleanMailText(text) {
  return (text || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\r/g, '')
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseItalianDateTime(value) {
  if (!value) return null;
  const m = String(value).trim().match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] || '9'), Number(m[5] || '0'), 0);
}

function extractField(text, label) {
  const re = new RegExp(`${label}\\s*:\\s*([\\s\\S]*?)(?:\\n\\s*\\n|\\n[A-ZÀ-Ú][^\\n]*:|$)`, 'i');
  return text.match(re)?.[1]?.trim() || null;
}

function parseMepaMail(text, subject, from) {
  const clean = cleanMailText(text);
  const garaId = extractField(clean, 'Identificativo Numerico Gara');
  if (!garaId && !/acquistinretepa\.it/i.test(from || '')) return null;
  const nomeGara = extractField(clean, 'Nome Gara') || subject || null;
  const categoria = extractField(clean, 'Categorie di riferimento');
  const pubblicazione = extractField(clean, 'Data pubblicazione');
  const scadenza = extractField(clean, 'Data ultima per la presentazione delle offerte');
  const chiarimenti = extractField(clean, 'Data termine richiesta chiarimenti');
  const ente = clean.match(/Hai ricevuto una comunicazione da parte di\s+(.+?)\s+relativa alla Gara/i)?.[1]?.trim() || null;
  return {
    categoria,
    gara_id: garaId,
    nome_gara: nomeGara,
    ente,
    data_pubblicazione: pubblicazione,
    scadenza_offerte: scadenza,
    termine_chiarimenti: chiarimenti,
    corpo: clean
  };
}

async function syncMepaGmail(utente_id) {
  const client = getClient(utente_id);
  if (!client) throw new Error('Google non connesso');
  const gmail = google.gmail({ version: 'v1', auth: client });
  const list = await gmail.users.messages.list({
    userId: 'me',
    maxResults: 25,
    q: 'from:comunicazioni@acquistinretepa.it newer_than:180d'
  });
  const ids = list.data.messages || [];
  const upsert = db.prepare(`
    INSERT OR IGNORE INTO mepa_mail_alerts
    (utente_id,gmail_message_id,mittente,oggetto,categoria,gara_id,nome_gara,ente,data_pubblicazione,scadenza_offerte,termine_chiarimenti,corpo)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  let inserted = 0;
  for (const item of ids) {
    const msg = await gmail.users.messages.get({ userId: 'me', id: item.id, format: 'full' });
    const headers = Object.fromEntries((msg.data.payload?.headers || []).map(h => [String(h.name).toLowerCase(), h.value]));
    const parsed = parseMepaMail(decodeGmailBody(msg.data.payload), headers.subject || '', headers.from || '');
    if (!parsed) continue;
    const r = upsert.run(
      utente_id,
      item.id,
      headers.from || null,
      headers.subject || null,
      parsed.categoria,
      parsed.gara_id,
      parsed.nome_gara,
      parsed.ente,
      parsed.data_pubblicazione,
      parsed.scadenza_offerte,
      parsed.termine_chiarimenti,
      parsed.corpo
    );
    if (r.changes > 0) inserted += 1;
  }
  return { inserted, total: ids.length };
}

function listMepaMailAlerts(utente_id) {
  return db.prepare(`
    SELECT * FROM mepa_mail_alerts
    WHERE utente_id = ? AND sync_attiva = 1
    ORDER BY COALESCE(scadenza_offerte, data_pubblicazione, creato_il) DESC, id DESC
    LIMIT 100
  `).all(utente_id);
}

function getMepaMailAlertById(utente_id, id) {
  return db.prepare('SELECT * FROM mepa_mail_alerts WHERE utente_id = ? AND id = ?').get(utente_id, id);
}

function updateMepaMailAlert(utente_id, id, patch = {}) {
  const alert = getMepaMailAlertById(utente_id, id);
  if (!alert) throw new Error('Alert non trovato');
  const stato = patch.stato || alert.stato || 'nuova';
  const syncAttiva = patch.sync_attiva === undefined ? alert.sync_attiva : (patch.sync_attiva ? 1 : 0);
  db.prepare(`
    UPDATE mepa_mail_alerts
    SET stato = ?, sync_attiva = ?, eliminata_il = CASE WHEN ? = 0 THEN COALESCE(eliminata_il, datetime('now')) ELSE NULL END
    WHERE id = ? AND utente_id = ?
  `).run(stato, syncAttiva, syncAttiva, id, utente_id);
  return getMepaMailAlertById(utente_id, id);
}

function findOrCreatePaAnagrafica(ente) {
  if (!ente) return null;
  let row = db.prepare(`
    SELECT * FROM anagrafiche
    WHERE LOWER(ragione_sociale) = LOWER(?) AND attivo = 1
    LIMIT 1
  `).get(ente);
  if (row) return row.id;
  const inserted = db.prepare(`
    INSERT INTO anagrafiche (tipo, ragione_sociale, paese, attivo, tipologia_cliente, pa_mepa, pa_rdo, canale_cliente)
    VALUES ('cliente', ?, 'IT', 1, 'pa', 1, 1, 'mepa')
  `).run(ente);
  return inserted.lastInsertRowid;
}

function chunkBase64(value) {
  return String(value || '').match(/.{1,76}/g)?.join('\r\n') || '';
}

function buildRawEmail({ to, subject, text, attachments = [] }) {
  const cleanAttachments = Array.isArray(attachments) ? attachments.filter(a => a?.content && a?.filename) : [];
  if (!cleanAttachments.length) {
    return Buffer.from(
      `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${text}`,
      'utf8'
    ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  const boundary = `horygon-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    text || ''
  ];

  cleanAttachments.forEach((attachment) => {
    const contentType = attachment.contentType || 'application/octet-stream';
    const base64Content = chunkBase64(Buffer.isBuffer(attachment.content)
      ? attachment.content.toString('base64')
      : Buffer.from(String(attachment.content), 'utf8').toString('base64'));
    lines.push(
      `--${boundary}`,
      `Content-Type: ${contentType}; name="${attachment.filename}"`,
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Content
    );
  });

  lines.push(`--${boundary}--`);
  return Buffer.from(lines.join('\r\n'), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function sendMail(utente_id, to, subject, text, attachments = []) {
  const client = getCalendarClient(utente_id);
  if (!client) throw new Error('Google non connesso');
  const gmail = google.gmail({ version: 'v1', auth: client });
  const raw = buildRawEmail({ to, subject, text, attachments });
  try {
    const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    return res.data;
  } catch (e) {
    logGoogleError('google.gmail.send', e, { utente_id, to, subject, attachments: attachments?.length || 0 });
    throw e;
  }
}

function createNotificationForUsers({ tipo = 'info', titolo, messaggio, livello_urgenza = 'media', entita_tipo = null, entita_id = null, uniqueSuffix = '' }) {
  const users = db.prepare('SELECT id, email FROM utenti WHERE attivo = 1').all();
  const ins = db.prepare(`
    INSERT OR IGNORE INTO notifiche_app (utente_id, tipo, titolo, messaggio, livello_urgenza, entita_tipo, entita_id, unique_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  users.forEach(u => {
    const uniqueKey = [u.id, tipo, entita_tipo || '', entita_id || '', uniqueSuffix].join(':');
    ins.run(u.id, tipo, titolo, messaggio, livello_urgenza, entita_tipo, entita_id, uniqueKey);
  });
}

function createNotificationsForUserIds(userIds = [], { tipo = 'info', titolo, messaggio, livello_urgenza = 'media', entita_tipo = null, entita_id = null, uniqueSuffix = '' }) {
  const resolvedUserIds = [...new Set(
    (Array.isArray(userIds) ? userIds : [])
      .map(v => parseInt(v, 10))
      .filter(v => !Number.isNaN(v) && v > 0)
  )];
  if (!resolvedUserIds.length) return [];
  const ins = db.prepare(`
    INSERT OR IGNORE INTO notifiche_app (utente_id, tipo, titolo, messaggio, livello_urgenza, entita_tipo, entita_id, unique_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertedIds = [];
  resolvedUserIds.forEach(userId => {
    const uniqueKey = [userId, tipo, entita_tipo || '', entita_id || '', uniqueSuffix].join(':');
    const result = ins.run(userId, tipo, titolo, messaggio, livello_urgenza, entita_tipo, entita_id, uniqueKey);
    if (result.lastInsertRowid) insertedIds.push(result.lastInsertRowid);
  });
  return resolvedUserIds;
}

function getActiveUserIds() {
  return db.prepare('SELECT id FROM utenti WHERE attivo = 1 ORDER BY id').all().map(row => row.id);
}

async function sendMailToRecipients(senderUserId, recipients = [], subject, text, attachments = []) {
  const cleanRecipients = [...new Set(
    (Array.isArray(recipients) ? recipients : [])
      .map(v => String(v || '').trim())
      .filter(Boolean)
  )];
  if (!senderUserId || !cleanRecipients.length) return { sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  for (const recipient of cleanRecipients) {
    try {
      await sendMail(senderUserId, recipient, subject, text, attachments);
      sent += 1;
    } catch (e) {
      logGoogleError('notifications.sendMailToRecipients', e, { senderUserId, to: recipient, subject });
      failed += 1;
    }
  }
  return { sent, failed };
}

async function notifyUsersWithEmail({
  senderUserId,
  userIds = null,
  tipo = 'info',
  titolo,
  messaggio,
  livello_urgenza = 'media',
  entita_tipo = null,
  entita_id = null,
  uniqueSuffix = '',
  emailSettingKey = null,
  emailSubject = null,
  emailText = null
}) {
  const resolvedUserIds = Array.isArray(userIds) && userIds.length ? userIds : getActiveUserIds();
  const recipients = createNotificationsForUserIds(resolvedUserIds, {
    tipo,
    titolo,
    messaggio,
    livello_urgenza,
    entita_tipo,
    entita_id,
    uniqueSuffix
  });
  let email = { sent: 0, failed: 0, skipped: true };
  if (emailSettingKey && getSetting(emailSettingKey, '0') === '1' && recipients.length) {
    const placeholders = recipients.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT email
      FROM utenti
      WHERE attivo = 1 AND email IS NOT NULL AND TRIM(email) <> '' AND id IN (${placeholders})
    `).all(...recipients);
    email = await sendMailToRecipients(
      senderUserId,
      rows.map(row => row.email),
      emailSubject || `[Horygon] ${titolo}`,
      emailText || `${titolo}\n\n${messaggio || ''}`
    );
    email.skipped = false;
  }
  return { notifiedUsers: recipients.length, email };
}

async function emailCustomerIfEnabled({
  senderUserId,
  to,
  subject,
  text,
  settingKey = null
}) {
  if (!to) return { sent: 0, skipped: true };
  if (settingKey && getSetting(settingKey, '0') !== '1') return { sent: 0, skipped: true };
  const result = await sendMailToRecipients(senderUserId, [to], subject, text);
  return { ...result, skipped: false };
}

async function dispatchPendingNotificationEmails(senderUserId) {
  if (getSetting('notifications.email_enabled', '0') !== '1') return { sent: 0 };
  const rows = db.prepare(`
    SELECT n.*, u.email
    FROM notifiche_app n
    JOIN utenti u ON u.id = n.utente_id
    WHERE n.letta = 0 AND n.invio_email_tentato = 0 AND u.attivo = 1
    ORDER BY n.id ASC
    LIMIT 20
  `).all();
  let sent = 0;
  for (const row of rows) {
    let ok = 0;
    try {
      await sendMail(senderUserId, row.email, `[Horygon] ${row.titolo}`, `${row.titolo}\n\n${row.messaggio || ''}`);
      ok = 1;
      sent += 1;
    } catch (e) {
      logGoogleError('notifications.dispatchPendingEmail', e, { senderUserId, notification_id: row.id, to: row.email, title: row.titolo });
    }
    db.prepare('UPDATE notifiche_app SET invio_email_tentato = 1, invio_email_ok = ? WHERE id = ?').run(ok, row.id);
  }
  return { sent };
}

async function upsertMepaAlertAutomation(utente_id, alertId) {
  const alert = getMepaMailAlertById(utente_id, alertId);
  if (!alert || !alert.sync_attiva || alert.attivita_disattivata) return null;
  const anagraficaId = alert.anagrafica_id || findOrCreatePaAnagrafica(alert.ente);
  if (anagraficaId && !alert.anagrafica_id) {
    db.prepare('UPDATE mepa_mail_alerts SET anagrafica_id = ? WHERE id = ?').run(anagraficaId, alertId);
  }
  let attivitaId = alert.attivita_id;
  if (!attivitaId) {
    const r = db.prepare(`
      INSERT INTO attivita (tipo, anagrafica_id, utente_id, data_ora, durata_minuti, oggetto, note, esito, promemoria_il, stato, stato_origine, origine_id)
      VALUES ('email', ?, ?, datetime('now'), 15, ?, ?, 'da_valutare', ?, 'aperta', 'mepa_mail', ?)
    `).run(anagraficaId, utente_id, `Mail ricevuta da PA - ${alert.gara_id || 'MEPA'}`, alert.corpo, alert.scadenza_offerte || alert.data_pubblicazione || null, alert.id);
    attivitaId = r.lastInsertRowid;
    db.prepare('UPDATE mepa_mail_alerts SET attivita_id = ? WHERE id = ?').run(attivitaId, alertId);
  }
  if (alert.scadenza_offerte && !alert.google_event_id) {
    try {
      const end = parseItalianDateTime(alert.scadenza_offerte);
      if (!end) throw new Error('Data scadenza non valida');
      const start = new Date(end.getTime() - 60 * 60 * 1000);
      const event = await createEvent(utente_id, {
        summary: `Scadenza MEPA ${alert.gara_id || ''}`.trim(),
        description: `${alert.nome_gara || ''}\n${alert.ente || ''}`,
        start: { dateTime: start.toISOString(), timeZone: 'Europe/Rome' },
        end: { dateTime: end.toISOString(), timeZone: 'Europe/Rome' }
      });
      if (event?.id) db.prepare('UPDATE mepa_mail_alerts SET google_event_id = ? WHERE id = ?').run(event.id, alertId);
    } catch {}
  }
  createNotificationForUsers({
    tipo: 'mepa_mail',
    titolo: `Nuova mail PA: ${alert.ente || 'PA'}`,
    messaggio: `${alert.gara_id || ''} ${alert.nome_gara || alert.oggetto || ''}`.trim(),
    livello_urgenza: 'media',
    entita_tipo: 'mepa_mail',
    entita_id: alertId,
    uniqueSuffix: 'new'
  });
  return getMepaMailAlertById(utente_id, alertId);
}

async function processMepaAutomation(utente_id) {
  const rows = db.prepare(`
    SELECT id FROM mepa_mail_alerts
    WHERE utente_id = ? AND sync_attiva = 1 AND stato <> 'eliminata'
    ORDER BY id DESC LIMIT 50
  `).all(utente_id);
  for (const row of rows) {
    await upsertMepaAlertAutomation(utente_id, row.id);
  }
  const now = new Date();
  const alerts = db.prepare(`
    SELECT * FROM mepa_mail_alerts
    WHERE utente_id = ? AND sync_attiva = 1 AND stato NOT IN ('eliminata','archiviata','scaduta')
      AND scadenza_offerte IS NOT NULL
  `).all(utente_id);
  for (const alert of alerts) {
    const due = parseItalianDateTime(alert.scadenza_offerte);
    if (!due || Number.isNaN(due.getTime())) continue;
    const diffDays = Math.ceil((due.getTime() - now.getTime()) / 86400000);
    if (diffDays <= 3 && diffDays >= 0 && !alert.notificata_3g) {
      createNotificationForUsers({
        tipo: 'deadline',
        titolo: `Scadenza MEPA in arrivo (${diffDays}g)`,
        messaggio: `${alert.gara_id || ''} ${alert.nome_gara || alert.oggetto || ''}`.trim(),
        livello_urgenza: 'media',
        entita_tipo: 'mepa_mail',
        entita_id: alert.id,
        uniqueSuffix: '3d'
      });
      db.prepare('UPDATE mepa_mail_alerts SET notificata_3g = 1 WHERE id = ?').run(alert.id);
    }
    if (diffDays <= 1 && diffDays >= 0 && !alert.notificata_1g) {
      createNotificationForUsers({
        tipo: 'deadline',
        titolo: `Scadenza MEPA imminente (${diffDays}g)`,
        messaggio: `${alert.gara_id || ''} ${alert.nome_gara || alert.oggetto || ''}`.trim(),
        livello_urgenza: 'alta',
        entita_tipo: 'mepa_mail',
        entita_id: alert.id,
        uniqueSuffix: '1d'
      });
      db.prepare('UPDATE mepa_mail_alerts SET notificata_1g = 1 WHERE id = ?').run(alert.id);
    }
    if (diffDays < 0 && alert.stato !== 'scaduta') {
      db.prepare('UPDATE mepa_mail_alerts SET stato = ? WHERE id = ?').run('scaduta', alert.id);
    }
  }
  return { ok: true };
}

function diffDaysFromNow(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.ceil((target - start) / 86400000);
}

function notifyActiveUsers({
  tipo,
  titolo,
  messaggio,
  livello_urgenza = 'media',
  entita_tipo,
  entita_id,
  uniqueSuffix
}) {
  createNotificationForUsers({
    tipo,
    titolo,
    messaggio,
    livello_urgenza,
    entita_tipo,
    entita_id,
    uniqueSuffix
  });
}

async function processCrmDeadlineAutomation(utente_id) {
  const stats = { preventivi: 0, fatture: 0, proforme: 0, spedizioni: 0 };

  const preventivi = db.prepare(`
    SELECT p.id, p.codice_preventivo, p.data_scadenza, p.stato, a.ragione_sociale
    FROM preventivi p
    LEFT JOIN anagrafiche a ON a.id = p.anagrafica_id
    WHERE p.data_scadenza IS NOT NULL
      AND COALESCE(lower(p.stato), 'bozza') NOT IN ('accettato', 'rifiutato', 'scaduto')
  `).all();
  preventivi.forEach((row) => {
    const days = diffDaysFromNow(row.data_scadenza);
    if (days === null) return;
    const label = row.codice_preventivo || `#${row.id}`;
    const customer = row.ragione_sociale || 'cliente';
    if (days < 0) {
      notifyActiveUsers({
        tipo: 'preventivo_scaduto',
        titolo: `Preventivo ${label} scaduto`,
        messaggio: `${customer} • scaduto il ${row.data_scadenza}`,
        livello_urgenza: 'alta',
        entita_tipo: 'preventivo',
        entita_id: row.id,
        uniqueSuffix: `preventivo:overdue:${row.data_scadenza}`
      });
      stats.preventivi += 1;
      return;
    }
    if (days <= 7) {
      notifyActiveUsers({
        tipo: 'preventivo_scadenza',
        titolo: `Preventivo ${label} in scadenza`,
        messaggio: `${customer} • scadenza tra ${days}g (${row.data_scadenza})`,
        livello_urgenza: days <= 1 ? 'alta' : 'media',
        entita_tipo: 'preventivo',
        entita_id: row.id,
        uniqueSuffix: `preventivo:due:${row.data_scadenza}:${days <= 1 ? '1' : '7'}`
      });
      stats.preventivi += 1;
    }
  });

  const fatture = db.prepare(`
    SELECT f.id, f.numero, f.scadenza, f.stato, f.tipo, a.ragione_sociale
    FROM fatture f
    LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id
    WHERE f.scadenza IS NOT NULL
      AND COALESCE(lower(f.stato), 'ricevuta') NOT IN ('pagata', 'annullata')
  `).all();
  fatture.forEach((row) => {
    const days = diffDaysFromNow(row.scadenza);
    if (days === null) return;
    const kind = row.tipo === 'ricevuta' ? 'passiva' : 'attiva';
    const label = row.numero || `#${row.id}`;
    const counterpart = row.ragione_sociale || (kind === 'passiva' ? 'fornitore' : 'cliente');
    if (days < 0) {
      notifyActiveUsers({
        tipo: 'fattura_scaduta',
        titolo: `Fattura ${kind} ${label} scaduta`,
        messaggio: `${counterpart} • scaduta il ${row.scadenza}`,
        livello_urgenza: 'alta',
        entita_tipo: 'fattura',
        entita_id: row.id,
        uniqueSuffix: `fattura:overdue:${row.scadenza}`
      });
      stats.fatture += 1;
      return;
    }
    if (days <= 7) {
      notifyActiveUsers({
        tipo: 'fattura_scadenza',
        titolo: `Fattura ${kind} ${label} in scadenza`,
        messaggio: `${counterpart} • scadenza tra ${days}g (${row.scadenza})`,
        livello_urgenza: days <= 1 ? 'alta' : 'media',
        entita_tipo: 'fattura',
        entita_id: row.id,
        uniqueSuffix: `fattura:due:${row.scadenza}:${days <= 1 ? '1' : '7'}`
      });
      stats.fatture += 1;
    }
  });

  const proforme = db.prepare(`
    SELECT p.id, p.numero_proforma, p.scadenza_acconto, p.scadenza_saldo, p.stato, a.ragione_sociale
    FROM proforme_invoice p
    LEFT JOIN anagrafiche a ON a.id = p.fornitore_id
    WHERE COALESCE(lower(p.stato), 'ricevuta') NOT IN ('chiusa', 'annullata')
  `).all();
  proforme.forEach((row) => {
    [
      { kind: 'acconto', date: row.scadenza_acconto },
      { kind: 'saldo', date: row.scadenza_saldo }
    ].forEach((item) => {
      const days = diffDaysFromNow(item.date);
      if (days === null) return;
      const supplier = row.ragione_sociale || 'fornitore';
      const label = row.numero_proforma || `#${row.id}`;
      if (days < 0) {
        notifyActiveUsers({
          tipo: 'proforma_scaduta',
          titolo: `${item.kind === 'acconto' ? 'Acconto' : 'Saldo'} proforma ${label} scaduto`,
          messaggio: `${supplier} • scaduto il ${item.date}`,
          livello_urgenza: 'alta',
          entita_tipo: 'proforma',
          entita_id: row.id,
          uniqueSuffix: `proforma:${item.kind}:overdue:${item.date}`
        });
        stats.proforme += 1;
        return;
      }
      if (days <= 7) {
        notifyActiveUsers({
          tipo: 'proforma_scadenza',
          titolo: `${item.kind === 'acconto' ? 'Acconto' : 'Saldo'} proforma ${label} in scadenza`,
          messaggio: `${supplier} • scadenza tra ${days}g (${item.date})`,
          livello_urgenza: days <= 1 ? 'alta' : 'media',
          entita_tipo: 'proforma',
          entita_id: row.id,
          uniqueSuffix: `proforma:${item.kind}:due:${item.date}:${days <= 1 ? '1' : '7'}`
        });
        stats.proforme += 1;
      }
    });
  });

  const spedizioni = db.prepare(`
    SELECT id, codice_spedizione, eta, tracking_number, stato_spedizione
    FROM spedizioni
    WHERE eta IS NOT NULL
      AND COALESCE(lower(stato_spedizione), 'in_preparazione') NOT IN ('consegnata', 'chiusa')
  `).all();
  spedizioni.forEach((row) => {
    const days = diffDaysFromNow(row.eta);
    if (days === null) return;
    const label = row.codice_spedizione || `#${row.id}`;
    if (days < 0) {
      notifyActiveUsers({
        tipo: 'spedizione_eta',
        titolo: `ETA spedizione ${label} superata`,
        messaggio: `${row.stato_spedizione || 'in gestione'} • ETA ${row.eta}${row.tracking_number ? ` • tracking ${row.tracking_number}` : ''}`,
        livello_urgenza: 'alta',
        entita_tipo: 'spedizione',
        entita_id: row.id,
        uniqueSuffix: `spedizione:eta:overdue:${row.eta}`
      });
      stats.spedizioni += 1;
      return;
    }
    if (days <= 1) {
      notifyActiveUsers({
        tipo: 'spedizione_eta',
        titolo: `Spedizione ${label} in arrivo`,
        messaggio: `${row.stato_spedizione || 'in gestione'} • ETA tra ${days}g (${row.eta})`,
        livello_urgenza: 'media',
        entita_tipo: 'spedizione',
        entita_id: row.id,
        uniqueSuffix: `spedizione:eta:due:${row.eta}`
      });
      stats.spedizioni += 1;
    }
  });

  return stats;
}

async function processAllAutomations(utente_id) {
  const mepa = await processMepaAutomation(utente_id);
  const deadlines = await processCrmDeadlineAutomation(utente_id);
  const emails = await dispatchPendingNotificationEmails(utente_id);
  return { mepa, deadlines, emails };
}

function listNotifications(userId) {
  return db.prepare(`
    SELECT * FROM notifiche_app
    WHERE utente_id = ? AND eliminata = 0
    ORDER BY
      pinned DESC,
      CASE livello_urgenza
        WHEN 'alta' THEN 3
        WHEN 'media' THEN 2
        ELSE 1
      END DESC,
      letta ASC,
      creato_il DESC,
      id DESC
    LIMIT 100
  `).all(userId);
}

function markNotificationRead(userId, id, letta = 1) {
  db.prepare('UPDATE notifiche_app SET letta = ? WHERE id = ? AND utente_id = ?').run(letta ? 1 : 0, id, userId);
}

function updateNotification(userId, id, patch = {}) {
  db.prepare(`
    UPDATE notifiche_app
    SET letta = COALESCE(?, letta),
        pinned = COALESCE(?, pinned),
        eliminata = COALESCE(?, eliminata),
        livello_urgenza = COALESCE(?, livello_urgenza)
    WHERE id = ? AND utente_id = ?
  `).run(
    patch.letta === undefined ? null : (patch.letta ? 1 : 0),
    patch.pinned === undefined ? null : (patch.pinned ? 1 : 0),
    patch.eliminata === undefined ? null : (patch.eliminata ? 1 : 0),
    patch.livello_urgenza === undefined ? null : patch.livello_urgenza,
    id,
    userId
  );
}

module.exports = {
  getClient, getEvents, createEvent, updateEvent, deleteEvent,
  getDriveFiles, uploadToDrive, deleteFromDrive,
  getGoogleContacts, syncLocalContactsToGoogle, syncSingleContactToGoogle,
  syncMepaGmail, listMepaMailAlerts, getMepaMailAlertById, updateMepaMailAlert,
  processMepaAutomation, processCrmDeadlineAutomation, processAllAutomations,
  listNotifications, markNotificationRead, updateNotification,
  listSettings, saveSettings, getSetting, sendMail, sendMailToRecipients,
  createNotificationsForUserIds, notifyUsersWithEmail, emailCustomerIfEnabled
};
