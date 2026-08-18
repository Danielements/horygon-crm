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
  addDays, addMonths, createJob, getJob, summarizeJob
} = require('./sdi-historical-sync');
const { prepareRequest } = require('./sdi-backfill');
const { advanceJobs } = require('./sdi-backfill-scheduler');
const { getQualifiedSignatureProvider } = require('./sdi-qualified-signature');

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
  // Overlap con l'ultima riconciliazione completata: quanti giorni riprendere
  // all'indietro dal punto di ripresa. Default = lookback.
  const o = Number(env.SDI_DAILY_RECONCILIATION_OVERLAP_DAYS);
  const overlapDays = Number.isFinite(o) && o >= 0 ? Math.floor(o) : lookbackDays;
  return { enabled, cron, lookbackDays, overlapDays };
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

// Ultimo `to` di una riconciliazione andata a buon fine per la direzione: e' il
// punto di ripresa. Deriva dai job del motore (nessuna tabella nuova).
function lastSuccessfulTo(tenantId, requestType) {
  const row = db.prepare(`
    SELECT MAX(date_to) AS m FROM sdi_historical_sync_job
    WHERE tenant_id = ? AND request_type = ? AND status IN ('COMPLETED','PARTIAL')
  `).get(tenantId, requestType);
  return row && row.m ? row.m : null;
}

// Finestra ancorata (tuo §7): la nuova richiesta riparte da
// lastSuccessfulTo - overlap (non da oggi-7 fisso), cosi' i giorni di un periodo
// saltato non sfuggono. Clampata a ~3 mesi (controllo SMTS 00201). Al primo giro,
// senza storico, ripiega su [oggi-lookback, oggi].
// Matematica pura della finestra, isolata per essere testabile senza DB.
function windowFromAnchor(to, anchor, { overlapDays = 7, lookbackDays = 7 } = {}) {
  let from = anchor ? addDays(anchor, -Math.abs(overlapDays)) : addDays(to, -Math.abs(lookbackDays));
  const minFrom = addMonths(to, -3);
  if (from < minFrom) from = minFrom;
  if (from > to) from = to;
  return { from, to, anchor: anchor || null };
}

function computeWindowForDirection(now, tenantId, requestType, opts = {}) {
  const to = toISODate(now);
  const anchor = lastSuccessfulTo(tenantId, requestType);
  return windowFromAnchor(to, anchor, opts);
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

async function runDirection({ tenantId, requestType, utenteId = null, client = null, now = new Date(), config = null }) {
  const cfg = config || parseConfig();
  const window = computeWindowForDirection(now, tenantId, requestType, { overlapDays: cfg.overlapDays, lookbackDays: cfg.lookbackDays });

  // 1) richiesta pronta ma non firmata? non ne creo un'altra (no-stacking).
  const pending = pendingUnsignedJob(tenantId, requestType);
  if (pending) {
    return {
      jobId: pending.id, state: 'SIGNATURE_REQUIRED', counters: emptyCounters(), reused: true,
      window: { from: pending.date_from, to: pending.date_to }
    };
  }

  // 2) job gia' attivo per questa finestra? lo riuso, non ricreo.
  let job = activeJobForWindow(tenantId, requestType, window.from, window.to);
  if (!job) {
    job = createJob({ tenantId, requestType, dateFrom: window.from, dateTo: window.to, utenteId });
    try {
      await prepareRequest({ tenantId, jobId: job.id, utenteId });
    } catch (error) {
      return { jobId: job.id, state: 'ERROR', counters: { ...emptyCounters(), errors: 1 }, error: error.message, window };
    }
    job = getJob(job.id);
  }

  // 3) firma automatica solo se il provider lo e' (oggi: mai -> resta CREATED).
  if (job.status === 'CREATED') {
    const provider = getQualifiedSignatureProvider();
    if (provider.isAutomatic()) {
      await provider.sign({ jobId: job.id, tenantId, utenteId });
      job = getJob(job.id);
    }
  }

  // 4) se firmato, un passo; il pilota completa nelle passate dopo.
  if (ADVANCEABLE.has(job.status)) {
    await advanceJobs({ tenantId, client, utenteId });
    job = getJob(job.id);
  }

  return { ...classify(job), window };
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
  now = new Date(), tenantId = 1, utenteId = null, trigger = 'schedule', client = null
} = {}) {
  const cfg = parseConfig();
  const out = { trigger, incoming: null, outgoing: null };
  const jobIds = { incoming: null, outgoing: null };
  const froms = [];

  for (const dir of DIRECTIONS) {
    let res;
    try {
      res = await runDirection({ tenantId, requestType: dir.requestType, utenteId, client, now, config: cfg });
    } catch (error) {
      res = { jobId: null, state: 'ERROR', counters: { ...emptyCounters(), errors: 1 }, error: error.message, window: null };
    }
    const win = res.window || null;
    out[dir.key] = { ...res.counters, state: res.state, jobId: res.jobId || null, window: win, ...(res.error ? { error: res.error } : {}) };
    jobIds[dir.key] = res.jobId || null;
    if (win && win.from) froms.push(win.from);
    // log separato per direzione
    writeSystemLog({
      livello: res.state === 'ERROR' ? 'error' : 'info',
      origine: `sdi.riconciliazione.${dir.key}`,
      messaggio: `Riconciliazione ${dir.key} ${win ? win.from + '..' + win.to : '(finestra n/d)'}: ${res.state}`,
      dettagli: out[dir.key]
    });
  }

  // Finestra complessiva per il record: to = oggi, from = il piu' vecchio dei due.
  const to = toISODate(now);
  const window = { from: froms.length ? froms.slice().sort()[0] : to, to };

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

  return { runId, window, ...out };
}

// --- ricerca di una fattura attesa (generica, qualunque controparte) -------

const SEARCH_STATES = {
  PRESENT: 'PRESENTE NEL CRM',
  IMPORTED_FROM_SDI: 'TROVATA SU SDI E IMPORTATA',
  NOT_PRESENT: 'NON PRESENTE NEL CRM',
  SIGNATURE_REQUIRED: 'RICHIESTA FIRMA SMTS'
};

function safeParse(json) {
  try { return JSON.parse(json); } catch { return null; }
}

// Un job SMTS (riconciliazione o backfill) non concluso la cui finestra copre
// l'intervallo cercato: se e' in attesa di firma, la fattura potrebbe arrivare
// proprio da li'.
function coveringPendingJob(tenantId, dataDa, dataA) {
  const rows = db.prepare(`
    SELECT * FROM sdi_historical_sync_job
    WHERE tenant_id = ? AND request_type IN ('INCOMING','OUTGOING')
      AND status NOT IN ('COMPLETED','FAILED','EXPIRED')
    ORDER BY id DESC LIMIT 30
  `).all(tenantId);
  if (!dataDa && !dataA) return rows[0] || null;
  return rows.find((j) => (!dataDa || j.date_from <= dataDa) && (!dataA || j.date_to >= dataA)) || null;
}

// Cerca una fattura per ragione sociale / P.IVA / intervallo date / importo
// (tutti facoltativi). Vale per qualunque fattura, emessa o ricevuta.
function searchInvoice({
  tenantId = 1, ragioneSociale = null, piva = null,
  dataDa = null, dataA = null, importo = null, direzione = null
} = {}) {
  const clauses = [];
  const params = [];
  if (direzione) {
    clauses.push("COALESCE(f.direzione, CASE WHEN f.tipo = 'emessa' THEN 'attiva' ELSE 'passiva' END) = ?");
    params.push(direzione);
  }
  if (piva) {
    const p = String(piva).replace(/\s+/g, '');
    clauses.push("(REPLACE(COALESCE(f.partita_iva,''),' ','') = ? OR REPLACE(COALESCE(f.codice_fiscale,''),' ','') = ? OR REPLACE(COALESCE(a.piva,''),' ','') = ? OR REPLACE(COALESCE(a.cf,''),' ','') = ?)");
    params.push(p, p, p, p);
  }
  if (ragioneSociale) {
    clauses.push("COALESCE(a.ragione_sociale, f.cliente_fornitore_label) LIKE ?");
    params.push('%' + String(ragioneSociale).trim() + '%');
  }
  if (dataDa) { clauses.push("COALESCE(f.data, f.data_ricezione) >= ?"); params.push(dataDa); }
  if (dataA) { clauses.push("COALESCE(f.data, f.data_ricezione) <= ?"); params.push(dataA); }

  const sql = `
    SELECT f.id, f.numero, f.numero_documento, f.data, f.data_ricezione, f.direzione, f.tipo,
           f.totale, f.imponibile, f.iva, f.sdi_id, f.origine_importazione,
           COALESCE(a.ragione_sociale, f.cliente_fornitore_label) AS controparte
    FROM fatture f LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id
    ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
    ORDER BY COALESCE(f.data, f.data_ricezione) DESC LIMIT 50
  `;
  let rows = db.prepare(sql).all(...params);

  // Tolleranza importo: applicata dopo la query (1%, minimo 0,01).
  if (importo !== null && importo !== '' && Number.isFinite(Number(importo))) {
    const target = Number(importo);
    const tol = Math.max(0.01, Math.abs(target) * 0.01);
    rows = rows.filter((r) => r.totale != null && Math.abs(Number(r.totale) - target) <= tol);
  }

  if (rows.length) {
    const daSdi = rows.every((r) => String(r.origine_importazione || '').toLowerCase().startsWith('sdi'));
    const key = daSdi ? 'IMPORTED_FROM_SDI' : 'PRESENT';
    return { stateKey: key, state: SEARCH_STATES[key], matches: rows };
  }

  const pending = coveringPendingJob(tenantId, dataDa, dataA);
  if (pending) {
    return {
      stateKey: 'SIGNATURE_REQUIRED', state: SEARCH_STATES.SIGNATURE_REQUIRED, matches: [],
      job: { id: pending.id, requestType: pending.request_type, from: pending.date_from, to: pending.date_to, status: pending.status }
    };
  }
  return { stateKey: 'NOT_PRESENT', state: SEARCH_STATES.NOT_PRESENT, matches: [], canRequestSmts: true };
}

// Panoramica "Ultima sincronizzazione SdI": ricevute (realtime + reconciliation)
// ed emesse (trasmissione CRM + reconciliation + esterne importate).
function getSyncOverview({ tenantId = 1 } = {}) {
  const g = (sql, ...a) => db.prepare(sql).get(...a) || {};
  const lastJobTo = (rt) => (g(
    "SELECT MAX(date_to) AS m FROM sdi_historical_sync_job WHERE tenant_id = ? AND request_type = ? AND status IN ('COMPLETED','PARTIAL')",
    tenantId, rt
  ).m) || null;
  return {
    incoming: {
      totali: g("SELECT COUNT(*) AS n FROM fatture WHERE direzione = 'passiva' OR tipo = 'ricevuta'").n || 0,
      ultimoRealtime: g("SELECT MAX(creato_il) AS m FROM fatture WHERE (direzione = 'passiva' OR tipo = 'ricevuta') AND source = 'SDI_REALTIME'").m || null,
      ultimaReconciliation: lastJobTo('INCOMING')
    },
    outgoing: {
      totali: g("SELECT COUNT(*) AS n FROM fatture WHERE direzione = 'attiva' OR tipo = 'emessa'").n || 0,
      ultimaTrasmissione: g("SELECT MAX(creato_il) AS m FROM fatture WHERE (direzione = 'attiva' OR tipo = 'emessa') AND source = 'CRM'").m || null,
      ultimaReconciliation: lastJobTo('OUTGOING'),
      esterneImportate: g("SELECT COUNT(*) AS n FROM fatture WHERE source = 'SDI_EXTERNAL'").n || 0
    }
  };
}

// Stato per la dashboard: ultima esecuzione + richieste in attesa di firma +
// panoramica di sincronizzazione.
function getReconciliationStatus({ tenantId = 1 } = {}) {
  const lastRun = db.prepare('SELECT * FROM sdi_daily_reconciliation_run WHERE tenant_id = ? ORDER BY id DESC LIMIT 1').get(tenantId);
  const pendingSignature = db.prepare(`
    SELECT id, request_type, date_from, date_to, status
    FROM sdi_historical_sync_job
    WHERE tenant_id = ? AND status = 'CREATED' AND request_xml_path IS NOT NULL
    ORDER BY id DESC LIMIT 20
  `).all(tenantId);
  return {
    config: parseConfig(),
    lastRun: lastRun ? { ...lastRun, summary: safeParse(lastRun.summary) } : null,
    pendingSignature,
    overview: getSyncOverview({ tenantId })
  };
}

module.exports = {
  DIRECTIONS,
  SEARCH_STATES,
  parseConfig,
  computeWindow,
  computeWindowForDirection,
  windowFromAnchor,
  lastSuccessfulTo,
  toISODate,
  emptyCounters,
  classifyJobState,
  mapCounters,
  pendingUnsignedJob,
  activeJobForWindow,
  coveringPendingJob,
  runDirection,
  runDailyReconciliation,
  searchInvoice,
  getReconciliationStatus,
  getSyncOverview
};
