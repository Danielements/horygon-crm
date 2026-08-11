const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');

const {
  SdiMassiveServicesClient,
  SdiMassiveServiceError,
  LIMITS,
  TYPES_NS,
  DEFAULT_ENDPOINT
} = require('../src/services/sdi-massive-client');
const {
  buildMassiveRequestXml,
  buildMassiveRequestFilename,
  assertDateRange,
  MAX_RANGE_DAYS
} = require('../src/services/sdi-massive-request');

// Fixture costruite sul contratto ufficiale ServiziMassiviTypes_v1.0.xsd.
// Nessuna chiamata reale: il transport e' iniettato.

function envelope(inner) {
  return '<?xml version="1.0"?>'
    + '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">'
    + `<soapenv:Body><ns:${inner.element} xmlns:ns="${TYPES_NS}">${inner.body}</ns:${inner.element}></soapenv:Body>`
    + '</soapenv:Envelope>';
}

function stubTransport(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const transport = async (request) => {
    calls.push(request);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return { statusCode: next.statusCode ?? 200, body: next.body };
  };
  transport.calls = calls;
  return transport;
}

// --- costruzione della richiesta ------------------------------------------

test('la richiesta fatture emesse segue il tracciato InputMassivo', () => {
  const xml = buildMassiveRequestXml({
    requestType: 'OUTGOING',
    vatNumbers: ['03365990591'],
    dateFrom: '2026-03-01',
    dateTo: '2026-03-31'
  });
  assert.match(xml, /<InputMassivo xmlns="http:\/\/www\.sogei\.it\/InputPubblico">/);
  assert.match(xml, /<Richiesta>FATT<\/Richiesta>/);
  assert.match(xml, /<Piva>03365990591<\/Piva>/);
  assert.match(xml, /<FattureEmesse>.*<DataEmissione><Da>2026-03-01<\/Da><A>2026-03-31<\/A><\/DataEmissione>/);
  assert.match(xml, /<Ruolo>CEDENTE<\/Ruolo>/);
});

test('le fatture ricevute usano DataRicezione e ruolo CESSIONARIO', () => {
  const xml = buildMassiveRequestXml({
    requestType: 'INCOMING',
    vatNumbers: '03365990591',
    dateFrom: '2026-04-01',
    dateTo: '2026-04-30'
  });
  assert.match(xml, /<FattureRicevute><DataRicezione><Da>2026-04-01<\/Da>/);
  assert.match(xml, /<Ruolo>CESSIONARIO<\/Ruolo>/);
});

test('le fatture messe a disposizione non portano il blocco Flusso', () => {
  const xml = buildMassiveRequestXml({
    requestType: 'AVAILABLE_TO_RECIPIENT',
    vatNumbers: '03365990591',
    dateFrom: '2026-05-01',
    dateTo: '2026-05-31'
  });
  assert.match(xml, /<FattureFEDisposizione>/);
  assert.ok(!xml.includes('<Flusso>'), 'Flusso non previsto per FattureFEDisposizione');
});

test('la richiesta per identificativi SdI accetta solo valori numerici', () => {
  const xml = buildMassiveRequestXml({
    requestType: 'BY_SDI_ID',
    vatNumbers: '03365990591',
    sdiIds: ['32477911', '32477881']
  });
  assert.match(xml, /<FattureSDI><idsdi>32477911<\/idsdi><idsdi>32477881<\/idsdi><\/FattureSDI>/);
  assert.throws(
    () => buildMassiveRequestXml({ requestType: 'BY_SDI_ID', vatNumbers: '03365990591', sdiIds: ['abc'] }),
    /non numerico/
  );
});

test('la partita IVA deve essere di 11 cifre e al massimo 30 per richiesta', () => {
  assert.throws(
    () => buildMassiveRequestXml({ requestType: 'OUTGOING', vatNumbers: 'IT033659905', dateFrom: '2026-03-01', dateTo: '2026-03-31' }),
    /11 cifre/
  );
  const troppe = Array.from({ length: 31 }, (_, i) => String(10000000000 + i));
  assert.throws(
    () => buildMassiveRequestXml({ requestType: 'OUTGOING', vatNumbers: troppe, dateFrom: '2026-03-01', dateTo: '2026-03-31' }),
    /Massimo 30 partite IVA/
  );
});

test('il prefisso IT viene normalizzato via dalla partita IVA', () => {
  const xml = buildMassiveRequestXml({
    requestType: 'OUTGOING', vatNumbers: 'IT03365990591', dateFrom: '2026-03-01', dateTo: '2026-03-31'
  });
  assert.match(xml, /<Piva>03365990591<\/Piva>/);
});

test('un intervallo oltre i tre mesi viene rifiutato prima dell invio (00201)', () => {
  assert.doesNotThrow(() => assertDateRange('2026-03-01', '2026-05-31'));
  assert.throws(() => assertDateRange('2026-01-01', '2026-06-30'), /oltre i 3 mesi/);
  assert.throws(() => assertDateRange('2026-03-31', '2026-03-01'), /invertito/);
  // Tre mesi di calendario, non giorni contati: dal 1 marzo al 1 giugno sono
  // tre mesi esatti e il servizio li accetta, pur essendo 93 giorni.
  assert.doesNotThrow(() => assertDateRange('2026-03-01', '2026-06-01'));
  assert.throws(() => assertDateRange('2026-03-01', '2026-06-02'), /oltre i 3 mesi/);
  assert.doesNotThrow(() => assertDateRange('2026-12-01', '2027-03-01'), 'anche a cavallo d anno');
  assert.ok(MAX_RANGE_DAYS >= 90);
});

test('il nome file della richiesta rispetta il pattern del tracciato', () => {
  const name = buildMassiveRequestFilename({
    vatNumber: '03365990591', requestType: 'OUTGOING', dateFrom: '2026-03-01', dateTo: '2026-03-31'
  });
  assert.match(name, /^[a-zA-Z0-9_.]{9,50}$/);
  assert.match(name, /^03365990591_OUTGOING_20260301_20260331\.xml$/);
});

// --- adapter sm-scarico-file ----------------------------------------------

test('inoltroRichiesta usa SOAPAction nuda e restituisce IdRichiesta', async () => {
  const transport = stubTransport({
    body: envelope({ element: 'InoltroRichiestaResponse', body: '<IdRichiesta>REQ123</IdRichiesta><DataOraRicezione>2026-08-07T10:00:00</DataOraRicezione>' })
  });
  const client = new SdiMassiveServicesClient({ transport });
  const result = await client.submitRequest({ filename: '03365990591_OUT.xml', signedRequest: Buffer.from('firmato') });

  assert.equal(result.idRichiesta, 'REQ123');
  assert.equal(transport.calls[0].soapAction, 'inoltroRichiesta', 'SOAPAction e una stringa nuda, non un URI');
  assert.equal(transport.calls[0].endpoint, DEFAULT_ENDPOINT);
  const sent = transport.calls[0].body.toString('utf8');
  assert.match(sent, /<typ:InoltroRichiestaRequest>/);
  assert.match(sent, new RegExp(`<File>${Buffer.from('firmato').toString('base64')}</File>`));
});

test('una risposta senza IdRichiesta non conferma la presa in carico', async () => {
  const transport = stubTransport({ body: envelope({ element: 'InoltroRichiestaResponse', body: '<DataOraRicezione>2026-08-07T10:00:00</DataOraRicezione>' }) });
  const client = new SdiMassiveServicesClient({ transport });
  await assert.rejects(
    () => client.submitRequest({ filename: '03365990591_OUT.xml', signedRequest: Buffer.from('x') }),
    (error) => error instanceof SdiMassiveServiceError && error.code === 'NO_ID'
  );
});

test('i codici errore ER01-ER05 diventano eccezioni tipizzate', async () => {
  const build = (codice) => stubTransport({
    body: envelope({ element: 'InoltroRichiestaResponse', body: `<IdRichiesta>0</IdRichiesta><Errore><Codice>${codice}</Codice><Descrizione>test</Descrizione></Errore>` })
  });
  for (const [codice, retryable] of [['ER01', true], ['ER02', false], ['ER03', true], ['ER04', false], ['ER05', false]]) {
    const client = new SdiMassiveServicesClient({ transport: build(codice) });
    await assert.rejects(
      () => client.submitRequest({ filename: '03365990591_OUT.xml', signedRequest: Buffer.from('x') }),
      (error) => error.code === codice && error.retryable === retryable,
      `atteso ${codice} retryable=${retryable}`
    );
  }
});

test('esitoRichiesta interpreta gli stati ST00-ST03', async () => {
  const build = (stato, extra = '') => stubTransport({
    body: envelope({ element: 'EsitoRichiestaResponse', body: `<Stato>${stato}</Stato>${extra}` })
  });

  let client = new SdiMassiveServicesClient({ transport: build('ST01') });
  let esito = await client.getRequestStatus('REQ1');
  assert.equal(esito.processing, true);
  assert.equal(esito.statoDescrizione, 'IN ELABORAZIONE');

  client = new SdiMassiveServicesClient({ transport: build('ST02') });
  esito = await client.getRequestStatus('REQ1');
  assert.equal(esito.rejected, true);

  const elenco = Buffer.from('<Archivi/>').toString('base64');
  client = new SdiMassiveServicesClient({ transport: build('ST03', `<EsitoFile><NomeFile>elenco.xml</NomeFile><File>${elenco}</File></EsitoFile>`) });
  esito = await client.getRequestStatus('REQ1');
  assert.equal(esito.ready, true);
  assert.equal(esito.esitoFile.nomeFile, 'elenco.xml');
  assert.equal(esito.esitoFile.buffer.toString('utf8'), '<Archivi/>');
});

test('il limite di 10 interrogazioni per richiesta e applicato lato client', async () => {
  const transport = stubTransport({ body: envelope({ element: 'EsitoRichiestaResponse', body: '<Stato>ST01</Stato>' }) });
  const client = new SdiMassiveServicesClient({ transport });
  for (let i = 0; i < LIMITS.maxEsitoCallsPerRequest; i += 1) {
    const esito = await client.getRequestStatus('REQ1');
    assert.equal(esito.callsRemaining, LIMITS.maxEsitoCallsPerRequest - i - 1);
  }
  await assert.rejects(
    () => client.getRequestStatus('REQ1'),
    (error) => error.code === 'LOCAL_LIMIT'
  );
  // Il contatore e' per richiesta: un altro IdRichiesta riparte da zero.
  assert.equal((await client.getRequestStatus('REQ2')).callsUsed, 1);
});

test('scaricoFile restituisce l archivio e traccia la presa visione', async () => {
  const zip = zlib.gzipSync(Buffer.from('finto archivio'));
  const transport = stubTransport({
    body: envelope({ element: 'ScaricoFileResponse', body: `<ArchivioFile><NomeFile>archivio_001.zip</NomeFile><File>${zip.toString('base64')}</File></ArchivioFile>` })
  });
  const client = new SdiMassiveServicesClient({ transport });
  const result = await client.downloadArchive('REQ1', 'FILE1', { acknowledgeVisualizzazione: true });
  assert.equal(result.nomeFile, 'archivio_001.zip');
  assert.deepEqual(result.buffer, zip);
  assert.equal(result.presaVisione, true);
  assert.equal(transport.calls[0].soapAction, 'scaricoFile');
});

test('il limite di 10 archivi in due minuti e applicato lato client', async () => {
  let clock = 1000;
  const transport = stubTransport({
    body: envelope({ element: 'ScaricoFileResponse', body: '<ArchivioFile><NomeFile>a_001.zip</NomeFile><File>eA==</File></ArchivioFile>' })
  });
  const client = new SdiMassiveServicesClient({ transport, now: () => clock });

  for (let i = 0; i < LIMITS.maxArchiveDownloadsPerWindow; i += 1) {
    await client.downloadArchive('REQ1', `FILE${i}`);
  }
  await assert.rejects(
    () => client.downloadArchive('REQ1', 'FILE99'),
    (error) => error.code === 'LOCAL_LIMIT'
  );

  // Passata la finestra di due minuti la richiesta torna possibile.
  clock += LIMITS.archiveWindowMs + 1;
  const result = await client.downloadArchive('REQ1', 'FILE99');
  assert.equal(result.nomeFile, 'a_001.zip');
});

test('un SOAP Fault e un HTTP non 2xx diventano errori tipizzati', async () => {
  const fault = new SdiMassiveServicesClient({
    transport: stubTransport({ body: '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault><faultstring>errore interno</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>' })
  });
  await assert.rejects(
    () => fault.getRequestStatus('REQ1'),
    (error) => error.code === 'SOAP_FAULT'
  );

  const http = new SdiMassiveServicesClient({ transport: stubTransport({ statusCode: 503, body: '' }) });
  await assert.rejects(
    () => http.getRequestStatus('REQ1'),
    (error) => error.code === 'HTTP_503'
  );
});

test('il client rifiuta operazioni fuori contratto e input mancanti', async () => {
  const client = new SdiMassiveServicesClient({ transport: stubTransport({ body: '<x/>' }) });
  await assert.rejects(() => client.call('operazioneInventata', ''), /non prevista dal contratto/);
  await assert.rejects(() => client.submitRequest({ filename: '', signedRequest: Buffer.from('x') }), /Nome file richiesta mancante/);
  await assert.rejects(() => client.submitRequest({ filename: 'a.xml', signedRequest: null }), /firmato mancante/);
  await assert.rejects(() => client.downloadArchive('REQ1', ''), /obbligatori/);
  assert.throws(() => new SdiMassiveServicesClient({}), /richiede un transport/);
});
