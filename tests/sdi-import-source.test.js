const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveImportSource } = require('../src/services/sdi-import-pipeline');

test('resolveImportSource: emessa NON-CRM trovata su SdI -> SDI_EXTERNAL', () => {
  assert.equal(resolveImportSource('OUTGOING', 'SDI_HISTORICAL_SYNC'), 'SDI_EXTERNAL');
  assert.equal(resolveImportSource('OUTGOING', 'SDI_REALTIME'), 'SDI_EXTERNAL');
  assert.equal(resolveImportSource('OUTGOING', 'SDI_MANUAL_IMPORT'), 'SDI_EXTERNAL');
});

test('resolveImportSource: emessa dal CRM resta CRM (non e\' esterna)', () => {
  assert.equal(resolveImportSource('OUTGOING', 'CRM'), 'CRM');
});

test('resolveImportSource: ricevute e direzione sconosciuta invariate', () => {
  assert.equal(resolveImportSource('INCOMING', 'SDI_HISTORICAL_SYNC'), 'SDI_HISTORICAL_SYNC');
  assert.equal(resolveImportSource('INCOMING', 'SDI_REALTIME'), 'SDI_REALTIME');
  assert.equal(resolveImportSource('INCOMING', 'CRM'), 'CRM');
  assert.equal(resolveImportSource('UNKNOWN', 'SDI_HISTORICAL_SYNC'), 'SDI_HISTORICAL_SYNC');
});
