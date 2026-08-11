const db = require('../db/database');
const { writeAudit } = require('./audit');
const { MAX_RANGE_MONTHS, REQUEST_TYPES, addMonthsToDate } = require('./sdi-massive-request');

// Ciclo di vita dei job di backfill storico dai Servizi Massivi.
//
// Il servizio non parla con la rete: costruisce finestre, persiste lo stato e
// applica i vincoli (isolamento tenant, concorrenza, transizioni ammesse).
// Le chiamate SOAP restano nel client, cosi' backfill e trasporto restano
// separabili e testabili singolarmente.

const STATUSES = [
  'CREATED', 'SIGNED', 'SUBMITTED', 'PROCESSING', 'READY',
  'DOWNLOADING', 'IMPORTING', 'COMPLETED', 'PARTIAL', 'FAILED', 'EXPIRED'
];

const TERMINAL_STATUSES = new Set(['COMPLETED', 'PARTIAL', 'FAILED', 'EXPIRED']);

// Ogni stato dichiara i successori ammessi: una transizione fuori da qui e' un
// errore di programmazione, non un caso da gestire in silenzio.
const TRANSITIONS = {
  CREATED: ['SIGNED', 'FAILED'],
  SIGNED: ['SUBMITTED', 'FAILED'],
  SUBMITTED: ['PROCESSING', 'READY', 'FAILED', 'EXPIRED'],
  PROCESSING: ['PROCESSING', 'READY', 'FAILED', 'EXPIRED'],
  READY: ['DOWNLOADING', 'FAILED', 'EXPIRED'],
  DOWNLOADING: ['DOWNLOADING', 'IMPORTING', 'PARTIAL', 'FAILED', 'EXPIRED'],
  IMPORTING: ['IMPORTING', 'COMPLETED', 'PARTIAL', 'FAILED'],
  COMPLETED: [],
  // PARTIAL non e' un fallimento: e' una passata finita con qualcosa rimasto
  // indietro. Un backfill che non si puo' riprendere costringerebbe a rifare
  // la richiesta da capo, cioe' a spendere un'altra firma qualificata per dati
  // che sono gia' stati scaricati. Si riparte da dove ci si era fermati.
  PARTIAL: ['DOWNLOADING', 'IMPORTING'],
  FAILED: [],
  EXPIRED: []
};

// --- generazione finestre -------------------------------------------------

// Aritmetica su stringhe YYYY-MM-DD in UTC: nessun oggetto Date locale, cosi'
// il fuso della macchina non puo' spostare i confini di finestra. Le date del
// tracciato sono xs:date, quindi giorni di calendario senza fuso.
function generateWindows(dateFrom, dateTo, { months = 1 } = {}) {
  assertDate(dateFrom);
  assertDate(dateTo);
  if (compareDates(dateFrom, dateTo) > 0) {
    throw new Error(`Intervallo invertito: ${dateFrom} - ${dateTo}`);
  }
  if (!Number.isInteger(months) || months < 1) {
    throw new Error(`Ampiezza finestra non valida: ${months}`);
  }

  const windows = [];
  let cursor = dateFrom;
  let guard = 0;
  while (compareDates(cursor, dateTo) <= 0) {
    if (guard++ > 1200) throw new Error('Generazione finestre interrotta: troppe iterazioni');
    // Fine finestra = ultimo giorno prima dell'inizio della successiva.
    let end = addDays(addMonths(cursor, months), -1);
    if (compareDates(end, dateTo) > 0) end = dateTo;
    // Stesso metro del tracciato: mesi di calendario, non giorni contati.
    if (end > addMonthsToDate(cursor, MAX_RANGE_MONTHS)) {
      throw new Error(`Finestra ${cursor} - ${end} oltre i ${MAX_RANGE_MONTHS} mesi ammessi`);
    }
    windows.push({ from: cursor, to: end });
    cursor = addDays(end, 1);
  }
  return windows;
}

function assertDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) throw new Error(`Data non valida: ${value}`);
}

function toParts(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  return { y, m, d };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addMonths(date, months) {
  const { y, m, d } = toParts(date);
  const total = (y * 12) + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  // Se il giorno non esiste nel mese di arrivo si tiene l'ultimo disponibile.
  const day = Math.min(d, daysInMonth(year, month));
  return `${year}-${pad(month)}-${pad(day)}`;
}

function addDays(date, days) {
  const { y, m, d } = toParts(date);
  const ms = Date.UTC(y, m - 1, d) + (days * 86400000);
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function compareDates(a, b) {
  return a < b ? -1 : (a > b ? 1 : 0);
}

function daysBetween(a, b) {
  const pa = toParts(a);
  const pb = toParts(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
}

// --- isolamento tenant ----------------------------------------------------

function getFiscalConfiguration(tenantId) {
  const row = db.prepare('SELECT * FROM sdi_fiscal_configuration WHERE tenant_id = ?').get(tenantId);
  if (!row) throw new Error(`Configurazione fiscale mancante per il tenant ${tenantId}`);
  return row;
}

// La partita IVA da interrogare non puo' mai arrivare dal client: deriva dalla
// configurazione fiscale del tenant autenticato.
function resolveTenantVatNumber(tenantId, requestedVatNumber = null) {
  const config = getFiscalConfiguration(tenantId);
  const own = normalizeVat(config.vat_number);
  if (!own) throw new Error(`Partita IVA non configurata per il tenant ${tenantId}`);
  if (requestedVatNumber && normalizeVat(requestedVatNumber) !== own) {
    throw new Error(
      `Richiesta massiva per la partita IVA ${normalizeVat(requestedVatNumber)} non ammessa: `
      + `il tenant ${tenantId} e' abilitato solo su ${own}`
    );
  }
  if (!Number(config.massive_services_enabled)) {
    throw new Error(`Servizi massivi non abilitati per il tenant ${tenantId}`);
  }
  if (!Number(config.massive_services_provider_enabled)) {
    throw new Error(
      `Provider non ancora censito per il tenant ${tenantId}: `
      + 'completare il censimento canale su Fatture e Corrispettivi'
    );
  }
  return own;
}

function normalizeVat(value) {
  return String(value || '').trim().replace(/\s+/g, '').replace(/^IT/i, '');
}

// --- ciclo di vita del job ------------------------------------------------

function createJob({ tenantId, requestType, dateFrom, dateTo, dryRun = false, utenteId = null }) {
  if (!REQUEST_TYPES[requestType]) throw new Error(`Tipo richiesta non supportato: ${requestType}`);
  assertDate(dateFrom);
  assertDate(dateTo);

  // L'indice parziale sul DB impedisce due job identici non conclusi; qui si
  // anticipa il controllo per restituire un errore comprensibile.
  const existing = db.prepare(`
    SELECT id, status FROM sdi_historical_sync_job
    WHERE tenant_id = ? AND request_type = ? AND date_from = ? AND date_to = ?
      AND status NOT IN ('COMPLETED', 'FAILED', 'EXPIRED')
    LIMIT 1
  `).get(tenantId, requestType, dateFrom, dateTo);
  if (existing) {
    throw new Error(`Job ${requestType} ${dateFrom}-${dateTo} gia attivo (id ${existing.id}, stato ${existing.status})`);
  }

  const result = db.prepare(`
    INSERT INTO sdi_historical_sync_job (tenant_id, request_type, date_from, date_to, status, dry_run)
    VALUES (?,?,?,?, 'CREATED', ?)
  `).run(tenantId, requestType, dateFrom, dateTo, dryRun ? 1 : 0);

  const jobId = Number(result.lastInsertRowid);
  audit('SDI_HISTORICAL_REQUEST_CREATED', { tenantId, jobId, utenteId, dettagli: { requestType, dateFrom, dateTo, dryRun } });
  return getJob(jobId);
}

function planBackfill({ tenantId, requestType, dateFrom, dateTo, months = 1, dryRun = false, utenteId = null }) {
  const windows = generateWindows(dateFrom, dateTo, { months });
  const created = [];
  const skipped = [];
  windows.forEach((window) => {
    try {
      created.push(createJob({ tenantId, requestType, dateFrom: window.from, dateTo: window.to, dryRun, utenteId }));
    } catch (error) {
      skipped.push({ window, reason: error.message });
    }
  });
  return { windows, created, skipped };
}

function getJob(jobId) {
  return db.prepare('SELECT * FROM sdi_historical_sync_job WHERE id = ?').get(jobId);
}

function transitionJob(jobId, nextStatus, patch = {}) {
  if (!STATUSES.includes(nextStatus)) throw new Error(`Stato non previsto: ${nextStatus}`);
  const job = getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} non trovato`);
  const allowed = TRANSITIONS[job.status] || [];
  if (!allowed.includes(nextStatus)) {
    throw new Error(`Transizione non ammessa da ${job.status} a ${nextStatus} per il job ${jobId}`);
  }

  const fields = ['status = ?'];
  const values = [nextStatus];
  const columns = {
    remote_request_id: patch.remoteRequestId,
    submitted_at: patch.submittedAt,
    completed_at: patch.completedAt,
    expires_at: patch.expiresAt,
    archives_count: patch.archivesCount,
    documents_found: patch.documentsFound,
    documents_imported: patch.documentsImported,
    duplicates: patch.duplicates,
    unmatched: patch.unmatched,
    esito_calls: patch.esitoCalls,
    errors: patch.errors === undefined ? undefined : JSON.stringify(patch.errors)
  };
  Object.entries(columns).forEach(([column, value]) => {
    if (value === undefined) return;
    fields.push(`${column} = ?`);
    values.push(value);
  });
  if (nextStatus === 'SUBMITTED' && patch.submittedAt === undefined) {
    fields.push("submitted_at = datetime('now')");
  }
  if (TERMINAL_STATUSES.has(nextStatus) && patch.completedAt === undefined) {
    fields.push("completed_at = datetime('now')");
  }
  fields.push("aggiornato_il = datetime('now')");
  values.push(jobId);

  db.prepare(`UPDATE sdi_historical_sync_job SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getJob(jobId);
}

// Riapertura amministrativa di un job concluso, per ri-elaborare archivi gia'
// scaricati senza rifare la richiesta a SdI.
//
// Non passa da transitionJob di proposito: la regola "da uno stato terminale
// non si esce" protegge il flusso normale e resta valida. Questa e' un'altra
// cosa, un'azione esplicita di chi sa cosa sta facendo, e lascia traccia.
function reopenJobForReimport(jobId, { utenteId = null, motivo = null } = {}) {
  const job = getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} non trovato`);
  if (!['COMPLETED', 'PARTIAL', 'IMPORTING', 'DOWNLOADING'].includes(job.status)) {
    throw new Error(`Il job ${jobId} non e ri-elaborabile dallo stato ${job.status}`);
  }
  db.prepare("UPDATE sdi_historical_sync_job SET status = 'DOWNLOADING', completed_at = NULL, aggiornato_il = datetime('now') WHERE id = ?")
    .run(job.id);
  audit('SDI_HISTORICAL_JOB_REOPENED', {
    tenantId: job.tenant_id, jobId: job.id, utenteId,
    dettagli: { statoPrecedente: job.status, motivo }
  });
  return getJob(job.id);
}

function registerArchive({ tenantId, jobId, remoteArchiveId, remoteFilename, size, sha256, localPath }) {
  const result = db.prepare(`
    INSERT INTO sdi_historical_sync_archive
      (tenant_id, job_id, remote_archive_id, remote_filename, size, sha256, local_path, downloaded_at, status)
    VALUES (?,?,?,?,?,?,?, datetime('now'), 'DOWNLOADED')
  `).run(tenantId, jobId, remoteArchiveId || null, remoteFilename || null, size || null, sha256 || null, localPath || null);
  const archiveId = Number(result.lastInsertRowid);
  db.prepare(`
    UPDATE sdi_historical_sync_job
    SET archives_count = (SELECT COUNT(*) FROM sdi_historical_sync_archive WHERE job_id = ?),
        aggiornato_il = datetime('now')
    WHERE id = ?
  `).run(jobId, jobId);
  audit('SDI_HISTORICAL_ARCHIVE_DOWNLOADED', { tenantId, jobId, dettagli: { archiveId, remoteFilename, sha256, size } });
  return archiveId;
}

function recordItem({ tenantId, jobId, archiveId, entryName, documentType, direction, identificativoSdi, originalFilename, originalSha256, xmlSha256, localPath, outcome, fatturaId, dedupKey, dedupLevel, errorMessage }) {
  const result = db.prepare(`
    INSERT INTO sdi_historical_sync_item
      (tenant_id, job_id, archive_id, entry_name, document_type, direction, identificativo_sdi,
       original_filename, original_sha256, xml_sha256, local_path, outcome, fattura_id,
       dedup_key, dedup_level, error_message)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    tenantId, jobId, archiveId || null, entryName || null, documentType || null, direction || null,
    identificativoSdi || null, originalFilename || null, originalSha256 || null, xmlSha256 || null,
    localPath || null, outcome || null, fatturaId || null, dedupKey || null, dedupLevel || null,
    errorMessage || null
  );
  refreshJobCounters(jobId);
  return Number(result.lastInsertRowid);
}

function refreshJobCounters(jobId) {
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS found,
      SUM(CASE WHEN outcome = 'IMPORTED' THEN 1 ELSE 0 END) AS imported,
      SUM(CASE WHEN outcome = 'DUPLICATE' THEN 1 ELSE 0 END) AS duplicates,
      SUM(CASE WHEN outcome = 'UNMATCHED' THEN 1 ELSE 0 END) AS unmatched
    FROM sdi_historical_sync_item WHERE job_id = ?
  `).get(jobId);
  db.prepare(`
    UPDATE sdi_historical_sync_job
    SET documents_found = ?, documents_imported = ?, duplicates = ?, unmatched = ?, aggiornato_il = datetime('now')
    WHERE id = ?
  `).run(counts.found || 0, counts.imported || 0, counts.duplicates || 0, counts.unmatched || 0, jobId);
}

function summarizeJob(jobId) {
  const job = getJob(jobId);
  if (!job) return null;
  const archives = db.prepare('SELECT * FROM sdi_historical_sync_archive WHERE job_id = ? ORDER BY id').all(jobId);
  const outcomes = db.prepare(`
    SELECT outcome, COUNT(*) AS n FROM sdi_historical_sync_item WHERE job_id = ? GROUP BY outcome
  `).all(jobId);
  return { job, archives, outcomes };
}

function audit(azione, { tenantId, jobId, utenteId = null, dettagli = {} }) {
  try {
    writeAudit({
      utente_id: utenteId,
      azione,
      entita_tipo: 'sdi_historical_sync_job',
      entita_id: jobId || null,
      dettagli: { tenantId, ...dettagli }
    });
  } catch {}
}

module.exports = {
  STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  addDays,
  addMonths,
  audit,
  createJob,
  generateWindows,
  getFiscalConfiguration,
  getJob,
  planBackfill,
  recordItem,
  refreshJobCounters,
  registerArchive,
  reopenJobForReimport,
  resolveTenantVatNumber,
  summarizeJob,
  transitionJob
};
