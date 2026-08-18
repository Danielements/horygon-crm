const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseConfig, computeWindow, windowFromAnchor, classifyJobState, mapCounters, emptyCounters
} = require('../src/services/sdi-daily-reconciliation');

test('parseConfig: default disabilitato, cron 06:00, lookback 7', () => {
  const cfg = parseConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.cron, '0 6 * * *');
  assert.equal(cfg.lookbackDays, 7);
});

test('parseConfig: legge enabled/cron/lookback dall\'ambiente', () => {
  const cfg = parseConfig({
    SDI_DAILY_RECONCILIATION_ENABLED: 'true',
    SDI_DAILY_RECONCILIATION_CRON: '30 5 * * 1',
    SDI_DAILY_RECONCILIATION_LOOKBACK_DAYS: '10'
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.cron, '30 5 * * 1');
  assert.equal(cfg.lookbackDays, 10);
});

test('parseConfig: lookback non valido ripiega su 7', () => {
  assert.equal(parseConfig({ SDI_DAILY_RECONCILIATION_LOOKBACK_DAYS: 'x' }).lookbackDays, 7);
  assert.equal(parseConfig({ SDI_DAILY_RECONCILIATION_LOOKBACK_DAYS: '0' }).lookbackDays, 7);
  assert.equal(parseConfig({ SDI_DAILY_RECONCILIATION_LOOKBACK_DAYS: '-3' }).lookbackDays, 7);
});

test('computeWindow: finestra mobile [oggi-7, oggi]', () => {
  const w = computeWindow(new Date('2026-08-13T09:00:00Z'), 7);
  assert.deepEqual(w, { from: '2026-08-06', to: '2026-08-13' });
});

test('computeWindow: rispetta il lookback e attraversa il confine di mese', () => {
  assert.deepEqual(computeWindow(new Date('2026-08-03T00:00:00Z'), 7), { from: '2026-07-27', to: '2026-08-03' });
  assert.deepEqual(computeWindow(new Date('2026-03-01T00:00:00Z'), 1), { from: '2026-02-28', to: '2026-03-01' });
});

test('classifyJobState: CREATED con richiesta preparata = SIGNATURE_REQUIRED', () => {
  assert.equal(classifyJobState({ status: 'CREATED', request_xml_path: '/x.xml' }), 'SIGNATURE_REQUIRED');
  assert.equal(classifyJobState({ status: 'CREATED', request_xml_path: null }), 'PENDING');
  assert.equal(classifyJobState({ status: 'COMPLETED' }), 'COMPLETED');
  assert.equal(classifyJobState({ status: 'PARTIAL' }), 'PARTIAL');
  assert.equal(classifyJobState({ status: 'FAILED' }), 'FAILED');
  assert.equal(classifyJobState({ status: 'EXPIRED' }), 'EXPIRED');
  assert.equal(classifyJobState({ status: 'SUBMITTED' }), 'IN_PROGRESS');
  assert.equal(classifyJobState(null), 'UNKNOWN');
});

test('mapCounters: dai contatori del job', () => {
  const c = mapCounters({ documents_found: 12, duplicates: 9, documents_imported: 3, unmatched: 0 });
  assert.deepEqual(c, { checked: 12, alreadyPresent: 9, newInvoices: 3, imported: 3, errors: 0 });
});

test('mapCounters: ripiega sugli outcome se i contatori del job mancano', () => {
  const c = mapCounters({}, [
    { outcome: 'IMPORTED', n: 2 },
    { outcome: 'DUPLICATE', n: 5 },
    { outcome: 'UNMATCHED', n: 1 }
  ]);
  assert.equal(c.imported, 2);
  assert.equal(c.newInvoices, 2);
  assert.equal(c.alreadyPresent, 5);
  assert.equal(c.errors, 1);
  assert.equal(c.checked, 8); // 2 + 5 + 1
});

test('emptyCounters: tutti a zero', () => {
  assert.deepEqual(emptyCounters(), { checked: 0, alreadyPresent: 0, newInvoices: 0, imported: 0, errors: 0 });
});

test('parseConfig: overlap default = lookback, oppure esplicito', () => {
  assert.equal(parseConfig({}).overlapDays, 7);
  assert.equal(parseConfig({ SDI_DAILY_RECONCILIATION_LOOKBACK_DAYS: '10' }).overlapDays, 10);
  assert.equal(parseConfig({ SDI_DAILY_RECONCILIATION_OVERLAP_DAYS: '3' }).overlapDays, 3);
  assert.equal(parseConfig({ SDI_DAILY_RECONCILIATION_OVERLAP_DAYS: '0' }).overlapDays, 0);
});

test('windowFromAnchor: ancorata all-ultima riconciliazione con overlap', () => {
  // riparte da anchor - overlap, non da oggi-7.
  assert.deepEqual(
    windowFromAnchor('2026-08-18', '2026-08-18', { overlapDays: 7 }),
    { from: '2026-08-11', to: '2026-08-18', anchor: '2026-08-18' }
  );
  // un buco: ultima completata 10 giorni fa -> copre tutto il buco (non solo 7gg).
  assert.deepEqual(
    windowFromAnchor('2026-08-18', '2026-08-08', { overlapDays: 7 }),
    { from: '2026-08-01', to: '2026-08-18', anchor: '2026-08-08' }
  );
});

test('windowFromAnchor: senza storico ripiega su [oggi-lookback, oggi]', () => {
  assert.deepEqual(
    windowFromAnchor('2026-08-18', null, { lookbackDays: 7 }),
    { from: '2026-08-11', to: '2026-08-18', anchor: null }
  );
});

test('windowFromAnchor: clamp a ~3 mesi (controllo 00201)', () => {
  // anchor molto vecchio -> from non piu' indietro di 3 mesi da oggi.
  const w = windowFromAnchor('2026-08-18', '2026-01-01', { overlapDays: 7 });
  assert.equal(w.to, '2026-08-18');
  assert.equal(w.from, '2026-05-18'); // addMonths(-3)
});
