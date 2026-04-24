const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authMiddleware } = require('../middleware/auth');
const {
  parseMepaCSV,
  scanAndImportAll,
  rebuildMepaFromFiles,
  getMepaAnalytics,
  getMepaInactiveOpportunities,
  getCpvCatalogEntries,
  getActiveCpvPrefixes,
  getActiveCpvFilter,
  hasActiveGovernance,
  saveCpvCatalogEntry,
  listEnabledCategories,
  saveEnabledCategory,
  setEnabledCategoryState,
  deleteEnabledCategory,
  previewCpvCatalogText,
  importCpvCatalogText,
  listUniqueMepaFiles,
  normalizeCpvCode,
  formatCpvCode,
} = require('../services/mepa-parser');
const db = require('../db/database');

router.use(authMiddleware);

router.get('/stato', (req, res) => {
  try {
    const categoryId = req.query.categoria_id ? Number(req.query.categoria_id) : null;
    const { where: cpvWhere, params: cpvParams } = getActiveCpvFilter('', categoryId);
    const totRighe = db.prepare('SELECT COUNT(*) as n FROM mepa_ordini').get();
    const totRigheHorygon = db.prepare(`SELECT COUNT(*) as n FROM mepa_ordini WHERE ${cpvWhere}`).get(...cpvParams);
    const anni = db.prepare('SELECT DISTINCT anno FROM mepa_ordini ORDER BY anno DESC').all().map(r => r.anno);
    const importLog = db.prepare('SELECT * FROM mepa_import_log ORDER BY data_import DESC').all();
    const totValore = db.prepare('SELECT SUM(valore_economico) as tot FROM mepa_ordini').get();
    const totValoreHorygon = db.prepare(`SELECT SUM(valore_economico) as tot FROM mepa_ordini WHERE ${cpvWhere}`).get(...cpvParams);
    const fileStats = listUniqueMepaFiles();
    res.json({
      totalRecords: totRighe.n,
      totalRecordsHorygon: totRigheHorygon.n,
      anni,
      importLog,
      totValore: totValore.tot || 0,
      totValoreHorygon: totValoreHorygon.tot || 0,
      cpvMonitorati: getCpvCatalogEntries({ activeOnly: true, categoryId }).length,
      categorieAbilitate: listEnabledCategories({ activeOnly: true, categoryId }).length,
      fileDuplicati: fileStats.filter(file => file.duplicateInFolder || file.alreadyImported).length,
      governanceReady: hasActiveGovernance(categoryId),
      categoriaId: categoryId,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/analytics', (req, res) => {
  try {
    const categoryId = req.query.categoria_id ? Number(req.query.categoria_id) : null;
    res.json(getMepaAnalytics(categoryId));
  }
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

router.get('/categorie-abilitate', (req, res) => {
  try {
    const activeOnly = req.query.attiva === '1';
    res.json(listEnabledCategories({ activeOnly }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/categorie-abilitate', (req, res) => {
  try {
    res.json({ ok: true, categoria: saveEnabledCategory(req.body || {}) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/categorie-abilitate/:id', (req, res) => {
  try {
    res.json({ ok: true, categoria: setEnabledCategoryState(req.params.id, req.body?.attiva) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/categorie-abilitate/:id', (req, res) => {
  try {
    res.json(deleteEnabledCategory(req.params.id));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/cpv-operativi', (req, res) => {
  try {
    const entries = getCpvCatalogEntries({ activeOnly: true });
    const rows = entries.map(entry => {
      const prefix = normalizeCpvCode(entry.codice_cpv, { keepCheckDigit: true }).substring(0, 8);
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

router.get('/cpv-search', (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    const categoryId = req.query.categoria_id ? Number(req.query.categoria_id) : null;
    const normalized = normalizeCpvCode(query, { keepCheckDigit: true });
    const matchKey = normalized.substring(0, 8);

    const catalog = getCpvCatalogEntries({ activeOnly: true, categoryId });
    const filtered = catalog
      .filter(entry => {
        const entryDisplay = formatCpvCode(entry.codice_cpv);
        const entryKey = normalizeCpvCode(entry.codice_cpv, { keepCheckDigit: true }).substring(0, 8);
        if (!query) return true;
        if (matchKey && entryKey.startsWith(matchKey)) return true;
        return entryDisplay.toLowerCase().includes(query.toLowerCase()) || String(entry.desc || '').toLowerCase().includes(query.toLowerCase());
      })
      .slice(0, 20)
      .map(entry => {
        const entryKey = normalizeCpvCode(entry.codice_cpv, { keepCheckDigit: true }).substring(0, 8);
        const mercato = db.prepare(`
          SELECT
            SUM(valore_economico) as valore_totale,
            SUM(n_ordini) as ordini_totali,
            COUNT(DISTINCT anno) as anni_coperti
          FROM mepa_ordini
          WHERE codice_cpv LIKE ?
        `).get(`${entryKey}%`);

        return {
          ...entry,
          codice_cpv_display: formatCpvCode(entry.codice_cpv),
          valore_totale: mercato?.valore_totale || 0,
          ordini_totali: mercato?.ordini_totali || 0,
          anni_coperti: mercato?.anni_coperti || 0,
        };
      });

    res.json({ ok: true, query, results: filtered });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/cpv-catalog', (req, res) => {
  try {
    res.json({ ok: true, cpv: saveCpvCatalogEntry(req.body || {}) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/cpv-import', (req, res) => {
  multer({ storage: multer.memoryStorage() }).single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      const body = req.body || {};
      const textBody = String(body.testo || '');
      const fileText = req.file ? req.file.buffer.toString('utf8') : '';
      const rawText = textBody || fileText;
      if (!rawText.trim()) return res.status(400).json({ error: 'Carica un file testo/CSV o incolla i CPV' });
      const result = importCpvCatalogText(rawText, {
        categoria: body.categoria,
        categoria_id: body.categoria_id,
        fonte: body.fonte || req.file?.originalname || '',
        priorita: body.priorita,
        attivo: body.attivo === '0' ? 0 : 1,
        descrizione_categoria: body.descrizione_categoria || '',
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
});

router.post('/cpv-preview', (req, res) => {
  multer({ storage: multer.memoryStorage() }).single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      const body = req.body || {};
      const textBody = String(body.testo || '');
      const fileText = req.file ? req.file.buffer.toString('utf8') : '';
      const rawText = textBody || fileText;
      if (!rawText.trim()) return res.status(400).json({ error: 'Carica un file testo/CSV o incolla i CPV' });
      const preview = previewCpvCatalogText(rawText, {
        categoria: body.categoria,
      });
      res.json({ ok: true, ...preview });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
});

router.post('/scan', (req, res) => {
  try { res.json({ ok: true, results: scanAndImportAll() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/rebuild', (req, res) => {
  try { res.json({ ok: true, results: rebuildMepaFromFiles() }); }
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
    const p = normalizeCpvCode(req.params.cpv, { keepCheckDigit: true }).substring(0, 8) + '%';
    res.json({
      anni: db.prepare('SELECT anno, SUM(n_ordini) as n_ordini, SUM(valore_economico) as valore FROM mepa_ordini WHERE codice_cpv LIKE ? GROUP BY anno ORDER BY anno').all(p),
      regioni: db.prepare('SELECT regione_pa, SUM(valore_economico) as valore, SUM(n_ordini) as n_ordini FROM mepa_ordini WHERE codice_cpv LIKE ? GROUP BY regione_pa ORDER BY valore DESC').all(p),
      tipologie: db.prepare('SELECT tipologia_pa, SUM(valore_economico) as valore FROM mepa_ordini WHERE codice_cpv LIKE ? GROUP BY tipologia_pa ORDER BY valore DESC LIMIT 10').all(p),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
