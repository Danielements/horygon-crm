const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authMiddleware } = require('../middleware/auth');
const {
  parseMepaCSV,
  scanAndImportAll,
  getMepaAnalytics,
  getMepaInactiveOpportunities,
  getCpvCatalogEntries,
  getActiveCpvPrefixes,
  saveCpvCatalogEntry,
  CPV_HORYGON,
} = require('../services/mepa-parser');
const db = require('../db/database');

router.use(authMiddleware);

router.get('/stato', (req, res) => {
  try {
    const cpvPrefixes = getActiveCpvPrefixes();
    const cpvWhere = cpvPrefixes.map(() => 'codice_cpv LIKE ?').join(' OR ') || '1=0';
    const cpvParams = cpvPrefixes.map(prefix => `${prefix}%`);
    const totRighe = db.prepare('SELECT COUNT(*) as n FROM mepa_ordini').get();
    const totRigheHorygon = db.prepare(`SELECT COUNT(*) as n FROM mepa_ordini WHERE ${cpvWhere}`).get(...cpvParams);
    const anni = db.prepare('SELECT DISTINCT anno FROM mepa_ordini ORDER BY anno DESC').all().map(r => r.anno);
    const importLog = db.prepare('SELECT * FROM mepa_import_log ORDER BY data_import DESC').all();
    const totValore = db.prepare('SELECT SUM(valore_economico) as tot FROM mepa_ordini').get();
    const totValoreHorygon = db.prepare(`SELECT SUM(valore_economico) as tot FROM mepa_ordini WHERE ${cpvWhere}`).get(...cpvParams);
    res.json({
      totalRecords: totRighe.n,
      totalRecordsHorygon: totRigheHorygon.n,
      anni,
      importLog,
      totValore: totValore.tot || 0,
      totValoreHorygon: totValoreHorygon.tot || 0,
      cpvMonitorati: getCpvCatalogEntries({ activeOnly: true }).length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/analytics', (req, res) => {
  try { res.json(getMepaAnalytics()); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

router.get('/opportunita-non-attive', (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    res.json(getMepaInactiveOpportunities(limit));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/cpv-catalog', (req, res) => {
  try {
    const activeOnly = req.query.attivo === '1';
    res.json(getCpvCatalogEntries({ activeOnly }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/cpv-operativi', (req, res) => {
  try {
    const entries = getCpvCatalogEntries({ activeOnly: true });
    const rows = entries.map(entry => {
      const prefix = String(entry.codice_cpv || '').replace(/[^0-9]/g, '').substring(0, 6);
      const prodotti = db.prepare(`
        SELECT p.id, p.nome, p.codice_interno,
          COALESCE(SUM(CASE
            WHEN m.tipo='carico' THEN m.quantita
            WHEN m.tipo IN ('scarico','reso') THEN -m.quantita
            WHEN m.tipo='rettifica' THEN m.quantita
            ELSE 0
          END),0) as giacenza
        FROM prodotti p
        JOIN prodotti_listini l ON l.prodotto_id = p.id
        LEFT JOIN magazzino_movimenti m ON m.prodotto_id = p.id
        WHERE p.attivo = 1 AND REPLACE(IFNULL(l.cpv,''),'-','') LIKE ?
        GROUP BY p.id
        ORDER BY p.nome
      `).all(`${prefix}%`);
      const mercato = db.prepare(`
        SELECT SUM(valore_economico) as valore, SUM(n_ordini) as ordini
        FROM mepa_ordini WHERE codice_cpv LIKE ?
      `).get(`${prefix}%`);
      const scorta = prodotti.reduce((sum, p) => sum + (p.giacenza || 0), 0);
      return {
        ...entry,
        prodotti_count: prodotti.length,
        prodotti,
        giacenza_totale: scorta,
        stato_operativo: !prodotti.length ? 'prodotto_assente' : scorta > 0 ? 'in_scorta' : 'da_acquistare',
        valore_mercato: mercato?.valore || 0,
        ordini_mercato: mercato?.ordini || 0
      };
    });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/cpv-catalog', (req, res) => {
  try {
    res.json({ ok: true, cpv: saveCpvCatalogEntry(req.body || {}) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/scan', (req, res) => {
  try { res.json({ ok: true, results: scanAndImportAll() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/upload', (req, res) => {
  const dataDir = path.join(process.cwd(), 'data', 'mepa');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const storage = multer.diskStorage({ destination: dataDir, filename: (req, file, cb) => cb(null, file.originalname) });
  multer({ storage }).single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Nessun file' });
    try {
      const content = fs.readFileSync(req.file.path, 'latin1');
      const result = parseMepaCSV(content, req.file.originalname);
      res.json({ ok: true, file: req.file.originalname, ...result });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

router.get('/cpv/:cpv', (req, res) => {
  try {
    const p = req.params.cpv.substring(0, 6) + '%';
    res.json({
      anni: db.prepare('SELECT anno, SUM(n_ordini) as n_ordini, SUM(valore_economico) as valore FROM mepa_ordini WHERE codice_cpv LIKE ? GROUP BY anno ORDER BY anno').all(p),
      regioni: db.prepare('SELECT regione_pa, SUM(valore_economico) as valore, SUM(n_ordini) as n_ordini FROM mepa_ordini WHERE codice_cpv LIKE ? GROUP BY regione_pa ORDER BY valore DESC').all(p),
      tipologie: db.prepare('SELECT tipologia_pa, SUM(valore_economico) as valore FROM mepa_ordini WHERE codice_cpv LIKE ? GROUP BY tipologia_pa ORDER BY valore DESC LIMIT 10').all(p),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
