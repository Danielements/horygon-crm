const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authMiddleware } = require('../middleware/auth');
const { parseCIGStream, getCIGAnalytics, scanCIGFolder } = require('../services/cig-parser');
const db = require('../db/database');

router.use(authMiddleware);

// Stato
router.get('/stato', (req, res) => {
  try {
    const tot = db.prepare('SELECT COUNT(*) as n FROM cig_stats').get();
    const anni = db.prepare('SELECT DISTINCT anno FROM cig_stats ORDER BY anno').all().map(r => r.anno);
    const log = db.prepare('SELECT * FROM cig_import_log ORDER BY data_import DESC').all();
    res.json({ totalRecords: tot.n, anni, importLog: log });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Analytics stagionalità
router.get('/analytics', (req, res) => {
  try { res.json(getCIGAnalytics()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Scan cartella data/cig/ (background)
router.post('/scan', (req, res) => {
  res.json({ ok: true, messaggio: 'Scan CIG avviato in background' });
  scanCIGFolder((p) => {
    console.log(`[CIG] ${p.totale} righe, ${p.horygon} match`);
  }).then(results => {
    console.log('[CIG] Scan completato:', results);
  }).catch(e => console.error('[CIG] Errore:', e.message));
});

// Upload file CIG
router.post('/upload', (req, res) => {
  const dataDir = path.join(process.cwd(), 'data', 'cig');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const storage = multer.diskStorage({ destination: dataDir, filename: (req, file, cb) => cb(null, file.originalname) });
  multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } }).single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Nessun file' });
    // Risponde subito, processa in background
    res.json({ ok: true, messaggio: 'Elaborazione avviata in background', file: req.file.originalname });
    parseCIGStream(req.file.path, req.file.originalname, (p) => {
      console.log(`[CIG] ${p.totale} righe, ${p.horygon} Horygon`);
    }).then(r => console.log('[CIG] Completato:', r))
      .catch(e => console.error('[CIG] Errore:', e.message));
  });
});

// Stagionalità per CPV specifico
router.get('/stagionalita/:cpv', (req, res) => {
  try {
    const p = req.params.cpv.substring(0, 6) + '%';
    const rows = db.prepare(`
      SELECT mese, SUM(n_gare) as n_gare, SUM(importo_totale) as importo
      FROM cig_stats WHERE cod_cpv LIKE ? GROUP BY mese ORDER BY mese
    `).all(p);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
