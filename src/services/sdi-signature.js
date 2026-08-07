const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getSetting } = require('./google');
const { signCadesBes, certificateDer } = require('./sdi-cades');

const ROOT = path.resolve(__dirname, '../../');
const SDI_CERTS_DIR = process.env.SDI_CERTS_DIR || '/run/sdi-certs';

// Specifiche tecniche SdI 1.8.4 par. 2.1: la firma e' obbligatoria solo per le
// fatture destinate alla pubblica amministrazione (FPA12). Per FPR12 e FSM10 il
// file non firmato viene accettato dal SdI.
const FORMATS_REQUIRING_SIGNATURE = new Set(['FPA12']);

function isSignatureRequired(format) {
  return FORMATS_REQUIRING_SIGNATURE.has(String(format || '').trim().toUpperCase());
}

function getSignatureConfig() {
  const mode = String(getSetting('sdi.signature.mode', 'disabled') || 'disabled').trim().toLowerCase();
  return {
    mode,
    certificatePath: resolveConfiguredPath(getSetting('sdi.signature.certificate_path', defaultPath('firma', 'signer.pem'))),
    keyPath: resolveConfiguredPath(getSetting('sdi.signature.key_path', defaultPath('firma', 'signer.key'))),
    chainPath: resolveConfiguredPath(getSetting('sdi.signature.chain_path', '')),
    passphrase: String(process.env.SDI_SIGNATURE_KEY_PASSPHRASE || getSetting('sdi.signature.key_passphrase', '') || '')
  };
}

function getSignatureStatus() {
  const config = getSignatureConfig();
  if (config.mode !== 'local') {
    return {
      mode: config.mode,
      available: false,
      reason: `Firma SDI non configurata (sdi.signature.mode=${config.mode})`,
      certificate: null
    };
  }
  if (!config.certificatePath || !fs.existsSync(config.certificatePath)) {
    return { mode: config.mode, available: false, reason: `Certificato di firma non trovato: ${config.certificatePath || 'non configurato'}`, certificate: null };
  }
  if (!config.keyPath || !fs.existsSync(config.keyPath)) {
    return { mode: config.mode, available: false, reason: `Chiave di firma non trovata: ${config.keyPath || 'non configurata'}`, certificate: null };
  }
  try {
    const summary = describeCertificate(config.certificatePath);
    if (summary.expired) {
      // Controllo SdI 00100: certificato di firma scaduto.
      return { mode: config.mode, available: false, reason: `Certificato di firma scaduto il ${summary.validTo}`, certificate: summary };
    }
    if (summary.notYetValid) {
      return { mode: config.mode, available: false, reason: `Certificato di firma non ancora valido (dal ${summary.validFrom})`, certificate: summary };
    }
    return { mode: config.mode, available: true, reason: null, certificate: summary };
  } catch (error) {
    return { mode: config.mode, available: false, reason: `Certificato di firma non leggibile: ${error.message}`, certificate: null };
  }
}

function describeCertificate(certificatePath) {
  const certificate = new crypto.X509Certificate(certificateDer(fs.readFileSync(certificatePath)));
  const now = Date.now();
  return {
    subject: certificate.subject,
    issuer: certificate.issuer,
    serialNumber: certificate.serialNumber,
    validFrom: certificate.validFrom,
    validTo: certificate.validTo,
    fingerprint256: certificate.fingerprint256,
    expired: new Date(certificate.validTo).getTime() < now,
    notYetValid: new Date(certificate.validFrom).getTime() > now
  };
}

// Restituisce il file da trasmettere al SdI. Se il formato non richiede firma e
// la firma non e' configurata, restituisce l'XML originale invariato.
function applySdiSignature(xml, { format, force = false } = {}) {
  const required = isSignatureRequired(format);
  const status = getSignatureStatus();

  // Per FPR12 e FSM10 la firma e' facoltativa: di default non viene apposta, cosi'
  // un problema sul certificato non blocca anche le fatture che non ne hanno
  // bisogno. Con sdi.signature.apply=always si firma tutto.
  if (!required && applyPolicy() !== 'always') {
    return {
      signed: false,
      buffer: Buffer.from(String(xml), 'utf8'),
      extension: '.xml',
      meta: { signed: false, required: false, reason: 'Firma non richiesta per questo formato' }
    };
  }

  if (!status.available) {
    if (required && !force) {
      throw new Error(
        `La fattura ${format} e' destinata alla PA e deve essere firmata (Specifiche tecniche SdI par. 2.1), `
        + `ma la firma non e' disponibile: ${status.reason}`
      );
    }
    return {
      signed: false,
      buffer: Buffer.from(String(xml), 'utf8'),
      extension: '.xml',
      meta: { signed: false, required, reason: status.reason }
    };
  }

  const config = getSignatureConfig();
  const signedAt = new Date();
  const buffer = signCadesBes({
    content: Buffer.from(String(xml), 'utf8'),
    certificatePem: fs.readFileSync(config.certificatePath),
    privateKeyPem: fs.readFileSync(config.keyPath),
    passphrase: config.passphrase,
    chainPem: config.chainPath && fs.existsSync(config.chainPath) ? [fs.readFileSync(config.chainPath)] : [],
    signingTime: signedAt
  });

  return {
    signed: true,
    buffer,
    extension: '.xml.p7m',
    meta: {
      signed: true,
      required,
      format: 'CAdES-BES',
      signingTime: signedAt.toISOString(),
      certificateSubject: status.certificate?.subject || null,
      certificateSerial: status.certificate?.serialNumber || null,
      certificateValidTo: status.certificate?.validTo || null,
      p7mSha256: crypto.createHash('sha256').update(buffer).digest('hex')
    }
  };
}

function applyPolicy() {
  return String(getSetting('sdi.signature.apply', 'when_required') || 'when_required').trim().toLowerCase() === 'always'
    ? 'always'
    : 'when_required';
}

function defaultPath(...parts) {
  return path.join(SDI_CERTS_DIR, ...parts);
}

function resolveConfiguredPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (process.platform !== 'win32') {
    // Le impostazioni salvate da una postazione Windows arrivano con i
    // backslash e, se lasciate cosi', dentro il container diventano percorsi
    // inesistenti del tipo /app/C:\Users\... oppure /app/\run\sdi-certs\...
    if (/^[A-Za-z]:\\/.test(raw)) return defaultPath('firma', path.posix.basename(raw.replace(/\\/g, '/')));
    if (raw.includes('\\')) {
      const normalized = raw.replace(/\\/g, '/');
      return path.posix.isAbsolute(normalized) ? normalized : path.resolve(ROOT, normalized);
    }
  }
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw);
}

module.exports = {
  FORMATS_REQUIRING_SIGNATURE,
  applySdiSignature,
  getSignatureConfig,
  getSignatureStatus,
  isSignatureRequired
};
