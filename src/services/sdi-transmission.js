const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const db = require('../db/database');
const { getSetting } = require('./google');
const { generateOutboundXmlForInvoice } = require('./sdi-fatturapa');

const ROOT = path.resolve(__dirname, '../../');
const SDI_CERTS_DIR = process.env.SDI_CERTS_DIR || '/run/sdi-certs';
const SOAP_ACTION_RICEVI_FILE = 'http://www.fatturapa.it/SdIRiceviFile/RiceviFile';

async function transmitInvoiceToSdiTest(fatturaId) {
  const generated = await generateOutboundXmlForInvoice(fatturaId, { mode: 'test' });
  const result = await transmitGeneratedFlow(generated.flowId, { mode: 'test' });
  return { ...generated, transmission: result };
}

async function transmitGeneratedFlow(flowId, options = {}) {
  const flow = db.prepare(`
    SELECT fl.*, f.id AS fattura_id
    FROM fatture_sdi_flussi fl
    JOIN fatture f ON f.id = fl.fattura_id
    WHERE fl.id = ?
  `).get(flowId);
  if (!flow) throw new Error('Flusso SDI non trovato');
  if (!flow.xml_path) throw new Error('Flusso SDI senza XML generato');

  const xmlAbsolutePath = resolveUploadPath(flow.xml_path);
  if (!fs.existsSync(xmlAbsolutePath)) throw new Error(`XML SDI non trovato: ${flow.xml_path}`);
  const xmlBuffer = fs.readFileSync(xmlAbsolutePath);
  const mode = String(options.mode || flow.modalita || 'test').trim();
  const endpoint = getTransmissionEndpoint(mode);
  const soapMessage = buildRiceviFileMtomMessage(flow.nome_file, xmlBuffer);
  const response = await postSoapToSdi(endpoint, soapMessage, mode);
  const responseStorage = persistTransmissionResponse(response.bodyBuffer, flow.nome_file || `flow-${flow.id}`);
  const responseXml = extractXmlFromHttpResponse(response);
  const parsed = parseRiceviFileResponse(responseXml || response.body);
  const success = response.statusCode >= 200 && response.statusCode < 300 && !parsed.fault;
  const stato = success ? 'inviato_test' : 'errore_invio_test';
  const descrizione = parsed.fault?.faultstring || parsed.erroreDescrizione || response.statusMessage || response.body.slice(0, 500) || null;

  db.prepare(`
    UPDATE fatture_sdi_flussi
    SET stato = ?,
        identificativo_sdi = COALESCE(?, identificativo_sdi),
        esito_codice = ?,
        esito_descrizione = ?,
        response_path = ?,
        inviato_il = datetime('now'),
        ultimo_evento_il = datetime('now')
    WHERE id = ?
  `).run(
    stato,
    parsed.identificativoSdi || null,
    parsed.esito || (success ? 'HTTP_200' : `HTTP_${response.statusCode}`),
    descrizione,
    responseStorage.relativePath,
    flow.id
  );

  db.prepare(`
    UPDATE fatture
    SET stato_sdi = ?
    WHERE id = ?
  `).run(stato, flow.fattura_id);

  return {
    flowId: flow.id,
    endpoint,
    statusCode: response.statusCode,
    statusMessage: response.statusMessage,
    responsePath: responseStorage.relativePath,
    identificativoSdi: parsed.identificativoSdi || null,
    esito: parsed.esito || null,
    fault: parsed.fault || null,
    responseHeaders: response.headers,
    responsePreview: response.body.slice(0, 1200),
    success
  };
}

function getTransmissionEndpoint(mode = 'test') {
  const key = mode === 'production' ? 'sdi.production.endpoint' : 'sdi.test.endpoint';
  const configured = String(getSetting(key, mode === 'production' ? 'https://servizi.fatturapa.it/' : 'https://testservizi.fatturapa.it/') || '').trim();
  if (/\/ricevi_file\/?$/i.test(configured)) return configured;
  return new URL('/ricevi_file', configured.endsWith('/') ? configured : `${configured}/`).toString();
}

function postSoapToSdi(endpoint, soapMessage, mode = 'test') {
  const target = new URL(endpoint);
  const tls = loadTlsMaterial(mode);
  const body = soapMessage.body;
  const requestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || 443,
    path: `${target.pathname}${target.search}`,
    method: 'POST',
    cert: tls.cert,
    key: tls.key,
    ca: tls.ca,
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true,
    headers: {
      Host: target.host,
      'Content-Type': soapMessage.contentType,
      Accept: 'text/xml',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      SOAPAction: `"${SOAP_ACTION_RICEVI_FILE}"`,
      'Content-Length': body.length
    },
    timeout: 30000
  };

  return new Promise((resolve, reject) => {
    const req = https.request(requestOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          statusMessage: res.statusMessage || '',
          headers: res.headers,
          bodyBuffer: Buffer.concat(chunks),
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout invio SDI')));
    req.on('error', reject);
    req.end(body);
  });
}

function loadTlsMaterial(mode = 'test') {
  const certPath = normalizeExistingSdiPath('sdi.production.client_cert_path', getSetting('sdi.production.client_cert_path', path.join(SDI_CERTS_DIR, 'prod', 'client.cer')));
  const keyPath = normalizeExistingSdiPath('sdi.production.client_key_path', getSetting('sdi.production.client_key_path', path.join(SDI_CERTS_DIR, 'prod', 'client.key')));
  if (!fs.existsSync(certPath)) throw new Error(`Certificato client SDI non trovato: ${certPath}`);
  if (!fs.existsSync(keyPath)) throw new Error(`Chiave client SDI non trovata: ${keyPath}`);
  return {
    cert: loadCertificatePem(certPath),
    key: fs.readFileSync(keyPath),
    ca: loadCaBundle(mode)
  };
}

function loadCaBundle(mode = 'test') {
  const files = [];
  const explicit = mode === 'production'
    ? getSetting('sdi.production.ca_path', path.join(SDI_CERTS_DIR, 'prod', 'ca.cer'))
    : getSetting('sdi.test.ca_path', path.join(SDI_CERTS_DIR, 'test', 'caentrate.cer'));
  if (explicit) files.push(normalizeExistingSdiPath(mode === 'production' ? 'sdi.production.ca_path' : 'sdi.test.ca_path', explicit));
  const folder = path.join(SDI_CERTS_DIR, mode === 'production' ? 'prod' : 'test');
  if (fs.existsSync(folder)) {
    fs.readdirSync(folder)
      .filter((name) => /\.(cer|crt|pem)$/i.test(name))
      .forEach((name) => files.push(path.join(folder, name)));
  }
  return [...new Set(files)]
    .filter((file) => fs.existsSync(file))
    .map((file) => loadCertificatePem(file));
}

function buildRiceviFileSoapEnvelope(filename, xml) {
  const encodedFile = Buffer.from(String(xml || ''), 'utf8').toString('base64');
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://www.fatturapa.gov.it/sdi/ws/trasmissione/v1.0" xmlns:typ="http://www.fatturapa.gov.it/sdi/ws/trasmissione/v1.0/types" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soapenv:Header/>
  <soapenv:Body>
    <typ:fileSdIAccoglienza>
      <NomeFile>${xmlEscape(filename)}</NomeFile>
      <File>${encodedFile}</File>
    </typ:fileSdIAccoglienza>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildRiceviFileMtomMessage(filename, fileBuffer) {
  const boundary = `----=_HorygonSdiMtom_${crypto.randomUUID().replace(/-/g, '')}`;
  const rootContentId = `<root.${crypto.randomUUID()}@horygon.it>`;
  const fileContentId = `<file.${crypto.randomUUID()}@horygon.it>`;
  const href = `cid:${fileContentId.slice(1, -1)}`;
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://www.fatturapa.gov.it/sdi/ws/trasmissione/v1.0" xmlns:typ="http://www.fatturapa.gov.it/sdi/ws/trasmissione/v1.0/types" xmlns:xop="http://www.w3.org/2004/08/xop/include" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soapenv:Header/>
  <soapenv:Body>
    <typ:fileSdIAccoglienza>
      <NomeFile>${xmlEscape(filename)}</NomeFile>
      <File><xop:Include href="${href}"/></File>
    </typ:fileSdIAccoglienza>
  </soapenv:Body>
</soapenv:Envelope>`;

  const rootPart = Buffer.from([
    `--${boundary}`,
    'Content-Type: application/xop+xml; charset=UTF-8; type="text/xml"',
    'Content-Transfer-Encoding: binary',
    `Content-ID: ${rootContentId}`,
    '',
    envelope,
    ''
  ].join('\r\n'), 'utf8');
  const filePartHeaders = Buffer.from([
    `--${boundary}`,
    'Content-Type: application/octet-stream',
    'Content-Transfer-Encoding: binary',
    `Content-ID: ${fileContentId}`,
    '',
    ''
  ].join('\r\n'), 'utf8');
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

  return {
    body: Buffer.concat([rootPart, filePartHeaders, Buffer.from(fileBuffer), closing]),
    contentType: `multipart/related; type="application/xop+xml"; start="${rootContentId}"; start-info="text/xml"; boundary="${boundary}"`,
    boundary,
    rootContentId,
    fileContentId,
    envelope
  };
}

function parseRiceviFileResponse(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true
  });
  try {
    const parsed = parser.parse(String(xml || ''));
    const body = parsed?.Envelope?.Body || parsed?.Body || parsed;
    if (body?.Fault) {
      return {
        fault: {
          faultcode: body.Fault.faultcode || null,
          faultstring: body.Fault.faultstring || null
        }
      };
    }
    const response = body?.rispostaSdIRiceviFile
      || body?.RispostaSdIRiceviFile
      || body?.riceviFileResponse
      || body?.RiceviFileResponse
      || findObjectByKey(parsed, 'rispostaSdIRiceviFile')
      || findObjectByKey(parsed, 'RispostaSdIRiceviFile');
    return {
      identificativoSdi: firstValue(response, ['IdentificativoSdI', 'identificativoSdI']),
      dataOraRicezione: firstValue(response, ['DataOraRicezione', 'dataOraRicezione']),
      esito: firstValue(response, ['Esito', 'esito']),
      erroreDescrizione: firstValue(response, ['Errore', 'errore', 'Descrizione', 'descrizione'])
    };
  } catch (error) {
    return { parseError: error.message };
  }
}

function extractXmlFromHttpResponse(response) {
  const contentType = String(response?.headers?.['content-type'] || '');
  const bodyBuffer = response?.bodyBuffer || Buffer.from(String(response?.body || ''), 'utf8');
  if (!/multipart\/related/i.test(contentType)) return bodyBuffer.toString('utf8');
  const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
  if (!boundaryMatch) return bodyBuffer.toString('utf8');
  const boundary = boundaryMatch[1];
  const raw = bodyBuffer.toString('binary');
  const parts = raw.split(`--${boundary}`).filter((part) => part.trim() && part.trim() !== '--');
  for (const part of parts) {
    const separator = part.indexOf('\r\n\r\n');
    if (separator < 0) continue;
    const headers = part.slice(0, separator);
    const content = part.slice(separator + 4).replace(/\r\n--$/, '');
    if (/xml/i.test(headers) || /^\s*<\??xml|^\s*<[\w:-]+/.test(content)) {
      return Buffer.from(content, 'binary').toString('utf8').trim();
    }
  }
  return bodyBuffer.toString('utf8');
}

function findObjectByKey(value, targetKey) {
  if (!value || typeof value !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(value, targetKey)) return value[targetKey];
  for (const child of Object.values(value)) {
    const found = findObjectByKey(child, targetKey);
    if (found) return found;
  }
  return null;
}

function firstValue(source, keys) {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return String(source[key]);
  }
  return null;
}

function persistTransmissionResponse(content, filename) {
  const dayDir = path.join(ROOT, 'uploads', 'sdi-outbound-responses', new Date().toISOString().slice(0, 10).replace(/-/g, '/'));
  if (!fs.existsSync(dayDir)) fs.mkdirSync(dayDir, { recursive: true });
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content || ''), 'utf8');
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const safeName = String(filename || 'response').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.xml$/i, '');
  const absolutePath = path.join(dayDir, `${hash}_${safeName}_response.xml`);
  if (!fs.existsSync(absolutePath)) fs.writeFileSync(absolutePath, buffer);
  return {
    absolutePath,
    relativePath: `/${path.relative(ROOT, absolutePath).replace(/\\/g, '/')}`,
    sha256: hash
  };
}

function resolveUploadPath(relativePath) {
  const cleanRelativePath = String(relativePath || '').replace(/^[/\\]+/, '');
  const absolutePath = path.resolve(ROOT, cleanRelativePath);
  const uploadsRoot = path.resolve(ROOT, 'uploads');
  if (!absolutePath.startsWith(uploadsRoot + path.sep)) {
    throw new Error('Percorso XML SDI non valido');
  }
  return absolutePath;
}

function normalizePath(filePath) {
  if (!filePath) return '';
  return path.isAbsolute(filePath) ? filePath : path.resolve(ROOT, filePath);
}

function normalizeExistingSdiPath(key, filePath) {
  const mapped = normalizeLegacySettingPath(key, String(filePath || ''));
  const absolute = normalizePath(mapped);
  if (fs.existsSync(absolute)) return absolute;
  const cerFallback = absolute.replace(/\.crt$/i, '.cer');
  if (cerFallback !== absolute && fs.existsSync(cerFallback)) return cerFallback;
  return absolute;
}

function normalizeLegacySettingPath(key, value) {
  if (process.platform === 'win32') return value;
  if (!/^[A-Za-z]:\\/.test(value)) return value;
  const mapping = {
    'sdi.production.client_cert_path': path.join(SDI_CERTS_DIR, 'prod', 'client.cer'),
    'sdi.production.client_key_path': path.join(SDI_CERTS_DIR, 'prod', 'client.key'),
    'sdi.production.server_cert_path': path.join(SDI_CERTS_DIR, 'prod', 'server.cer'),
    'sdi.production.server_key_path': path.join(SDI_CERTS_DIR, 'prod', 'server.key'),
    'sdi.production.ca_path': path.join(SDI_CERTS_DIR, 'prod', 'ca.cer'),
    'sdi.production.remote_server_cert_path': path.join(SDI_CERTS_DIR, 'prod', 'servizi.fatturapa.it.cer'),
    'sdi.production.remote_client_public_cert_path': path.join(SDI_CERTS_DIR, 'prod', 'Sistema_Interscambio_Fattura_PA.cer'),
    'sdi.test.ca_path': path.join(SDI_CERTS_DIR, 'test', 'caentrate.cer'),
    'sdi.test.remote_server_cert_path': path.join(SDI_CERTS_DIR, 'test', 'testservizi.fatturapa.it.cer'),
    'sdi.test.remote_client_public_cert_path': path.join(SDI_CERTS_DIR, 'test', 'SistemaInterscambioFatturaPATest.cer')
  };
  return mapping[key] || value;
}

function loadCertificatePem(filePath) {
  const raw = fs.readFileSync(filePath);
  const text = raw.toString('utf8');
  if (text.includes('BEGIN CERTIFICATE')) return text;
  const compact = text.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/=]+$/.test(compact) && compact.length > 0) {
    return pemFromDer(Buffer.from(compact, 'base64'), 'CERTIFICATE');
  }
  return pemFromDer(raw, 'CERTIFICATE');
}

function pemFromDer(buffer, label) {
  const base64 = buffer.toString('base64').match(/.{1,64}/g)?.join('\n') || '';
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = {
  buildRiceviFileSoapEnvelope,
  buildRiceviFileMtomMessage,
  extractXmlFromHttpResponse,
  getTransmissionEndpoint,
  parseRiceviFileResponse,
  transmitGeneratedFlow,
  transmitInvoiceToSdiTest
};
