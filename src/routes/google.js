const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authMiddleware } = require('../middleware/auth');
const { getEvents, createEvent, updateEvent, deleteEvent, getDriveFiles, uploadToDrive, deleteFromDrive, getGoogleContacts, syncLocalContactsToGoogle, syncMepaGmail, listMepaMailAlerts, getMepaMailAlertById, updateMepaMailAlert, processMepaAutomation, listNotifications, markNotificationRead, updateNotification } = require('../services/google');

const upload = multer({ storage: multer.memoryStorage() });

router.use(authMiddleware);

function normalizeGoogleDateTime(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(value))) return `${value}:00`;
  return String(value);
}

function buildCalendarPayload(body = {}) {
  const title = String(body.title || '').trim();
  const start = normalizeGoogleDateTime(body.start);
  const end = normalizeGoogleDateTime(body.end || body.start);
  if (!title) throw new Error('Titolo evento obbligatorio');
  if (!start || !end) throw new Error('Data inizio/fine non valida');
  return {
    summary: title,
    description: body.description || '',
    start: body.allDay ? { date: start.slice(0, 10) } : { dateTime: start, timeZone: 'Europe/Rome' },
    end: body.allDay ? { date: end.slice(0, 10) } : { dateTime: end, timeZone: 'Europe/Rome' },
  };
}

// ═══════════════════════════════
// CALENDAR
// ═══════════════════════════════

// Lista eventi
router.get('/calendar/events', async (req, res) => {
  const { timeMin, timeMax } = req.query;
  const events = await getEvents(req.user.id, timeMin, timeMax);
  res.json(events);
});

// Crea evento
router.post('/calendar/events', async (req, res) => {
  try {
    const evento = buildCalendarPayload(req.body || {});
    const result = await createEvent(req.user.id, evento);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Aggiorna evento
router.put('/calendar/events/:eventId', async (req, res) => {
  try {
    const evento = buildCalendarPayload(req.body || {});
    const result = await updateEvent(req.user.id, req.params.eventId, evento);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Elimina evento
router.delete('/calendar/events/:eventId', async (req, res) => {
  try {
    await deleteEvent(req.user.id, req.params.eventId);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ═══════════════════════════════
// DRIVE
// ═══════════════════════════════
const DRIVE_FOLDER = process.env.DRIVE_FOLDER || 'HORYGON';

// Lista file
router.get('/drive/files', async (req, res) => {
  const result = await getDriveFiles(req.user.id, DRIVE_FOLDER);
  res.json(result);
});

// Upload file su Drive
router.post('/drive/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nessun file' });
    const result = await uploadToDrive(
      req.user.id, DRIVE_FOLDER,
      req.file.originalname, req.file.mimetype, req.file.buffer
    );
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Elimina file da Drive
router.delete('/drive/files/:fileId', async (req, res) => {
  try {
    await deleteFromDrive(req.user.id, req.params.fileId);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GMAIL / MEPA
router.post('/gmail/mepa/sync', async (req, res) => {
  try {
    const result = await syncMepaGmail(req.user.id);
    const automation = await processMepaAutomation(req.user.id);
    res.json({ ...result, notifications: automation });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/gmail/mepa/messages', async (req, res) => {
  try {
    await processMepaAutomation(req.user.id);
    res.json(listMepaMailAlerts(req.user.id));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/gmail/mepa/messages/:id', async (req, res) => {
  try {
    const prev = getMepaMailAlertById(req.user.id, req.params.id);
    const alert = updateMepaMailAlert(req.user.id, req.params.id, req.body || {});
    if (prev?.google_event_id && (alert.stato === 'eliminata' || alert.sync_attiva === 0)) {
      try { await deleteEvent(req.user.id, prev.google_event_id); } catch {}
    }
    res.json(alert);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/notifications', async (req, res) => {
  try {
    await processMepaAutomation(req.user.id);
    res.json(listNotifications(req.user.id));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/notifications/:id', async (req, res) => {
  try {
    updateNotification(req.user.id, req.params.id, req.body || {});
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/contacts', async (req, res) => {
  try {
    res.json(await getGoogleContacts(req.user.id));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/contacts/sync', async (req, res) => {
  try {
    res.json(await syncLocalContactsToGoogle(req.user.id));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
