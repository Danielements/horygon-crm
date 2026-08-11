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
  // Omesso per default. E' facoltativo nel nostro tracciato (minOccurs="0") e
  // assente non vale FILE_FATTURA, che e' esattamente cio' che vogliamo
  // (Istruzioni SMTS: "se valorizzato con FILE_FATTURA o non presente").
  // Ometterlo rende la richiesta valida anche per lo schema del servizio di
  // Consultazione e Download Massivi v2.4, che TipoOutput non lo prevede:
  // stesso namespace, stesso nome radice, schemi diversi. Un elemento in meno
  // e' un motivo in meno di essere rifiutati.
  tipoOutput = null,
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
  if (tipoOutput !== null && !['FILE_FATTURA', 'ELENCO'].includes(tipoOutput)) {
    throw new Error(`TipoOutput non valido: ${tipoOutput}`);
  }

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

  const output = (requestType === 'BY_SDI_ID' || tipoOutput === null) ? '' : `<TipoOutput>${tipoOutput}</TipoOutput>`;
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
// (errore 00201 - Intervallo temporale indicato troppo ampio).
//
// Tre mesi sono mesi di calendario, non un numero fisso di giorni: dal 1 marzo
// al 1 giugno sono tre mesi e ne fanno 93, dal 1 dicembre al 1 marzo sono
// sempre tre mesi ma ne fanno 91. Contare i giorni rifiutava intervalli che il
// servizio accetta, come mostrano le richieste composte sul portale.
const MAX_RANGE_MONTHS = 3;
// Tenuto per compatibilita' con chi lo importa: e' il caso peggiore in giorni.
const MAX_RANGE_DAYS = 92;

function addMonthsToDate(date, months) {
  const [y, m, d] = String(date).split('-').map(Number);
  const totale = (y * 12) + (m - 1) + months;
  const anno = Math.floor(totale / 12);
  const mese = (totale % 12) + 1;
  const ultimo = new Date(Date.UTC(anno, mese, 0)).getUTCDate();
  const giorno = Math.min(d, ultimo);
  return `${anno}-${String(mese).padStart(2, '0')}-${String(giorno).padStart(2, '0')}`;
}

function assertDateRange(dateFrom, dateTo) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateFrom || ''))) throw new Error(`Data iniziale non valida: ${dateFrom}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateTo || ''))) throw new Error(`Data finale non valida: ${dateTo}`);
  if (dateTo < dateFrom) throw new Error(`Intervallo invertito: ${dateFrom} - ${dateTo}`);
  const limite = addMonthsToDate(dateFrom, MAX_RANGE_MONTHS);
  if (dateTo > limite) {
    throw new Error(
      `Intervallo ${dateFrom} - ${dateTo} oltre i ${MAX_RANGE_MONTHS} mesi ammessi `
      + `(il massimo da ${dateFrom} e ${limite}, controllo 00201)`
    );
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

  // Il prefisso sulla sola radice non e' estetica: RichiestaServiziMassivi_v1.0
  // non dichiara elementFormDefault, quindi vale "unqualified" e i figli devono
  // stare FUORI dal namespace. Con xmlns di default finirebbero dentro, e SdI
  // risponde 00200 "File non conforme al tracciato" indicando TipoRichiesta.
  //
  // InputMassivo_v1.5 fa l'opposto (elementFormDefault="qualified"), ed e' per
  // questo che li' il namespace di default e' corretto. I due tracciati non si
  // scrivono allo stesso modo.
  //
  // L'elemento ds:Signature del tracciato e' lo spazio per la firma XAdES
  // avvolgente. Con la firma CAdES il documento esce cosi' com'e' e la firma lo
  // avvolge dall'esterno, nel .p7m: qui non va lasciato alcun segnaposto.
  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<ns:FileRichiesta xmlns:ns="${RICHIESTA_NS}" versione="1.0">`
    + `<TipoRichiesta>${tipoRichiesta}</TipoRichiesta>`
    + `<NomeFile>${nomeFile}</NomeFile>`
    + `<File>${payload.toString('base64')}</File>`
    + `</ns:FileRichiesta>`;
}

// Validazione contro gli XSD ufficiali, prima della firma.
//
// Un file non conforme torna indietro come 00200 solo dopo l'inoltro, cioe'
// dopo che una firma qualificata e' gia' stata spesa e non e' recuperabile.
// Gli schemi sono versionati nel repo: verificare qui costa nulla ed e' l'unico
// momento in cui l'errore e' ancora gratis.
const SMTS_DIR = path.join(__dirname, '../../resources/sdi/smts');
const DSIG_LOCAL = path.join(__dirname, '../../resources/sdi/invoices/common/xmldsig-core-schema.xsd');

let libxmlPromise = null;
function getLibxml() {
  if (!libxmlPromise) libxmlPromise = import('libxml2-wasm');
  return libxmlPromise;
}

async function validateAgainstXsd(xml, xsdFile, etichetta) {
  const { XmlDocument, XsdValidator } = await getLibxml();
  // L'import di xmldsig punta a un URL remoto, e il validatore gira in WASM
  // senza accesso al filesystem dell'host: non e' raggiungibile in nessuno dei
  // due modi. Si rimuove l'import e il riferimento a ds:Signature, che con la
  // firma CAdES non emettiamo comunque - stesso trattamento gia' applicato agli
  // schemi FatturaPA in sdi-xml-validator.
  const xsd = String(fs.readFileSync(path.join(SMTS_DIR, xsdFile), 'utf8'))
    .replace(/^\s*<xs:import[^>]*xmldsig-core-schema\.xsd[^>]*\/>\s*$/m, '')
    .replace(/^\s*<xs:element\s+ref="ds:Signature"[^>]*\/>\s*$/m, '');

  let xsdDoc = null;
  let validator = null;
  let xmlDoc = null;
  try {
    xsdDoc = XmlDocument.fromBuffer(Buffer.from(xsd, 'utf8'), { url: `${SMTS_DIR.replace(/\\/g, '/')}/${xsdFile}` });
    validator = XsdValidator.fromDoc(xsdDoc);
    xmlDoc = XmlDocument.fromString(xml);
    validator.validate(xmlDoc);
    return { ok: true, schema: xsdFile, errors: [] };
  } catch (error) {
    const details = Array.isArray(error?.details) ? error.details : null;
    return {
      ok: false,
      schema: xsdFile,
      errors: details ? details.map((d) => d.message || String(d)) : [error.message]
    };
  } finally {
    try { xmlDoc && xmlDoc.dispose(); } catch {}
    try { validator && validator.dispose(); } catch {}
    try { xsdDoc && xsdDoc.dispose(); } catch {}
  }
}

// Valida entrambi i livelli: l'involucro e il documento che porta dentro.
async function validateMassiveRequest({ involucro, contenutoXml }) {
  const esiti = [];
  if (contenutoXml) esiti.push(await validateAgainstXsd(contenutoXml, 'InputMassivo_v1.5.xsd', 'contenuto'));
  esiti.push(await validateAgainstXsd(involucro, 'RichiestaServiziMassivi_v1.0.xsd', 'involucro'));

  const falliti = esiti.filter((esito) => !esito.ok);
  if (falliti.length) {
    const error = new Error(
      'La richiesta massiva non e conforme ai tracciati ufficiali: '
      + falliti.map((f) => `${f.schema} -> ${f.errors.join('; ')}`).join(' | ')
    );
    error.code = 'RICHIESTA_NON_CONFORME';
    error.dettagli = falliti;
    throw error;
  }
  return { ok: true, schemi: esiti.map((e) => e.schema) };
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
  MAX_RANGE_MONTHS,
  addMonthsToDate,
  MAX_SDI_IDS,
  REQUEST_TYPES,
  assertDateRange,
  buildMassiveRequestFilename,
  buildMassiveRequestXml,
  getMassiveSigningConfig,
  getMassiveSigningStatus,
  signMassiveRequest,
  validateMassiveRequest,
  verifySignedMassiveRequest
};
