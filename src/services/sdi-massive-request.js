const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getSetting } = require('./google');
const { signCadesBes } = require('./sdi-cades');

// Costruzione e firma del file di richiesta per i Servizi Massivi di Scarico.
//
// Il tracciato segue InputMassivo_v1.5.xsd (namespace http://www.sogei.it/InputPubblico,
// elementFormDefault="qualified"), versionato in resources/sdi/smts.
//
// Istruzioni SMTS v1.5 par. 1: "la richiesta massiva riguardante una specifica
// partita IVA deve esser firmata per mezzo di firma qualificata dal soggetto
// richiedente". Le credenziali di firma sono deliberatamente separate da quelle
// mTLS del canale SDICoop: sono due cose diverse e non vanno confuse.

const INPUT_NS = 'http://www.sogei.it/InputPubblico';
const RICHIESTA_NS = 'http://ivaservizi.agenziaentrate.gov.it/docs/xsd/ServiziMassivi/input/RichiestaServiziMassivi/v1.0';
const SDI_CERTS_DIR = process.env.SDI_CERTS_DIR || '/run/sdi-certs';

// TipoRichiesta dell'involucro, tabella al par. 1.1 delle specifiche formato.
const TIPI_RICHIESTA = {
  FATT: 'fatture e dati di sintesi RSM',
  CORR: 'corrispettivi',
  BOLLO_AB: 'bollo A e bollo B',
  BOLLO_B: 'solo bollo B',
  IVA: 'documenti IVA precompilati'
};

// Mappa fra i tipi usati dal CRM e i blocchi del tracciato ufficiale.
const REQUEST_TYPES = {
  OUTGOING: { element: 'FattureEmesse', ruolo: 'CEDENTE', dateElement: 'DataEmissione' },
  INCOMING: { element: 'FattureRicevute', ruolo: 'CESSIONARIO', dateElement: 'DataRicezione' },
  AVAILABLE_TO_RECIPIENT: { element: 'FattureFEDisposizione', ruolo: 'CESSIONARIO', dateElement: 'DataEmissione' },
  BY_SDI_ID: { element: 'FattureSDI', ruolo: null, dateElement: null }
};

const FLOW_VALUES = new Set(['ALL', 'CON', 'DIS', 'ACC', 'RIF', 'DEC', 'IMP']);
const MAX_SDI_IDS = 10000;

function buildMassiveRequestXml({
  requestType,
  vatNumbers,
  dateFrom,
  dateTo,
  sdiIds = [],
  tipoRicerca = 'PUNTUALE',
  tipoOutput = 'FILE_FATTURA',
  flow = 'ALL'
}) {
  const descriptor = REQUEST_TYPES[requestType];
  if (!descriptor) throw new Error(`Tipo richiesta massiva non supportato: ${requestType}`);

  const pive = (Array.isArray(vatNumbers) ? vatNumbers : [vatNumbers]).map(normalizeVat);
  if (!pive.length) throw new Error('Nessuna partita IVA indicata nella richiesta massiva');
  // Le specifiche ammettono al piu' 30 partite IVA per richiesta.
  if (pive.length > 30) throw new Error(`Massimo 30 partite IVA per richiesta, ricevute ${pive.length}`);
  pive.forEach((piva) => {
    if (!/^\d{11}$/.test(piva)) throw new Error(`Partita IVA non conforme al tracciato (11 cifre): ${piva}`);
  });

  if (!['PUNTUALE', 'COMPLETA'].includes(tipoRicerca)) throw new Error(`TipoRicerca non valido: ${tipoRicerca}`);
  if (!['FILE_FATTURA', 'ELENCO'].includes(tipoOutput)) throw new Error(`TipoOutput non valido: ${tipoOutput}`);

  let body;
  if (requestType === 'BY_SDI_ID') {
    const ids = (sdiIds || []).map((id) => String(id).trim()).filter(Boolean);
    if (!ids.length) throw new Error('Nessun IdentificativoSdI indicato');
    if (ids.length > MAX_SDI_IDS) throw new Error(`Massimo ${MAX_SDI_IDS} identificativi per richiesta, ricevuti ${ids.length}`);
    ids.forEach((id) => {
      if (!/^\d+$/.test(id)) throw new Error(`IdentificativoSdI non numerico: ${id}`);
    });
    body = `<FattureSDI>${ids.map((id) => `<idsdi>${id}</idsdi>`).join('')}</FattureSDI>`;
  } else {
    assertDateRange(dateFrom, dateTo);
    if (!FLOW_VALUES.has(flow)) throw new Error(`Valore di flusso non ammesso: ${flow}`);
    const periodo = `<${descriptor.dateElement}><Da>${dateFrom}</Da><A>${dateTo}</A></${descriptor.dateElement}>`;
    // FattureFEDisposizione non prevede il blocco Flusso.
    const flusso = requestType === 'AVAILABLE_TO_RECIPIENT'
      ? ''
      : `<Flusso>${flow === 'ALL' ? '<Tutte>ALL</Tutte>' : `<FatturaB2B>${flow}</FatturaB2B>`}</Flusso>`;
    body = `<${descriptor.element}>${periodo}${flusso}<Ruolo>${descriptor.ruolo}</Ruolo></${descriptor.element}>`;
  }

  const output = requestType === 'BY_SDI_ID' ? '' : `<TipoOutput>${tipoOutput}</TipoOutput>`;
  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<InputMassivo xmlns="${INPUT_NS}">`
    + `<TipoRichiesta><Fatture>`
    + `<Richiesta>FATT</Richiesta>`
    + `<ElencoPiva>${pive.map((piva) => `<Piva>${piva}</Piva>`).join('')}</ElencoPiva>`
    + `<TipoRicerca>${tipoRicerca}</TipoRicerca>`
    + output
    + body
    + `</Fatture></TipoRichiesta>`
    + `</InputMassivo>`;
}

// Istruzioni SMTS: l'intervallo temporale non puo' eccedere i tre mesi
// (errore 00201 - Intervallo temporale indicato troppo ampio). Il CRM resta
// comunque su finestre mensili come default applicativo.
const MAX_RANGE_DAYS = 92;

function assertDateRange(dateFrom, dateTo) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateFrom || ''))) throw new Error(`Data iniziale non valida: ${dateFrom}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateTo || ''))) throw new Error(`Data finale non valida: ${dateTo}`);
  const from = Date.parse(`${dateFrom}T00:00:00Z`);
  const to = Date.parse(`${dateTo}T00:00:00Z`);
  if (to < from) throw new Error(`Intervallo invertito: ${dateFrom} - ${dateTo}`);
  const days = Math.round((to - from) / 86400000) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new Error(`Intervallo di ${days} giorni oltre il massimo ammesso di ${MAX_RANGE_DAYS} (controllo 00201)`);
  }
}

// Involucro della richiesta massiva.
//
// Specifiche formato file SMTS v1.5 par. 1.1: il file allegato alla SOAP
// request non e' l'InputMassivo, ma un documento conforme a
// RichiestaServiziMassivi_v1.0.xsd che lo contiene codificato in base-64. Ed e'
// questo involucro il documento che va firmato.
//
// Sono due livelli e vanno tenuti distinti: saltare l'involucro produce un file
// che il servizio rifiuta, e la firma qualificata spesa per firmarlo e' persa.
function buildRichiestaServiziMassiviXml({ tipoRichiesta = 'FATT', nomeFile, contenutoXml }) {
  if (!TIPI_RICHIESTA[tipoRichiesta]) {
    throw new Error(`TipoRichiesta non ammesso dal tracciato: ${tipoRichiesta}`);
  }
  assertNomeFile(nomeFile);
  const payload = Buffer.from(String(contenutoXml || ''), 'utf8');
  if (!payload.length) throw new Error('Contenuto della richiesta massiva mancante');

  // L'elemento ds:Signature del tracciato e' lo spazio per la firma XAdES
  // avvolgente. Con la firma CAdES il documento esce cosi' com'e' e la firma lo
  // avvolge dall'esterno, nel .p7m: qui non va lasciato alcun segnaposto.
  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<FileRichiesta xmlns="${RICHIESTA_NS}" versione="1.0">`
    + `<TipoRichiesta>${tipoRichiesta}</TipoRichiesta>`
    + `<NomeFile>${nomeFile}</NomeFile>`
    + `<File>${payload.toString('base64')}</File>`
    + `</FileRichiesta>`;
}

function assertNomeFile(nomeFile) {
  if (!/^[a-zA-Z0-9_.]{9,50}$/.test(String(nomeFile || ''))) {
    throw new Error(`Nome file non conforme al tracciato ([a-zA-Z0-9_.]{9,50}): ${nomeFile}`);
  }
}

// Nome file della richiesta: stesso vincolo del resto del SdI, [a-zA-Z0-9_.]{9,50}.
function buildMassiveRequestFilename({ vatNumber, requestType, dateFrom, dateTo, suffix = '' }) {
  const parts = [
    normalizeVat(vatNumber),
    String(requestType || 'REQ').replace(/[^A-Za-z0-9]/g, ''),
    String(dateFrom || '').replace(/-/g, ''),
    String(dateTo || '').replace(/-/g, ''),
    String(suffix || '').replace(/[^A-Za-z0-9]/g, '')
  ].filter(Boolean);
  const name = `${parts.join('_')}.xml`.replace(/[^A-Za-z0-9_.]/g, '');
  assertNomeFile(name);
  return name;
}

// --- credenziali di firma, distinte da quelle mTLS -----------------------

function getMassiveSigningConfig() {
  return {
    mode: String(getSetting('sdi.massive.signature.mode', 'disabled') || 'disabled').trim().toLowerCase(),
    certificatePath: resolvePath(getSetting('sdi.massive.signature.certificate_path', path.join(SDI_CERTS_DIR, 'massive', 'signer.pem'))),
    keyPath: resolvePath(getSetting('sdi.massive.signature.key_path', path.join(SDI_CERTS_DIR, 'massive', 'signer.key'))),
    passphrase: String(process.env.SDI_MASSIVE_SIGNATURE_PASSPHRASE || getSetting('sdi.massive.signature.key_passphrase', '') || '')
  };
}

function getMassiveSigningStatus() {
  const config = getMassiveSigningConfig();
  // Firma esterna: la richiesta esce in chiaro, viene firmata fuori dal CRM con
  // il dispositivo qualificato del titolare della partita IVA, e il .p7m rientra
  // per la verifica. E' il caso di FirmaOK, che non ha API server-to-server.
  if (config.mode === 'external') {
    return { available: true, external: true, mode: 'external', reason: null };
  }
  if (config.mode !== 'local') {
    return { available: false, external: false, mode: config.mode, reason: `Firma richieste massive non configurata (sdi.massive.signature.mode=${config.mode})` };
  }
  if (!fs.existsSync(config.certificatePath)) {
    return { available: false, mode: config.mode, reason: `Certificato di firma massiva non trovato: ${config.certificatePath}` };
  }
  if (!fs.existsSync(config.keyPath)) {
    return { available: false, mode: config.mode, reason: `Chiave di firma massiva non trovata: ${config.keyPath}` };
  }
  return { available: true, mode: config.mode, reason: null };
}

// Verifica una richiesta massiva firmata fuori dal CRM.
//
// Riusa la verifica del ciclo di firma delle fatture: il confronto che conta e'
// lo stesso, cioe' che il contenuto estratto dal P7M sia esattamente la
// richiesta prodotta dal CRM. Firmare una richiesta diversa da quella
// registrata significherebbe interrogare un periodo o una partita IVA diversi
// da quelli del job, e accorgersene solo dagli archivi che tornano.
function verifySignedMassiveRequest({ signedBuffer, expectedXmlSha256, now = new Date() }) {
  const { verifySignedFile } = require('./sdi-firma-esterna');
  return verifySignedFile({ signedBuffer, expectedXmlSha256, now });
}

function signMassiveRequest(xml) {
  const status = getMassiveSigningStatus();
  if (status.external) {
    throw new Error(
      'La firma delle richieste massive e impostata su "external": la richiesta va scaricata, '
      + 'firmata con il dispositivo qualificato e ricaricata, non firmata dal server'
    );
  }
  if (!status.available) {
    throw new Error(
      'La richiesta massiva deve essere firmata con firma qualificata '
      + `(Istruzioni SMTS v1.5 par. 1), ma la firma non e' disponibile: ${status.reason}`
    );
  }
  const config = getMassiveSigningConfig();
  const buffer = signCadesBes({
    content: Buffer.from(String(xml), 'utf8'),
    certificatePem: fs.readFileSync(config.certificatePath),
    privateKeyPem: fs.readFileSync(config.keyPath),
    passphrase: config.passphrase
  });
  return {
    buffer,
    format: 'CAdES-BES',
    sha256: crypto.createHash('sha256').update(buffer).digest('hex')
  };
}

function normalizeVat(value) {
  return String(value || '').trim().replace(/\s+/g, '').replace(/^IT/i, '');
}

function resolvePath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (process.platform !== 'win32' && raw.includes('\\')) {
    const normalized = raw.replace(/\\/g, '/');
    return path.posix.isAbsolute(normalized) ? normalized : path.join(SDI_CERTS_DIR, 'massive', path.posix.basename(normalized));
  }
  return path.isAbsolute(raw) ? raw : path.resolve(__dirname, '../../', raw);
}

module.exports = {
  INPUT_NS,
  RICHIESTA_NS,
  TIPI_RICHIESTA,
  buildRichiestaServiziMassiviXml,
  MAX_RANGE_DAYS,
  MAX_SDI_IDS,
  REQUEST_TYPES,
  assertDateRange,
  buildMassiveRequestFilename,
  buildMassiveRequestXml,
  getMassiveSigningConfig,
  getMassiveSigningStatus,
  signMassiveRequest,
  verifySignedMassiveRequest
};
