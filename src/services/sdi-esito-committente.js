const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const db = require('../db/database');
const { getSetting } = require('./google');
const {
  extractXmlFromHttpResponse,
  persistTransmissionResponse,
  postSoapToSdi
} = require('./sdi-transmission');

const ROOT = path.resolve(__dirname, '../../');
const OUTCOME_DIR = path.join(ROOT, 'uploads', 'sdi-esiti-committente');
const RICEZIONE_TYPES_NS = 'http://www.fatturapa.gov.it/sdi/ws/ricezione/v1.0/types';
const MESSAGGI_NS = 'http://www.fatturapa.gov.it/sdi/messaggi/v1.0';
const SOAP_ACTION_NOTIFICA_ESITO = 'http://www.fatturapa.it/SdIRicezioneNotifiche/NotificaEsito';

async function sendEsitoCommittenteToSdiTest(fatturaId, options = {}) {
  return sendEsitoCommittenteToSdi(fatturaId, { ...options, mode: 'test' });
}

async function sendEsitoCommittenteToSdi(fatturaId, options = {}) {
  const mode = String(options.mode || getSetting('sdi.mode', 'test') || 'test').trim();
  if (mode !== 'test' && mode !== 'production') throw new Error(`Modalita SDI non valida: ${mode}`);

  const invoice = loadPassiveInvoiceForOutcome(fatturaId);
  const metadata = parseJsonObject(invoice.documento_meta);
  const identificativoSdi = String(
    options.identificativoSdi
    || metadata.identificativo_sdi
    || invoice.sdi_id
    || ''
  ).trim();
  const originalFilename = String(
    options.originalFilename
    || metadata.nome_file_sdi
    || metadata.nome_file
    || ''
  ).trim();
  if (!/^\d{1,12}$/.test(identificativoSdi)) {
    throw new Error('IdentificativoSdI mancante o non valido per invio esito committente');
  }
  if (!originalFilename) throw new Error('Nome file SdI originale mancante per invio esito committente');

  const formato = String(metadata.formato_trasmissione || '').trim().toUpperCase();
  if (formato && formato !== 'FPA12' && !options.force) {
    throw new Error(`Esito committente previsto per fatture PA FPA12; formato ricevuto: ${formato}`);
  }

  const esito = options.allowInvalidOutcome
    ? normalizeOutcomeForTest(options.esito || 'EC99')
    : normalizeOutcome(options.esito || 'EC01');
  const progressivo = Number(options.progressivo || 1);
  const filename = buildEsitoCommittenteFilename(originalFilename, progressivo);
  const outcomeXml = buildNotificaEsitoCommittenteXml({
    identificativoSdi,
    numeroFattura: options.numeroFattura || invoice.numero_documento || invoice.numero,
    annoFattura: options.annoFattura || extractYear(invoice.data),
    posizioneFattura: options.posizioneFattura || 1,
    esito,
    allowInvalidOutcome: options.allowInvalidOutcome || false,
    descrizione: options.descrizione || (esito === 'EC02' ? 'Fattura rifiutata in test' : ''),
    messageIdCommittente: options.messageIdCommittente || buildMessageId(invoice.id)
  });
  const stored = persistOutcomeXml(outcomeXml, filename);
  const soapMessage = buildSdIRiceviNotificaSoapEnvelope({
    identificativoSdi,
    filename,
    outcomeXml
  });
  const endpoint = getRiceviNotificaEndpoint(mode);
  const flowId = persistOutcomeFlow({
    invoice,
    mode,
    filename,
    identificativoSdi,
    outcomeXml,
    stored,
    esito,
    endpoint,
    metadata: {
      originalFilename,
      numeroFattura: options.numeroFattura || invoice.numero_documento || invoice.numero,
      annoFattura: options.annoFattura || extractYear(invoice.data),
      posizioneFattura: options.posizioneFattura || 1
    }
  });

  const response = await postSoapToSdi(endpoint, soapMessage, mode, {
    soapAction: SOAP_ACTION_NOTIFICA_ESITO
  });
  const responseStorage = persistTransmissionResponse(response.bodyBuffer, filename);
  const responseXml = extractXmlFromHttpResponse(response);
  const parsed = parseSdIRiceviNotificaResponse(responseXml || response.body);
  const scartoStorage = parsed.scarto?.xml
    ? persistOutcomeXml(parsed.scarto.xml, parsed.scarto.nomeFile || `${filename.replace(/\.xml$/i, '')}_scarto.xml`)
    : null;
  const httpOk = response.statusCode >= 200 && response.statusCode < 300;
  const success = httpOk && parsed.accepted && !parsed.fault;
  const stato = mapResponseState(parsed, httpOk);
  const descrizione = parsed.fault?.faultstring
    || parsed.scarto?.descrizione
    || parsed.scarto?.codice
    || response.statusMessage
    || null;

  db.prepare(`
    UPDATE fatture_sdi_flussi
    SET stato = ?,
        esito_codice = ?,
        esito_descrizione = ?,
        response_path = ?,
        inviato_il = datetime('now'),
        ultimo_evento_il = datetime('now')
    WHERE id = ?
  `).run(
    stato,
    parsed.esito || (httpOk ? 'HTTP_200' : `HTTP_${response.statusCode}`),
    descrizione,
    responseStorage.relativePath,
    flowId
  );

  return {
    flowId,
    endpoint,
    filename,
    xmlPath: stored.relativePath,
    hash: stored.sha256,
    statusCode: response.statusCode,
    statusMessage: response.statusMessage,
    responsePath: responseStorage.relativePath,
    scartoPath: scartoStorage?.relativePath || null,
    esitoRisposta: parsed.esito || null,
    accepted: parsed.accepted,
    rejected: parsed.rejected,
    retryable: parsed.retryable,
    fault: parsed.fault || null,
    scarto: parsed.scarto ? { ...parsed.scarto, xmlPath: scartoStorage?.relativePath || null } : null,
    responseHeaders: response.headers,
    responsePreview: response.body.slice(0, 1200),
    success
  };
}

function loadPassiveInvoiceForOutcome(fatturaId) {
  const invoice = db.prepare(`
    SELECT *
    FROM fatture
    WHERE id = ?
  `).get(fatturaId);
  if (!invoice) throw new Error('Fattura non trovata');
  const direction = String(invoice.direzione || '').trim().toLowerCase();
  const tipo = String(invoice.tipo || '').trim().toLowerCase();
  if (direction !== 'passiva' && tipo !== 'ricevuta') {
    throw new Error('Esito committente disponibile solo per fatture passive ricevute');
  }
  return invoice;
}

function getRiceviNotificaEndpoint(mode = 'test') {
  const key = mode === 'production' ? 'sdi.production.endpoint' : 'sdi.test.endpoint';
  const fallback = mode === 'production' ? 'https://servizi.fatturapa.it/' : 'https://testservizi.fatturapa.it/';
  const configured = String(getSetting(key, fallback) || '').trim();
  if (/\/ricevi_notifica\/?$/i.test(configured)) return configured;
  return new URL('/ricevi_notifica', configured.endsWith('/') ? configured : `${configured}/`).toString();
}

function buildNotificaEsitoCommittenteXml(payload) {
  const identificativoSdi = String(payload.identificativoSdi || '').trim();
  if (!/^\d{1,12}$/.test(identificativoSdi)) throw new Error('IdentificativoSdI non valido');
  const esito = payload.allowInvalidOutcome
    ? normalizeOutcomeForTest(payload.esito || 'EC99')
    : normalizeOutcome(payload.esito || 'EC01');
  const numeroFattura = String(payload.numeroFattura || '').trim();
  const annoFattura = String(payload.annoFattura || '').trim();
  const posizioneFattura = String(payload.posizioneFattura || '').trim();
  const riferimento = numeroFattura && /^\d{4}$/.test(annoFattura)
    ? [
        '  <RiferimentoFattura>',
        `    <NumeroFattura>${xmlEscape(numeroFattura)}</NumeroFattura>`,
        `    <AnnoFattura>${xmlEscape(annoFattura)}</AnnoFattura>`,
        posizioneFattura ? `    <PosizioneFattura>${xmlEscape(posizioneFattura)}</PosizioneFattura>` : '',
        '  </RiferimentoFattura>'
      ].filter(Boolean).join('\n')
    : '';
  const descrizione = String(payload.descrizione || '').trim();
  const messageId = String(payload.messageIdCommittente || '').trim().slice(0, 14);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<types:NotificaEsitoCommittente xmlns:types="${MESSAGGI_NS}" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" versione="1.0">`,
    `  <IdentificativoSdI>${xmlEscape(identificativoSdi)}</IdentificativoSdI>`,
    riferimento,
    `  <Esito>${esito}</Esito>`,
    descrizione ? `  <Descrizione>${xmlEscape(descrizione.slice(0, 255))}</Descrizione>` : '',
    messageId ? `  <MessageIdCommittente>${xmlEscape(messageId)}</MessageIdCommittente>` : '',
    '</types:NotificaEsitoCommittente>'
  ].filter((line) => line !== '').join('\n');
}

function buildSdIRiceviNotificaSoapEnvelope({ identificativoSdi, filename, outcomeXml }) {
  const encodedFile = Buffer.from(String(outcomeXml || ''), 'utf8').toString('base64');
  return {
    body: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:typ="${RICEZIONE_TYPES_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soapenv:Header/>
  <soapenv:Body>
    <typ:fileSdI>
      <IdentificativoSdI>${xmlEscape(identificativoSdi)}</IdentificativoSdI>
      <NomeFile>${xmlEscape(filename)}</NomeFile>
      <File>${encodedFile}</File>
    </typ:fileSdI>
  </soapenv:Body>
</soapenv:Envelope>`, 'utf8'),
    contentType: 'text/xml; charset=UTF-8'
  };
}

function parseSdIRiceviNotificaResponse(xml) {
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
        },
        accepted: false,
        rejected: false,
        retryable: false
      };
    }
    const response = body?.rispostaSdINotificaEsito
      || findObjectByKey(parsed, 'rispostaSdINotificaEsito')
      || {};
    const esito = firstValue(response, ['Esito', 'esito']);
  const scarto = parseScartoEsito(response?.ScartoEsito);
    return {
      esito,
      accepted: esito === 'ES01',
      rejected: esito === 'ES00',
      retryable: esito === 'ES02',
      scarto
    };
  } catch (error) {
    return {
      parseError: error.message,
      accepted: false,
      rejected: false,
      retryable: false
    };
  }
}

function parseScartoEsito(value) {
  if (!value || typeof value !== 'object') return null;
  const nomeFile = firstValue(value, ['NomeFile']);
  const encoded = firstValue(value, ['File']);
  const xml = encoded ? Buffer.from(String(encoded).replace(/\s+/g, ''), 'base64').toString('utf8') : '';
  const errori = collectErrors(xml);
  return {
    nomeFile,
    xml: xml || null,
    codice: errori[0]?.codice || extractScartoEsitoCode(xml) || null,
    descrizione: errori[0]?.descrizione || null,
    errori
  };
}

function buildEsitoCommittenteFilename(originalFilename, progressivo = 1) {
  const base = path.basename(String(originalFilename || '').trim()).replace(/\.xml(\.p7m)?$/i, '').replace(/[^A-Za-z0-9_.]+/g, '');
  const suffix = `_EC_${String(progressivo).padStart(3, '0')}.xml`;
  const filename = `${base}${suffix}`;
  if (!/^[A-Za-z0-9_.]{9,50}$/.test(filename)) {
    throw new Error(`Nome file esito committente non valido per SdI: ${filename}`);
  }
  return filename;
}

function persistOutcomeXml(xml, filename) {
  const dayDir = path.join(OUTCOME_DIR, new Date().toISOString().slice(0, 10).replace(/-/g, '/'));
  if (!fs.existsSync(dayDir)) fs.mkdirSync(dayDir, { recursive: true });
  const buffer = Buffer.from(String(xml || ''), 'utf8');
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const absolutePath = path.join(dayDir, `${sha256}_${filename}`);
  if (!fs.existsSync(absolutePath)) fs.writeFileSync(absolutePath, buffer);
  return {
    absolutePath,
    relativePath: `/${path.relative(ROOT, absolutePath).replace(/\\/g, '/')}`,
    sha256
  };
}

function persistOutcomeFlow({ invoice, mode, filename, identificativoSdi, stored, esito, endpoint, metadata }) {
  const result = db.prepare(`
    INSERT INTO fatture_sdi_flussi (
      fattura_id, direzione, modalita, tipo_messaggio, nome_file, identificativo_sdi, stato,
      esito_codice, xml_path, hash_file, payload_meta, ultimo_evento_il
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
  `).run(
    invoice.id,
    'outbound',
    mode,
    'notifica_esito_committente',
    filename,
    identificativoSdi,
    'esito_committente_generato',
    esito,
    stored.relativePath,
    stored.sha256,
    JSON.stringify({ ...metadata, endpoint })
  );
  return Number(result.lastInsertRowid);
}

function mapResponseState(parsed, httpOk) {
  if (!httpOk || parsed.fault) return 'errore_esito_committente';
  if (parsed.accepted) return 'esito_committente_accettato_sdi';
  if (parsed.retryable) return 'esito_committente_retry_sdi';
  if (parsed.rejected) return 'esito_committente_scartato_sdi';
  return 'esito_committente_risposta_sconosciuta';
}

function collectErrors(xml) {
  if (!xml) return [];
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true
  });
  try {
    const parsed = parser.parse(xml);
    const entries = [];
    walk(parsed, (node) => {
      if (!node || typeof node !== 'object') return;
      const codice = firstValue(node, ['Codice', 'CodiceErrore']);
      const descrizione = firstValue(node, ['Descrizione', 'DescrizioneErrore']);
      if (codice || descrizione) entries.push({ codice: codice || null, descrizione: descrizione || null });
    });
    return entries;
  } catch {
    return [];
  }
}

function walk(node, visitor) {
  if (node == null) return;
  if (Array.isArray(node)) return node.forEach((item) => walk(item, visitor));
  if (typeof node !== 'object') return;
  visitor(node);
  Object.values(node).forEach((value) => walk(value, visitor));
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
  for (const [key, value] of Object.entries(source)) {
    if (keys.includes(key) && value !== undefined && value !== null && typeof value !== 'object') {
      return String(value).trim();
    }
    if (value && typeof value === 'object') {
      const nested = firstValue(value, keys);
      if (nested != null) return nested;
    }
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

function normalizeOutcome(value) {
  const outcome = String(value || '').trim().toUpperCase();
  if (!['EC01', 'EC02'].includes(outcome)) throw new Error(`Esito committente non valido: ${value}`);
  return outcome;
}

function normalizeOutcomeForTest(value) {
  const outcome = String(value || '').trim().toUpperCase();
  if (!/^EC[A-Z0-9]{2}$/.test(outcome)) throw new Error(`Esito committente test non valido: ${value}`);
  return outcome;
}

function extractScartoEsitoCode(xml) {
  if (!xml) return null;
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true
  });
  try {
    const parsed = parser.parse(xml);
    const scarto = findObjectByKey(parsed, 'Scarto');
    return firstValue(scarto || parsed, ['Esito', 'Codice', 'CodiceErrore']);
  } catch {
    return null;
  }
}

function extractYear(value) {
  const match = String(value || '').match(/^(\d{4})/);
  return match ? match[1] : String(new Date().getUTCFullYear());
}

function buildMessageId(invoiceId) {
  return `H${String(invoiceId || 0).padStart(7, '0')}${Date.now().toString().slice(-6)}`.slice(0, 14);
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
  MESSAGGI_NS,
  RICEZIONE_TYPES_NS,
  SOAP_ACTION_NOTIFICA_ESITO,
  buildEsitoCommittenteFilename,
  buildNotificaEsitoCommittenteXml,
  buildSdIRiceviNotificaSoapEnvelope,
  getRiceviNotificaEndpoint,
  parseSdIRiceviNotificaResponse,
  sendEsitoCommittenteToSdi,
  sendEsitoCommittenteToSdiTest
};
