const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const { writeSystemLog } = require('./system-log');
const { receiveSdiNotificationXml } = require('./sdi-inbound');
const { importInvoiceXml } = require('./fattura-import');

const ROOT = path.resolve(__dirname, '../../');
const INBOUND_DIR = path.join(ROOT, 'uploads', 'sdi-inbound');

const SOAP11_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
const SOAP12_NS = 'http://www.w3.org/2003/05/soap-envelope';
const TRANSMISSION_TYPES_NS = 'http://www.fatturapa.gov.it/sdi/ws/trasmissione/v1.0/types';
const RECEPTION_TYPES_NS = 'http://www.fatturapa.gov.it/sdi/ws/ricezione/v1.0/types';

const ONE_WAY_TRANSMISSION_OPERATIONS = new Set([
  'ricevutaConsegna',
  'notificaMancataConsegna',
  'notificaScarto',
  'notificaEsito',
  'notificaDecorrenzaTermini',
  'attestazioneTrasmissioneFattura',
  'RicevutaConsegna',
  'NotificaMancataConsegna',
  'NotificaScarto',
  'NotificaEsito',
  'NotificaDecorrenzaTermini',
  'AttestazioneTrasmissioneFattura'
]);

const OPERATION_KIND = {
  ricevutaConsegna: 'RECEIPT_DELIVERED',
  RicevutaConsegna: 'RECEIPT_DELIVERED',
  notificaMancataConsegna: 'DELIVERY_FAILED',
  NotificaMancataConsegna: 'DELIVERY_FAILED',
  notificaScarto: 'REJECTED',
  NotificaScarto: 'REJECTED',
  notificaEsito: 'CUSTOMER_OUTCOME',
  NotificaEsito: 'CUSTOMER_OUTCOME',
  notificaDecorrenzaTermini: 'DEADLINE_EXPIRED',
  NotificaDecorrenzaTermini: 'DEADLINE_EXPIRED',
  attestazioneTrasmissioneFattura: 'TRANSMISSION_ATTESTATION',
  AttestazioneTrasmissioneFattura: 'TRANSMISSION_ATTESTATION',
  fileSdIConMetadati: 'INCOMING_INVOICE',
  RiceviFatture: 'INCOMING_INVOICE'
};

function processInboundSdiRequest(req) {
  const requestId = crypto.randomUUID();
  const rawBuffer = getRawRequestBuffer(req);
  const contentType = String(req.headers['content-type'] || '');
  const soapAction = normalizeSoapAction(req.headers.soapaction);

  writeSystemLog({
    livello: 'info',
    origine: 'sdi.ws.inbound',
    route: '/api/sdi/ws/inbound',
    metodo: 'POST',
    messaggio: 'sdi.soap.request_received',
    dettagli: {
      requestId,
      contentType,
      userAgent: String(req.headers['user-agent'] || ''),
      contentLength: rawBuffer.length,
      remoteIp: req.ip || req.socket?.remoteAddress || null,
      forwardedFor: String(req.headers['x-forwarded-for'] || ''),
      soapAction
    }
  });

  if (!rawBuffer.length) throw typedError('EmptyRequestBodyError', 'Body XML mancante');
  const rawXml = rawBuffer.toString('utf8');
  const parsedSoap = parseSoapEnvelope(rawXml);
  const operation = identifySdiOperation(parsedSoap.operationLocalName, parsedSoap.operationNamespace);

  writeSystemLog({
    livello: 'info',
    origine: 'sdi.ws.inbound',
    route: '/api/sdi/ws/inbound',
    metodo: 'POST',
    messaggio: 'sdi.soap.parsed',
    dettagli: {
      requestId,
      isSoap: true,
      soapVersion: parsedSoap.soapVersion,
      envelopeNamespace: parsedSoap.envelopeNamespace,
      operationName: parsedSoap.operationLocalName,
      operationNamespace: parsedSoap.operationNamespace,
      soapAction
    }
  });

  const payload = extractSdiPayload(parsedSoap.operationElement);
  const decodedFile = decodeSdiBase64File(payload.file, payload.nomeFile);
  const decodedXml = decodedFile.contentType === 'xml' ? decodedFile.buffer.toString('utf8') : '';
  const metadataFile = payload.metadati
    ? decodeSdiBase64File(payload.metadati, payload.nomeFileMetadati || `${payload.nomeFile || 'metadati'}_MT.xml`)
    : null;

  writeSystemLog({
    livello: 'info',
    origine: 'sdi.ws.inbound',
    route: '/api/sdi/ws/inbound',
    metodo: 'POST',
    messaggio: 'sdi.payload.extracted',
    dettagli: {
      requestId,
      operationName: parsedSoap.operationLocalName,
      operationKind: operation.kind,
      identificativoSdI: payload.identificativoSdI,
      nomeFile: payload.nomeFile,
      decodedSize: decodedFile.buffer.length,
      decodedSha256: decodedFile.sha256,
      decodedContentType: decodedFile.contentType,
      metadataSha256: metadataFile?.sha256 || null
    }
  });

  const storage = storeInboundSdiRequest({
    requestId,
    req,
    rawBuffer,
    parsedSoap,
    operation,
    payload,
    decodedFile,
    metadataFile
  });

  const result = {
    requestId,
    isSoap: true,
    soapVersion: parsedSoap.soapVersion,
    envelopeRootElement: 'Envelope',
    payloadRootElement: parsedSoap.operationLocalName,
    operationName: parsedSoap.operationLocalName,
    operationNamespace: parsedSoap.operationNamespace,
    operationKind: operation.kind,
    identificativoSdI: payload.identificativoSdI,
    nomeFile: payload.nomeFile,
    decodedFileSha256: decodedFile.sha256,
    storage,
    responseKind: operation.responseKind
  };

  if (operation.kind === 'INCOMING_INVOICE') {
    processIncomingInvoice({ result, decodedXml, payload, storage });
  } else {
    processTransmissionNotification({ result, decodedXml, payload, storage });
  }

  return result;
}

function processIncomingInvoice({ result, decodedXml, payload, storage }) {
  if (!decodedXml) {
    writeSystemLog({
      livello: 'warning',
      origine: 'sdi.ws.inbound',
      route: '/api/sdi/ws/inbound',
      metodo: 'POST',
      messaggio: 'Fattura SdI ricevuta in formato non XML',
      dettagli: {
        requestId: result.requestId,
        nomeFile: payload.nomeFile,
        decodedPath: storage.decodedPath,
        decodedFileSha256: result.decodedFileSha256
      }
    });
    result.kind = 'incoming-invoice-stored';
    result.processingStatus = 'stored_non_xml';
    updateManifest(storage.manifestPath, { processingStatus: result.processingStatus });
    return;
  }

  try {
    const imported = importInvoiceXml(decodedXml, {
      xmlPath: storage.decodedPath,
      source: 'sdi-ws'
    });
    result.kind = 'incoming-invoice';
    result.importedId = imported.duplicate ? imported.existingId : imported.id;
    result.duplicate = imported.duplicate;
    result.processingStatus = imported.duplicate ? 'duplicate' : 'imported';
    updateManifest(storage.manifestPath, {
      processingStatus: result.processingStatus,
      invoiceId: result.importedId
    });
    writeSystemLog({
      livello: 'info',
      origine: 'sdi.ws.inbound',
      route: '/api/sdi/ws/inbound',
      metodo: 'POST',
      messaggio: imported.duplicate
        ? `Fattura passiva SdI gia presente: ${imported.existingId}`
        : `Fattura passiva SdI importata: ${imported.id}`,
      dettagli: {
        event: 'sdi.incoming_invoice.imported',
        requestId: result.requestId,
        fatturaId: result.importedId,
        duplicate: imported.duplicate,
        xmlPath: storage.decodedPath,
        metadataPath: storage.metadataPath,
        numero: imported.parsed?.numero || null,
        fornitore: imported.parsed?.fornitore_nome || null
      }
    });
  } catch (error) {
    result.kind = 'incoming-invoice-stored';
    result.processingStatus = 'stored_import_failed';
    updateManifest(storage.manifestPath, {
      processingStatus: result.processingStatus,
      errors: [{ errorName: error.name, errorMessage: error.message }]
    });
    writeSystemLog({
      livello: 'error',
      origine: 'sdi.ws.inbound',
      route: '/api/sdi/ws/inbound',
      metodo: 'POST',
      messaggio: `Fattura SdI salvata ma non importata: ${error.message}`,
      stack: error.stack || null,
      dettagli: {
        event: 'sdi.incoming_invoice.import_failed',
        requestId: result.requestId,
        xmlPath: storage.decodedPath,
        metadataPath: storage.metadataPath
      }
    });
  }
}

function processTransmissionNotification({ result, decodedXml, payload, storage }) {
  if (!decodedXml) {
    result.kind = 'notification-stored';
    result.processingStatus = 'stored_non_xml';
    updateManifest(storage.manifestPath, { processingStatus: result.processingStatus });
    return;
  }

  try {
    const notification = receiveSdiNotificationXml(decodedXml, {
      originalFilename: payload.nomeFile || null
    });
    result.kind = 'notification';
    result.flowId = notification.flowId;
    result.fatturaId = notification.fatturaId;
    result.tipoNotifica = notification.parsed.tipoNotifica;
    result.statoNormalizzato = notification.statoNormalizzato;
    result.processingStatus = 'matched';
    updateManifest(storage.manifestPath, {
      processingStatus: result.processingStatus,
      matchedTransmissionId: notification.flowId,
      invoiceId: notification.fatturaId
    });
    writeSystemLog({
      livello: 'info',
      origine: 'sdi.ws.inbound',
      route: '/api/sdi/ws/inbound',
      metodo: 'POST',
      messaggio: 'sdi.flow.matched',
      dettagli: {
        requestId: result.requestId,
        transmissionId: notification.flowId,
        invoiceId: notification.fatturaId,
        tipoNotifica: notification.parsed.tipoNotifica,
        stato: notification.statoNormalizzato,
        identificativoSdI: notification.parsed.identificativoSdi,
        nomeFileFattura: notification.parsed.nomeFileFattura,
        codiceErrore: notification.parsed.codiceErrore || null,
        descrizioneErrore: notification.parsed.descrizioneErrore || null,
        errori: notification.parsed.errori || []
      }
    });
  } catch (error) {
    if (!/Nessun flusso SDI trovato/i.test(error.message)) throw error;
    result.kind = 'notification-unmatched';
    result.processingStatus = 'unmatched';
    updateManifest(storage.manifestPath, {
      processingStatus: result.processingStatus,
      errors: [{ errorName: error.name, errorMessage: error.message }]
    });
    writeSystemLog({
      livello: 'warning',
      origine: 'sdi.ws.inbound',
      route: '/api/sdi/ws/inbound',
      metodo: 'POST',
      messaggio: 'sdi.flow.unmatched',
      dettagli: {
        requestId: result.requestId,
        identificativoSdI: payload.identificativoSdI,
        nomeFile: payload.nomeFile,
        decodedSha256: result.decodedFileSha256,
        decodedPath: storage.decodedPath
      }
    });
  }
}

function parseSoapEnvelope(rawXml) {
  const xml = String(rawXml || '').replace(/^\uFEFF/, '').trim();
  if (!xml) throw typedError('EmptyRequestBodyError', 'Body XML mancante');
  if (/<!DOCTYPE/i.test(xml)) throw typedError('UnsafeXmlError', 'DOCTYPE non consentito nei messaggi SDI');

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    preserveOrder: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    allowBooleanAttributes: true
  });

  let parsed;
  try {
    parsed = parser.parse(xml);
  } catch (error) {
    throw typedError('SoapXmlParseError', `XML SOAP non parsabile: ${error.message}`, error);
  }

  const root = buildElementTree(parsed).find((node) => node.type === 'element');
  if (!root) throw typedError('SoapEnvelopeNotFoundError', 'Envelope SOAP non trovato');
  if (root.localName !== 'Envelope' || ![SOAP11_NS, SOAP12_NS].includes(root.namespaceURI)) {
    throw typedError('InvalidSoapEnvelopeError', `Envelope SOAP non valido: ${root.localName} ${root.namespaceURI || ''}`.trim());
  }

  const body = findDirectChild(root, 'Body', root.namespaceURI);
  if (!body) throw typedError('SoapBodyNotFoundError', 'SOAP Body non trovato');
  const operationElement = body.children.find((node) => node.type === 'element');
  if (!operationElement) throw typedError('SoapOperationNotFoundError', 'Operazione SOAP non trovata');

  return {
    isSoap: true,
    soapVersion: root.namespaceURI === SOAP12_NS ? '1.2' : '1.1',
    envelopeNamespace: root.namespaceURI,
    operationLocalName: operationElement.localName,
    operationNamespace: operationElement.namespaceURI || '',
    operationElement
  };
}

function buildElementTree(nodes, inheritedNamespaces = { '': '' }) {
  if (!Array.isArray(nodes)) return [];
  const result = [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(node, '#text')) {
      result.push({ type: 'text', text: String(node['#text'] || '') });
      continue;
    }
    const tagName = Object.keys(node).find((key) => key !== ':@' && key !== '?xml' && key !== '#text');
    if (!tagName || tagName === '?xml') continue;
    const rawAttributes = node[':@'] || {};
    const namespaces = { ...inheritedNamespaces };
    Object.entries(rawAttributes).forEach(([key, value]) => {
      const name = key.replace(/^@_/, '');
      if (name === 'xmlns') namespaces[''] = String(value || '');
      else if (name.startsWith('xmlns:')) namespaces[name.slice('xmlns:'.length)] = String(value || '');
    });
    const { prefix, localName } = splitQualifiedName(tagName);
    const attributes = {};
    Object.entries(rawAttributes).forEach(([key, value]) => {
      const name = key.replace(/^@_/, '');
      if (!name.startsWith('xmlns')) attributes[name] = String(value || '');
    });
    result.push({
      type: 'element',
      name: tagName,
      prefix,
      localName,
      namespaceURI: namespaces[prefix || ''] || '',
      attributes,
      children: buildElementTree(node[tagName], namespaces)
    });
  }
  return result;
}

function identifySdiOperation(operationName, operationNamespace) {
  const kind = OPERATION_KIND[operationName];
  if (!kind) throw typedError('UnknownSdiOperationError', `Operazione SdI non gestita: ${operationName}`);
  if (kind === 'INCOMING_INVOICE') {
    if (operationNamespace !== RECEPTION_TYPES_NS) {
      throw typedError('InvalidSdiNamespaceError', `Namespace ricezione non valido: ${operationNamespace}`);
    }
    return { kind, responseKind: 'ricevi_fatture_er01', oneWay: false };
  }
  if (operationNamespace !== TRANSMISSION_TYPES_NS) {
    throw typedError('InvalidSdiNamespaceError', `Namespace trasmissione non valido: ${operationNamespace}`);
  }
  return { kind, responseKind: 'empty_200', oneWay: true };
}

function extractSdiPayload(operationElement) {
  return {
    identificativoSdI: getDirectChildText(operationElement, 'IdentificativoSdI'),
    nomeFile: sanitizeSdiFilename(getDirectChildText(operationElement, 'NomeFile')),
    file: getDirectChildText(operationElement, 'File'),
    nomeFileMetadati: sanitizeSdiFilename(getDirectChildText(operationElement, 'NomeFileMetadati')),
    metadati: getDirectChildText(operationElement, 'Metadati')
  };
}

function decodeSdiBase64File(value, filename) {
  const normalized = String(value || '').replace(/\s+/g, '');
  if (!normalized) throw typedError('EmptySdiFileError', 'Campo File SDI vuoto');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw typedError('InvalidBase64FileError', 'Campo File SDI non e base64 valido');
  }
  const buffer = Buffer.from(normalized, 'base64');
  if (!buffer.length) throw typedError('InvalidBase64FileError', 'Campo File SDI decodificato vuoto');
  return {
    buffer,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    contentType: detectDecodedContentType(buffer, filename),
    originalName: filename || 'file-sdi'
  };
}

function storeInboundSdiRequest({ requestId, req, rawBuffer, parsedSoap, operation, payload, decodedFile, metadataFile }) {
  const now = new Date();
  const dayDir = path.join(
    INBOUND_DIR,
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    requestId
  );
  const decodedDir = path.join(dayDir, 'decoded');
  const metadataDir = path.join(dayDir, 'metadata');
  fs.mkdirSync(decodedDir, { recursive: true });
  fs.mkdirSync(metadataDir, { recursive: true });

  const envelopePath = path.join(dayDir, 'sdi-envelope.xml');
  fs.writeFileSync(envelopePath, rawBuffer);
  const decodedName = sanitizeFilePart(payload.nomeFile || decodedFile.originalName || 'sdi-file');
  const decodedPath = path.join(decodedDir, decodedName);
  fs.writeFileSync(decodedPath, decodedFile.buffer);

  let metadataPath = null;
  if (metadataFile) {
    const metadataName = sanitizeFilePart(payload.nomeFileMetadati || metadataFile.originalName || 'metadati.xml');
    metadataPath = path.join(metadataDir, metadataName);
    fs.writeFileSync(metadataPath, metadataFile.buffer);
  }

  const manifest = {
    requestId,
    receivedAt: now.toISOString(),
    remoteIp: req.ip || req.socket?.remoteAddress || null,
    forwardedFor: String(req.headers['x-forwarded-for'] || ''),
    contentType: String(req.headers['content-type'] || ''),
    contentLength: rawBuffer.length,
    userAgent: String(req.headers['user-agent'] || ''),
    soapVersion: parsedSoap.soapVersion,
    soapAction: normalizeSoapAction(req.headers.soapaction),
    envelopeNamespace: parsedSoap.envelopeNamespace,
    operationName: parsedSoap.operationLocalName,
    operationNamespace: parsedSoap.operationNamespace,
    operationKind: operation.kind,
    identificativoSdI: payload.identificativoSdI,
    nomeFile: payload.nomeFile,
    nomeFileMetadati: payload.nomeFileMetadati,
    decodedFileSha256: decodedFile.sha256,
    decodedContentType: decodedFile.contentType,
    envelopeSha256: crypto.createHash('sha256').update(rawBuffer).digest('hex'),
    matchedTransmissionId: null,
    processingStatus: 'stored',
    errors: []
  };
  const manifestPath = path.join(dayDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  return {
    requestDir: relativeFromRoot(dayDir),
    envelopePath: relativeFromRoot(envelopePath),
    decodedPath: relativeFromRoot(decodedPath),
    metadataPath: metadataPath ? relativeFromRoot(metadataPath) : null,
    manifestPath: relativeFromRoot(manifestPath)
  };
}

function buildRiceviFattureResponse(soapVersion = '1.1') {
  const envelopeNs = soapVersion === '1.2' ? SOAP12_NS : SOAP11_NS;
  return `<soap:Envelope xmlns:soap="${envelopeNs}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:ns1="${RECEPTION_TYPES_NS}"><soap:Body><ns1:rispostaRiceviFatture><Esito>ER01</Esito></ns1:rispostaRiceviFatture></soap:Body></soap:Envelope>`;
}

function getRawRequestBuffer(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  return Buffer.from(String(req.body ?? ''), 'utf8');
}

function normalizeSoapAction(value) {
  return String(value ?? '').trim().replace(/^"(.*)"$/, '$1');
}

function getDirectChildText(parent, localName) {
  const child = findDirectChild(parent, localName);
  if (!child) return '';
  return child.children
    .filter((node) => node.type === 'text')
    .map((node) => node.text)
    .join('')
    .trim();
}

function findDirectChild(parent, localName, namespaceURI = null) {
  return (parent?.children || []).find((node) => (
    node.type === 'element'
    && node.localName === localName
    && (namespaceURI === null || node.namespaceURI === namespaceURI)
  ));
}

function splitQualifiedName(name) {
  const value = String(name || '');
  if (!value.includes(':')) return { prefix: '', localName: value };
  const [prefix, ...rest] = value.split(':');
  return { prefix, localName: rest.join(':') };
}

function detectDecodedContentType(buffer, filename = '') {
  const lowerName = String(filename || '').toLowerCase();
  if (lowerName.endsWith('.p7m')) return 'p7m';
  if (lowerName.endsWith('.zip')) return 'zip';
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) return 'zip';
  if (buffer.length >= 2 && buffer[0] === 0x30 && (buffer[1] === 0x80 || buffer[1] === 0x81 || buffer[1] === 0x82)) return 'p7m';
  const start = buffer.toString('utf8', 0, Math.min(buffer.length, 100)).trimStart();
  if (start.startsWith('<?xml') || start.startsWith('<')) return 'xml';
  return 'binary';
}

function sanitizeSdiFilename(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return path.basename(trimmed).replace(/[^\w.-]+/g, '-');
}

function sanitizeFilePart(value) {
  return sanitizeSdiFilename(value) || 'file-sdi';
}

function relativeFromRoot(absolutePath) {
  return `/${path.relative(ROOT, absolutePath).replace(/\\/g, '/')}`;
}

function updateManifest(relativePath, patch) {
  if (!relativePath) return;
  const absolutePath = path.join(ROOT, relativePath.replace(/^[/\\]+/, ''));
  if (!fs.existsSync(absolutePath)) return;
  const current = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  fs.writeFileSync(absolutePath, JSON.stringify({ ...current, ...patch }, null, 2), 'utf8');
}

function typedError(name, message, cause = null) {
  const error = new Error(message);
  error.name = name;
  if (cause) error.cause = cause;
  return error;
}

module.exports = {
  SOAP11_NS,
  SOAP12_NS,
  TRANSMISSION_TYPES_NS,
  RECEPTION_TYPES_NS,
  buildElementTree,
  buildRiceviFattureResponse,
  decodeSdiBase64File,
  extractSdiPayload,
  getDirectChildText,
  identifySdiOperation,
  normalizeSoapAction,
  parseSoapEnvelope,
  processInboundSdiRequest
};
