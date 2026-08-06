const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const { listSettings, saveSettings } = require('../services/google');
const { writeAudit } = require('../services/audit');
const { writeSystemLog } = require('../services/system-log');
const { ensureSdiSettingsSeed, runSdiDiagnostics } = require('../services/sdi');

router.use(authMiddleware);

router.get('/stats/overview', (req, res) => {
  const mailRicevute = db.prepare(`SELECT COUNT(*) as n FROM mepa_mail_alerts WHERE sync_attiva = 1`).get().n;
  const mailNuove = db.prepare(`SELECT COUNT(*) as n FROM mepa_mail_alerts WHERE sync_attiva = 1 AND stato = 'nuova'`).get().n;
  const scadenze = db.prepare(`
    SELECT COUNT(*) as n FROM mepa_mail_alerts
    WHERE sync_attiva = 1 AND stato NOT IN ('eliminata','archiviata','scaduta')
      AND scadenza_offerte IS NOT NULL
      AND date(substr(scadenza_offerte,7,4) || '-' || substr(scadenza_offerte,4,2) || '-' || substr(scadenza_offerte,1,2))
          BETWEEN date('now') AND date('now', '+7 day')
  `).get().n;
  const attivitaSettimana = db.prepare(`SELECT COUNT(*) as n FROM attivita WHERE datetime(creato_il) >= datetime('now','-7 day')`).get().n;
  const appuntamentiSettimana = db.prepare(`SELECT COUNT(*) as n FROM attivita WHERE tipo='appuntamento' AND datetime(creato_il) >= datetime('now','-7 day')`).get().n;
  const notificheDaLeggere = db.prepare(`SELECT COUNT(*) as n FROM notifiche_app WHERE letta = 0`).get().n;
  const recenti = db.prepare(`
    SELECT 'mail' as tipo, oggetto as titolo, creato_il as data, stato
    FROM mepa_mail_alerts
    WHERE sync_attiva = 1
    UNION ALL
    SELECT 'attivita' as tipo, oggetto as titolo, creato_il as data, esito as stato
    FROM attivita
    ORDER BY data DESC
    LIMIT 20
  `).all();
  res.json({
    kpi: { mailRicevute, mailNuove, scadenze, attivitaSettimana, appuntamentiSettimana, notificheDaLeggere },
    recenti
  });
});

router.get('/settings', requirePermesso('utenti', 'admin'), (req, res) => {
  ensureSdiSettingsSeed();
  res.json(listSettings());
});

router.put('/settings', requirePermesso('utenti', 'admin'), (req, res) => {
  res.json(saveSettings(req.body?.items || []));
});

router.get('/sdi/diagnostics', requirePermesso('utenti', 'admin'), async (req, res) => {
  const result = await runSdiDiagnostics({ includeNetwork: false });
  res.json(result);
});

router.post('/sdi/test', requirePermesso('utenti', 'admin'), async (req, res) => {
  const result = await runSdiDiagnostics({ includeNetwork: true });
  writeAudit({
    utente_id: req.user.id,
    azione: 'sdi.test.run',
    entita_tipo: 'sdi',
    dettagli: {
      overallStatus: result.overallStatus,
      mode: result.mode,
      checks: result.checks.map((check) => ({ label: check.label, status: check.status, message: check.message }))
    }
  });
  writeSystemLog({
    livello: result.overallStatus === 'error' ? 'error' : result.overallStatus === 'warning' ? 'warning' : 'info',
    origine: 'sdi.test',
    route: '/api/system/sdi/test',
    metodo: 'POST',
    utente_id: req.user.id,
    messaggio: `Test SDI completato con stato ${result.overallStatus}`,
    dettagli: {
      mode: result.mode,
      includeNetwork: result.includeNetwork,
      checks: result.checks
    }
  });
  res.json(result);
});

router.get('/public-config', (req, res) => {
  res.json({
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    webPushPublicKey: process.env.WEB_PUSH_PUBLIC_KEY || '',
    webPushEnabled: !!(process.env.WEB_PUSH_PUBLIC_KEY && process.env.WEB_PUSH_PRIVATE_KEY)
  });
});

module.exports = router;
