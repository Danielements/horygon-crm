// Sanitizzazione dei dati prima di audit/system_log.
//
// Gli header di risposta di SdI portano credenziali di sessione: nel log di un
// invio reale sono finiti `set-cookie: LtpaToken2=...`. Nessun header sensibile
// deve essere persistito. Qui si tolgono le chiavi sensibili mantenendo il resto
// (content-type, date, ecc.) che serve alla diagnostica.

const SENSITIVE_HEADER_KEYS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'set-cookie2',
  'www-authenticate',
  'x-api-key',
  'x-auth-token'
]);

// In aggiunta alle chiavi esatte, si mascherano le chiavi che *contengono*
// termini sensibili (token/secret/password/pin/otp/apikey).
const SENSITIVE_KEY_HINT = /(token|secret|password|passwd|pin|otp|apikey|api[-_]?key|bearer)/i;

function isSensitiveHeaderKey(key) {
  const k = String(key || '').toLowerCase();
  return SENSITIVE_HEADER_KEYS.has(k) || SENSITIVE_KEY_HINT.test(k);
}

// Ritorna una copia degli header con le chiavi sensibili oscurate. Non muta
// l'originale (che puo' servire al chiamante per l'uso legittimo).
function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = isSensitiveHeaderKey(key) ? '[omesso]' : value;
  }
  return out;
}

module.exports = { sanitizeHeaders, isSensitiveHeaderKey };
