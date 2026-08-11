const { XMLParser } = require('fast-xml-parser');
const { getSetting } = require('./google');
const { parseEsitoRichiestaFile, selectInvoiceArchives } = require('./sdi-massive-esito');

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
// Gli allegati MTOM viaggiano accanto all'albero parsato, non dentro: una
// chiave Symbol non puo' essere confusa con un elemento del tracciato.
const ATTACHMENTS = Symbol('mtomAttachments');
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
    const allegato = esitoFile
      ? { nomeFile: firstText(esitoFile, 'NomeFile'), buffer: readFilePart(esitoFile, parsed[ATTACHMENTS]) }
      : null;

    // L'elenco degli archivi non sta nella risposta SOAP ma dentro EsitoFile:
    // senza leggerlo non si conoscono gli IdFile da passare a scaricoFile.
    // Un esito illeggibile non fa fallire l'interrogazione, che e' contingentata
    // a dieci chiamate: viene riportato e chi chiama decide.
    let esito = null;
    let esitoErrore = null;
    if (allegato?.buffer?.length) {
      try {
        esito = parseEsitoRichiestaFile(allegato.buffer);
      } catch (error) {
        esitoErrore = error.message;
      }
    }

    return {
      stato,
      statoDescrizione: STATI[stato] || null,
      processing: stato === 'ST01',
      rejected: stato === 'ST02',
      ready: stato === 'ST03',
      tipo: firstText(parsed, 'Tipo') || null,
      dataOraProduzioneFile: firstText(parsed, 'DataOraProduzioneFile') || null,
      esitoFile: allegato,
      esito,
      esitoErrore,
      // Con ST03 il tracciato promette un EsitoFile. Se manca, la differenza
      // fra "SdI non ha allegato nulla" e "non abbiamo saputo leggerlo" sta in
      // questi numeri, e senza sarebbe una nuova interrogazione per scoprirlo.
      diagnostica: (stato === 'ST03' && !allegato?.buffer?.length) ? { ...this.lastRaw } : null,
      archivi: esito ? esito.archivi : [],
      archiviFatture: esito ? selectInvoiceArchives(esito) : [],
      dataFineDisponibilita: esito ? esito.dataFineDisponibilita : null,
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
      buffer: readFilePart(archivio, parsed[ATTACHMENTS]),
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
    if (statusCode < 200 || statusCode >= 300) {
      throw new SdiMassiveServiceError(`HTTP ${statusCode} da ${operationName}`, `HTTP_${statusCode}`, operationName);
    }

    // Gli elementi File del contratto sono base64Binary annotati
    // xmime:expectedContentTypes, cioe' ottimizzabili in MTOM: il contenuto puo'
    // arrivare come allegato MIME invece che inline. Leggere il corpo come
    // stringa e ignorare il content-type fa trovare un <File> vuoto al posto
    // dell'allegato, senza nessun errore.
    const bodyBuffer = Buffer.isBuffer(response?.body)
      ? response.body
      : Buffer.from(String(response?.body || ''), 'utf8');
    const contentType = String(response?.headers?.['content-type'] || '');
    const { xml, attachments } = splitMtomResponse(bodyBuffer, contentType);

    this.lastRaw = { operation: operationName, contentType, bytes: bodyBuffer.length, attachments: attachments.size };
    return { ...parseResponse(xml, operationName), [ATTACHMENTS]: attachments };
  }
}

function buildEnvelope(element, innerXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:typ="${TYPES_NS}">`
    + `<soapenv:Header/><soapenv:Body><typ:${element}>${innerXml}</typ:${element}></soapenv:Body>`
    + `</soapenv:Envelope>`;
}

// Separa una risposta MTOM nella parte XML e negli allegati indicizzati per
// Content-ID. Una risposta non multipart passa invariata.
function splitMtomResponse(buffer, contentType) {
  const attachments = new Map();
  if (!/multipart\/related/i.test(contentType)) {
    return { xml: buffer.toString('utf8'), attachments };
  }
  const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
  if (!boundaryMatch) return { xml: buffer.toString('utf8'), attachments };

  const raw = buffer.toString('binary');
  const parti = raw.split(`--${boundaryMatch[1]}`).filter((parte) => parte.trim() && parte.trim() !== '--');
  let xml = '';
  for (const parte of parti) {
    const separatore = parte.indexOf('\r\n\r\n');
    if (separatore < 0) continue;
    const intestazioni = parte.slice(0, separatore);
    // Il CRLF finale appartiene al delimitatore, non al contenuto: lasciarlo
    // dentro cambierebbe l'hash di un allegato binario.
    const contenuto = parte.slice(separatore + 4).replace(/\r\n$/, '');
    const cid = (intestazioni.match(/content-id:\s*<?([^>\r\n]+)>?/i) || [])[1];
    const tipo = (intestazioni.match(/content-type:\s*([^\r\n;]+)/i) || [])[1] || '';

    if (/xop\+xml|text\/xml|soap\+xml/i.test(tipo) && !xml) {
      xml = Buffer.from(contenuto, 'binary').toString('utf8');
    } else if (cid) {
      attachments.set(cid.trim(), Buffer.from(contenuto, 'binary'));
    }
  }
  return { xml: xml || buffer.toString('utf8'), attachments };
}

// Restituisce il contenuto di un elemento File, comunque sia arrivato: inline
// in base-64 oppure come allegato MTOM referenziato da xop:Include.
function readFilePart(node, attachments) {
  if (!node || typeof node !== 'object') return Buffer.alloc(0);
  const inline = firstText(node, 'File');
  if (inline) return decodeBase64(inline);

  const include = firstNode(node, 'Include');
  const href = include ? String(include['@_href'] || '') : '';
  if (href.startsWith('cid:') && attachments) {
    // L'href e' URL-encoded: i Content-ID contengono spesso caratteri sfuggiti.
    const cid = decodeURIComponent(href.slice(4));
    return attachments.get(cid) || attachments.get(cid.replace(/^<|>$/g, '')) || Buffer.alloc(0);
  }
  return Buffer.alloc(0);
}

function parseResponse(xml, operation) {
  // Gli attributi servono: senza, l'href di xop:Include sparisce e un allegato
  // MTOM diventa indistinguibile da un file assente.
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false, trimValues: true });
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
  buildEnvelope,
  readFilePart,
  splitMtomResponse
};
