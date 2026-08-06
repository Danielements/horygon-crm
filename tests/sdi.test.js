const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const db = require('../src/db/database');
const { buildOrdinaryInvoiceXml, buildSimplifiedInvoiceXml, buildProgressivoInvio } = require('../src/services/sdi-fatturapa-builder');
const { validateInvoiceXml } = require('../src/services/sdi-xml-validator');
const { parseSdiNotificationXml } = require('../src/services/sdi-notification-parser');
const { receiveSdiNotificationXml } = require('../src/services/sdi-inbound');
const { getSchemaRegistryEntry, listSchemaRegistry, syncSchemaRegistry } = require('../src/services/sdi-schema-registry');
const { buildFilename } = require('../src/services/sdi-fatturapa');
const { buildRiceviFileMtomMessage, buildRiceviFileSoapEnvelope, extractXmlFromHttpResponse, parseRiceviFileResponse } = require('../src/services/sdi-transmission');
const {
  RECEPTION_TYPES_NS,
  TRANSMISSION_TYPES_NS,
  decodeSdiBase64File,
  extractSdiPayload,
  identifySdiOperation,
  normalizeSoapAction,
  parseSoapEnvelope,
  processInboundSdiRequest
} = require('../src/services/sdi-soap-inbound');

function makeOrdinaryPayload(format) {
  return {
    formatoTrasmissione: format,
    namespace: getSchemaRegistryEntry(format).namespace,
    fileProgressivo: buildProgressivoInvio(101),
    tipoDocumento: 'TD01',
    data: '2026-08-06',
    numero: `TEST-${format}`,
    importoTotaleDocumento: 122,
    divisa: 'EUR',
    destinationCode: format === 'FPA12' ? 'ABC123' : '0000000',
    pecDestinatario: format === 'FPA12' ? '' : 'cliente@example.com',
    transmitter: {
      email: 'info@horygon.com',
      phone: '0773000000'
    },
    company: {
      country: 'IT',
      vat: '03365990591',
      fiscalCode: '03365990591',
      denomination: 'HORYGON S.R.L.',
      regimeFiscale: 'RF01',
      address: 'Via Roma',
      streetNumber: '1',
      cap: '04100',
      city: 'Latina',
      province: 'LT',
      pec: 'info@horygon.com',
      phone: '0773000000',
      reaOffice: 'LT',
      reaNumber: '123456',
      shareCapital: 10000,
      soleShareholder: 'SM',
      liquidationState: 'LN'
    },
    customer: {
      denomination: format === 'FPA12' ? 'Comune di Test' : 'Cliente Test SRL',
      address: 'Via Milano',
      streetNumber: '10',
      cap: '20100',
      city: 'Milano',
      province: 'MI',
      country: 'IT',
      fiscalCode: '01234567890',
      vat: { country: 'IT', code: '01234567890' }
    },
    lines: [
      {
        numeroLinea: 1,
        descrizione: 'Fornitura test',
        quantita: 1,
        unitaMisura: 'NR',
        prezzoUnitario: 100,
        totaleRiga: 100,
        aliquotaIva: 22,
        importoIva: 22
      }
    ],
    riepilogo: [
      {
        aliquotaIva: 22,
        imponibile: 100,
        imposta: 22,
        esigibilitaIva: 'I'
      }
    ],
    payment: {
      condizioniPagamento: 'TP02',
      details: [{
        modalitaPagamento: 'MP05',
        dataScadenzaPagamento: '2026-08-31',
        importoPagamento: 122
      }]
    }
  };
}

function makeSimplifiedPayload() {
  return {
    namespace: getSchemaRegistryEntry('FSM10').namespace,
    fileProgressivo: buildProgressivoInvio(202),
    destinationCode: '0000000',
    pecDestinatario: 'cliente@example.com',
    tipoDocumento: 'TD07',
    data: '2026-08-06',
    numero: 'TEST-FSM10',
    divisa: 'EUR',
    company: {
      country: 'IT',
      vat: '03365990591',
      fiscalCode: '03365990591',
      denomination: 'HORYGON S.R.L.',
      regimeFiscale: 'RF01',
      address: 'Via Roma',
      streetNumber: '1',
      cap: '04100',
      city: 'Latina',
      province: 'LT',
      reaOffice: 'LT',
      reaNumber: '123456',
      shareCapital: 10000,
      liquidationState: 'LN'
    },
    customer: {
      denomination: 'Cliente Test SRL',
      address: 'Via Milano',
      streetNumber: '10',
      cap: '20100',
      city: 'Milano',
      province: 'MI',
      country: 'IT',
      fiscalCode: '01234567890',
      vat: { country: 'IT', code: '01234567890' }
    },
    lines: [
      {
        descrizione: 'Documento semplificato',
        totaleRiga: 50,
        aliquotaIva: 22,
        importoIva: 11
      }
    ]
  };
}

test('schema registry exposes FPA12 FPR12 FSM10', () => {
  const rows = syncSchemaRegistry();
  assert.ok(rows.length >= 3);
  const formats = listSchemaRegistry().map((item) => item.format).sort();
  assert.deepEqual(formats, ['FPA12', 'FPR12', 'FSM10']);
});

test('FPR12 sample validates against local XSD and app rules', async () => {
  const xml = buildOrdinaryInvoiceXml(makeOrdinaryPayload('FPR12'));
  const result = await validateInvoiceXml({ xml, format: 'FPR12' });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test('FPA12 sample validates against local XSD and app rules', async () => {
  const xml = buildOrdinaryInvoiceXml(makeOrdinaryPayload('FPA12'));
  const result = await validateInvoiceXml({ xml, format: 'FPA12' });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test('FSM10 sample validates against local XSD and app rules', async () => {
  const xml = buildSimplifiedInvoiceXml(makeSimplifiedPayload());
  const result = await validateInvoiceXml({ xml, format: 'FSM10' });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test('notification parser recognizes scarto and extracts metadata', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ns2:NotificaScarto xmlns:ns2="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2">
  <IdentificativoSdI>123456</IdentificativoSdI>
  <NomeFile>IT03365990591_00001.xml</NomeFile>
  <ListaErrori>
    <Errore>
      <Codice>00404</Codice>
      <Descrizione>File duplicato</Descrizione>
    </Errore>
  </ListaErrori>
</ns2:NotificaScarto>`;
  const parsed = parseSdiNotificationXml(xml, { originalFilename: 'notifica.xml' });
  assert.equal(parsed.tipoNotifica, 'NotificaScarto');
  assert.equal(parsed.statoNormalizzato, 'scarto');
  assert.equal(parsed.identificativoSdi, '123456');
  assert.equal(parsed.nomeFileFattura, 'IT03365990591_00001.xml');
  assert.equal(parsed.codiceErrore, '00404');
});

test('inbound notification links to existing flow and updates state', () => {
  const uniqueInvoice = `TST-SDI-${Date.now()}`;
  const uniqueFlowFile = `IT03365990591_TEST_${Date.now()}.xml`;
  const invoiceInsert = db.prepare(`
    INSERT INTO fatture (
      numero, numero_documento, tipo, direzione, tipo_documento, data, imponibile, iva, totale, stato, stato_pagamento, valuta
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(uniqueInvoice, uniqueInvoice, 'emessa', 'attiva', 'fattura', '2026-08-06', 100, 22, 122, 'ricevuta', 'da_pagare', 'EUR');
  const fatturaId = Number(invoiceInsert.lastInsertRowid);
  const flowInsert = db.prepare(`
    INSERT INTO fatture_sdi_flussi (
      fattura_id, direzione, modalita, tipo_messaggio, nome_file, stato, xml_path, hash_file, payload_meta, ultimo_evento_il
    ) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
  `).run(
    fatturaId,
    'outbound',
    'test',
    'fattura',
    uniqueFlowFile,
    'xml_generato_test',
    '/uploads/sdi-outbound/test.xml',
    'hash-test',
    '{}'
  );
  const flowId = Number(flowInsert.lastInsertRowid);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ns2:NotificaScarto xmlns:ns2="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2">
  <IdentificativoSdI>987654</IdentificativoSdI>
  <NomeFile>${uniqueFlowFile}</NomeFile>
  <ListaErrori>
    <Errore>
      <Codice>00404</Codice>
      <Descrizione>File duplicato</Descrizione>
    </Errore>
  </ListaErrori>
</ns2:NotificaScarto>`;

  const result = receiveSdiNotificationXml(xml, { originalFilename: 'notifica-scarto.xml' });
  assert.equal(result.flowId, flowId);
  assert.equal(result.fatturaId, fatturaId);
  assert.equal(result.statoNormalizzato, 'scarto');
  assert.equal(fs.existsSync(path.join(process.cwd(), result.storage.relativePath.replace(/^\//, '').replace(/\//g, path.sep))), true);

  const updatedFlow = db.prepare('SELECT stato, esito_codice, identificativo_sdi FROM fatture_sdi_flussi WHERE id = ?').get(flowId);
  const updatedInvoice = db.prepare('SELECT stato_sdi FROM fatture WHERE id = ?').get(fatturaId);
  assert.equal(updatedFlow.stato, 'scarto');
  assert.equal(updatedFlow.esito_codice, '00404');
  assert.equal(updatedFlow.identificativo_sdi, '987654');
  assert.equal(updatedInvoice.stato_sdi, 'scarto');
});

test('transmission SOAP envelope carries invoice filename and payload', () => {
  const envelope = buildRiceviFileSoapEnvelope('IT03365990591_00001.xml', '<FatturaElettronica>ok</FatturaElettronica>');
  assert.match(envelope, /http:\/\/www\.fatturapa\.it\/sdi\/ws\/trasmissione\/v1\.0\/types|http:\/\/www\.fatturapa\.gov\.it\/sdi\/ws\/trasmissione\/v1\.0\/types/);
  assert.match(envelope, /<NomeFile>IT03365990591_00001\.xml<\/NomeFile>/);
  assert.match(envelope, /PEZhdHR1cmFFbGV0dHJvbmljYT5vazwvRmF0dHVyYUVsZXR0cm9uaWNhPg==/);
});

test('outbound filename follows SdIRiceviFile nomeFile_Type constraints', () => {
  const filename = buildFilename(
    { id: 4, numero_documento: 'TEST-SDI-001' },
    { piva: 'IT01043931003' },
    {
      fileProgressivo: '2608061647',
      company: { country: 'IT', vat: '03365990591', fiscalCode: '03365990591' }
    }
  );
  assert.equal(filename, 'IT03365990591_2608061647.xml');
  assert.match(filename, /^[A-Za-z0-9_.]{9,50}$/);
  assert.equal(filename.length <= 50, true);
});

test('transmission MTOM message carries xop include and binary attachment', () => {
  const message = buildRiceviFileMtomMessage('IT03365990591_00001.xml', Buffer.from('<FatturaElettronica>ok</FatturaElettronica>'));
  assert.match(message.contentType, /multipart\/related/);
  assert.match(message.contentType, /application\/xop\+xml/);
  assert.match(message.envelope, /xop:Include/);
  assert.equal(message.body.includes(Buffer.from('<FatturaElettronica>ok</FatturaElettronica>')), true);
  assert.equal(message.body.includes(Buffer.from('\r\n\r\n<FatturaElettronica>ok</FatturaElettronica>')), true);
});

test('transmission parser extracts SdI identifier from RiceviFile response', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <ns1:rispostaSdIRiceviFile xmlns:ns1="http://www.fatturapa.gov.it/sdi/ws/trasmissione/v1.0/types">
      <IdentificativoSdI>32480000</IdentificativoSdI>
      <DataOraRicezione>2026-08-06T15:10:00</DataOraRicezione>
    </ns1:rispostaSdIRiceviFile>
  </soap:Body>
</soap:Envelope>`;
  const parsed = parseRiceviFileResponse(xml);
  assert.equal(parsed.identificativoSdi, '32480000');
  assert.equal(parsed.dataOraRicezione, '2026-08-06T15:10:00');
});

test('transmission parser extracts XML from multipart SdI response', () => {
  const boundary = 'MIMEBoundary_test';
  const xml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns1:rispostaSdIRiceviFile xmlns:ns1="http://www.fatturapa.gov.it/sdi/ws/trasmissione/v1.0/types"><IdentificativoSdI>32480001</IdentificativoSdI><DataOraRicezione>2026-08-06T15:11:00</DataOraRicezione></ns1:rispostaSdIRiceviFile></soap:Body></soap:Envelope>';
  const body = Buffer.from(`--${boundary}\r\nContent-Type: application/xop+xml; charset=UTF-8; type="text/xml"\r\nContent-ID: <root@test>\r\n\r\n${xml}\r\n--${boundary}--\r\n`, 'utf8');
  const extracted = extractXmlFromHttpResponse({
    headers: { 'content-type': `multipart/related; boundary="${boundary}"; type="application/xop+xml"` },
    bodyBuffer: body
  });
  assert.match(extracted, /rispostaSdIRiceviFile/);
  assert.equal(parseRiceviFileResponse(extracted).identificativoSdi, '32480001');
});

test('SOAP parser recognizes SOAP 1.1 prefixes and default namespace', () => {
  const variants = [
    ['soapenv', '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><types:notificaScarto xmlns:types="http://www.fatturapa.gov.it/sdi/ws/trasmissione/v1.0/types"><IdentificativoSdI>123</IdentificativoSdI><NomeFile>IT03365990591_00007.xml</NomeFile><File>PHg+eTwveD4=</File></types:notificaScarto></soapenv:Body></soapenv:Envelope>'],
    ['soap', '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><types:notificaScarto xmlns:types="http://www.fatturapa.gov.it/sdi/ws/trasmissione/v1.0/types"><IdentificativoSdI>123</IdentificativoSdI><NomeFile>IT03365990591_00007.xml</NomeFile><File>PHg+eTwveD4=</File></types:notificaScarto></soap:Body></soap:Envelope>'],
    ['S', '<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><types:notificaScarto xmlns:types="http://www.fatturapa.gov.it/sdi/ws/trasmissione/v1.0/types"><IdentificativoSdI>123</IdentificativoSdI><NomeFile>IT03365990591_00007.xml</NomeFile><File>PHg+eTwveD4=</File></types:notificaScarto></S:Body></S:Envelope>'],
    ['default', '<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/"><Body><types:notificaScarto xmlns:types="http://www.fatturapa.gov.it/sdi/ws/trasmissione/v1.0/types"><IdentificativoSdI>123</IdentificativoSdI><NomeFile>IT03365990591_00007.xml</NomeFile><File>PHg+eTwveD4=</File></types:notificaScarto></Body></Envelope>']
  ];
  for (const [, xml] of variants) {
    const parsed = parseSoapEnvelope(xml);
    assert.equal(parsed.isSoap, true);
    assert.equal(parsed.soapVersion, '1.1');
    assert.equal(parsed.operationLocalName, 'notificaScarto');
    assert.equal(parsed.operationNamespace, TRANSMISSION_TYPES_NS);
  }
});

test('SOAP parser recognizes SOAP 1.2 namespace', () => {
  const parsed = parseSoapEnvelope('<S:Envelope xmlns:S="http://www.w3.org/2003/05/soap-envelope"><S:Body><types:fileSdIConMetadati xmlns:types="http://www.fatturapa.gov.it/sdi/ws/ricezione/v1.0/types"><IdentificativoSdI>123</IdentificativoSdI><NomeFile>IT03365990591_00007.xml</NomeFile><File>PHg+eTwveD4=</File><NomeFileMetadati>IT03365990591_00007_MT_001.xml</NomeFileMetadati><Metadati>PG0+PC9tPg==</Metadati></types:fileSdIConMetadati></S:Body></S:Envelope>');
  assert.equal(parsed.soapVersion, '1.2');
  assert.equal(parsed.operationLocalName, 'fileSdIConMetadati');
  assert.equal(parsed.operationNamespace, RECEPTION_TYPES_NS);
});

test('SOAPAction is normalized with and without quotes', () => {
  assert.equal(normalizeSoapAction('"http://www.fatturapa.it/TrasmissioneFatture/NotificaScarto"'), 'http://www.fatturapa.it/TrasmissioneFatture/NotificaScarto');
  assert.equal(normalizeSoapAction('http://www.fatturapa.it/TrasmissioneFatture/NotificaScarto'), 'http://www.fatturapa.it/TrasmissioneFatture/NotificaScarto');
  assert.equal(normalizeSoapAction(undefined), '');
});

test('operation resolver maps transmission and reception operations', () => {
  assert.equal(identifySdiOperation('RicevutaConsegna', TRANSMISSION_TYPES_NS).responseKind, 'empty_200');
  assert.equal(identifySdiOperation('notificaMancataConsegna', TRANSMISSION_TYPES_NS).responseKind, 'empty_200');
  assert.equal(identifySdiOperation('NotificaScarto', TRANSMISSION_TYPES_NS).kind, 'REJECTED');
  assert.equal(identifySdiOperation('notificaEsito', TRANSMISSION_TYPES_NS).kind, 'CUSTOMER_OUTCOME');
  assert.equal(identifySdiOperation('notificaDecorrenzaTermini', TRANSMISSION_TYPES_NS).kind, 'DEADLINE_EXPIRED');
  assert.equal(identifySdiOperation('attestazioneTrasmissioneFattura', TRANSMISSION_TYPES_NS).kind, 'TRANSMISSION_ATTESTATION');
  assert.equal(identifySdiOperation('fileSdIConMetadati', RECEPTION_TYPES_NS).responseKind, 'ricevi_fatture_er01');
});

test('payload extractor decodes base64 with new lines', () => {
  const encoded = Buffer.from('<NotificaScarto>ok</NotificaScarto>').toString('base64').replace(/(.{8})/g, '$1\n');
  const parsed = parseSoapEnvelope(`<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><types:notificaScarto xmlns:types="${TRANSMISSION_TYPES_NS}"><IdentificativoSdI>32477506</IdentificativoSdI><NomeFile>IT03365990591_00007.xml</NomeFile><File>${encoded}</File></types:notificaScarto></soapenv:Body></soapenv:Envelope>`);
  const payload = extractSdiPayload(parsed.operationElement);
  const decoded = decodeSdiBase64File(payload.file, payload.nomeFile);
  assert.equal(payload.identificativoSdI, '32477506');
  assert.equal(payload.nomeFile, 'IT03365990591_00007.xml');
  assert.equal(decoded.buffer.toString('utf8'), '<NotificaScarto>ok</NotificaScarto>');
  assert.equal(decoded.contentType, 'xml');
});

test('base64 decoder identifies p7m and zip payloads', () => {
  assert.equal(decodeSdiBase64File(Buffer.from([0x30, 0x82, 0x01, 0x02]).toString('base64'), 'file.xml.p7m').contentType, 'p7m');
  assert.equal(decodeSdiBase64File(Buffer.from([0x50, 0x4b, 0x03, 0x04]).toString('base64'), 'file.zip').contentType, 'zip');
  assert.throws(() => decodeSdiBase64File('', 'empty.xml'), /Campo File SDI vuoto/);
  assert.throws(() => decodeSdiBase64File('@@@', 'bad.xml'), /base64 valido/);
});

test('real regression fixture is not parsed as Envelope operation', () => {
  const decodedNotification = `<?xml version="1.0" encoding="UTF-8"?>
<NotificaScarto xmlns="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2">
  <IdentificativoSdI>32477506</IdentificativoSdI>
  <NomeFile>IT03365990591_00007.xml</NomeFile>
  <ListaErrori><Errore><Codice>00404</Codice><Descrizione>File duplicato</Descrizione></Errore></ListaErrori>
</NotificaScarto>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header/>
  <soapenv:Body>
    <types:notificaScarto xmlns:types="${TRANSMISSION_TYPES_NS}">
      <IdentificativoSdI>32477506</IdentificativoSdI>
      <NomeFile>IT03365990591_00007.xml</NomeFile>
      <File>${Buffer.from(decodedNotification).toString('base64')}</File>
    </types:notificaScarto>
  </soapenv:Body>
</soapenv:Envelope>`;
  const req = {
    body: Buffer.from(xml),
    headers: {
      'content-type': 'text/xml',
      'user-agent': 'IBM WebServices/1.0',
      soapaction: '"http://www.fatturapa.it/TrasmissioneFatture/NotificaScarto"'
    },
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' }
  };
  const result = processInboundSdiRequest(req);
  assert.equal(result.isSoap, true);
  assert.equal(result.soapVersion, '1.1');
  assert.equal(result.operationName, 'notificaScarto');
  assert.equal(result.payloadRootElement, 'notificaScarto');
  assert.notEqual(result.operationName, 'Envelope');
  assert.equal(result.responseKind, 'empty_200');
  assert.equal(result.kind, 'notification-unmatched');
  assert.equal(fs.existsSync(path.join(process.cwd(), result.storage.envelopePath.replace(/^\//, '').replace(/\//g, path.sep))), true);
  assert.equal(fs.existsSync(path.join(process.cwd(), result.storage.decodedPath.replace(/^\//, '').replace(/\//g, path.sep))), true);
});
