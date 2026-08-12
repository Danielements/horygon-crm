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
const { buildFilename, buildFilenameProgressivo, buildInvoicePayload, normalizeCustomerFiscalCode, normalizeLatinText } = require('../src/services/sdi-fatturapa');
const { buildRiceviFileMtomMessage, buildRiceviFileSoapEnvelope, extractXmlFromHttpResponse, parseRiceviFileResponse } = require('../src/services/sdi-transmission');
const {
  MESSAGGI_NS,
  RICEZIONE_TYPES_NS,
  buildEsitoCommittenteFilename,
  buildNotificaEsitoCommittenteXml,
  buildSdIRiceviNotificaSoapEnvelope,
  parseSdIRiceviNotificaResponse
} = require('../src/services/sdi-esito-committente');
const {
  RECEPTION_TYPES_NS,
  TRANSMISSION_TYPES_NS,
  decodeSdiBase64File,
  decodeSdiFile,
  extractSdiPayload,
  identifySdiOperation,
  listSdiDispatcherKeys,
  normalizeSoapAction,
  parseMultipartRelated,
  parseSoapEnvelope,
  processInboundSdiRequest,
  sendEmptySdiOneWayResponse
} = require('../src/services/sdi-soap-inbound');
const { buildFilenameCandidates } = require('../src/services/sdi-inbound');

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

test('FPR12 B2C sample validates with 0000000 and no PEC', async () => {
  const payload = makeOrdinaryPayload('FPR12');
  payload.destinationCode = '0000000';
  payload.pecDestinatario = '';
  payload.customer.denomination = 'Cliente Consumatore Test';
  payload.customer.vat = { country: '', code: '' };
  payload.customer.fiscalCode = '01043931003';
  const xml = buildOrdinaryInvoiceXml(payload);
  assert.match(xml, /<CodiceDestinatario>0000000<\/CodiceDestinatario>/);
  assert.equal(xml.includes('<PECDestinatario>'), false);
  assert.match(xml, /<CodiceFiscale>01043931003<\/CodiceFiscale>/);
  const result = await validateInvoiceXml({ xml, format: 'FPR12' });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.xsdValid, true);
  assert.equal(result.formalTaxIdValid, true);
  assert.equal(result.taxRegistryVerified, false);
  assert.equal(result.taxRegistryVerificationStatus, 'NOT_CHECKED');
  assert.match(result.warnings.join('\n'), /codici fiscali sintetici vengono scartati/i);
});

test('FPA12 sample validates against local XSD and app rules', async () => {
  const xml = buildOrdinaryInvoiceXml(makeOrdinaryPayload('FPA12'));
  const result = await validateInvoiceXml({ xml, format: 'FPA12' });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

// Caso reale: ordine evaso per AERONAUTICA MILITARE 70 STORMO, senza partita
// IVA, con CIG e split payment. E' la fattura che il CRM deve saper emettere,
// e la si verifica contro lo schema, non a occhio.
function makeAeronauticaInvoice(overrides = {}) {
  return {
    id: 45,
    numero: '45/2026',
    numero_documento: '45/2026',
    data: '2026-08-11',
    tipo_documento: 'fattura',
    totale: 1220,
    valuta: 'EUR',
    scadenza: '2026-10-10',
    cig: 'B1C2D3E4F5',
    cup: 'F81B26000000001',
    ordine_codice: 'ORD-2026-00042',
    ordine_data: '2026-06-30',
    righe: [{ descrizione: 'Fornitura ricambi', quantita: 2, prezzo_unitario: 500, totale_riga: 1000, aliquota_iva: 22 }],
    riepilogo_iva: [{ aliquota_iva: 22, imponibile: 1000, imposta: 220 }],
    ...overrides
  };
}

function makeAeronauticaCustomer(overrides = {}) {
  return {
    ragione_sociale: 'AERONAUTICA MILITARE 70 STORMO',
    piva: null,
    cf: '80007090592',
    pec: 'aerostormo70@postacert.difesa.it',
    indirizzo: 'Aeroporto Enrico Comani',
    cap: '04100',
    citta: 'Latina',
    provincia: 'LT',
    paese: 'IT',
    destinationCode: 'AKGVPD',
    isPa: true,
    escludiSplitPayment: false,
    ...overrides
  };
}

test('PA invoice carries CIG, CUP and split payment and validates against the FPA12 schema', async () => {
  const payload = buildInvoicePayload(
    makeAeronauticaInvoice(),
    makeOrdinaryPayload('FPA12').company,
    makeAeronauticaCustomer(),
    { mode: 'test', progressivo: 'H0045' }
  );
  assert.equal(payload.formatoTrasmissione, 'FPA12');
  assert.equal(payload.destinationCode, 'AKGVPD');
  assert.equal(payload.esigibilitaIva, 'S');
  assert.deepEqual(payload.datiOrdineAcquisto, {
    idDocumento: 'ORD-2026-00042',
    data: '2026-06-30',
    codiceCup: 'F81B26000000001',
    codiceCig: 'B1C2D3E4F5'
  });

  const xml = buildOrdinaryInvoiceXml(payload);
  const result = await validateInvoiceXml({ xml, format: 'FPA12' });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));

  // Il cessionario ha il solo codice fiscale: la PA non ha partita IVA.
  assert.match(xml, /<CessionarioCommittente>[\s\S]*?<CodiceFiscale>80007090592<\/CodiceFiscale>/);
  assert.equal(/<CessionarioCommittente>[\s\S]*?<IdFiscaleIVA>/.test(xml), false);
  // DatiOrdineAcquisto sta dentro DatiGenerali, subito dopo
  // DatiGeneraliDocumento, e il CUP precede il CIG.
  assert.match(xml, /<\/DatiGeneraliDocumento>\s*<DatiOrdineAcquisto>/);
  assert.match(xml, /<CodiceCUP>F81B26000000001<\/CodiceCUP>\s*<CodiceCIG>B1C2D3E4F5<\/CodiceCIG>/);
  assert.match(xml, /<Imposta>220\.00<\/Imposta>\s*<EsigibilitaIVA>S<\/EsigibilitaIVA>/);
});

test('a credit note is a TD04 that cites the invoice it reverses, in schema order', async () => {
  const payload = buildInvoicePayload(
    makeAeronauticaInvoice({
      numero: '7/2026',
      numero_documento: '7/2026',
      tipo_documento: 'nota_credito',
      riferimento_numero: '6',
      riferimento_data: '2026-06-25'
    }),
    makeOrdinaryPayload('FPA12').company,
    makeAeronauticaCustomer(),
    { mode: 'test', progressivo: 'H0052' }
  );
  assert.equal(payload.tipoDocumento, 'TD04');
  assert.deepEqual(payload.datiFattureCollegate, { idDocumento: '6', data: '2026-06-25' });

  const xml = buildOrdinaryInvoiceXml(payload);
  const result = await validateInvoiceXml({ xml, format: 'FPA12' });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));

  // DatiFattureCollegate segue DatiOrdineAcquisto dentro DatiGenerali: in
  // DatiGeneraliType l'ordine e' DatiGeneraliDocumento, DatiOrdineAcquisto,
  // DatiContratto, DatiConvenzione, DatiRicezione, DatiFattureCollegate.
  assert.match(xml, /<\/DatiOrdineAcquisto>\s*<DatiFattureCollegate>/);
  assert.match(xml, /<DatiFattureCollegate>\s*<IdDocumento>6<\/IdDocumento>\s*<Data>2026-06-25<\/Data>/);
});

test('an invoice with no reference carries no DatiFattureCollegate', async () => {
  const payload = buildInvoicePayload(
    makeAeronauticaInvoice(),
    makeOrdinaryPayload('FPA12').company,
    makeAeronauticaCustomer(),
    { mode: 'test', progressivo: 'H0053' }
  );
  assert.equal(payload.datiFattureCollegate, null);
  assert.equal(buildOrdinaryInvoiceXml(payload).includes('<DatiFattureCollegate>'), false);
});

test('PA invoice without CIG omits the correlated document block', async () => {
  const payload = buildInvoicePayload(
    makeAeronauticaInvoice({ cig: null, cup: null }),
    makeOrdinaryPayload('FPA12').company,
    makeAeronauticaCustomer(),
    { mode: 'test', progressivo: 'H0046' }
  );
  assert.equal(payload.datiOrdineAcquisto, null);
  const xml = buildOrdinaryInvoiceXml(payload);
  assert.equal(xml.includes('<DatiOrdineAcquisto>'), false);
  const result = await validateInvoiceXml({ xml, format: 'FPA12' });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test('PA excluded from split payment falls back to immediate VAT', () => {
  const payload = buildInvoicePayload(
    makeAeronauticaInvoice(),
    makeOrdinaryPayload('FPA12').company,
    makeAeronauticaCustomer({ escludiSplitPayment: true }),
    { mode: 'test', progressivo: 'H0047' }
  );
  assert.equal(payload.esigibilitaIva, 'I');
  assert.equal(payload.riepilogo[0].esigibilitaIva, 'I');
});

// Lo stesso ordine evaso puo' andare a un cliente privato: li' CIG, CUP e
// scissione dei pagamenti non c'entrano nulla e la fattura resta quella di
// prima.
test('private customer invoice keeps immediate VAT and no purchase order block', async () => {
  const payload = buildInvoicePayload(
    makeAeronauticaInvoice({ cig: null, cup: null, ordine_codice: 'ORD-2026-00043' }),
    makeOrdinaryPayload('FPR12').company,
    {
      ragione_sociale: 'CLIENTE PRIVATO SRL',
      piva: 'IT01043931003',
      cf: '01043931003',
      indirizzo: 'Via Test',
      cap: '00100',
      citta: 'Roma',
      provincia: 'RM',
      paese: 'IT',
      destinationCode: 'UMZGLCP',
      isPa: false,
      escludiSplitPayment: false
    },
    { mode: 'test', progressivo: 'H0048' }
  );
  assert.equal(payload.formatoTrasmissione, 'FPR12');
  assert.equal(payload.esigibilitaIva, 'I');
  assert.equal(payload.datiOrdineAcquisto, null);

  const xml = buildOrdinaryInvoiceXml(payload);
  assert.equal(xml.includes('<DatiOrdineAcquisto>'), false);
  assert.match(xml, /<EsigibilitaIVA>I<\/EsigibilitaIVA>/);
  const result = await validateInvoiceXml({ xml, format: 'FPR12' });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

// Un CIG su una fattura a un privato non si perde in silenzio: succede nei
// subappalti soggetti a tracciabilita'.
test('private customer with a CIG still gets the correlated document block', () => {
  const payload = buildInvoicePayload(
    makeAeronauticaInvoice({ cup: null }),
    makeOrdinaryPayload('FPR12').company,
    {
      ragione_sociale: 'APPALTATORE SRL',
      piva: 'IT01043931003',
      cf: '01043931003',
      indirizzo: 'Via Test',
      cap: '00100',
      citta: 'Roma',
      provincia: 'RM',
      paese: 'IT',
      destinationCode: 'UMZGLCP',
      isPa: false,
      escludiSplitPayment: false
    },
    { mode: 'test', progressivo: 'H0049' }
  );
  assert.equal(payload.esigibilitaIva, 'I');
  assert.equal(payload.datiOrdineAcquisto.codiceCig, 'B1C2D3E4F5');
});

// Trovato sull'anagrafica reale dell'Aeronautica: "Via dell'Aeroporto" scritto
// con l'apostrofo tipografico. Gli String*LatinType della FatturaPA ammettono
// solo fino a U+00FF, quindi l'XSD lo rifiuta — dopo che la firma qualificata
// e' stata spesa.
test('typographic punctuation is normalised so the address passes the Latin pattern', async () => {
  const payload = buildInvoicePayload(
    makeAeronauticaInvoice(),
    makeOrdinaryPayload('FPA12').company,
    makeAeronauticaCustomer({ indirizzo: 'Via dell’Aeroporto, 1 – palazzina C' }),
    { mode: 'test', progressivo: 'H0050' }
  );
  assert.equal(payload.customer.address, "Via dell'Aeroporto, 1 - palazzina C");
  const result = await validateInvoiceXml({ xml: buildOrdinaryInvoiceXml(payload), format: 'FPA12' });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test('characters outside Latin-1 are left alone so validation says so instead of mutilating a name', () => {
  assert.equal(normalizeLatinText('Shenzhen 中国 Ltd'), 'Shenzhen 中国 Ltd');
  // Gli accenti italiani stanno in Latin-1 Supplement e non vanno toccati.
  assert.equal(normalizeLatinText('Città di Latina'), 'Città di Latina');
});

test('a PA marked only by tipologia_cliente still gets FPA12', () => {
  const payload = buildInvoicePayload(
    makeAeronauticaInvoice(),
    makeOrdinaryPayload('FPA12').company,
    // Scheda creata dalla sezione Clienti: `tipo` resta 'cliente'.
    { ...makeAeronauticaCustomer(), isPa: undefined, tipo: 'cliente', tipologia_cliente: 'pa' },
    { mode: 'test', progressivo: 'H0051', forceFormat: 'FPA12' }
  );
  assert.equal(payload.formatoTrasmissione, 'FPA12');
  assert.equal(payload.destinationCode, 'AKGVPD');
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

test('notification parser recognizes B2B scarto and mancata consegna variants', () => {
  const scarto = parseSdiNotificationXml('<RicevutaScarto><IdentificativoSdI>10</IdentificativoSdI><NomeFile>IT03365990591_00001.xml</NomeFile></RicevutaScarto>');
  assert.equal(scarto.tipoNotifica, 'RicevutaScarto');
  assert.equal(scarto.statoNormalizzato, 'scarto');

  const impossibilita = parseSdiNotificationXml('<RicevutaImpossibilitaRecapito><IdentificativoSdI>11</IdentificativoSdI><NomeFile>IT03365990591_00002.xml</NomeFile></RicevutaImpossibilitaRecapito>');
  assert.equal(impossibilita.tipoNotifica, 'RicevutaImpossibilitaRecapito');
  assert.equal(impossibilita.statoNormalizzato, 'UNDELIVERABLE');
  assert.equal(impossibilita.subtype, 'B2X_IMPOSSIBILITA_RECAPITO');
});

test('notification parser accepts namespaced B2X impossibilita recapito payload', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ns3:RicevutaImpossibilitaRecapito
  xmlns:ns3="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fattura/messaggi/v1.0"
  versione="1.0">
  <IdentificativoSdI>123456789</IdentificativoSdI>
  <NomeFile>IT03365990591_00010.xml</NomeFile>
  <Hash>0123456789abcdef</Hash>
  <DataOraRicezione>2026-08-06T22:00:00+02:00</DataOraRicezione>
  <DataMessaADisposizione>2026-08-07</DataMessaADisposizione>
  <Descrizione>Non e stato possibile recapitare la fattura al destinatario.</Descrizione>
  <MessageId>123456</MessageId>
</ns3:RicevutaImpossibilitaRecapito>`;
  const parsed = parseSdiNotificationXml(xml, { originalFilename: 'IT03365990591_00010_MC_001.xml' });
  assert.equal(parsed.rootElement, 'RicevutaImpossibilitaRecapito');
  assert.equal(parsed.namespace, 'http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fattura/messaggi/v1.0');
  assert.equal(parsed.subtype, 'B2X_IMPOSSIBILITA_RECAPITO');
  assert.equal(parsed.status, 'UNDELIVERABLE');
  assert.equal(parsed.outerNomeFile, 'IT03365990591_00010_MC_001.xml');
  assert.equal(parsed.innerNomeFile, 'IT03365990591_00010.xml');
  assert.equal(parsed.hash, '0123456789abcdef');
  assert.equal(parsed.dataMessaADisposizione, '2026-08-07');
  assert.equal(parsed.messageId, '123456');
});

test('notification parser keeps B2G mancata consegna classification', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<p:NotificaMancataConsegna xmlns:p="http://www.fatturapa.gov.it/sdi/messaggi/v1.0" versione="1.0">
  <IdentificativoSdI>123456790</IdentificativoSdI>
  <NomeFile>IT03365990591_00011.xml</NomeFile>
  <Descrizione>Consegna non riuscita.</Descrizione>
</p:NotificaMancataConsegna>`;
  const parsed = parseSdiNotificationXml(xml);
  assert.equal(parsed.rootElement, 'NotificaMancataConsegna');
  assert.equal(parsed.namespace, 'http://www.fatturapa.gov.it/sdi/messaggi/v1.0');
  assert.equal(parsed.subtype, 'B2G_MANCATA_CONSEGNA');
  assert.equal(parsed.status, 'UNDELIVERABLE');
});

test('progressivo invio stays within SdI limits and differs across invoices', () => {
  const values = [1, 2, 3, 4, 5, 6].map((id) => buildProgressivoInvio(id));
  assert.equal(new Set(values).size, values.length);
  values.forEach((value) => {
    assert.match(value, /^[A-Z0-9]{1,10}$/);
    assert.equal(value.length <= 10, true);
  });
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
  assert.equal(filename, 'IT03365990591_61647.xml');
  assert.match(filename, /^[A-Za-z0-9_.]{9,50}$/);
  assert.match(filename, /^IT03365990591_[A-Z0-9]{5}\.xml$/);
  assert.equal(filename.length <= 50, true);
});

test('outbound filename progressivo is limited to five alphanumeric characters', () => {
  assert.equal(buildFilenameProgressivo('SHUSSCN008'), 'CN008');
  assert.equal(buildFilenameProgressivo('9'), '00009');
});

test('customer fiscal code is omitted when it duplicates VAT code', () => {
  assert.equal(normalizeCustomerFiscalCode('01043931003', { country: 'IT', code: '01043931003' }), '');
  assert.equal(normalizeCustomerFiscalCode('IT01043931003', { country: 'IT', code: '01043931003' }), '');
  assert.equal(normalizeCustomerFiscalCode('RSSMRA80A01H501U', { country: 'IT', code: '01043931003' }), 'RSSMRA80A01H501U');
});

test('invoice payload computes customer VAT in local scope', () => {
  const payload = buildInvoicePayload(
    {
      id: 8,
      numero: 'TESTSDI004',
      numero_documento: 'TESTSDI004',
      data: '2026-08-06',
      tipo_documento: 'fattura',
      totale: 122,
      valuta: 'EUR',
      righe: [{ descrizione: 'Test', quantita: 1, prezzo_unitario: 100, totale_riga: 100, aliquota_iva: 22 }],
      riepilogo_iva: [{ aliquota_iva: 22, imponibile: 100, imposta: 22 }]
    },
    makeOrdinaryPayload('FPR12').company,
    {
      ragione_sociale: 'CLIENTE TEST SDI UMZGLCP',
      piva: 'IT01043931003',
      cf: '01043931003',
      indirizzo: 'Via Test',
      cap: '00100',
      citta: 'Roma',
      provincia: 'RM',
      paese: 'IT',
      destinationCode: 'UMZGLCP',
      isPa: false
    },
    { mode: 'test' }
  );
  assert.deepEqual(payload.customer.vat, { country: 'IT', code: '01043931003' });
  assert.equal(payload.customer.fiscalCode, '');
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

test('customer outcome XML follows NotificaEsitoCommittente contract', () => {
  const xml = buildNotificaEsitoCommittenteXml({
    identificativoSdi: '32477506',
    numeroFattura: 'UMZGLCP-00008-1',
    annoFattura: '2026',
    posizioneFattura: 1,
    esito: 'EC01',
    messageIdCommittente: '412209483'
  });
  assert.match(xml, new RegExp(`<types:NotificaEsitoCommittente[^>]+${MESSAGGI_NS}`));
  assert.match(xml, /<IdentificativoSdI>32477506<\/IdentificativoSdI>/);
  assert.match(xml, /<NumeroFattura>UMZGLCP-00008-1<\/NumeroFattura>/);
  assert.match(xml, /<AnnoFattura>2026<\/AnnoFattura>/);
  assert.match(xml, /<PosizioneFattura>1<\/PosizioneFattura>/);
  assert.match(xml, /<Esito>EC01<\/Esito>/);
});

test('customer outcome filename appends EC suffix and respects SdI limits', () => {
  const filename = buildEsitoCommittenteFilename('IT03365990591_00008.xml', 1);
  assert.equal(filename, 'IT03365990591_00008_EC_001.xml');
  assert.match(filename, /^[A-Za-z0-9_.]{9,50}$/);
  assert.equal(filename.length <= 50, true);
  assert.throws(() => buildEsitoCommittenteFilename('IT03365990591_123456789012345678901234567890.xml', 1), /Nome file esito committente non valido/);
});

test('customer outcome SOAP envelope uses SdIRiceviNotifica fileSdI wrapper', () => {
  const outcomeXml = '<types:NotificaEsitoCommittente xmlns:types="http://www.fatturapa.gov.it/sdi/messaggi/v1.0" versione="1.0"><IdentificativoSdI>32477506</IdentificativoSdI><Esito>EC01</Esito></types:NotificaEsitoCommittente>';
  const envelope = buildSdIRiceviNotificaSoapEnvelope({
    identificativoSdi: '32477506',
    filename: 'IT03365990591_00008_EC_001.xml',
    outcomeXml
  });
  const text = envelope.body.toString('utf8');
  assert.match(text, new RegExp(`xmlns:typ="${RICEZIONE_TYPES_NS}"`));
  assert.match(text, /<typ:fileSdI>/);
  assert.match(text, /<IdentificativoSdI>32477506<\/IdentificativoSdI>/);
  assert.match(text, /<NomeFile>IT03365990591_00008_EC_001\.xml<\/NomeFile>/);
  assert.equal(text.includes(Buffer.from(outcomeXml).toString('base64')), true);
});

test('customer outcome response parser handles ES01 ES02 and ES00 scarto payload', () => {
  const ok = parseSdIRiceviNotificaResponse('<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><types:rispostaSdINotificaEsito xmlns:types="http://www.fatturapa.gov.it/sdi/ws/ricezione/v1.0/types"><Esito>ES01</Esito></types:rispostaSdINotificaEsito></soap:Body></soap:Envelope>');
  assert.equal(ok.accepted, true);
  assert.equal(ok.esito, 'ES01');

  const retry = parseSdIRiceviNotificaResponse('<rispostaSdINotificaEsito><Esito>ES02</Esito></rispostaSdINotificaEsito>');
  assert.equal(retry.retryable, true);

  const scartoXml = '<ScartoEsitoCommittente><IdentificativoSdI>32477506</IdentificativoSdI><ListaErrori><Errore><Codice>EN01</Codice><Descrizione>Esito non ammissibile</Descrizione></Errore></ListaErrori></ScartoEsitoCommittente>';
  const rejected = parseSdIRiceviNotificaResponse(`<rispostaSdINotificaEsito><Esito>ES00</Esito><ScartoEsito><NomeFile>IT03365990591_00008_EC_001.xml</NomeFile><File>${Buffer.from(scartoXml).toString('base64')}</File></ScartoEsito></rispostaSdINotificaEsito>`);
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.scarto.codice, 'EN01');
  assert.equal(rejected.scarto.descrizione, 'Esito non ammissibile');
});

test('customer outcome can intentionally generate invalid EC99 only for interoperability test', () => {
  assert.throws(() => buildNotificaEsitoCommittenteXml({
    identificativoSdi: '32477506',
    esito: 'EC99'
  }), /Esito committente non valido/);
  const xml = buildNotificaEsitoCommittenteXml({
    identificativoSdi: '32477506',
    esito: 'EC99',
    allowInvalidOutcome: true
  });
  assert.match(xml, /<Esito>EC99<\/Esito>/);
});

test('customer outcome response parser extracts EN00 from ScartoEsito payload', () => {
  const scartoXml = '<ScartoEsitoCommittente><IdentificativoSdI>32477506</IdentificativoSdI><Esito>EN00</Esito></ScartoEsitoCommittente>';
  const rejected = parseSdIRiceviNotificaResponse(`<rispostaSdINotificaEsito><Esito>ES00</Esito><ScartoEsito><NomeFile>IT03365990591_00008_EC_001.xml</NomeFile><File>${Buffer.from(scartoXml).toString('base64')}</File></ScartoEsito></rispostaSdINotificaEsito>`);
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.scarto.codice, 'EN00');
  assert.match(rejected.scarto.xml, /ScartoEsitoCommittente/);
});

test('customer outcome response parser extracts EN00 from nested ScartoEsito Scarto', () => {
  const scartoXml = '<ScartoEsitoCommittente><IdentificativoSdI>32477506</IdentificativoSdI><Scarto><Esito>EN00</Esito><Descrizione>Esito non conforme</Descrizione></Scarto></ScartoEsitoCommittente>';
  const rejected = parseSdIRiceviNotificaResponse(`<rispostaSdINotificaEsito><Esito>ES00</Esito><ScartoEsito><NomeFile>IT03365990591_00008_EC_001.xml</NomeFile><File>${Buffer.from(scartoXml).toString('base64')}</File></ScartoEsito></rispostaSdINotificaEsito>`);
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.scarto.codice, 'EN00');
  assert.match(rejected.scarto.xml, /<Scarto>/);
});

test('notification parser extracts NotificaEsito nested EsitoCommittente fields', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<p:NotificaEsito xmlns:p="http://www.fatturapa.gov.it/sdi/messaggi/v1.0" versione="1.0">
  <IdentificativoSdI>32490001</IdentificativoSdI>
  <NomeFile>IT03365990591_NE001.xml</NomeFile>
  <EsitoCommittente>
    <Esito>EC01</Esito>
    <MessageIdCommittente>MSGCOMM1</MessageIdCommittente>
  </EsitoCommittente>
  <MessageId>MSGSDI1</MessageId>
</p:NotificaEsito>`;
  const parsed = parseSdiNotificationXml(xml, { originalFilename: 'IT03365990591_NE001_NE_001.xml' });
  assert.equal(parsed.tipoNotifica, 'NotificaEsito');
  assert.equal(parsed.statoNormalizzato, 'esito');
  assert.equal(parsed.esitoCommittente, 'EC01');
  assert.equal(parsed.messageIdCommittente, 'MSGCOMM1');
  assert.equal(parsed.messageId, 'MSGSDI1');
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
  const ricezioneDecorrenza = identifySdiOperation('notificaDecorrenzaTermini', RECEPTION_TYPES_NS);
  assert.equal(ricezioneDecorrenza.contractName, 'RicezioneFatture');
  assert.equal(ricezioneDecorrenza.responseKind, 'empty_200');
});

test('dispatcher exposes interoperability keys and validates duplicate localNames by contract', () => {
  assert.deepEqual(listSdiDispatcherKeys(), [
    'trasmissione|NotificaMancataConsegna',
    'trasmissione|NotificaDecorrenzaTermini',
    'trasmissione|AttestazioneTrasmissioneFattura',
    'ricezione|NotificaDecorrenzaTermini'
  ]);
  const txDecorrenza = identifySdiOperation(
    'NotificaDecorrenzaTermini',
    TRANSMISSION_TYPES_NS,
    'http://www.fatturapa.it/TrasmissioneFatture/NotificaDecorrenzaTermini'
  );
  assert.equal(txDecorrenza.dispatcherKey, 'trasmissione|NotificaDecorrenzaTermini');
  const rxDecorrenza = identifySdiOperation(
    'NotificaDecorrenzaTermini',
    RECEPTION_TYPES_NS,
    'http://www.fatturapa.it/RicezioneFatture/NotificaDecorrenzaTermini'
  );
  assert.equal(rxDecorrenza.dispatcherKey, 'ricezione|NotificaDecorrenzaTermini');
  assert.throws(() => identifySdiOperation(
    'NotificaDecorrenzaTermini',
    RECEPTION_TYPES_NS,
    'http://www.fatturapa.it/TrasmissioneFatture/NotificaDecorrenzaTermini'
  ), /SOAPAction non coerente/);
});

test('filename matcher builds controlled signed and unsigned variants', () => {
  assert.deepEqual(buildFilenameCandidates('IT03365990591_00010.xml'), [
    'IT03365990591_00010.xml',
    'IT03365990591_00010.xml.p7m',
    'IT03365990591_00010.p7m'
  ]);
  assert.deepEqual(buildFilenameCandidates('IT03365990591_00010.xml.p7m'), [
    'IT03365990591_00010.xml.p7m',
    'IT03365990591_00010.xml'
  ]);
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

test('payload extractor decodes MTOM xop include attachments', () => {
  const boundary = 'MIMEBoundary_horygon_test';
  const fileContentId = 'file-test@horygon.it';
  const decodedNotification = '<RicevutaConsegna><IdentificativoSdI>32480002</IdentificativoSdI><NomeFile>IT03365990591_00002.xml</NomeFile></RicevutaConsegna>';
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:types="${TRANSMISSION_TYPES_NS}" xmlns:xop="http://www.w3.org/2004/08/xop/include">
  <soapenv:Body>
    <types:ricevutaConsegna>
      <IdentificativoSdI>32480002</IdentificativoSdI>
      <NomeFile>IT03365990591_00002_RC_001.xml</NomeFile>
      <File><xop:Include href="cid:${fileContentId}"/></File>
    </types:ricevutaConsegna>
  </soapenv:Body>
</soapenv:Envelope>`;
  const body = Buffer.from([
    `--${boundary}`,
    'Content-Type: application/xop+xml; charset=UTF-8; type="text/xml"',
    'Content-ID: <root-test@horygon.it>',
    '',
    envelope,
    `--${boundary}`,
    'Content-Type: application/octet-stream',
    `Content-ID: <${fileContentId}>`,
    '',
    decodedNotification,
    `--${boundary}--`,
    ''
  ].join('\r\n'), 'utf8');
  const multipart = parseMultipartRelated(body, `multipart/related; boundary="${boundary}"; type="application/xop+xml"; start="<root-test@horygon.it>"`);
  const parsed = parseSoapEnvelope(multipart.rootPart.body.toString('utf8'));
  const payload = extractSdiPayload(parsed.operationElement);
  const decoded = decodeSdiFile(payload.file, payload.nomeFile, multipart);
  assert.equal(payload.identificativoSdI, '32480002');
  assert.equal(payload.file.xopHref, `cid:${fileContentId}`);
  assert.equal(decoded.buffer.toString('utf8'), decodedNotification);
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

test('B2X delivery failure callback uses NotificaMancataConsegna SOAP operation but RicevutaImpossibilitaRecapito payload', () => {
  const decodedNotification = `<?xml version="1.0" encoding="UTF-8"?>
<ns3:RicevutaImpossibilitaRecapito
  xmlns:ns3="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fattura/messaggi/v1.0"
  versione="1.0">
  <IdentificativoSdI>123456789</IdentificativoSdI>
  <NomeFile>IT03365990591_00010.xml</NomeFile>
  <Hash>0123456789abcdef</Hash>
  <DataOraRicezione>2026-08-06T22:00:00+02:00</DataOraRicezione>
  <DataMessaADisposizione>2026-08-07</DataMessaADisposizione>
  <Descrizione>Non e stato possibile recapitare la fattura al destinatario.</Descrizione>
  <MessageId>123456</MessageId>
</ns3:RicevutaImpossibilitaRecapito>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <types:notificaMancataConsegna xmlns:types="${TRANSMISSION_TYPES_NS}">
      <IdentificativoSdI>123456789</IdentificativoSdI>
      <NomeFile>IT03365990591_00010_MC_001.xml</NomeFile>
      <File>${Buffer.from(decodedNotification).toString('base64')}</File>
    </types:notificaMancataConsegna>
  </soapenv:Body>
</soapenv:Envelope>`;
  const req = {
    body: Buffer.from(xml),
    headers: {
      'content-type': 'text/xml',
      'user-agent': 'IBM WebServices/1.0',
      soapaction: '"http://www.fatturapa.it/TrasmissioneFatture/NotificaMancataConsegna"'
    },
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' }
  };
  const result = processInboundSdiRequest(req);
  assert.equal(result.isSoap, true);
  assert.equal(result.operationName, 'notificaMancataConsegna');
  assert.equal(result.operationKind, 'DELIVERY_FAILED');
  assert.equal(result.decodedInnerRoot, 'RicevutaImpossibilitaRecapito');
  assert.equal(result.kind, 'notification-unmatched');
  assert.equal(result.responseKind, 'empty_200');
});

test('deadline callbacks are tracked separately for RicezioneFatture and TrasmissioneFatture', () => {
  const suffix = Date.now().toString(36).toUpperCase().slice(-5);
  const nomeFile = `IT03365990591_${suffix}.xml`;
  const identificativoSdi = String(32500000 + Math.floor(Math.random() * 10000));
  const invoiceInsert = db.prepare(`
    INSERT INTO fatture (
      numero, numero_documento, tipo, direzione, tipo_documento, data, imponibile, iva, totale, stato, stato_pagamento, valuta
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(`TEST-DT-${suffix}`, `TEST-DT-${suffix}`, 'emessa', 'attiva', 'TD01', '2026-08-06', 100, 22, 122, 'ricevuta', 'da_pagare', 'EUR');
  const fatturaId = Number(invoiceInsert.lastInsertRowid);
  const flowInsert = db.prepare(`
    INSERT INTO fatture_sdi_flussi (
      fattura_id, direzione, modalita, tipo_messaggio, nome_file, identificativo_sdi, stato, xml_path, hash_file, payload_meta, ultimo_evento_il
    ) VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))
  `).run(fatturaId, 'outbound', 'test', 'fattura', nomeFile, identificativoSdi, 'inviato_test', '/uploads/sdi-outbound/test-dt.xml', 'hash-dt', '{}');
  const flowId = Number(flowInsert.lastInsertRowid);
  db.prepare(`
    INSERT INTO sdi_interoperability_tests (
      test_name, fattura_id, flow_id, nome_file, identificativo_sdi, callback_atteso, payload_meta, updated_at
    ) VALUES (?,?,?,?,?,?,?,datetime('now'))
  `).run('Decorrenza termini', fatturaId, flowId, nomeFile, identificativoSdi, 'NotificaDecorrenzaTermini', JSON.stringify({ flowSide: 'outbound' }));

  const decodedNotification = `<?xml version="1.0" encoding="UTF-8"?>
<p:NotificaDecorrenzaTermini xmlns:p="http://www.fatturapa.gov.it/sdi/messaggi/v1.0" versione="1.0">
  <IdentificativoSdI>${identificativoSdi}</IdentificativoSdI>
  <NomeFile>${nomeFile}</NomeFile>
  <DataOraRicezione>2026-08-06T22:00:00+02:00</DataOraRicezione>
</p:NotificaDecorrenzaTermini>`;
  const encoded = Buffer.from(decodedNotification).toString('base64');
  const receptionReq = makeSoapReq({
    operationName: 'notificaDecorrenzaTermini',
    operationNamespace: RECEPTION_TYPES_NS,
    soapAction: 'http://www.fatturapa.it/RicezioneFatture/NotificaDecorrenzaTermini',
    identificativoSdi,
    nomeFile: `${nomeFile.replace(/\.xml$/i, '')}_DT_PA_001.xml`,
    encoded
  });
  const transmissionReq = makeSoapReq({
    operationName: 'notificaDecorrenzaTermini',
    operationNamespace: TRANSMISSION_TYPES_NS,
    soapAction: 'http://www.fatturapa.it/TrasmissioneFatture/NotificaDecorrenzaTermini',
    identificativoSdi,
    nomeFile: `${nomeFile.replace(/\.xml$/i, '')}_DT_OE_001.xml`,
    encoded
  });

  const reception = processInboundSdiRequest(receptionReq);
  const transmission = processInboundSdiRequest(transmissionReq);
  assert.equal(reception.dispatcherKey, 'ricezione|NotificaDecorrenzaTermini');
  assert.equal(transmission.dispatcherKey, 'trasmissione|NotificaDecorrenzaTermini');
  assert.equal(reception.responseKind, 'empty_200');
  assert.equal(transmission.responseKind, 'empty_200');

  const rows = db.prepare(`
    SELECT callback_ricevuto, payload_meta
    FROM sdi_interoperability_tests
    WHERE flow_id = ?
      AND callback_ricevuto = 'NotificaDecorrenzaTermini'
    ORDER BY id
  `).all(flowId);
  const sides = rows.map((row) => JSON.parse(row.payload_meta).flowSide).sort();
  assert.deepEqual(sides, ['ricezione', 'trasmissione']);
});

test('attestazione transmission callback inline payload is accepted and classified', () => {
  const decodedNotification = `<?xml version="1.0" encoding="UTF-8"?>
<p:AttestazioneTrasmissioneFattura xmlns:p="http://www.fatturapa.gov.it/sdi/messaggi/v1.0" versione="1.0">
  <IdentificativoSdI>32490002</IdentificativoSdI>
  <NomeFile>IT03365990591_AT001.xml</NomeFile>
  <DataOraRicezione>2026-08-06T22:00:00+02:00</DataOraRicezione>
  <Destinatario><Codice>XS0000</Codice><Descrizione>Canale non disponibile</Descrizione></Destinatario>
  <MessageId>MSGAT1</MessageId>
  <Note>Attestazione test</Note>
  <HashFileOriginale>abcdef</HashFileOriginale>
</p:AttestazioneTrasmissioneFattura>`;
  const req = makeSoapReq({
    operationName: 'attestazioneTrasmissioneFattura',
    operationNamespace: TRANSMISSION_TYPES_NS,
    soapAction: 'http://www.fatturapa.it/TrasmissioneFatture/AttestazioneTrasmissioneFattura',
    identificativoSdi: '32490002',
    nomeFile: 'IT03365990591_AT001_AT_001.xml',
    encoded: Buffer.from(decodedNotification).toString('base64')
  });
  const result = processInboundSdiRequest(req);
  assert.equal(result.operationKind, 'TRANSMISSION_ATTESTATION');
  assert.equal(result.decodedInnerRoot, 'AttestazioneTrasmissioneFattura');
  assert.equal(result.responseKind, 'empty_200');
});

function makeSoapReq({ operationName, operationNamespace, soapAction, identificativoSdi, nomeFile, encoded }) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <types:${operationName} xmlns:types="${operationNamespace}">
      <IdentificativoSdI>${identificativoSdi}</IdentificativoSdI>
      <NomeFile>${nomeFile}</NomeFile>
      <File>${encoded}</File>
    </types:${operationName}>
  </soapenv:Body>
</soapenv:Envelope>`;
  return {
    body: Buffer.from(xml),
    headers: {
      'content-type': 'text/xml',
      'user-agent': 'IBM WebServices/1.0',
      soapaction: `"${soapAction}"`
    },
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' }
  };
}

test('one-way SdI response is HTTP 200 with zero bytes and no content type', () => {
  const response = makeFakeResponse();
  sendEmptySdiOneWayResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Content-Length'], '0');
  assert.equal(Object.prototype.hasOwnProperty.call(response.headers, 'Content-Type'), false);
  assert.equal(response.body.length, 0);
});

function makeFakeResponse() {
  return {
    statusCode: null,
    headers: { 'Content-Type': 'text/xml' },
    body: Buffer.alloc(0),
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    removeHeader(name) {
      delete this.headers[name];
    },
    end(chunk = '') {
      this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    }
  };
}
