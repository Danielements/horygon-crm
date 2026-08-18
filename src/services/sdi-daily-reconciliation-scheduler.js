// Scheduler della riconciliazione giornaliera SdI.
//
// Gated da ENV, **disabilitato di default**: un job che tocca un canale fiscale
// non deve partire da solo senza che qualcuno lo abbia acceso di proposito.
//
//   SDI_DAILY_RECONCILIATION_ENABLED=true
//   SDI_DAILY_RECONCILIATION_CRON=0 6 * * *
//   SDI_DAILY_RECONCILIATION_LOOKBACK_DAYS=7
//
// In firma manuale ogni esecuzione prepara le richieste e le lascia in
// SIGNATURE_REQUIRED: l'operatore le firma dalla dashboard. Non c'e' rete finche'
// non si firma.

const cron = require('node-cron');
const { writeSystemLog } = require('./system-log');
const { parseConfig, runDailyReconciliation } = require('./sdi-daily-reconciliation');

let task = null;

function startDailyReconciliationScheduler({ tenantId = 1 } = {}) {
  if (task) return task;
  const cfg = parseConfig();
  if (!cfg.enabled) {
    writeSystemLog({
      livello: 'info',
      origine: 'sdi.riconciliazione.scheduler',
      messaggio: 'Riconciliazione giornaliera SdI disabilitata (SDI_DAILY_RECONCILIATION_ENABLED != true)'
    });
    return null;
  }
  if (!cron.validate(cfg.cron)) {
    writeSystemLog({
      livello: 'error',
      origine: 'sdi.riconciliazione.scheduler',
      messaggio: `CRON non valido: "${cfg.cron}" — scheduler non avviato`
    });
    return null;
  }

  task = cron.schedule(cfg.cron, () => {
    runDailyReconciliation({ tenantId, trigger: 'schedule' }).catch((error) => {
      writeSystemLog({
        livello: 'error',
        origine: 'sdi.riconciliazione.scheduler',
        messaggio: `Riconciliazione giornaliera fallita: ${error.message}`,
        stack: error.stack || null
      });
    });
  }, { timezone: 'Europe/Rome' });

  writeSystemLog({
    livello: 'info',
    origine: 'sdi.riconciliazione.scheduler',
    messaggio: `Riconciliazione giornaliera SdI attiva (cron "${cfg.cron}", lookback ${cfg.lookbackDays}g)`
  });
  return task;
}

function stopDailyReconciliationScheduler() {
  if (task) { task.stop(); task = null; }
}

module.exports = { startDailyReconciliationScheduler, stopDailyReconciliationScheduler };
