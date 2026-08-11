const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db/database');
const {
  generateWindows,
  addMonths,
  addDays,
  createJob,
  getJob,
  transitionJob,
  planBackfill,
  registerArchive,
  recordItem,
  summarizeJob,
  resolveTenantVatNumber,
  TRANSITIONS
} = require('../src/services/sdi-historical-sync');

const TENANT = 1;

function cleanup() {
  db.prepare("DELETE FROM sdi_historical_sync_item WHERE entry_name LIKE 'test-%' OR job_id IN (SELECT id FROM sdi_historical_sync_job WHERE request_type LIKE 'TEST%')").run();
  db.prepare("DELETE FROM sdi_historical_sync_archive WHERE job_id IN (SELECT id FROM sdi_historical_sync_job WHERE date_from LIKE '2099%')").run();
  db.prepare("DELETE FROM sdi_historical_sync_job WHERE date_from LIKE '2099%'").run();
  db.prepare('DELETE FROM sdi_fiscal_configuration WHERE tenant_id IN (1, 99)').run();
  db.prepare('DELETE FROM tenants WHERE id = 99').run();
}

function seedFiscalConfig(tenantId, overrides = {}) {
  const values = {
    vat_number: '03365990591',
    massive_services_enabled: 1,
    massive_services_provider_enabled: 1,
    ...overrides
  };
  db.prepare(`
    INSERT INTO sdi_fiscal_configuration (tenant_id, vat_number, massive_services_enabled, massive_services_provider_enabled)
    VALUES (?,?,?,?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      vat_number = excluded.vat_number,
      massive_services_enabled = excluded.massive_services_enabled,
      massive_services_provider_enabled = excluded.massive_services_provider_enabled
  `).run(tenantId, values.vat_number, values.massive_services_enabled, values.massive_services_provider_enabled);
}

// --- generatore di finestre -----------------------------------------------

test('le finestre mensili coprono il periodo senza buchi ne sovrapposizioni', () => {
  const windows = generateWindows('2026-03-01', '2026-08-07');
  assert.equal(windows[0].from, '2026-03-01');
  assert.equal(windows.at(-1).to, '2026-08-07');
  for (let i = 1; i < windows.length; i += 1) {
    assert.equal(
      windows[i].from,
      addDays(windows[i - 1].to, 1),
      `buco o sovrapposizione fra ${windows[i - 1].to} e ${windows[i].from}`
    );
  }
  // Nessuna finestra vuota o invertita.
  windows.forEach((w) => assert.ok(w.from <= w.to, `finestra invertita ${w.from}-${w.to}`));
});

test('la finestra non taglia documenti ai confini: ogni giorno appare una volta sola', () => {
  const windows = generateWindows('2026-01-15', '2026-04-20');
  const seen = new Set();
  windows.forEach(({ from, to }) => {
    let day = from;
    while (day <= to) {
      assert.ok(!seen.has(day), `giorno ripetuto: ${day}`);
      seen.add(day);
      day = addDays(day, 1);
    }
  });
  // 2026 non e' bisestile: 15/01 -> 20/04 sono 96 giorni.
  assert.equal(seen.size, 96);
  assert.ok(seen.has('2026-01-15') && seen.has('2026-04-20'));
});

test('i mesi corti e gli anni bisestili non spostano i confini', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');

  const feb = generateWindows('2026-01-31', '2026-03-31');
  assert.equal(feb[0].from, '2026-01-31');
  assert.ok(feb.every((w) => w.from <= w.to));
});

test('una finestra piu ampia dei tre mesi viene rifiutata', () => {
  assert.throws(() => generateWindows('2026-01-01', '2026-12-31', { months: 6 }), /oltre i 3 mesi/);
  assert.doesNotThrow(() => generateWindows('2026-01-01', '2026-12-31', { months: 3 }));
});

test('intervalli e ampiezze non valide sono rifiutati', () => {
  assert.throws(() => generateWindows('2026-03-31', '2026-03-01'), /invertito/);
  assert.throws(() => generateWindows('non-una-data', '2026-03-01'), /Data non valida/);
  assert.throws(() => generateWindows('2026-03-01', '2026-03-31', { months: 0 }), /Ampiezza finestra/);
});

test('un periodo di un solo giorno produce una finestra sola', () => {
  const windows = generateWindows('2026-03-01', '2026-03-01');
  assert.deepEqual(windows, [{ from: '2026-03-01', to: '2026-03-01' }]);
});

// --- isolamento tenant ----------------------------------------------------

test('la partita IVA deriva dal tenant e non da chi chiama', () => {
  cleanup();
  seedFiscalConfig(TENANT);
  assert.equal(resolveTenantVatNumber(TENANT), '03365990591');
  assert.equal(resolveTenantVatNumber(TENANT, 'IT03365990591'), '03365990591');
  assert.throws(() => resolveTenantVatNumber(TENANT, '01234567890'), /non ammessa/);
  cleanup();
});

test('senza abilitazione o censimento le richieste massive sono bloccate', () => {
  cleanup();
  seedFiscalConfig(TENANT, { massive_services_enabled: 0 });
  assert.throws(() => resolveTenantVatNumber(TENANT), /non abilitati/);

  seedFiscalConfig(TENANT, { massive_services_enabled: 1, massive_services_provider_enabled: 0 });
  assert.throws(() => resolveTenantVatNumber(TENANT), /Provider non ancora censito/);

  assert.throws(() => resolveTenantVatNumber(99), /Configurazione fiscale mancante/);
  cleanup();
});

// --- ciclo di vita del job ------------------------------------------------

test('il job segue la macchina a stati e rifiuta le transizioni non ammesse', () => {
  cleanup();
  const job = createJob({ tenantId: TENANT, requestType: 'OUTGOING', dateFrom: '2099-01-01', dateTo: '2099-01-31' });
  assert.equal(job.status, 'CREATED');

  assert.throws(() => transitionJob(job.id, 'COMPLETED'), /Transizione non ammessa/);
  assert.throws(() => transitionJob(job.id, 'STATO_INVENTATO'), /Stato non previsto/);

  transitionJob(job.id, 'SIGNED');
  const submitted = transitionJob(job.id, 'SUBMITTED', { remoteRequestId: 'REQ-1' });
  assert.equal(submitted.remote_request_id, 'REQ-1');
  assert.ok(submitted.submitted_at, 'submitted_at valorizzato automaticamente');

  transitionJob(job.id, 'PROCESSING');
  transitionJob(job.id, 'PROCESSING', {});
  transitionJob(job.id, 'READY');
  transitionJob(job.id, 'DOWNLOADING');
  transitionJob(job.id, 'IMPORTING');
  const done = transitionJob(job.id, 'COMPLETED');
  assert.equal(done.status, 'COMPLETED');
  assert.ok(done.completed_at, 'completed_at valorizzato sui terminali');

  // Da uno stato terminale non si esce.
  assert.deepEqual(TRANSITIONS.COMPLETED, []);
  assert.throws(() => transitionJob(job.id, 'IMPORTING'), /Transizione non ammessa/);
  cleanup();
});

test('due job identici non conclusi non possono coesistere', () => {
  cleanup();
  const args = { tenantId: TENANT, requestType: 'INCOMING', dateFrom: '2099-02-01', dateTo: '2099-02-28' };
  const first = createJob(args);
  assert.throws(() => createJob(args), /gia attivo/);

  // Chiuso il primo, lo stesso periodo torna richiedibile.
  transitionJob(first.id, 'FAILED');
  const second = createJob(args);
  assert.notEqual(second.id, first.id);
  cleanup();
});

test('planBackfill crea un job per finestra e segnala quelle gia attive', () => {
  cleanup();
  const plan = planBackfill({ tenantId: TENANT, requestType: 'OUTGOING', dateFrom: '2099-01-01', dateTo: '2099-03-31' });
  assert.equal(plan.windows.length, 3);
  assert.equal(plan.created.length, 3);
  assert.equal(plan.skipped.length, 0);

  const again = planBackfill({ tenantId: TENANT, requestType: 'OUTGOING', dateFrom: '2099-01-01', dateTo: '2099-03-31' });
  assert.equal(again.created.length, 0);
  assert.equal(again.skipped.length, 3, 'le finestre gia attive vengono saltate, non duplicate');
  cleanup();
});

test('archivi e voci aggiornano i contatori del job', () => {
  cleanup();
  const job = createJob({ tenantId: TENANT, requestType: 'OUTGOING', dateFrom: '2099-04-01', dateTo: '2099-04-30' });
  registerArchive({ tenantId: TENANT, jobId: job.id, remoteArchiveId: 'A1', remoteFilename: 'a_001.zip', size: 100, sha256: 'abc' });
  registerArchive({ tenantId: TENANT, jobId: job.id, remoteArchiveId: 'A2', remoteFilename: 'a_002.zip', size: 200, sha256: 'def' });

  recordItem({ tenantId: TENANT, jobId: job.id, entryName: 'test-1.xml', outcome: 'IMPORTED', direction: 'OUTGOING' });
  recordItem({ tenantId: TENANT, jobId: job.id, entryName: 'test-2.xml', outcome: 'DUPLICATE', dedupLevel: 'IDENTIFICATIVO_SDI' });
  recordItem({ tenantId: TENANT, jobId: job.id, entryName: 'test-3.xml', outcome: 'UNMATCHED', direction: 'UNKNOWN' });

  const updated = getJob(job.id);
  assert.equal(updated.archives_count, 2);
  assert.equal(updated.documents_found, 3);
  assert.equal(updated.documents_imported, 1);
  assert.equal(updated.duplicates, 1);
  assert.equal(updated.unmatched, 1);

  const summary = summarizeJob(job.id);
  assert.equal(summary.archives.length, 2);
  assert.equal(summary.outcomes.length, 3);
  cleanup();
});

test('la creazione del job produce audit', () => {
  cleanup();
  const before = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE azione = 'SDI_HISTORICAL_REQUEST_CREATED'").get().n;
  const job = createJob({ tenantId: TENANT, requestType: 'OUTGOING', dateFrom: '2099-05-01', dateTo: '2099-05-31' });
  registerArchive({ tenantId: TENANT, jobId: job.id, remoteArchiveId: 'A1', remoteFilename: 'x_001.zip' });
  const after = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE azione = 'SDI_HISTORICAL_REQUEST_CREATED'").get().n;
  const archives = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE azione = 'SDI_HISTORICAL_ARCHIVE_DOWNLOADED'").get().n;
  assert.equal(after, before + 1);
  assert.ok(archives >= 1);
  db.prepare("DELETE FROM audit_log WHERE azione LIKE 'SDI_HISTORICAL_%'").run();
  cleanup();
});
