const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const db = require('../src/db/database');
const { signCadesBes } = require('../src/services/sdi-cades');
const { parseEsitoRichiestaFile, selectInvoiceArchives } = require('../src/services/sdi-massive-esito');
const { SdiMassiveServicesClient, TYPES_NS } = require('../src/services/sdi-massive-client');
const { getMassiveSigningStatus } = require('../src/services/sdi-massive-request');
const { createJob, generateWindows, getJob } = require('../src/services/sdi-historical-sync');
const {
  MAX_ESITO_CALLS,
  attachSignedRequest,
  downloadArchives,
  getRequestToSign,
  importArchives,
  isExpired,
  matchCompanionMetadata,
  pollRequest,
  prepareRequest,
  readCompanionMetadata,
  reprocessArchives,
  submitRequest
} = require('../src/services/sdi-backfill');

const ROOT = path.resolve(__dirname, '..');
const TENANT = 9301;
const PIVA = '03365990591';
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// --- fixture sul tracciato ufficiale --------------------------------------
// Il file di esito segue "Formato dei file utilizzati dai Servizi Massivi"
// v1.5 par. 1.2. Lo schema ScaricoRichiesteEsito_v1.0.xsd non e' pubblicato
// insieme al WSDL, quindi la fixture riproduce la tabella della specifica.

function esitoXml({ idRichiesta = 'REQ-1', archivi = [], errori = [], numeroArchivi = null } = {}) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<EsitoRichiesta versione="1.0">'
    + `<IdRichiesta>${idRichiesta}</IdRichiesta>`
    + `<Piva>${PIVA}</Piva>`
    + '<DataFineDisponibilita>2026-09-15</DataFineDisponibilita>'
    + `<NumeroArchivi>${numeroArchivi === null ? archivi.length : numeroArchivi}</NumeroArchivi>`
    + `<NumeroErrori>${errori.length}</NumeroErrori>`
    + '<Esito>'
    + (archivi.length
      ? `<ElencoArchivi>${archivi.map((a) => '<Archivio>'
        + `<IdFile>${a.idFile}</IdFile><NomeFile>${a.nomeFile}</NomeFile>`
        + `<DimensioneFile>${a.dimensione || 1024}</DimensioneFile>`
        + `<TipoElementi>${a.tipo || 'Fatt'}</TipoElementi>`
        + `<NumeroElementi>${a.elementi || 1}</NumeroElementi></Archivio>`).join('')}</ElencoArchivi>`
      : '')
    + (errori.length
      ? `<ElencoErrori>${errori.map((e) => `<Errore><Codice>${e.codice}</Codice><Descrizione>${e.descrizione}</Descrizione></Errore>`).join('')}</ElencoErrori>`
      : '')
    + '</Esito></EsitoRichiesta>';
}

function envelope(element, body) {
  return '<?xml version="1.0"?>'
    + '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">'
    + `<soapenv:Body><ns:${element} xmlns:ns="${TYPES_NS}">${body}</ns:${element}></soapenv:Body>`
    + '</soapenv:Envelope>';
}

function clientWith(responses) {
  const queue = [...responses];
  const calls = [];
  const transport = async (request) => {
    calls.push(request);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return { statusCode: next.statusCode || 200, body: next.body };
  };
  const client = new SdiMassiveServicesClient({ transport, endpoint: 'https://esempio.invalid/sm-scarico-file' });
  client.calls = calls;
  return client;
}

function invoiceXml({ numero, cedente = PIVA, cessionario = '01043931003' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2">
<FatturaElettronicaHeader><DatiTrasmissione><IdTrasmittente><IdPaese>IT</IdPaese><IdCodice>${cedente}</IdCodice></IdTrasmittente><ProgressivoInvio>H0001</ProgressivoInvio><FormatoTrasmissione>FPR12</FormatoTrasmissione><CodiceDestinatario>0000000</CodiceDestinatario></DatiTrasmissione>
<CedentePrestatore><DatiAnagrafici><IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${cedente}</IdCodice></IdFiscaleIVA><Anagrafica><Denominazione>Fornitore</Denominazione></Anagrafica></DatiAnagrafici></CedentePrestatore>
<CessionarioCommittente><DatiAnagrafici><IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${cessionario}</IdCodice></IdFiscaleIVA><Anagrafica><Denominazione>Cliente</Denominazione></Anagrafica></DatiAnagrafici></CessionarioCommittente>
</FatturaElettronicaHeader>
<FatturaElettronicaBody><DatiGenerali><DatiGeneraliDocumento><TipoDocumento>TD01</TipoDocumento><Divisa>EUR</Divisa><Data>2026-03-15</Data><Numero>${numero}</Numero><ImportoTotaleDocumento>122.00</ImportoTotaleDocumento></DatiGeneraliDocumento></DatiGenerali>
<DatiBeniServizi><DettaglioLinee><NumeroLinea>1</NumeroLinea><Descrizione>Servizio</Descrizione><PrezzoUnitario>100.00</PrezzoUnitario><PrezzoTotale>100.00</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA></DettaglioLinee>
<DatiRiepilogo><AliquotaIVA>22.00</AliquotaIVA><ImponibileImporto>100.00</ImponibileImporto><Imposta>22.00</Imposta></DatiRiepilogo></DatiBeniServizi></FatturaElettronicaBody>
</p:FatturaElettronica>`;
}

function metadataXml({ idfile, hashfile }) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + `<FileMetadati><idfile>${idfile}</idfile><hashfile>${hashfile}</hashfile>`
    + '<dataaccoglienza>2026-03-15</dataaccoglienza></FileMetadati>';
}

function zipWith(files) {
  // ZIP store-only, scritto a mano: evita di dipendere da un archiviatore
  // esterno e resta leggibile da SafeZipReader come un archivio qualunque.
  const zlib = require('zlib');
  const chunks = [];
  const central = [];
  let offset = 0;
  files.forEach(({ name, content }) => {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(data) : crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(crc >>> 0, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  });

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(chunks), centralBuf, end]);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

function seedFiscalConfig() {
  // sdi_fiscal_configuration.tenant_id ha una FK su tenants: il tenant di prova
  // va creato, non solo referenziato.
  db.prepare("INSERT OR IGNORE INTO tenants (id, codice, ragione_sociale) VALUES (?, ?, ?)")
    .run(TENANT, `TEST${TENANT}`, 'Tenant di prova backfill');
  db.prepare(`
    INSERT INTO sdi_fiscal_configuration
      (tenant_id, vat_number, tax_code, massive_services_enabled, massive_services_provider_enabled)
    VALUES (?,?,?,1,1)
    ON CONFLICT(tenant_id) DO UPDATE SET
      vat_number = excluded.vat_number, tax_code = excluded.tax_code,
      massive_services_enabled = 1, massive_services_provider_enabled = 1
  `).run(TENANT, PIVA, PIVA);
}

function cleanup() {
  db.prepare('DELETE FROM sdi_historical_sync_item WHERE tenant_id = ?').run(TENANT);
  db.prepare('DELETE FROM sdi_historical_sync_archive WHERE tenant_id = ?').run(TENANT);
  db.prepare('DELETE FROM sdi_historical_sync_job WHERE tenant_id = ?').run(TENANT);
  db.prepare('DELETE FROM fatture_righe WHERE tenant_id = ?').run(TENANT);
  db.prepare('DELETE FROM fatture_iva_riepilogo WHERE tenant_id = ?').run(TENANT);
  db.prepare('DELETE FROM fatture WHERE tenant_id = ?').run(TENANT);
  db.prepare('DELETE FROM sdi_fiscal_configuration WHERE tenant_id = ?').run(TENANT);
  db.prepare('DELETE FROM tenants WHERE id = ?').run(TENANT);
  db.prepare("DELETE FROM audit_log WHERE azione LIKE 'SDI_HISTORICAL_%'").run();
}

function material() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'massiva-'));
  const keyPath = path.join(dir, 'k.key');
  const certPath = path.join(dir, 'c.pem');
  try {
    execFileSync('openssl', ['genrsa', '-out', keyPath, '2048'], { stdio: 'ignore' });
    execFileSync('openssl', ['req', '-x509', '-key', keyPath, '-out', certPath, '-days', '30',
      '-subj', '/C=IT/O=Poste Italiane/CN=FURFARI DANIELE'],
    { stdio: 'ignore', env: Object.assign({}, process.env, { MSYS_NO_PATHCONV: '1' }) });
  } catch {
    return null;
  }
  return { keyPath, certPath };
}

function sign(content, m) {
  return signCadesBes({
    content: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
    certificatePem: fs.readFileSync(m.certPath),
    privateKeyPem: fs.readFileSync(m.keyPath)
  });
}

// --- lettura del file di esito --------------------------------------------

test('il file di esito espone gli IdFile necessari a scaricoFile', () => {
  const esito = parseEsitoRichiestaFile(Buffer.from(esitoXml({
    idRichiesta: 'REQ-77',
    archivi: [
      { idFile: '101', nomeFile: 'archivio1.zip', elementi: 40 },
      { idFile: '102', nomeFile: 'archivio2.zip', elementi: 12 }
    ]
  }), 'utf8'));

  assert.equal(esito.idRichiesta, 'REQ-77');
  assert.equal(esito.dataFineDisponibilita, '2026-09-15');
  assert.equal(esito.archivi.length, 2);
  assert.deepEqual(esito.archivi.map((a) => a.idFile), ['101', '102']);
  assert.equal(esito.archivi[0].numeroElementi, 40);
  assert.equal(esito.conteggioCoerente, true);
});

test('un solo archivio non diventa una lista di caratteri', () => {
  // fast-xml-parser restituisce un oggetto e non un array quando l'elemento
  // ricorre una volta sola: e' l'errore classico su questi tracciati.
  const esito = parseEsitoRichiestaFile(Buffer.from(esitoXml({ archivi: [{ idFile: '55', nomeFile: 'solo.zip' }] }), 'utf8'));
  assert.equal(esito.archivi.length, 1);
  assert.equal(esito.archivi[0].idFile, '55');
});

test('gli archivi non fatture restano fuori dal backfill fatture', () => {
  const esito = parseEsitoRichiestaFile(Buffer.from(esitoXml({
    archivi: [
      { idFile: '1', nomeFile: 'fatture.zip', tipo: 'Fatt' },
      { idFile: '2', nomeFile: 'corrispettivi.zip', tipo: 'Corr' },
      { idFile: '3', nomeFile: 'registri.zip', tipo: 'IVA_REGI' }
    ]
  }), 'utf8'));
  assert.equal(esito.archivi.length, 3);
  const fatture = selectInvoiceArchives(esito);
  assert.deepEqual(fatture.map((a) => a.idFile), ['1']);
  assert.equal(esito.archivi[1].tipoElementiDescrizione, 'corrispettivi');
});

test('un conteggio archivi incoerente viene segnalato invece di passare inosservato', () => {
  const esito = parseEsitoRichiestaFile(Buffer.from(esitoXml({
    archivi: [{ idFile: '1', nomeFile: 'uno.zip' }],
    numeroArchivi: 3
  }), 'utf8'));
  assert.equal(esito.conteggioCoerente, false);
});

test('gli errori dell esito vengono estratti', () => {
  const esito = parseEsitoRichiestaFile(Buffer.from(esitoXml({
    errori: [{ codice: '00201', descrizione: 'Intervallo temporale indicato troppo ampio' }]
  }), 'utf8'));
  assert.equal(esito.errori.length, 1);
  assert.equal(esito.errori[0].codice, '00201');
});

test('un esito che e uno ZIP viene rifiutato con un messaggio chiaro', () => {
  assert.throws(() => parseEsitoRichiestaFile(Buffer.from([0x50, 0x4b, 0x03, 0x04])), /archivio ZIP/);
});

// --- il client restituisce gli archivi gia' pronti ------------------------

test('esitoRichiesta espone gli archivi letti dal file di esito', async () => {
  const esito = Buffer.from(esitoXml({ archivi: [{ idFile: '900', nomeFile: 'fatture.zip' }] }), 'utf8');
  const client = clientWith([{
    body: envelope('EsitoRichiestaResponse',
      '<Stato>ST03</Stato><EsitoFile><NomeFile>esito.xml</NomeFile>'
      + `<File>${esito.toString('base64')}</File></EsitoFile>`)
  }]);
  const status = await client.getRequestStatus('REQ-1');
  assert.equal(status.ready, true);
  assert.equal(status.archiviFatture.length, 1);
  assert.equal(status.archiviFatture[0].idFile, '900');
  assert.equal(status.dataFineDisponibilita, '2026-09-15');
});

test('un esito illeggibile non fa perdere l interrogazione', async () => {
  // Le interrogazioni sono dieci in tutto: un file di esito malformato non deve
  // trasformarsi in un errore che costringe a bruciarne un'altra.
  const client = clientWith([{
    body: envelope('EsitoRichiestaResponse',
      '<Stato>ST03</Stato><EsitoFile><NomeFile>esito.xml</NomeFile>'
      + `<File>${Buffer.from('<rotto>', 'utf8').toString('base64')}</File></EsitoFile>`)
  }]);
  const status = await client.getRequestStatus('REQ-2');
  assert.equal(status.ready, true);
  assert.ok(status.esitoErrore, 'il problema va riportato');
  assert.deepEqual(status.archiviFatture, []);
});

// --- risposte MTOM --------------------------------------------------------
// Gli elementi File del contratto sono base64Binary annotati
// xmime:expectedContentTypes, quindi il contenuto puo' arrivare come allegato
// MIME invece che inline. Leggerlo come stringa fa trovare un File vuoto.

function mtomResponse(element, innerXml, { cid = 'allegato@sdi', payload }) {
  const boundary = 'uuid:boundary-test';
  const soap = '<?xml version="1.0"?>'
    + '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">'
    + `<soapenv:Body><ns:${element} xmlns:ns="${TYPES_NS}">${innerXml}</ns:${element}></soapenv:Body>`
    + '</soapenv:Envelope>';
  const parti = [
    `--${boundary}`,
    'Content-Type: application/xop+xml; charset=UTF-8; type="text/xml"',
    'Content-ID: <root@sdi>',
    '',
    soap,
    `--${boundary}`,
    'Content-Type: application/octet-stream',
    `Content-ID: <${cid}>`,
    '',
    payload.toString('binary'),
    `--${boundary}--`,
    ''
  ].join('\r\n');
  return {
    body: Buffer.from(parti, 'binary'),
    headers: { 'content-type': `multipart/related; type="application/xop+xml"; boundary="${boundary}"` }
  };
}

function clientWithRaw(responses) {
  const queue = [...responses];
  const transport = async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return { statusCode: 200, body: next.body, headers: next.headers || {} };
  };
  return new SdiMassiveServicesClient({ transport, endpoint: 'https://esempio.invalid/sm-scarico-file' });
}

test('un esito allegato in MTOM viene letto, non trovato vuoto', async () => {
  const esito = Buffer.from(esitoXml({ archivi: [{ idFile: '777', nomeFile: 'fatture.zip' }] }), 'utf8');
  const client = clientWithRaw([mtomResponse(
    'EsitoRichiestaResponse',
    '<Stato>ST03</Stato><EsitoFile><NomeFile>esito.xml</NomeFile>'
    + '<File><xop:Include xmlns:xop="http://www.w3.org/2004/08/xop/include" href="cid:allegato@sdi"/></File></EsitoFile>',
    { payload: esito }
  )]);

  const status = await client.getRequestStatus('REQ-MTOM');
  assert.equal(status.ready, true);
  assert.equal(status.archiviFatture.length, 1, 'l allegato MTOM deve essere risolto');
  assert.equal(status.archiviFatture[0].idFile, '777');
  assert.equal(status.diagnostica, null, 'niente da diagnosticare se l esito si e letto');
});

test('un archivio allegato in MTOM arriva integro', async () => {
  const zip = zipWith([{ name: 'IT01043931003_00500.xml', content: invoiceXml({ numero: '2026/M1' }) }]);
  const client = clientWithRaw([mtomResponse(
    'ScaricoFileResponse',
    '<ArchivioFile><NomeFile>fatture.zip</NomeFile>'
    + '<File><xop:Include xmlns:xop="http://www.w3.org/2004/08/xop/include" href="cid:allegato@sdi"/></File></ArchivioFile>',
    { payload: zip }
  )]);

  const archivio = await client.downloadArchive('REQ-MTOM', '777');
  assert.equal(archivio.nomeFile, 'fatture.zip');
  assert.equal(sha256(archivio.buffer), sha256(zip), 'il binario non deve essere alterato dal transito MIME');
});

test('un ST03 senza allegato lascia di che capire perche', async () => {
  const client = clientWith([{
    body: envelope('EsitoRichiestaResponse', '<Stato>ST03</Stato>')
  }]);
  const status = await client.getRequestStatus('REQ-VUOTO');
  assert.equal(status.ready, true);
  assert.ok(status.diagnostica, 'senza allegato serve sapere cosa e arrivato');
  assert.equal(status.diagnostica.attachments, 0);
});

// --- metadati che accompagnano i file-fattura -----------------------------

test('il file di metadati viene riconosciuto dal contenuto e abbinato per hash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-'));
  const fattura = invoiceXml({ numero: '2026/900' });
  const facturaBuffer = Buffer.from(fattura, 'utf8');
  const hash = sha256(facturaBuffer);

  const metaPath = path.join(dir, 'IT03365990591_00001.xml_MT.xml');
  fs.writeFileSync(metaPath, metadataXml({ idfile: '3344556677', hashfile: hash }), 'utf8');
  const meta = readCompanionMetadata(metaPath);
  assert.ok(meta, 'il metadato va riconosciuto senza conoscere il suffisso del nome');
  assert.equal(meta.idfile, '3344556677');

  const abbinato = matchCompanionMetadata({
    file: { name: 'IT03365990591_00001.xml', sha256: hash },
    buffer: facturaBuffer,
    metadati: [{ ...meta, file: { name: 'IT03365990591_00001.xml_MT.xml' } }]
  });
  assert.equal(abbinato.idfile, '3344556677');
});

test('una fattura non viene scambiata per un file di metadati', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-'));
  const fatturaPath = path.join(dir, 'IT03365990591_00002.xml');
  fs.writeFileSync(fatturaPath, invoiceXml({ numero: '2026/901' }), 'utf8');
  assert.equal(readCompanionMetadata(fatturaPath), null);
});

// --- involucro della richiesta --------------------------------------------
// Specifiche formato SMTS v1.5 par. 1.1: cio' che si firma e si allega alla
// SOAP request e' un FileRichiesta conforme a RichiestaServiziMassivi_v1.0,
// che contiene l'InputMassivo codificato in base-64. Sono due livelli.

test('la richiesta da firmare e l involucro, non l InputMassivo nudo', () => {
  const { buildRichiestaServiziMassiviXml, buildMassiveRequestXml, RICHIESTA_NS } = require('../src/services/sdi-massive-request');
  const input = buildMassiveRequestXml({
    requestType: 'INCOMING', vatNumbers: [PIVA], dateFrom: '2026-06-01', dateTo: '2026-08-10'
  });
  const involucro = buildRichiestaServiziMassiviXml({
    tipoRichiesta: 'FATT', nomeFile: '03365990591_TEST_1.xml', contenutoXml: input
  });

  // I due tracciati si scrivono in modo opposto e vanno tenuti distinti:
  // RichiestaServiziMassivi non dichiara elementFormDefault, quindi vale
  // "unqualified" e solo la radice sta nel namespace. Mettere anche i figli
  // dentro produce 00200 "File non conforme al tracciato".
  assert.match(involucro, new RegExp(`<ns:FileRichiesta xmlns:ns="${RICHIESTA_NS.replace(/[/.]/g, '\\$&')}" versione="1.0">`));
  assert.doesNotMatch(involucro, /<FileRichiesta xmlns=/, 'i figli non devono ereditare il namespace');
  assert.match(involucro, /<TipoRichiesta>FATT<\/TipoRichiesta>/);
  assert.match(involucro, /<NomeFile>03365990591_TEST_1\.xml<\/NomeFile>/);

  // Il contenuto annidato segue invece InputMassivo, che e' "qualified".
  const annidato = Buffer.from(involucro.match(/<File>([^<]+)<\/File>/)[1], 'base64').toString('utf8');
  assert.match(annidato, /<InputMassivo xmlns="http:\/\/www\.sogei\.it\/InputPubblico">/);

  // L'InputMassivo deve essere dentro, in base-64, non in chiaro.
  assert.doesNotMatch(involucro, /<InputMassivo/, 'l InputMassivo non va in chiaro nell involucro');
  const base64 = involucro.match(/<File>([^<]+)<\/File>/)[1];
  assert.equal(Buffer.from(base64, 'base64').toString('utf8'), input);
});

test('l involucro rifiuta un TipoRichiesta fuori tracciato e un nome file non conforme', () => {
  const { buildRichiestaServiziMassiviXml } = require('../src/services/sdi-massive-request');
  assert.throws(
    () => buildRichiestaServiziMassiviXml({ tipoRichiesta: 'FATTURE', nomeFile: '03365990591_A.xml', contenutoXml: '<x/>' }),
    /TipoRichiesta non ammesso/
  );
  // Il tracciato vuole fra 9 e 50 caratteri: "a.xml" e' troppo corto,
  // "corto.xml" sono esattamente 9 e passa.
  assert.throws(
    () => buildRichiestaServiziMassiviXml({ tipoRichiesta: 'FATT', nomeFile: 'a.xml', contenutoXml: '<x/>' }),
    /Nome file non conforme/
  );
  assert.throws(
    () => buildRichiestaServiziMassiviXml({ tipoRichiesta: 'FATT', nomeFile: 'nome con spazi.xml', contenutoXml: '<x/>' }),
    /Nome file non conforme/
  );
});

test('il job prepara l involucro e ne calcola l hash da confrontare con la firma', async () => {
  cleanup();
  seedFiscalConfig();
  const job = createJob({ tenantId: TENANT, requestType: 'INCOMING', dateFrom: '2026-06-01', dateTo: '2026-08-10' });
  const prepared = await prepareRequest({ tenantId: TENANT, jobId: job.id });

  const documento = getRequestToSign(job.id, TENANT).buffer.toString('utf8');
  assert.match(documento, /<ns:FileRichiesta /, 'si firma l involucro');
  assert.match(documento, /<TipoRichiesta>FATT<\/TipoRichiesta>/);

  // Il periodo richiesto resta verificabile: sta nell'InputMassivo annidato.
  const interno = Buffer.from(documento.match(/<File>([^<]+)<\/File>/)[1], 'base64').toString('utf8');
  assert.match(interno, /<Da>2026-06-01<\/Da><A>2026-08-10<\/A>/);
  assert.match(interno, new RegExp(`<Piva>${PIVA}</Piva>`));

  // L'hash registrato e' quello dell'involucro: e' il confronto che protegge
  // dal firmare un documento diverso.
  assert.equal(sha256(Buffer.from(documento, 'utf8')), prepared.xmlSha256);
  cleanup();
});

test('la richiesta e valida contro gli XSD ufficiali, entrambi i livelli', async () => {
  const {
    buildMassiveRequestXml, buildRichiestaServiziMassiviXml, validateMassiveRequest
  } = require('../src/services/sdi-massive-request');

  for (const requestType of ['INCOMING', 'OUTGOING', 'AVAILABLE_TO_RECIPIENT']) {
    const input = buildMassiveRequestXml({
      requestType, vatNumbers: [PIVA], dateFrom: '2026-03-01', dateTo: '2026-05-31'
    });
    const involucro = buildRichiestaServiziMassiviXml({
      tipoRichiesta: 'FATT', nomeFile: '03365990591_TEST_00001.xml', contenutoXml: input
    });
    const esito = await validateMassiveRequest({ involucro, contenutoXml: input });
    assert.deepEqual(esito.schemi, ['InputMassivo_v1.5.xsd', 'RichiestaServiziMassivi_v1.0.xsd'], requestType);
  }
});

test('un involucro con i figli nel namespace viene bloccato prima della firma', async () => {
  const { buildMassiveRequestXml, validateMassiveRequest, RICHIESTA_NS } = require('../src/services/sdi-massive-request');
  const input = buildMassiveRequestXml({
    requestType: 'INCOMING', vatNumbers: [PIVA], dateFrom: '2026-03-01', dateTo: '2026-05-31'
  });

  // Esattamente la forma che SdI ha rifiutato con 00200 il 10.08.2026: xmlns di
  // default sulla radice, che trascina i figli dentro il namespace mentre lo
  // schema li vuole fuori. Il controllo locale deve intercettarla, altrimenti
  // l'errore si scopre solo dopo aver speso una firma qualificata.
  const sbagliato = '<?xml version="1.0" encoding="UTF-8"?>'
    + `<FileRichiesta xmlns="${RICHIESTA_NS}" versione="1.0">`
    + '<TipoRichiesta>FATT</TipoRichiesta>'
    + '<NomeFile>03365990591_TEST_00001.xml</NomeFile>'
    + `<File>${Buffer.from(input, 'utf8').toString('base64')}</File>`
    + '</FileRichiesta>';

  await assert.rejects(
    () => validateMassiveRequest({ involucro: sbagliato, contenutoXml: input }),
    (error) => error.code === 'RICHIESTA_NON_CONFORME'
  );
});

// --- ciclo completo del job -----------------------------------------------

test('senza configurazione fiscale il job non parte', async () => {
  cleanup();
  const job = createJob({ tenantId: TENANT, requestType: 'INCOMING', dateFrom: '2026-03-01', dateTo: '2026-05-31' });
  await assert.rejects(() => prepareRequest({ tenantId: TENANT, jobId: job.id }), /Configurazione fiscale mancante/);
  cleanup();
});

test('la richiesta preparata attende la firma esterna e non e inoltrabile', async (t) => {
  const signing = getMassiveSigningStatus();
  if (signing.available && !signing.external) return t.skip('firma massiva locale configurata su questa macchina');
  cleanup();
  seedFiscalConfig();
  const job = createJob({ tenantId: TENANT, requestType: 'INCOMING', dateFrom: '2026-03-01', dateTo: '2026-05-31' });

  const prepared = await prepareRequest({ tenantId: TENANT, jobId: job.id });
  assert.equal(getJob(job.id).status, 'CREATED', 'senza firma il job non avanza');
  assert.ok(prepared.xmlSha256);
  assert.match(prepared.signedFilename, /\.p7m$/);

  const document = getRequestToSign(job.id, TENANT);
  const xml = document.buffer.toString('utf8');
  assert.match(xml, /<ns:FileRichiesta /, 'si firma l involucro, non l InputMassivo');
  const interno = Buffer.from(xml.match(/<File>([^<]+)<\/File>/)[1], 'base64').toString('utf8');
  assert.match(interno, /<FattureRicevute>/);
  assert.match(interno, new RegExp(`<Piva>${PIVA}</Piva>`));
  assert.match(interno, /<Da>2026-03-01<\/Da><A>2026-05-31<\/A>/);
  assert.equal(sha256(document.buffer), prepared.xmlSha256);
  cleanup();
});

test('una richiesta firmata diversa da quella preparata viene rifiutata', async (t) => {
  const m = material();
  if (!m) return t.skip('openssl non disponibile');
  cleanup();
  seedFiscalConfig();
  const job = createJob({ tenantId: TENANT, requestType: 'INCOMING', dateFrom: '2026-03-01', dateTo: '2026-05-31' });
  await prepareRequest({ tenantId: TENANT, jobId: job.id });

  // Firmare un periodo diverso da quello registrato significherebbe scaricare
  // mesi che nessuno ha chiesto, e accorgersene solo dagli archivi.
  assert.throws(
    () => attachSignedRequest({ jobId: job.id, tenantId: TENANT, signedBuffer: sign('<InputMassivo>altro</InputMassivo>', m) }),
    (error) => error.code === 'SIGNED_DOCUMENT_MISMATCH'
  );
  assert.equal(getJob(job.id).status, 'CREATED');
  cleanup();
});

test('il ciclo completo porta il job dalla firma all import', async (t) => {
  const m = material();
  if (!m) return t.skip('openssl non disponibile');
  cleanup();
  seedFiscalConfig();

  const job = createJob({ tenantId: TENANT, requestType: 'INCOMING', dateFrom: '2026-03-01', dateTo: '2026-05-31' });
  const prepared = await prepareRequest({ tenantId: TENANT, jobId: job.id });

  // 1. firma esterna
  const document = getRequestToSign(job.id, TENANT);
  const signed = attachSignedRequest({
    jobId: job.id, tenantId: TENANT, signedBuffer: sign(document.buffer, m), filename: 'richiesta.xml.p7m'
  });
  assert.equal(signed.status, 'SIGNED');
  assert.match(signed.signer.subject, /FURFARI DANIELE/);
  assert.equal(prepared.needsExternalSignature, true);

  // 2. inoltro
  const fattura = invoiceXml({ numero: '2026/950', cedente: '01043931003', cessionario: PIVA });
  const fatturaBuffer = Buffer.from(fattura, 'utf8');
  const archivio = zipWith([
    { name: 'IT01043931003_00099.xml', content: fattura },
    { name: 'IT01043931003_00099.xml_MT.xml', content: metadataXml({ idfile: '5566778899', hashfile: sha256(fatturaBuffer) }) }
  ]);
  const esito = Buffer.from(esitoXml({ idRichiesta: 'REQ-XYZ', archivi: [{ idFile: '4242', nomeFile: 'fatture.zip' }] }), 'utf8');

  const client = clientWith([
    { body: envelope('InoltroRichiestaResponse', '<IdRichiesta>REQ-XYZ</IdRichiesta><DataOraRicezione>2026-08-09T10:00:00</DataOraRicezione>') },
    { body: envelope('EsitoRichiestaResponse', `<Stato>ST03</Stato><EsitoFile><NomeFile>esito.xml</NomeFile><File>${esito.toString('base64')}</File></EsitoFile>`) },
    { body: envelope('ScaricoFileResponse', `<ArchivioFile><NomeFile>fatture.zip</NomeFile><File>${archivio.toString('base64')}</File></ArchivioFile>`) }
  ]);

  const submitted = await submitRequest({ jobId: job.id, tenantId: TENANT, client });
  assert.equal(submitted.idRichiesta, 'REQ-XYZ');

  // 3. esito
  const polled = await pollRequest({ jobId: job.id, tenantId: TENANT, client });
  assert.equal(polled.status, 'READY');
  assert.equal(polled.archivi.length, 1);
  assert.equal(getJob(job.id).expires_at, '2026-09-15');

  // 4. scarico
  const downloaded = await downloadArchives({ jobId: job.id, tenantId: TENANT, client, archivi: polled.archivi });
  assert.equal(downloaded.scaricati.length, 1);
  assert.equal(downloaded.falliti.length, 0);

  // 5. import in dry-run: non scrive nulla e non chiude il job
  const simulato = await importArchives({ jobId: job.id, tenantId: TENANT, dryRun: true });
  assert.equal(simulato.dryRun, true);
  assert.equal(getJob(job.id).status, 'IMPORTING', 'una simulazione non deve chiudere il job');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fatture WHERE tenant_id = ?').get(TENANT).n, 0);

  // 6. import vero
  const importato = await importArchives({ jobId: job.id, tenantId: TENANT, dryRun: false });
  assert.equal(importato.status, 'COMPLETED');

  const fatture = db.prepare('SELECT * FROM fatture WHERE tenant_id = ?').all(TENANT);
  assert.equal(fatture.length, 1);
  assert.equal(fatture[0].numero, '2026/950');
  assert.equal(fatture[0].direzione, 'passiva', 'la direzione deve arrivare dagli identificativi del tenant');
  // L'identificativo SdI non e' ricavabile dal nome del file-fattura: arriva
  // dal file di metadati che lo accompagna nell'archivio.
  assert.equal(fatture[0].sdi_id, '5566778899');
  assert.equal(fatture[0].sdi_send_allowed, 0, 'una fattura storica non e ritrasmettibile');
  cleanup();
});

test('lo scarico delle fatture messe a disposizione richiede una conferma esplicita', async () => {
  cleanup();
  seedFiscalConfig();
  const job = createJob({ tenantId: TENANT, requestType: 'AVAILABLE_TO_RECIPIENT', dateFrom: '2026-03-01', dateTo: '2026-05-31' });
  db.prepare("UPDATE sdi_historical_sync_job SET status = 'READY', remote_request_id = 'REQ-MD' WHERE id = ?").run(job.id);

  await assert.rejects(
    () => downloadArchives({ jobId: job.id, tenantId: TENANT, client: clientWith([{ body: '<x/>' }]), archivi: [{ idFile: '1' }] }),
    /presa visione/
  );
  cleanup();
});

test('un job di un altro tenant non e raggiungibile', () => {
  cleanup();
  seedFiscalConfig();
  const job = createJob({ tenantId: TENANT, requestType: 'INCOMING', dateFrom: '2026-03-01', dateTo: '2026-05-31' });
  assert.throws(() => getRequestToSign(job.id, TENANT + 1), /non trovato/);
  cleanup();
});

// --- limiti e scadenze ----------------------------------------------------

test('le dieci interrogazioni di esito sopravvivono al riavvio', async () => {
  cleanup();
  seedFiscalConfig();
  const job = createJob({ tenantId: TENANT, requestType: 'INCOMING', dateFrom: '2026-03-01', dateTo: '2026-05-31' });
  db.prepare("UPDATE sdi_historical_sync_job SET status = 'SUBMITTED', remote_request_id = 'REQ-L' WHERE id = ?").run(job.id);

  const inElaborazione = { body: envelope('EsitoRichiestaResponse', '<Stato>ST01</Stato>') };
  // Client nuovo a ogni giro: e' quello che succede quando il container
  // riparte mentre la richiesta e' ancora in elaborazione.
  for (let i = 0; i < MAX_ESITO_CALLS; i++) {
    const esito = await pollRequest({ jobId: job.id, tenantId: TENANT, client: clientWith([inElaborazione]) });
    assert.equal(esito.status, 'PROCESSING');
    assert.equal(esito.interrogazioniRimaste, MAX_ESITO_CALLS - 1 - i);
  }

  await assert.rejects(
    () => pollRequest({ jobId: job.id, tenantId: TENANT, client: clientWith([inElaborazione]) }),
    (error) => error.code === 'ESITO_LIMIT'
  );
  assert.equal(getJob(job.id).esito_calls, MAX_ESITO_CALLS);
  cleanup();
});

test('il limite di esito e una soglia di frequenza, non un tetto definitivo', async () => {
  cleanup();
  seedFiscalConfig();
  const job = createJob({ tenantId: TENANT, requestType: 'INCOMING', dateFrom: '2026-03-01', dateTo: '2026-05-31' });
  // Job che ha gia esaurito le dieci interrogazioni, ma un giorno fa.
  db.prepare(`
    UPDATE sdi_historical_sync_job
    SET status = 'PROCESSING', remote_request_id = 'REQ-W', esito_calls = ?, esito_last_at = '2026-08-09 08:00:00'
    WHERE id = ?
  `).run(MAX_ESITO_CALLS, job.id);

  // SdI risponde ER03 "richiesta troppo frequente", non "quota esaurita":
  // dopo un periodo di riposo si puo' tornare a chiedere, altrimenti un job
  // lento resterebbe bloccato per sempre.
  const esito = await pollRequest({
    jobId: job.id, tenantId: TENANT,
    client: clientWith([{ body: envelope('EsitoRichiestaResponse', '<Stato>ST01</Stato>') }]),
    now: new Date('2026-08-10T12:00:00Z')
  });
  assert.equal(esito.status, 'PROCESSING');
  assert.equal(esito.interrogazioniRimaste, MAX_ESITO_CALLS - 1, 'il conteggio riparte');
  assert.equal(getJob(job.id).esito_calls, 1);
  cleanup();
});

test('la finestra di riposo delle interrogazioni e di un giorno', () => {
  const { isEsitoWindowElapsed } = require('../src/services/sdi-backfill');
  const now = new Date('2026-08-10T12:00:00Z');
  assert.equal(isEsitoWindowElapsed(null, now), true);
  assert.equal(isEsitoWindowElapsed('2026-08-10 08:00:00', now), false);
  assert.equal(isEsitoWindowElapsed('2026-08-09 08:00:00', now), true);
});

test('la disponibilita vale per tutto l ultimo giorno', () => {
  assert.equal(isExpired('2026-09-15', new Date('2026-09-15T23:00:00Z')), false);
  assert.equal(isExpired('2026-09-15', new Date('2026-09-16T00:30:00Z')), true);
  assert.equal(isExpired(null, new Date()), false, 'senza scadenza nota non si blocca nulla');
});

test('scaduta la disponibilita il job passa a EXPIRED invece di riprovare', async () => {
  cleanup();
  seedFiscalConfig();
  const job = createJob({ tenantId: TENANT, requestType: 'INCOMING', dateFrom: '2026-03-01', dateTo: '2026-05-31' });
  db.prepare("UPDATE sdi_historical_sync_job SET status = 'READY', remote_request_id = 'REQ-S', expires_at = '2026-06-30' WHERE id = ?").run(job.id);

  await assert.rejects(
    () => downloadArchives({
      jobId: job.id, tenantId: TENANT, client: clientWith([{ body: '<x/>' }]),
      archivi: [{ idFile: '1' }], now: new Date('2026-08-09T10:00:00Z')
    }),
    (error) => error.code === 'ARCHIVI_SCADUTI'
  );
  assert.equal(getJob(job.id).status, 'EXPIRED');
  cleanup();
});

test('un job parziale si riprende senza rifare la richiesta', async () => {
  cleanup();
  seedFiscalConfig();
  const job = createJob({ tenantId: TENANT, requestType: 'INCOMING', dateFrom: '2026-03-01', dateTo: '2026-05-31' });

  // Una passata finita male lascia il job in PARTIAL con un archivio ancora da
  // lavorare: rifare la richiesta costerebbe un'altra firma qualificata.
  const fattura = invoiceXml({ numero: '2026/970', cedente: '01043931003', cessionario: PIVA });
  const archivio = zipWith([{ name: 'IT01043931003_00170.xml', content: fattura }]);
  const stored = path.join(ROOT, 'uploads', 'sdi-storico', String(TENANT), 'ripresa.zip');
  fs.mkdirSync(path.dirname(stored), { recursive: true });
  fs.writeFileSync(stored, archivio);

  db.prepare(`
    INSERT INTO sdi_historical_sync_archive (tenant_id, job_id, remote_archive_id, remote_filename, size, sha256, local_path, status)
    VALUES (?,?,?,?,?,?,?, 'DOWNLOADED')
  `).run(TENANT, job.id, '77', 'ripresa.zip', archivio.length, sha256(archivio),
    `/${path.relative(ROOT, stored).split(path.sep).join('/')}`);

  ['SIGNED', 'SUBMITTED', 'READY', 'DOWNLOADING', 'PARTIAL'].forEach((stato) => {
    db.prepare('UPDATE sdi_historical_sync_job SET status = ? WHERE id = ?').run(stato, job.id);
  });

  const ripresa = await importArchives({ jobId: job.id, tenantId: TENANT, dryRun: false });
  assert.equal(ripresa.status, 'COMPLETED');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fatture WHERE tenant_id = ?').get(TENANT).n, 1);

  fs.rmSync(path.join(ROOT, 'uploads', 'sdi-storico', String(TENANT)), { recursive: true, force: true });
  cleanup();
});

// --- controparte, scadenza, ri-elaborazione -------------------------------

test('su una fattura emessa la controparte e il cessionario, non noi', async () => {
  cleanup();
  seedFiscalConfig();
  const job = createJob({ tenantId: TENANT, requestType: 'OUTGOING', dateFrom: '2026-03-01', dateTo: '2026-05-31' });

  // Fattura emessa: il cedente siamo noi, il cliente e' il cessionario.
  const fattura = invoiceXml({ numero: '2026/A1', cedente: PIVA, cessionario: '01043931003' });
  const archivio = zipWith([{ name: 'IT03365990591_00300.xml', content: fattura }]);
  const stored = path.join(ROOT, 'uploads', 'sdi-storico', String(TENANT), 'emesse.zip');
  fs.mkdirSync(path.dirname(stored), { recursive: true });
  fs.writeFileSync(stored, archivio);
  db.prepare(`
    INSERT INTO sdi_historical_sync_archive (tenant_id, job_id, remote_archive_id, remote_filename, size, sha256, local_path, status)
    VALUES (?,?,?,?,?,?,?, 'DOWNLOADED')
  `).run(TENANT, job.id, '90', 'emesse.zip', archivio.length, sha256(archivio),
    `/${path.relative(ROOT, stored).split(path.sep).join('/')}`);
  db.prepare("UPDATE sdi_historical_sync_job SET status = 'DOWNLOADING' WHERE id = ?").run(job.id);

  await importArchives({ jobId: job.id, tenantId: TENANT, dryRun: false });

  const fatt = db.prepare('SELECT * FROM fatture WHERE tenant_id = ?').get(TENANT);
  assert.equal(fatt.direzione, 'attiva');
  assert.equal(fatt.partita_iva, 'IT01043931003', 'la controparte e il cliente, non HORYGON');
  assert.equal(fatt.cliente_fornitore_label, 'Cliente');

  fs.rmSync(path.join(ROOT, 'uploads', 'sdi-storico', String(TENANT)), { recursive: true, force: true });
  cleanup();
});

test('su una fattura ricevuta la controparte resta il cedente', () => {
  const { parseFatturaPAXml } = require('../src/services/fattura-import');
  const { determineDirection } = require('../src/services/sdi-document-classifier');
  const xml = invoiceXml({ numero: '2026/P1', cedente: '01043931003', cessionario: PIVA });
  const parsed = parseFatturaPAXml(xml);
  const info = determineDirection(xml, { vatNumber: PIVA, taxCode: PIVA });
  assert.equal(info.direction, 'INCOMING');
  assert.equal(parsed.fornitore_piva, 'IT01043931003');
  assert.equal(info.parties.cedente.denomination, 'Fornitore');
});

test('la scadenza viene letta da DatiPagamento e si tiene la prima', () => {
  const { parseFatturaPAXml } = require('../src/services/fattura-import');
  const base = invoiceXml({ numero: '2026/R1' });
  const conRate = base.replace('</FatturaElettronicaBody>',
    '<DatiPagamento><CondizioniPagamento>TP01</CondizioniPagamento>'
    + '<DettaglioPagamento><ModalitaPagamento>MP05</ModalitaPagamento><DataScadenzaPagamento>2026-06-30</DataScadenzaPagamento><ImportoPagamento>61.00</ImportoPagamento></DettaglioPagamento>'
    + '<DettaglioPagamento><ModalitaPagamento>MP05</ModalitaPagamento><DataScadenzaPagamento>2026-05-31</DataScadenzaPagamento><ImportoPagamento>61.00</ImportoPagamento></DettaglioPagamento>'
    + '</DatiPagamento></FatturaElettronicaBody>');

  const parsed = parseFatturaPAXml(conRate);
  assert.equal(parsed.scadenza, '2026-05-31', 'la prima in ordine di data, non di apparizione');
  assert.equal(parsed.documento_meta.pagamenti.length, 2, 'le altre rate non vanno perse');
  assert.deepEqual(parsed.documento_meta.scadenze, ['2026-05-31', '2026-06-30']);

  assert.equal(parseFatturaPAXml(base).scadenza, null, 'senza DatiPagamento non si inventa');
});

test('la ri-elaborazione rilegge gli archivi senza richiederli di nuovo a SdI', async () => {
  cleanup();
  seedFiscalConfig();
  const job = createJob({ tenantId: TENANT, requestType: 'INCOMING', dateFrom: '2026-03-01', dateTo: '2026-05-31' });

  const fattura = invoiceXml({ numero: '2026/RP', cedente: '01043931003', cessionario: PIVA });
  const archivio = zipWith([{ name: 'IT01043931003_00400.xml', content: fattura }]);
  const stored = path.join(ROOT, 'uploads', 'sdi-storico', String(TENANT), 'riprocessa.zip');
  fs.mkdirSync(path.dirname(stored), { recursive: true });
  fs.writeFileSync(stored, archivio);
  db.prepare(`
    INSERT INTO sdi_historical_sync_archive (tenant_id, job_id, remote_archive_id, remote_filename, size, sha256, local_path, status)
    VALUES (?,?,?,?,?,?,?, 'DOWNLOADED')
  `).run(TENANT, job.id, '91', 'riprocessa.zip', archivio.length, sha256(archivio),
    `/${path.relative(ROOT, stored).split(path.sep).join('/')}`);
  db.prepare("UPDATE sdi_historical_sync_job SET status = 'DOWNLOADING' WHERE id = ?").run(job.id);

  await importArchives({ jobId: job.id, tenantId: TENANT, dryRun: false });
  const primaId = db.prepare('SELECT id FROM fatture WHERE tenant_id = ?').get(TENANT).id;
  assert.equal(getJob(job.id).status, 'COMPLETED');

  // Una fattura del CRM non deve essere toccata dalla ri-elaborazione.
  const estranea = Number(db.prepare(
    "INSERT INTO fatture (tenant_id, numero, tipo, data, source, note) VALUES (?, 'CRM-1', 'emessa', '2026-04-01', 'CRM', 'estranea')"
  ).run(TENANT).lastInsertRowid);

  const ripreso = reprocessArchives({ jobId: job.id, tenantId: TENANT, motivo: 'parser aggiornato' });
  assert.equal(ripreso.fattureRimosse, 1);
  assert.equal(ripreso.nuovoDownload, false);
  assert.equal(ripreso.archiviDaRileggere, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fatture WHERE id = ?').get(primaId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fatture WHERE id = ?').get(estranea).n, 1, 'le fatture non storiche restano');

  const rifatto = await importArchives({ jobId: job.id, tenantId: TENANT, dryRun: false });
  assert.equal(rifatto.status, 'COMPLETED');
  const seconda = db.prepare("SELECT * FROM fatture WHERE tenant_id = ? AND source = 'SDI_HISTORICAL_SYNC'").all(TENANT);
  assert.equal(seconda.length, 1, 'reimportata una volta sola, non duplicata');
  assert.notEqual(seconda[0].id, primaId, 'e una riga nuova, non quella vecchia arricchita');

  fs.rmSync(path.join(ROOT, 'uploads', 'sdi-storico', String(TENANT)), { recursive: true, force: true });
  cleanup();
});

// --- pilota automatico ----------------------------------------------------

test('la finestra di manutenzione segue l ora italiana, non quella del container', () => {
  const { isMaintenanceWindow } = require('../src/services/sdi-backfill-scheduler');
  // In agosto Roma e' UTC+2: le 22:30 UTC sono le 00:30 italiane.
  assert.equal(isMaintenanceWindow(new Date('2026-08-10T22:30:00Z')), true);
  assert.equal(isMaintenanceWindow(new Date('2026-08-10T23:30:00Z')), false, 'in Italia e gia l una');
  assert.equal(isMaintenanceWindow(new Date('2026-08-10T10:00:00Z')), false);
});

test('le interrogazioni di esito vengono spalmate nel tempo', () => {
  const { shouldPoll } = require('../src/services/sdi-backfill-scheduler');
  const now = new Date('2026-08-10T12:00:00Z');
  assert.equal(shouldPoll({ esito_last_at: null }, now, 30), true, 'la prima si fa subito');
  assert.equal(shouldPoll({ esito_last_at: '2026-08-10 11:45:00' }, now, 30), false);
  assert.equal(shouldPoll({ esito_last_at: '2026-08-10 11:20:00' }, now, 30), true);
});

test('l intervallo si allarga per far durare le dieci interrogazioni', () => {
  const { pollIntervalMinutes, MAX_INTERVAL_MINUTES } = require('../src/services/sdi-backfill-scheduler');
  // Le prime restano fitte: una richiesta piccola puo' essere pronta subito.
  assert.equal(pollIntervalMinutes({ esito_calls: 0 }, 30), 30);
  assert.equal(pollIntervalMinutes({ esito_calls: 1 }, 30), 30);
  assert.equal(pollIntervalMinutes({ esito_calls: 2 }, 30), 60);
  assert.equal(pollIntervalMinutes({ esito_calls: 4 }, 30), 120);
  assert.equal(pollIntervalMinutes({ esito_calls: 6 }, 30), 240);
  assert.equal(pollIntervalMinutes({ esito_calls: 9 }, 30), MAX_INTERVAL_MINUTES, 'con un tetto');

  // A intervallo fisso dieci chiamate coprono cinque ore e si esauriscono
  // prima di un'elaborazione notturna; cosi' ne coprono una ventina.
  let ore = 0;
  for (let usate = 0; usate < 10; usate++) ore += pollIntervalMinutes({ esito_calls: usate }, 30) / 60;
  assert.ok(ore > 18, `le dieci interrogazioni devono coprire piu di 18 ore, coprono ${ore}`);
});

test('il pilota automatico inoltra da solo ma non firma mai', async () => {
  const { advanceJobs } = require('../src/services/sdi-backfill-scheduler');
  cleanup();
  seedFiscalConfig();

  const daFirmare = createJob({ tenantId: TENANT, requestType: 'INCOMING', dateFrom: '2026-03-01', dateTo: '2026-05-31' });
  const firmato = createJob({ tenantId: TENANT, requestType: 'OUTGOING', dateFrom: '2026-03-01', dateTo: '2026-05-31' });
  db.prepare("UPDATE sdi_historical_sync_job SET status = 'SIGNED', request_filename = 'r.xml', request_signed_path = ? WHERE id = ?")
    .run('/uploads/sdi-massive-requests/finto.p7m', firmato.id);

  // Il file firmato deve esistere: submitRequest lo legge da disco.
  const finto = path.join(ROOT, 'uploads', 'sdi-massive-requests', 'finto.p7m');
  fs.mkdirSync(path.dirname(finto), { recursive: true });
  fs.writeFileSync(finto, Buffer.from('p7m-finto'));

  const client = clientWith([
    { body: envelope('InoltroRichiestaResponse', '<IdRichiesta>REQ-AUTO</IdRichiesta>') }
  ]);
  const esito = await advanceJobs({ tenantId: TENANT, client, now: new Date('2026-08-10T10:00:00Z') });

  assert.equal(getJob(firmato.id).status, 'SUBMITTED');
  assert.equal(getJob(daFirmare.id).status, 'CREATED', 'chi attende la firma non viene toccato');
  assert.deepEqual(esito.azioni.map((a) => a.passo), ['inoltra']);

  fs.rmSync(finto, { force: true });
  cleanup();
});

test('il pilota automatico non scarica le fatture messe a disposizione', async () => {
  const { advanceJobs } = require('../src/services/sdi-backfill-scheduler');
  cleanup();
  seedFiscalConfig();
  const job = createJob({ tenantId: TENANT, requestType: 'AVAILABLE_TO_RECIPIENT', dateFrom: '2026-03-01', dateTo: '2026-05-31' });
  db.prepare("UPDATE sdi_historical_sync_job SET status = 'READY', remote_request_id = 'REQ-MD' WHERE id = ?").run(job.id);

  const esito = await advanceJobs({ tenantId: TENANT, client: clientWith([{ body: '<x/>' }]), now: new Date('2026-08-10T10:00:00Z') });
  assert.equal(getJob(job.id).status, 'READY', 'la presa visione resta una decisione umana');
  assert.equal(esito.azioni[0].passo, 'saltato');
  assert.match(esito.azioni[0].motivo, /presa visione/);
  cleanup();
});

test('durante la manutenzione non si interroga nulla', async () => {
  const { advanceJobs } = require('../src/services/sdi-backfill-scheduler');
  cleanup();
  seedFiscalConfig();
  createJob({ tenantId: TENANT, requestType: 'INCOMING', dateFrom: '2026-03-01', dateTo: '2026-05-31' });
  const esito = await advanceJobs({ tenantId: TENANT, client: clientWith([{ body: '<x/>' }]), now: new Date('2026-08-10T22:30:00Z') });
  assert.match(esito.saltato, /manutenzione/);
  cleanup();
});

test('un job con una richiesta viva non si elimina per distrazione', () => {
  const { deleteJob } = require('../src/services/sdi-backfill');
  cleanup();
  seedFiscalConfig();
  const job = createJob({ tenantId: TENANT, requestType: 'INCOMING', dateFrom: '2026-03-01', dateTo: '2026-05-31' });
  db.prepare("UPDATE sdi_historical_sync_job SET status='READY', remote_request_id='359870495' WHERE id = ?").run(job.id);

  // L'IdRichiesta vale una firma qualificata e resta utilizzabile trenta giorni.
  assert.throws(
    () => deleteJob({ jobId: job.id, tenantId: TENANT }),
    (error) => error.code === 'RICHIESTA_ANCORA_VIVA' && error.idRichiesta === '359870495'
  );
  assert.ok(getJob(job.id), 'il job deve essere ancora li');

  // Con la conferma esplicita si procede.
  assert.equal(deleteJob({ jobId: job.id, tenantId: TENANT, force: true }).eliminato, true);
  assert.equal(getJob(job.id), undefined);
  cleanup();
});

test('un job fallito si elimina senza cerimonie', () => {
  const { deleteJob } = require('../src/services/sdi-backfill');
  cleanup();
  seedFiscalConfig();
  const job = createJob({ tenantId: TENANT, requestType: 'INCOMING', dateFrom: '2026-03-01', dateTo: '2026-05-31' });
  db.prepare("UPDATE sdi_historical_sync_job SET status='FAILED', remote_request_id='111' WHERE id = ?").run(job.id);
  assert.equal(deleteJob({ jobId: job.id, tenantId: TENANT }).eliminato, true);
  cleanup();
});

// --- pianificazione marzo-oggi --------------------------------------------

test('marzo-agosto sta in due finestre da tre mesi', () => {
  // Il tracciato non ammette piu' di tre mesi per richiesta (controllo 00201).
  // Finestre piu' larghe possibili significano meno firme qualificate da fare
  // a mano: qui due invece delle sei mensili.
  const windows = generateWindows('2026-03-01', '2026-08-09', { months: 3 });
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[0], { from: '2026-03-01', to: '2026-05-31' });
  assert.deepEqual(windows[1], { from: '2026-06-01', to: '2026-08-09' });
});
