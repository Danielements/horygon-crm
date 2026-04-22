const { google } = require('googleapis');
const db = require('../db/database');

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

// ═══════════════════════════════
// CALENDAR
// ═══════════════════════════════
async function getEvents(utente_id, timeMin, timeMax) {
  const client = getClient(utente_id);
  if (!client) return [];
  const calendar = google.calendar({ version: 'v3', auth: client });
  try {
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMin || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      timeMax: timeMax || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      maxResults: 250,
      singleEvents: true,
      orderBy: 'startTime'
    });
    return res.data.items || [];
  } catch (e) {
    console.error('Calendar getEvents error:', e.message);
    return [];
  }
}

async function createEvent(utente_id, evento) {
  const client = getClient(utente_id);
  if (!client) throw new Error('Google non connesso');
  const calendar = google.calendar({ version: 'v3', auth: client });
  const res = await calendar.events.insert({ calendarId: 'primary', requestBody: evento });
  return res.data;
}

async function updateEvent(utente_id, eventId, evento) {
  const client = getClient(utente_id);
  if (!client) throw new Error('Google non connesso');
  const calendar = google.calendar({ version: 'v3', auth: client });
  const res = await calendar.events.update({ calendarId: 'primary', eventId, requestBody: evento });
  return res.data;
}

async function deleteEvent(utente_id, eventId) {
  const client = getClient(utente_id);
  if (!client) throw new Error('Google non connesso');
  const calendar = google.calendar({ version: 'v3', auth: client });
  await calendar.events.delete({ calendarId: 'primary', eventId });
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
  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType, body: stream },
    fields: 'id,webViewLink,webContentLink'
  });
  return res.data;
}

async function deleteFromDrive(utente_id, fileId) {
  const client = getClient(utente_id);
  if (!client) throw new Error('Google non connesso');
  const drive = google.drive({ version: 'v3', auth: client });
  await drive.files.delete({ fileId });
}

module.exports = {
  getClient, getEvents, createEvent, updateEvent, deleteEvent,
  getDriveFiles, uploadToDrive, deleteFromDrive
};
