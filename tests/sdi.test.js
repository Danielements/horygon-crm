const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOrdinaryInvoiceXml, buildSimplifiedInvoiceXml, buildProgressivoInvio } = require('../src/services/sdi-fatturapa-builder');
const { validateInvoiceXml } = require('../src/services/sdi-xml-validator');
const { parseSdiNotificationXml } = require('../src/services/sdi-notification-parser');
const { getSchemaRegistryEntry, listSchemaRegistry, syncSchemaRegistry } = require('../src/services/sdi-schema-registry');

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
