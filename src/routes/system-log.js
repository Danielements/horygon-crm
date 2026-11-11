const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { listSystemLogs, clearSystemLogs } = require('../services/system-log');

router.use(authMiddleware);

router.use((req, res, next) => {
  if (req.user?.ruolo_id !== 4) return res.status(403).json({ error: 'Accesso riservato al superadmin' });
  next();
});

router.get('/', (req, res) => {
  const rows = listSystemLogs({
    level: req.query.level || '',
    origin: req.query.origin || '',
    q: req.query.q || '',
    limit: req.query.limit || 200
  });
  const stats = {
    totale: rows.length,
    errori: rows.filter(r => r.livello === 'error').length,
    warning: rows.filter(r => r.livello === 'warn').length,
    origini: [...new Set(rows.map(r => r.origine).filter(Boolean))].length
  };
  res.json({ rows, stats });
});

router.delete('/', (req, res) => {
  clearSystemLogs();
  res.json({ ok: true });
});

module.exports = router;
