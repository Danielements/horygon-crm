const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const db = require('../db/database');

const ROOT = path.resolve(__dirname, '../../');
const SDI_CERTS_DIR = process.env.SDI_CERTS_DIR || '/run/sdi-certs';

function sdiPath(...parts) {
  return path.join(SDI_CERTS_DIR, ...parts);
}

const DEFAULT_SETTINGS = {
  'sdi.mode': 'test',
  'sdi.test.endpoint': 'https://testservizi.fatturapa.it/',
  'sdi.production.endpoint': 'https://servizi.fatturapa.it/',
  'sdi.production.client_cert_path': sdiPath('prod', 'client.cer'),
  'sdi.production.client_key_path': sdiPath('prod', 'client.key'),
  'sdi.production.server_cert_path': sdiPath('prod', 'server.cer'),
  'sdi.production.server_key_path': sdiPath('prod', 'server.key'),
  'sdi.production.ca_path': sdiPath('prod', 'ca.cer'),
  'sdi.production.remote_server_cert_path': sdiPath('prod', 'servizi.fatturapa.it.cer'),
  'sdi.production.remote_client_public_cert_path': sdiPath('prod', 'Sistema_Interscambio_Fattura_PA.cer'),
  'sdi.test.ca_path': sdiPath('test', 'CAEntratetest.cer'),
  'sdi.test.remote_server_cert_path': sdiPath('test', 'testservizi.fatturapa.it.cer'),
  'sdi.test.remote_client_public_cert_path': sdiPath('test', 'SistemaInterscambioFatturaPATest.cer'),
  'sdi.csr.client_path': sdiPath('csr', 'client.csr'),
  'sdi.csr.server_path': sdiPath('csr', 'server.csr')
};

function ensureSdiSettingsSeed() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO app_settings (key, value, type, updated_at)
    VALUES (?, ?, 'string', datetime('now'))
  `);
  Object.entries(DEFAULT_SETTINGS).forEach(([key, value]) => insert.run(key, String(value ?? '')));
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  if (row && row.value !== undefined && row.value !== null && String(row.value) !== '') {
    return normalizeLegacySettingPath(key, String(row.value));
  }
  return DEFAULT_SETTINGS[key] ?? '';
}

function getAllSdiSettings() {
  ensureSdiSettingsSeed();
  return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((key) => [key, getSetting(key)]));
}

function normalizePath(filePath) {
  if (!filePath) return '';
  return path.isAbsolute(filePath) ? filePath : path.resolve(ROOT, filePath);
}

function normalizeLegacySettingPath(key, value) {
  if (process.platform === 'win32') return value;
  if (!/^[A-Za-z]:\\/.test(value)) return value;
  const mapping = {
    'sdi.production.client_cert_path': sdiPath('prod', 'client.cer'),
    'sdi.production.client_key_path': sdiPath('prod', 'client.key'),
    'sdi.production.server_cert_path': sdiPath('prod', 'server.cer'),
    'sdi.production.server_key_path': sdiPath('prod', 'server.key'),
    'sdi.production.ca_path': sdiPath('prod', 'ca.cer'),
    'sdi.production.remote_server_cert_path': sdiPath('prod', 'servizi.fatturapa.it.cer'),
    'sdi.production.remote_client_public_cert_path': sdiPath('prod', 'Sistema_Interscambio_Fattura_PA.cer'),
    'sdi.test.ca_path': sdiPath('test', 'CAEntratetest.cer'),
    'sdi.test.remote_server_cert_path': sdiPath('test', 'testservizi.fatturapa.it.cer'),
    'sdi.test.remote_client_public_cert_path': sdiPath('test', 'SistemaInterscambioFatturaPATest.cer'),
    'sdi.csr.client_path': sdiPath('csr', 'client.csr'),
    'sdi.csr.server_path': sdiPath('csr', 'server.csr')
  };
  return mapping[key] || value;
}

function pemFromDer(buffer, label) {
  const base64 = buffer.toString('base64').match(/.{1,64}/g)?.join('\n') || '';
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

function loadCertificate(filePath) {
  const raw = fs.readFileSync(filePath);
  const text = raw.toString('utf8');
  if (text.includes('BEGIN CERTIFICATE')) return new crypto.X509Certificate(text);
  const compact = text.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/=]+$/.test(compact) && compact.length > 0) {
    return new crypto.X509Certificate(pemFromDer(Buffer.from(compact, 'base64'), 'CERTIFICATE'));
  }
  return new crypto.X509Certificate(pemFromDer(raw, 'CERTIFICATE'));
}

function loadPrivateKey(filePath) {
  return crypto.createPrivateKey(fs.readFileSync(filePath));
}

function summarizeCertificate(cert) {
  return {
    subject: cert.subject,
    issuer: cert.issuer,
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    serialNumber: cert.serialNumber,
    fingerprint256: cert.fingerprint256,
    fingerprint512: cert.fingerprint512
  };
}

function publicKeyFingerprintFromKeyObject(keyObject) {
  return crypto.createPublicKey(keyObject).export({ type: 'spki', format: 'pem' });
}

function publicKeyFingerprintFromCertificate(cert) {
  return cert.publicKey.export({ type: 'spki', format: 'pem' });
}

function computeOverallStatus(checks = []) {
  if (checks.some((check) => check.status === 'error')) return 'error';
  if (checks.some((check) => check.status === 'warning')) return 'warning';
  return 'ok';
}

function buildFileCheck(label, filePath, required = true) {
  const absolutePath = normalizePath(filePath);
  if (!absolutePath) {
    return {
      id: `${label}.path`,
      label,
      status: required ? 'error' : 'warning',
      message: required ? 'Percorso non configurato' : 'Percorso non configurato',
      details: { path: filePath || null }
    };
  }
  if (!fs.existsSync(absolutePath)) {
    return {
      id: `${label}.missing`,
      label,
      status: required ? 'error' : 'warning',
      message: required ? 'File non trovato' : 'File non presente',
      details: { path: absolutePath }
    };
  }
  const stats = fs.statSync(absolutePath);
  return {
    id: `${label}.exists`,
    label,
    status: 'ok',
    message: 'File presente',
    details: { path: absolutePath, size: stats.size }
  };
}

async function probeHttpsEndpoint(url, caPath) {
  const target = String(url || '').trim();
  if (!target) {
    return { status: 'warning', message: 'Endpoint non configurato', details: { url: null } };
  }
  const options = new URL(target);
  options.method = 'GET';
  options.timeout = 5000;
  if (caPath && fs.existsSync(caPath)) {
    options.ca = fs.readFileSync(caPath);
  }
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      res.resume();
      resolve({
        status: 'ok',
        message: `Handshake HTTPS riuscito (${res.statusCode})`,
        details: { url: target, statusCode: res.statusCode }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('Timeout handshake HTTPS'));
    });
    req.on('error', (error) => {
      resolve({
        status: 'error',
        message: `Handshake HTTPS fallito: ${error.message}`,
        details: { url: target, code: error.code || null }
      });
    });
    req.end();
  });
}

async function runSdiDiagnostics({ includeNetwork = false } = {}) {
  ensureSdiSettingsSeed();
  const settings = getAllSdiSettings();
  const checks = [];
  const certificates = {};
  const artifacts = {};

  const addCheck = (check) => {
    checks.push(check);
    return check;
  };

  const productionFiles = [
    ['clientCert', 'Certificato client produzione', settings['sdi.production.client_cert_path'], true],
    ['clientKey', 'Chiave client produzione', settings['sdi.production.client_key_path'], true],
    ['serverCert', 'Certificato server produzione', settings['sdi.production.server_cert_path'], true],
    ['serverKey', 'Chiave server produzione', settings['sdi.production.server_key_path'], false],
    ['productionCa', 'CA produzione', settings['sdi.production.ca_path'], true],
    ['prodRemoteServer', 'Certificato server remoto produzione', settings['sdi.production.remote_server_cert_path'], false],
    ['prodRemoteClient', 'Certificato client pubblico SdI produzione', settings['sdi.production.remote_client_public_cert_path'], false],
    ['testCa', 'CA test', settings['sdi.test.ca_path'], true],
    ['testRemoteServer', 'Certificato server remoto test', settings['sdi.test.remote_server_cert_path'], true],
    ['testRemoteClient', 'Certificato client pubblico SdI test', settings['sdi.test.remote_client_public_cert_path'], true],
    ['clientCsr', 'CSR client', settings['sdi.csr.client_path'], true],
    ['serverCsr', 'CSR server', settings['sdi.csr.server_path'], true]
  ];

  productionFiles.forEach(([key, label, filePath, required]) => {
    const check = addCheck(buildFileCheck(label, filePath, required));
    artifacts[key] = check.details?.path || normalizePath(filePath);
  });

  const certificateLoaders = [
    ['clientCert', 'client_production'],
    ['serverCert', 'server_production'],
    ['prodRemoteServer', 'sdi_remote_production'],
    ['prodRemoteClient', 'sdi_public_client_production'],
    ['testRemoteServer', 'sdi_remote_test'],
    ['testRemoteClient', 'sdi_public_client_test'],
    ['productionCa', 'ca_production'],
    ['testCa', 'ca_test']
  ];

  certificateLoaders.forEach(([artifactKey, targetKey]) => {
    const certPath = artifacts[artifactKey];
    if (!certPath || !fs.existsSync(certPath)) return;
    try {
      certificates[targetKey] = summarizeCertificate(loadCertificate(certPath));
      addCheck({
        id: `${targetKey}.parsed`,
        label: `Parsing ${targetKey}`,
        status: 'ok',
        message: 'Certificato leggibile',
        details: { path: certPath, subject: certificates[targetKey].subject }
      });
    } catch (error) {
      addCheck({
        id: `${targetKey}.parse_error`,
        label: `Parsing ${targetKey}`,
        status: 'error',
        message: `Certificato non leggibile: ${error.message}`,
        details: { path: certPath }
      });
    }
  });

  try {
    if (artifacts.clientCert && fs.existsSync(artifacts.clientCert) && artifacts.clientKey && fs.existsSync(artifacts.clientKey)) {
      const cert = loadCertificate(artifacts.clientCert);
      const key = loadPrivateKey(artifacts.clientKey);
      const matches = publicKeyFingerprintFromCertificate(cert) === publicKeyFingerprintFromKeyObject(key);
      addCheck({
        id: 'client.key_match',
        label: 'Accoppiamento cert/key client',
        status: matches ? 'ok' : 'error',
        message: matches ? 'Chiave privata coerente con il certificato client' : 'La chiave privata non corrisponde al certificato client',
        details: { certPath: artifacts.clientCert, keyPath: artifacts.clientKey }
      });
    }
  } catch (error) {
    addCheck({
      id: 'client.key_match_error',
      label: 'Accoppiamento cert/key client',
      status: 'error',
      message: `Verifica client fallita: ${error.message}`,
      details: { certPath: artifacts.clientCert, keyPath: artifacts.clientKey }
    });
  }

  try {
    if (artifacts.serverCert && fs.existsSync(artifacts.serverCert)) {
      if (artifacts.serverKey && fs.existsSync(artifacts.serverKey)) {
        const cert = loadCertificate(artifacts.serverCert);
        const key = loadPrivateKey(artifacts.serverKey);
        const matches = publicKeyFingerprintFromCertificate(cert) === publicKeyFingerprintFromKeyObject(key);
        addCheck({
          id: 'server.key_match',
          label: 'Accoppiamento cert/key server',
          status: matches ? 'ok' : 'error',
          message: matches ? 'Chiave privata coerente con il certificato server' : 'La chiave privata non corrisponde al certificato server',
          details: { certPath: artifacts.serverCert, keyPath: artifacts.serverKey }
        });
      } else {
        addCheck({
          id: 'server.key_missing',
          label: 'Accoppiamento cert/key server',
          status: 'warning',
          message: 'Certificato server presente ma chiave privata server non configurata',
          details: { certPath: artifacts.serverCert, keyPath: artifacts.serverKey || null }
        });
      }
    }
  } catch (error) {
    addCheck({
      id: 'server.key_match_error',
      label: 'Accoppiamento cert/key server',
      status: 'error',
      message: `Verifica server fallita: ${error.message}`,
      details: { certPath: artifacts.serverCert, keyPath: artifacts.serverKey }
    });
  }

  const mode = settings['sdi.mode'] || 'test';
  addCheck({
    id: 'sdi.mode',
    label: 'Modalita SDI',
    status: mode === 'production' ? 'warning' : 'ok',
    message: `Modalita attuale: ${mode}`,
    details: { mode }
  });

  if (includeNetwork) {
    const networkCheck = await probeHttpsEndpoint(
      mode === 'production' ? settings['sdi.production.endpoint'] : settings['sdi.test.endpoint'],
      normalizePath(mode === 'production' ? settings['sdi.production.ca_path'] : settings['sdi.test.ca_path'])
    );
    addCheck({
      id: 'network.handshake',
      label: 'Handshake HTTPS verso SDI',
      status: networkCheck.status,
      message: networkCheck.message,
      details: networkCheck.details
    });
  }

  const overallStatus = computeOverallStatus(checks);
  return {
    generatedAt: new Date().toISOString(),
    includeNetwork,
    mode,
    overallStatus,
    settings,
    artifacts,
    certificates,
    checks
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  ensureSdiSettingsSeed,
  runSdiDiagnostics
};
