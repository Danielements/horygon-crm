const fs = require('fs');
const path = require('path');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const db = require('../db/database');
const { getSetting } = require('./google');
const { generateOutboundXmlForInvoice } = require('./sdi-fatturapa');
const { registerOutboundTransmission } = require('./sdi-interoperability');

const ROOT = path.resolve(__dirname, '../../');
const SDI_CERTS_DIR = process.env.SDI_CERTS_DIR || '/run/sdi-certs';
const SOAP_ACTION_RICEVI_FILE = 'http://www.fatturapa.it/SdIRiceviFile/RiceviFile';

async function transmitInvoiceToSdiTest(fatturaId) {
  return transmitInvoiceToSdi(fatturaId, { mode: 'test' });
}

async function transmitInvoiceToSdi(fatturaId, options = {}) {
  const mode = String(options.mode || 'test').trim();
  if (mode !== 'test' && mode !== 'production') throw new Error(`Modalita SDI non valida: ${mode}`);
  const generated = await generateOutboundXmlForInvoice(fatturaId, {
    mode,
    allowUnsigned: options.allowUnsigned === true,
    forceFormat: options.forceFormat
  });
  const result = await transmitGeneratedFlow(generated.flowId, { mode });
  return { ...generated, transmission: result };
}

async function transmitGeneratedFlow(flowId, options = {}) {
  const flow = db.prepare(`
    SELECT
      fl.*,
      f.id AS fattura_id,
      f.numero,
      f.numero_documento,
      a.codice_destinatario
    FROM fatture_sdi_flussi fl
    JOIN fatture f ON f.id = fl.fattura_id
    LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id
    WHERE fl.id = ?
  `).get(flowId);
  if (!flow) throw new Error('Flusso SDI non trovato');
  if (!flow.xml_path) throw new Error('Flusso SDI senza XML generato');

  // Un documento che attende la firma esterna non e' trasmissibile in nessun
  // ambiente: SdI lo scarterebbe con 00102 e il nome file resterebbe bruciato.
  if (flow.stato === 'firma_richiesta') {
    throw new Error(
      `Il flusso SDI ${flow.id} attende il file firmato: scaricare l'XML, firmarlo `
      + 'e ricaricare il .p7m prima di trasmettere'
    );
  }

  const mode = String(options.mode || flow.modalita || 'test').trim();

  // I guardrail di ambiente vanno valutati prima di toccare il file: un flusso
  // generato per un ambiente non deve poter finire nell'altro, perche' nome file
  // e progressivo restano legati alla modalita' con cui sono stati prodotti.
  const flowMode = String(flow.modalita || 'test').trim();
  if (flowMode !== mode) {
    throw new Error(`Il flusso SDI ${flow.id} e stato generato in modalita "${flowMode}" e non puo essere trasmesso in "${mode}"`);
  }
  if (mode === 'production') {
    const configuredMode = String(getSetting('sdi.mode', 'test') || 'test').trim();
    if (configuredMode !== 'production') {
      throw new Error('Invio in produzione bloccato: sdi.mode non e impostato su "production"');
    }
  }

  const xmlAbsolutePath = resolveUploadPath(flow.xml_path);
  if (!fs.existsSync(xmlAbsolutePath)) throw new Error(`XML SDI non trovato: ${flow.xml_path}`);
  const xmlBuffer = fs.readFileSync(xmlAbsolutePath);
  const endpoint = getTransmissionEndpoint(mode);
  const soapMessage = buildRiceviFileMtomMessage(flow.nome_file, xmlBuffer);
  const response = await postSoapToSdi(endpoint, soapMessage, mode);
  const responseStorage = persistTransmissionResponse(response.bodyBuffer, flow.nome_file || `flow-${flow.id}`);
  const responseXml = extractXmlFromHttpResponse(response);
  const parsed = parseRiceviFileResponse(responseXml || response.body);
  const httpOk = response.statusCode >= 200 && response.statusCode < 300;
  const success = httpOk && !parsed.fault && parsed.accepted === true;
  const retryable = Boolean(parsed.retryable) || (!httpOk && response.statusCode >= 500);
  const stato = success
    ? `inviato_${mode}`
    : (retryable ? `invio_da_ritentare_${mode}` : `errore_invio_${mode}`);
  const descrizione = parsed.fault?.faultstring
    || parsed.erroreDescrizione
    || (httpOk && !parsed.identificativoSdi ? 'Risposta SdI senza IdentificativoSdI: presa in carico non confermata' : null)
    || response.statusMessage
    || response.body.slice(0, 500)
    || null;

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
    parsed.errore || (success ? 'ACCETTATO' : `HTTP_${response.statusCode}`),
    descrizione,
    responseStorage.relativePath,
    flow.id
  );

  db.prepare(`
    UPDATE fatture
    SET stato_sdi = ?
    WHERE id = ?
  `).run(stato, flow.fattura_id);

  try {
    registerOutboundTransmission({
      flow,
      invoice: {
        id: flow.fattura_id,
        numero: flow.numero,
        numero_documento: flow.numero_documento
      },
      customer: {
        codice_destinatario: parseJsonObject(flow.payload_meta).codice_destinatario || flow.codice_destinatario || null
      },
      payloadMeta: parseJsonObject(flow.payload_meta),
      transmission: {
        filename: flow.nome_file,
        identificativoSdi: parsed.identificativoSdi || null,
        statusCode: response.statusCode,
        statusMessage: response.statusMessage,
        success
      }
    });
  } catch {}

  return {
    flowId: flow.id,
    mode,
    endpoint,
    statusCode: response.statusCode,
    statusMessage: response.statusMessage,
    responsePath: responseStorage.relativePath,
    identificativoSdi: parsed.identificativoSdi || null,
    errore: parsed.errore || null,
    erroreDescrizione: parsed.erroreDescrizione || null,
    retryable,
    stato,
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

function postSoapToSdi(endpoint, soapMessage, mode = 'test', options = {}) {
  const target = new URL(endpoint);
  const tls = loadTlsMaterial(mode);
  const body = soapMessage.body;
  const soapAction = options.soapAction || SOAP_ACTION_RICEVI_FILE;
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
      SOAPAction: `"${soapAction}"`,
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
  const local = [...new Set(files)]
    .filter((file) => fs.existsSync(file))
    .map((file) => loadCertificatePem(file));

  // Passare "ca" a Node sostituisce lo store di sistema. Gli endpoint SdI usano
  // certificati server emessi da CA pubbliche (servizi.fatturapa.it e'
  // firmato Sectigo), quindi senza le radici di sistema la connessione si
  // reggerebbe solo sul certificato foglia copiato in cartella: al primo
  // rinnovo da parte di SOGEI l'handshake fallirebbe. Le radici standard
  // restano quindi in bundle insieme alla CA dell'Agenzia delle Entrate.
  return [...tls.rootCertificates, ...local];
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
    const identificativoSdi = firstValue(response, ['IdentificativoSdI', 'identificativoSdI']);
    const errore = firstValue(response, ['Errore', 'errore']);
    return {
      identificativoSdi,
      dataOraRicezione: firstValue(response, ['DataOraRicezione', 'dataOraRicezione']),
      errore: errore || null,
      erroreDescrizione: errore ? describeErroreInvio(errore) : null,
      // Il SdI risponde HTTP 200 anche quando rifiuta la presa in carico: la
      // trasmissione e' andata a buon fine solo senza Errore e con un
      // IdentificativoSdI valorizzato (TrasmissioneTypes_v1.1.xsd).
      accepted: Boolean(identificativoSdi) && !errore,
      retryable: errore === 'EI02'
    };
  } catch (error) {
    return { parseError: error.message, accepted: false, retryable: false };
  }
}

// Istruzioni per il servizio SDICoop - Trasmissione v3.3, operazione RiceviFile.
const ERRORI_INVIO = {
  EI01: 'File allegato vuoto',
  EI02: 'Servizio momentaneamente non disponibile',
  EI03: 'Utente non abilitato'
};

function describeErroreInvio(code) {
  return `${code} - ${ERRORI_INVIO[code] || 'Errore di trasmissione non documentato'}`;
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

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
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
  persistTransmissionResponse,
  postSoapToSdi,
  transmitGeneratedFlow,
  transmitInvoiceToSdi,
  transmitInvoiceToSdiTest
};
