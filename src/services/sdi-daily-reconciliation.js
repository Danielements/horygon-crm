// Riconciliazione giornaliera di sicurezza delle fatture SdI via SMTS.
//
// NON e' un sostituto del realtime: le emesse escono con SdIRiceviFile e la loro
// ricevuta rientra su TrasmissioneFatture; le ricevute arrivano su
// RicezioneFatture. Questo job e' solo una **rete di sicurezza** giornaliera che
// ripesca cio' che, per un fermo o perche' consegnato su un altro canale (es.
// Pass.go del commercialista), non e' finito nel CRM.
//
// Non duplica nulla del motore SMTS: crea un job storico con `createJob`, lo
// prepara con `prepareRequest`, e lascia avanzare il pilota `advanceJobs`. La
// deduplicazione (IdentificativoSdI -> SHA256) e l'import sono quelli gia'
// collaudati (`sdi-import-pipeline`). Con firma manuale (`external`) il job resta
// in `CREATED` = **richiesta firma**, e non parte alcuna chiamata di rete: la
// rete inizia solo dopo che una persona ha caricato il `.p7m`.

const db = require('../db/database');
const { writeSystemLog } = require('./system-log');
const { writeAudit } = require('./audit');
const {
  addDays, createJob, getJob, summarizeJob
} = require('./sdi-historical-sync');
const { prepareRequest } = require('./sdi-backfill');
const { advanceJobs } = require('./sdi-backfill-scheduler');
const { getRemoteSignatureProvider } = require('./sdi-remote-signature');

// INCOMING = FattureRicevute (CESSIONARIO), OUTGOING = FattureEmesse (CEDENTE).
// Le emesse dal CRM saranno di norma gia' presenti: OUTGOING serve a scoprire
// quelle emesse fuori dal CRM o perse per un errore di sincronizzazione.
const DIRECTIONS = [
  { key: 'incoming', requestType: 'INCOMING' },
  { key: 'outgoing', requestType: 'OUTGOING' }
];

// Gli stati che il pilota sa avanzare: se il job e' qui, un passo lo porta avanti.
const ADVANCEABLE = new Set(['SIGNED', 'SUBMITTED', 'PROCESSING', 'READY', 'DOWNLOADING']);

// --- helper puri (testabili senza DB ne' rete) ----------------------------

function parseConfig(env = process.env) {
  const enabled = String(env.SDI_DAILY_RECONCILIATION_ENABLED ?? 'false').trim().toLowerCase() === 'true';
  const cron = String(env.SDI_DAILY_RECONCILIATION_CRON || '0 6 * * *').trim();
  const n = Number(env.SDI_DAILY_RECONCILIATION_LOOKBACK_DAYS);
  const lookbackDays = Number.isFinite(n) && n > 0 ? Math.floor(n) : 7;
  return { enabled, cron, lookbackDays };
}

function toISODate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// Finestra mobile [oggi - lookback, oggi]. L'overlap e' voluto: la
// deduplicazione rende sicuro ricontrollare un periodo gia' acquisito.
function computeWindow(now = new Date(), lookbackDays = 7) {
  const to = toISODate(now);
  const from = addDays(to, -Math.abs(lookbackDays));
  return { from, to };
}

function emptyCounters() {
  return { checked: 0, alreadyPresent: 0, newInvoices: 0, imported: 0, errors: 0 };
}

// Stato leggibile del job per la dashboard/ricerca.
function classifyJobState(job) {
  if (!job) return 'UNKNOWN';
  if (job.status === 'CREATED') return job.request_xml_path ? 'SIGNATURE_REQUIRED' : 'PENDING';
  if (job.status === 'COMPLETED') return 'COMPLETED';
  if (job.status === 'PARTIAL') return 'PARTIAL';
  if (job.status === 'FAILED') return 'FAILED';
  if (job.status === 'EXPIRED') return 'EXPIRED';
  return 'IN_PROGRESS';
}

// Mappa i contatori del job (documents_found/duplicates/documents_imported/
// unmatched) sullo schema richiesto. `newInvoices` = documenti nuovi importati;
// `alreadyPresent` = duplicati riconosciuti dalla deduplica; `errors` = documenti
// non classificabili.
function mapCounters(job, outcomes = []) {
  const by = {};
  for (const o of (outcomes || [])) by[o.outcome] = Number(o.n) || 0;
  const imported = Number(job.documents_imported ?? by.IMPORTED ?? 0) || 0;
  const alreadyPresent = Number(job.duplicates ?? by.DUPLICATE ?? 0) || 0;
  const errors = Number(job.unmatched ?? by.UNMATCHED ?? 0) || 0;
  const checked = Number(job.documents_found ?? (imported + alreadyPresent + errors)) || 0;
  return { checked, alreadyPresent, newInvoices: imported, imported, errors };
}

// --- orchestrazione (usa il motore esistente) -----------------------------

// No-stacking: una sola richiesta preparata e non firmata per direzione. Cosi'
// una cadenza giornaliera in firma manuale non impila sette richieste da firmare.
function pendingUnsignedJob(tenantId, requestType) {
  return db.prepare(`
    SELECT * FROM sdi_historical_sync_job
    WHERE tenant_id = ? AND request_type = ? AND status = 'CREATED' AND request_xml_path IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(tenantId, requestType);
}

function activeJobForWindow(tenantId, requestType, from, to) {
  return db.prepare(`
    SELECT * FROM sdi_historical_sync_job
    WHERE tenant_id = ? AND request_type = ? AND date_from = ? AND date_to = ?
      AND status NOT IN ('COMPLETED', 'FAILED', 'EXPIRED')
    ORDER BY id DESC LIMIT 1
  `).get(tenantId, requestType, from, to);
}

function classify(job) {
  const state = classifyJobState(job);
  if (state === 'SIGNATURE_REQUIRED' || state === 'PENDING') {
    return { jobId: job.id, state, counters: emptyCounters() };
  }
  const summary = summarizeJob(job.id) || { outcomes: [] };
  return { jobId: job.id, state, counters: mapCounters(job, summary.outcomes) };
}

async function runDirection({ tenantId, requestType, from, to, utenteId = null, client = null }) {
  // 1) c'e' gia' una richiesta pronta ma non firmata? non ne creo un'altra.
  const pending = pendingUnsignedJob(tenantId, requestType);
  if (pending) {
    return { jobId: pending.id, state: 'SIGNATURE_REQUIRED', counters: emptyCounters(), reused: true };
  }

  // 2) c'e' gia' un job attivo per questa esatta finestra? lo riuso, non ricreo.
  let job = activeJobForWindow(tenantId, requestType, from, to);
  if (!job) {
    job = createJob({ tenantId, requestType, dateFrom: from, dateTo: to, utenteId });
    try {
      await prepareRequest({ tenantId, jobId: job.id, utenteId });
    } catch (error) {
      return { jobId: job.id, state: 'ERROR', counters: { ...emptyCounters(), errors: 1 }, error: error.message };
    }
    job = getJob(job.id);
  }

  // 3) firma remota, se un giorno ci sara'. Oggi torna null -> resta CREATED.
  if (job.status === 'CREATED') {
    const provider = getRemoteSignatureProvider();
    if (provider && typeof provider.isAvailable === 'function' && provider.isAvailable()) {
      await provider.signJob({ jobId: job.id, tenantId, utenteId });
      job = getJob(job.id);
    }
  }

  // 4) se firmato, un passo di avanzamento; il pilota completa nelle passate dopo.
  if (ADVANCEABLE.has(job.status)) {
    await advanceJobs({ tenantId, client, utenteId });
    job = getJob(job.id);
  }

  return classify(job);
}

function recordRun({ tenantId, trigger, window, incomingJobId, outgoingJobId, summary }) {
  const result = db.prepare(`
    INSERT INTO sdi_daily_reconciliation_run
      (tenant_id, trigger, window_from, window_to, incoming_job_id, outgoing_job_id, summary)
    VALUES (?,?,?,?,?,?,?)
  `).run(tenantId, trigger, window.from, window.to, incomingJobId || null, outgoingJobId || null, JSON.stringify(summary || {}));
  return Number(result.lastInsertRowid);
}

async function runDailyReconciliation({
  now = new Date(), tenantId = 1, utenteId = null, trigger = 'schedule',
  client = null, lookbackDays = null
} = {}) {
  const cfg = parseConfig();
  const lookback = Number.isFinite(lookbackDays) && lookbackDays > 0 ? lookbackDays : cfg.lookbackDays;
  const window = computeWindow(now, lookback);

  const out = { trigger, window, incoming: null, outgoing: null };
  const jobIds = { incoming: null, outgoing: null };

  for (const dir of DIRECTIONS) {
    let res;
    try {
      res = await runDirection({ tenantId, requestType: dir.requestType, from: window.from, to: window.to, utenteId, client });
    } catch (error) {
      res = { jobId: null, state: 'ERROR', counters: { ...emptyCounters(), errors: 1 }, error: error.message };
    }
    out[dir.key] = { ...res.counters, state: res.state, jobId: res.jobId || null, ...(res.error ? { error: res.error } : {}) };
    jobIds[dir.key] = res.jobId || null;
    // log separato per direzione
    writeSystemLog({
      livello: res.state === 'ERROR' ? 'error' : 'info',
      origine: `sdi.riconciliazione.${dir.key}`,
      messaggio: `Riconciliazione ${dir.key} ${window.from}..${window.to}: ${res.state}`,
      dettagli: out[dir.key]
    });
  }

  const runId = recordRun({
    tenantId, trigger, window,
    incomingJobId: jobIds.incoming, outgoingJobId: jobIds.outgoing,
    summary: { incoming: out.incoming, outgoing: out.outgoing }
  });

  writeAudit({
    utente_id: utenteId,
    azione: 'SDI_DAILY_RECONCILIATION_RUN',
    entita_tipo: 'sdi_daily_reconciliation_run',
    entita_id: runId,
    dettagli: { trigger, window, incoming: out.incoming, outgoing: out.outgoing }
  });

  return { runId, ...out };
}

module.exports = {
  DIRECTIONS,
  parseConfig,
  computeWindow,
  toISODate,
  emptyCounters,
  classifyJobState,
  mapCounters,
  pendingUnsignedJob,
  activeJobForWindow,
  runDirection,
  runDailyReconciliation
};
