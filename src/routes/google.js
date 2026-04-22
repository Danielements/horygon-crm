const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authMiddleware } = require('../middleware/auth');
const { getEvents, createEvent, updateEvent, deleteEvent, getDriveFiles, uploadToDrive, deleteFromDrive } = require('../services/google');

const upload = multer({ storage: multer.memoryStorage() });

router.use(authMiddleware);

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
    const { title, start, end, description, allDay } = req.body;
    const evento = {
      summary: title,
      description: description || '',
      start: allDay ? { date: start } : { dateTime: start, timeZone: 'Europe/Rome' },
      end: allDay ? { date: end } : { dateTime: end, timeZone: 'Europe/Rome' },
    };
    const result = await createEvent(req.user.id, evento);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Aggiorna evento
router.put('/calendar/events/:eventId', async (req, res) => {
  try {
    const { title, start, end, description, allDay } = req.body;
    const evento = {
      summary: title,
      description: description || '',
      start: allDay ? { date: start } : { dateTime: start, timeZone: 'Europe/Rome' },
      end: allDay ? { date: end } : { dateTime: end, timeZone: 'Europe/Rome' },
    };
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

module.exports = router;
