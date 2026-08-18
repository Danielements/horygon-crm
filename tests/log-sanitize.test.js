const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeHeaders, isSensitiveHeaderKey } = require('../src/services/log-sanitize');

test('sanitizeHeaders: oscura set-cookie e credenziali, tiene il resto', () => {
  const clean = sanitizeHeaders({
    'content-type': 'text/xml',
    'content-length': '719',
    'set-cookie': ['LtpaToken2=abc123==; Path=/; Domain=.fatturapa.it; HttpOnly'],
    'Authorization': 'Bearer secret',
    'date': 'Thu, 13 Aug 2026 18:11:00 GMT'
  });
  assert.equal(clean['content-type'], 'text/xml');
  assert.equal(clean['content-length'], '719');
  assert.equal(clean['date'], 'Thu, 13 Aug 2026 18:11:00 GMT');
  assert.equal(clean['set-cookie'], '[omesso]');
  assert.equal(clean['Authorization'], '[omesso]');
  // non muta l'originale
});

test('sanitizeHeaders: maschera chiavi che contengono termini sensibili', () => {
  const clean = sanitizeHeaders({ 'X-Api-Token': 't', 'x-secret-key': 's', 'X-Request-Id': 'r' });
  assert.equal(clean['X-Api-Token'], '[omesso]');
  assert.equal(clean['x-secret-key'], '[omesso]');
  assert.equal(clean['X-Request-Id'], 'r');
});

test('sanitizeHeaders: input non oggetto passa invariato', () => {
  assert.equal(sanitizeHeaders(null), null);
  assert.equal(sanitizeHeaders(undefined), undefined);
});

test('isSensitiveHeaderKey: casi noti', () => {
  ['set-cookie', 'Set-Cookie', 'cookie', 'authorization', 'x-api-key', 'ltpatoken'].forEach(k =>
    assert.equal(isSensitiveHeaderKey(k), true, k));
  ['content-type', 'date', 'content-length', 'x-request-id'].forEach(k =>
    assert.equal(isSensitiveHeaderKey(k), false, k));
});
