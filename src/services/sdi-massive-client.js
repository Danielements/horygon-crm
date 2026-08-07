const { XMLParser } = require('fast-xml-parser');
const { getSetting } = require('./google');

// Adapter per il web service sm-scarico-file dei Servizi Massivi SdI.
//
// Contratto: resources/sdi/smts/ServiziScaricoMassivo_v1.0.wsdl
//   targetNamespace  http://ivaservizi.agenziaentrate.gov.it/docs/wsdl/ServiziMassivi/v1.0
//   types            .../v1.0/types
//   endpoint         https://servizi.fatturapa.it/sm-scarico-file
//
// Attenzione: le SOAPAction di questo servizio sono stringhe nude
// ("inoltroRichiesta"), non URI come in SDICoop. Il valore viene dal WSDL.
//
// Il trasporto e' iniettabile: in test si usano fixture derivate dagli XSD
// ufficiali, senza alcuna chiamata reale.

const TYPES_NS = 'http://ivaservizi.agenziaentrate.gov.it/docs/wsdl/ServiziMassivi/v1.0/types';
const DEFAULT_ENDPOINT = 'https://servizi.fatturapa.it/sm-scarico-file';

const OPERATIONS = {
  inoltroRichiesta: { soapAction: 'inoltroRichiesta', element: 'InoltroRichiestaRequest' },
  esitoRichiesta: { soapAction: 'esitoRichiesta', element: 'EsitoRichiestaRequest' },
  scaricoFile: { soapAction: 'scaricoFile', element: 'ScaricoFileRequest' }
};

// ServiziMassiviTypes_v1.0.xsd
const STATI = {
  ST00: 'NON DISPONIBILE',
  ST01: 'IN ELABORAZIONE',
  ST02: 'SCARTATO',
  ST03: 'ELABORATO'
};

const ERRORI = {
  ER01: 'SERVIZIO NON DISPONIBILE',
  ER02: 'UTENTE NON ABILITATO',
  ER03: 'RICHIESTA TROPPO FREQUENTE',
  ER04: 'PARAMETRI DI INPUT NON VALIDI',
  ER05: 'DATO NON TROVATO'
};

// Limiti dichiarati nelle Istruzioni SMTS v1.5, applicati lato client per non
// incorrere in ER03 (richiesta troppo frequente), che e' inutile e costoso.
const LIMITS = {
  maxEsitoCallsPerRequest: 10,
  maxArchiveDownloadsPerWindow: 10,
  archiveWindowMs: 2 * 60 * 1000
};

class SdiMassiveServiceError extends Error {
  constructor(message, code, operation) {
    super(message);
    this.name = 'SdiMassiveServiceError';
    this.code = code;
    this.operation = operation;
    this.retryable = code === 'ER01' || code === 'ER03';
  }
}

class SdiMassiveServicesClient {
  // transport(request) -> { statusCode, body } ; iniettabile per i test.
  constructor({ transport, endpoint, now = () => Date.now() } = {}) {
    if (typeof transport !== 'function') {
      throw new Error('SdiMassiveServicesClient richiede un transport');
    }
    this.transport = transport;
    this.endpoint = endpoint || String(getSetting('sdi.massive.endpoint', DEFAULT_ENDPOINT) || DEFAULT_ENDPOINT).trim();
    this.now = now;
    this.esitoCalls = new Map();
    this.archiveDownloads = [];
  }

  // inoltroRichiesta: trasmette il file di richiesta firmato.
  async submitRequest({ filename, signedRequest }) {
    if (!filename) throw new Error('Nome file richiesta mancante');
    if (!Buffer.isBuffer(signedRequest) || !signedRequest.length) {
      throw new Error('File di richiesta firmato mancante');
    }
    const body = `<NomeFile>${escapeXml(filename)}</NomeFile>`
      + `<File>${signedRequest.toString('base64')}</File>`;
    const parsed = await this.call('inoltroRichiesta', `<FileRichiesta>${body}</FileRichiesta>`);
    this.assertNoError(parsed, 'inoltroRichiesta');
    const idRichiesta = firstText(parsed, 'IdRichiesta');
    if (!idRichiesta) {
      throw new SdiMassiveServiceError('Risposta senza IdRichiesta: presa in carico non confermata', 'NO_ID', 'inoltroRichiesta');
    }
    return { idRichiesta, dataOraRicezione: firstText(parsed, 'DataOraRicezione') || null };
  }

  // esitoRichiesta: stato della richiesta e, se elaborata, elenco archivi.
  async getRequestStatus(idRichiesta) {
    if (!idRichiesta) throw new Error('IdRichiesta mancante');
    const used = this.esitoCalls.get(idRichiesta) || 0;
    if (used >= LIMITS.maxEsitoCallsPerRequest) {
      throw new SdiMassiveServiceError(
        `Limite di ${LIMITS.maxEsitoCallsPerRequest} interrogazioni per richiesta gia raggiunto per ${idRichiesta}`,
        'LOCAL_LIMIT',
        'esitoRichiesta'
      );
    }
    this.esitoCalls.set(idRichiesta, used + 1);

    const parsed = await this.call('esitoRichiesta', `<IdRichiesta>${escapeXml(idRichiesta)}</IdRichiesta>`);
    this.assertNoError(parsed, 'esitoRichiesta');
    const stato = firstText(parsed, 'Stato');
    const esitoFile = firstNode(parsed, 'EsitoFile');
    return {
      stato,
      statoDescrizione: STATI[stato] || null,
      processing: stato === 'ST01',
      rejected: stato === 'ST02',
      ready: stato === 'ST03',
      tipo: firstText(parsed, 'Tipo') || null,
      dataOraProduzioneFile: firstText(parsed, 'DataOraProduzioneFile') || null,
      esitoFile: esitoFile
        ? { nomeFile: firstText(esitoFile, 'NomeFile'), buffer: decodeBase64(firstText(esitoFile, 'File')) }
        : null,
      callsUsed: used + 1,
      callsRemaining: LIMITS.maxEsitoCallsPerRequest - (used + 1)
    };
  }

  // scaricoFile: scarica il singolo archivio prodotto dalla richiesta.
  //
  // Le Istruzioni SMTS avvertono che il download di un archivio contenente
  // fatture messe a disposizione vale come PRESA VISIONE: chi chiama deve
  // saperlo e tracciarlo, quindi il flag va passato esplicitamente.
  async downloadArchive(idRichiesta, idFile, { acknowledgeVisualizzazione = false } = {}) {
    if (!idRichiesta || !idFile) throw new Error('IdRichiesta e IdFile sono obbligatori');
    this.enforceArchiveRate();
    const parsed = await this.call(
      'scaricoFile',
      `<IdRichiesta>${escapeXml(idRichiesta)}</IdRichiesta><IdFile>${escapeXml(idFile)}</IdFile>`
    );
    this.assertNoError(parsed, 'scaricoFile');
    const archivio = firstNode(parsed, 'ArchivioFile');
    if (!archivio) {
      throw new SdiMassiveServiceError('Risposta senza ArchivioFile', 'NO_ARCHIVE', 'scaricoFile');
    }
    return {
      nomeFile: firstText(archivio, 'NomeFile'),
      buffer: decodeBase64(firstText(archivio, 'File')),
      presaVisione: Boolean(acknowledgeVisualizzazione)
    };
  }

  enforceArchiveRate() {
    const now = this.now();
    this.archiveDownloads = this.archiveDownloads.filter((ts) => now - ts < LIMITS.archiveWindowMs);
    if (this.archiveDownloads.length >= LIMITS.maxArchiveDownloadsPerWindow) {
      throw new SdiMassiveServiceError(
        `Limite di ${LIMITS.maxArchiveDownloadsPerWindow} archivi ogni 2 minuti raggiunto: attendere per non incorrere in ER03`,
        'LOCAL_LIMIT',
        'scaricoFile'
      );
    }
    this.archiveDownloads.push(now);
  }

  assertNoError(parsed, operation) {
    const errore = firstNode(parsed, 'Errore');
    if (!errore) return;
    const codice = firstText(errore, 'Codice');
    const descrizione = firstText(errore, 'Descrizione') || ERRORI[codice] || 'errore non documentato';
    throw new SdiMassiveServiceError(`${codice} - ${descrizione}`, codice, operation);
  }

  async call(operationName, innerXml) {
    const operation = OPERATIONS[operationName];
    if (!operation) throw new Error(`Operazione non prevista dal contratto: ${operationName}`);
    const envelope = buildEnvelope(operation.element, innerXml);
    const response = await this.transport({
      endpoint: this.endpoint,
      soapAction: operation.soapAction,
      contentType: 'text/xml; charset=UTF-8',
      body: Buffer.from(envelope, 'utf8'),
      operation: operationName
    });
    const statusCode = response?.statusCode ?? 0;
    const text = Buffer.isBuffer(response?.body) ? response.body.toString('utf8') : String(response?.body || '');
    if (statusCode < 200 || statusCode >= 300) {
      throw new SdiMassiveServiceError(`HTTP ${statusCode} da ${operationName}`, `HTTP_${statusCode}`, operationName);
    }
    return parseResponse(text, operationName);
  }
}

function buildEnvelope(element, innerXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:typ="${TYPES_NS}">`
    + `<soapenv:Header/><soapenv:Body><typ:${element}>${innerXml}</typ:${element}></soapenv:Body>`
    + `</soapenv:Envelope>`;
}

function parseResponse(xml, operation) {
  const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, trimValues: true });
  let parsed;
  try {
    parsed = parser.parse(xml);
  } catch (error) {
    throw new SdiMassiveServiceError(`Risposta non parsabile: ${error.message}`, 'PARSE_ERROR', operation);
  }
  const body = parsed?.Envelope?.Body || parsed?.Body || parsed;
  if (body?.Fault) {
    const fault = body.Fault;
    throw new SdiMassiveServiceError(`SOAP Fault: ${fault.faultstring || 'senza descrizione'}`, 'SOAP_FAULT', operation);
  }
  return body;
}

function firstNode(source, key) {
  if (!source || typeof source !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(source, key) && source[key] && typeof source[key] === 'object') {
    return source[key];
  }
  for (const value of Object.values(source)) {
    const found = firstNode(value, key);
    if (found) return found;
  }
  return null;
}

function firstText(source, key) {
  if (!source || typeof source !== 'object') return null;
  for (const [name, value] of Object.entries(source)) {
    if (name === key && value !== null && value !== undefined && typeof value !== 'object') return String(value).trim();
    if (value && typeof value === 'object') {
      const nested = firstText(value, key);
      if (nested !== null && nested !== undefined) return nested;
    }
  }
  return null;
}

function decodeBase64(value) {
  const clean = String(value || '').replace(/\s+/g, '');
  return clean ? Buffer.from(clean, 'base64') : Buffer.alloc(0);
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = {
  DEFAULT_ENDPOINT,
  ERRORI,
  LIMITS,
  OPERATIONS,
  STATI,
  SdiMassiveServiceError,
  SdiMassiveServicesClient,
  TYPES_NS,
  buildEnvelope
};
