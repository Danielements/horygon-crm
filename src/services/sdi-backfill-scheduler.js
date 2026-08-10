const db = require('../db/database');
const { getSetting } = require('./google');
const { writeSystemLog } = require('./system-log');
const { getMassiveClient } = require('./sdi-massive-transport');
const { downloadArchives, importArchives, pollRequest, submitRequest } = require('./sdi-backfill');

// Avanzamento automatico dei job di backfill.
//
// Di tutto il ciclo SMTS un solo passo richiede una persona: la firma
// qualificata della richiesta, che con FirmaOK vuole PIN e OTP e non ha API.
// Tutto il resto - inoltro, attesa dell'esito, scarico, import - e' meccanico
// e non ha motivo di essere fatto a mano.
//
// Quindi: l'operatore firma, e da li' in poi il job cammina da solo.
//
// Un passo per job a ogni giro, non tutti in fila: cosi' una passata resta
// breve e prevedibile, e un job che si incarta non blocca gli altri.

const MAINTENANCE_TIMEZONE = 'Europe/Rome';
const DEFAULT_PASS_MINUTES = 15;
const DEFAULT_ESITO_MINUTES = 30;

// Stati che il pilota automatico sa far avanzare. CREATED non c'e': e' quello
// che attende la firma, e nessuno puo' firmare al posto dell'operatore.
const AUTOMATABLE = ['SIGNED', 'SUBMITTED', 'PROCESSING', 'READY', 'DOWNLOADING'];

function isAutoEnabled() {
  return String(getSetting('sdi.massive.auto', '0') || '0').trim() === '1';
}

function minutesSetting(key, fallback) {
  const value = Number(getSetting(key, String(fallback)));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// L'Accordo di Servizio prevede manutenzione fra 00:00 e 00:59: in quella
// fascia non si interroga nulla. L'ora e' quella italiana, non quella del
// container, che in produzione gira su UTC.
function isMaintenanceWindow(now = new Date()) {
  try {
    const ora = new Intl.DateTimeFormat('it-IT', {
      timeZone: MAINTENANCE_TIMEZONE, hour: '2-digit', hour12: false
    }).format(now);
    return Number(ora) === 0;
  } catch {
    return now.getUTCHours() === 23 || now.getUTCHours() === 0;
  }
}

// Le interrogazioni di esito sono dieci in tutto per richiesta: vanno spalmate,
// altrimenti si esauriscono in mezz'ora e poi non si sa piu' se il file e'
// pronto.
function shouldPoll(job, now, minIntervalMinutes) {
  if (!job.esito_last_at) return true;
  const last = Date.parse(`${String(job.esito_last_at).replace(' ', 'T')}Z`);
  if (!Number.isFinite(last)) return true;
  return (now.getTime() - last) >= minIntervalMinutes * 60 * 1000;
}

async function advanceJobs({ tenantId, client = null, now = new Date(), utenteId = null } = {}) {
  if (isMaintenanceWindow(now)) {
    return { saltato: 'finestra di manutenzione SdI (00:00-00:59)', azioni: [], errori: [] };
  }

  const jobs = db.prepare(`
    SELECT * FROM sdi_historical_sync_job
    WHERE tenant_id = ? AND status IN (${AUTOMATABLE.map(() => '?').join(',')})
    ORDER BY id
  `).all(tenantId, ...AUTOMATABLE);

  if (!jobs.length) return { azioni: [], errori: [], jobsEsaminati: 0 };

  const smts = client || getMassiveClient();
  const minEsito = minutesSetting('sdi.massive.esito.min_interval_minutes', DEFAULT_ESITO_MINUTES);
  const azioni = [];
  const errori = [];

  for (const job of jobs) {
    // Le fatture messe a disposizione non si scaricano da sole: quel download
    // vale come presa visione fiscale e resta una decisione di una persona.
    if (job.request_type === 'AVAILABLE_TO_RECIPIENT' && ['READY', 'DOWNLOADING'].includes(job.status)) {
      azioni.push({ jobId: job.id, passo: 'saltato', motivo: 'presa visione: richiede conferma manuale' });
      continue;
    }

    try {
      if (job.status === 'SIGNED') {
        const esito = await submitRequest({ jobId: job.id, tenantId, client: smts, utenteId });
        azioni.push({ jobId: job.id, passo: 'inoltra', idRichiesta: esito.idRichiesta });
      } else if (job.status === 'SUBMITTED' || job.status === 'PROCESSING') {
        if (!shouldPoll(job, now, minEsito)) {
          azioni.push({ jobId: job.id, passo: 'attesa', motivo: `prossima interrogazione fra meno di ${minEsito} minuti` });
          continue;
        }
        const esito = await pollRequest({ jobId: job.id, tenantId, client: smts, utenteId });
        azioni.push({ jobId: job.id, passo: 'esito', stato: esito.status, interrogazioniRimaste: esito.interrogazioniRimaste });
      } else if (job.status === 'READY') {
        const esito = await downloadArchives({ jobId: job.id, tenantId, client: smts, utenteId, now });
        azioni.push({ jobId: job.id, passo: 'scarica', archivi: esito.scaricati.length, falliti: esito.falliti.length });
      } else if (job.status === 'DOWNLOADING') {
        // dryRun null: decide il flag del job, cosi' una pianificazione fatta
        // in simulazione non finisce per importare davvero.
        const esito = await importArchives({ jobId: job.id, tenantId, dryRun: null, utenteId });
        azioni.push({ jobId: job.id, passo: 'importa', stato: esito.status, dryRun: esito.dryRun });
      }
    } catch (error) {
      errori.push({ jobId: job.id, passo: job.status, errore: error.message, code: error.code || null });
    }
  }

  if (azioni.length || errori.length) {
    writeSystemLog({
      livello: errori.length ? 'warning' : 'info',
      origine: 'sdi.storico.auto',
      messaggio: `Backfill automatico: ${azioni.length} azioni, ${errori.length} errori`,
      dettagli: { azioni, errori }
    });
  }
  return { azioni, errori, jobsEsaminati: jobs.length };
}

let timer = null;

// Avviato dal processo principale. Non fa nulla finche' sdi.massive.auto non
// vale 1: un pilota automatico che parte da solo su un canale fiscale sarebbe
// una brutta sorpresa.
function startBackfillScheduler({ tenantId = 1 } = {}) {
  if (timer) return timer;
  const minutes = minutesSetting('sdi.massive.auto.interval_minutes', DEFAULT_PASS_MINUTES);
  timer = setInterval(() => {
    if (!isAutoEnabled()) return;
    advanceJobs({ tenantId }).catch((error) => {
      writeSystemLog({
        livello: 'error',
        origine: 'sdi.storico.auto',
        messaggio: `Passata automatica fallita: ${error.message}`,
        stack: error.stack || null
      });
    });
  }, minutes * 60 * 1000);
  // Non deve tenere vivo il processo se tutto il resto e' fermo.
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function stopBackfillScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  AUTOMATABLE,
  advanceJobs,
  isAutoEnabled,
  isMaintenanceWindow,
  shouldPoll,
  startBackfillScheduler,
  stopBackfillScheduler
};
