const crypto = require('crypto');
const db = require('../db/database');

const KEY_PREFIX = 'ai.';
const SECRET = process.env.AI_SETTINGS_SECRET || process.env.JWT_SECRET || 'horygon-ai-default-secret';

function makeKey() {
  return crypto.createHash('sha256').update(String(SECRET)).digest();
}

function encryptValue(value) {
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', makeKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptValue(value) {
  if (!value || !String(value).startsWith('enc:')) return value || '';
  const [, ivB64, tagB64, dataB64] = String(value).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', makeKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

function maskValue(value) {
  const plain = decryptValue(value);
  if (!plain) return '';
  if (plain.length <= 8) return `${plain.slice(0, 2)}****`;
  return `${plain.slice(0, 3)}****${plain.slice(-4)}`;
}

function getAiSettings() {
  const rows = db.prepare(`SELECT key, value, type FROM app_settings WHERE key LIKE '${KEY_PREFIX}%' ORDER BY key`).all();
  const grouped = { openai: {}, claude: {}, runtime: {} };
  rows.forEach(row => {
    const cleanKey = row.key.replace(KEY_PREFIX, '');
    const [provider, ...rest] = cleanKey.split('.');
    const field = rest.join('.');
    const target = grouped[provider] || (grouped[provider] = {});
    const isSecret = field.includes('api_key');
    target[field] = isSecret ? maskValue(row.value) : castValue(row.value, row.type);
    if (isSecret) target[`${field}_configured`] = !!row.value;
  });
  return grouped;
}

function saveAiSettings(payload = {}) {
  const upsert = db.prepare(`
    INSERT INTO app_settings (key, value, type, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, type=excluded.type, updated_at=datetime('now')
  `);
  ['openai', 'claude', 'runtime'].forEach(provider => {
    const config = payload[provider] || {};
    Object.entries(config).forEach(([field, value]) => {
      if (field.endsWith('_configured')) return;
      const key = `${KEY_PREFIX}${provider}.${field}`;
      const isSecret = field.includes('api_key');
      if (isSecret && !value) return;
      upsert.run(key, isSecret ? encryptValue(value) : String(value ?? ''), inferType(value));
    });
  });
  return getAiSettings();
}

function castValue(value, type) {
  if (type === 'boolean') return value === '1' || value === 'true';
  if (type === 'number') return Number(value || 0);
  return value;
}

function inferType(value) {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  return 'string';
}

module.exports = { encryptValue, decryptValue, maskValue, getAiSettings, saveAiSettings };
