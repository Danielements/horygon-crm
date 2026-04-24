const express = require('express');
const multer = require('multer');
const { authMiddleware } = require('../middleware/auth');
const { importRdoWorkbook, getRdoMatches } = require('../services/rdo');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.use(authMiddleware);

router.get('/matches', (req, res) => {
  try {
    res.json({
      ok: true,
      ...getRdoMatches({
        importId: req.query.import_id ? Number(req.query.import_id) : null,
        q: req.query.q || '',
        matchedOnly: req.query.solo_match === '1',
      }),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Carica un file XLS o XLSX' });
    const imported = importRdoWorkbook(req.file.buffer, req.file.originalname);
    res.json({ ok: true, import: imported });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
