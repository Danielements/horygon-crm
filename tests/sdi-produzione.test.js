const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { buildOrdinaryInvoiceXml } = require('../src/services/sdi-fatturapa-builder');
const { validateInvoiceXml } = require('../src/services/sdi-xml-validator');
const { getSchemaRegistryEntry } = require('../src/services/sdi-schema-registry');
const { runSdiFiscalChecks } = require('../src/services/sdi-fiscal-checks');
const { parseRiceviFileResponse } = require('../src/services/sdi-transmission');
const { signCadesBes, certificateDer, readCertificateFields } = require('../src/services/sdi-cades');
const { allocateOutboundProgressivo, encodeBase36, normalizePrefix } = require('../src/services/sdi-progressivo');

function makePayload(format) {
  return {
    formatoTrasmissione: format,
    namespace: getSchemaRegistryEntry(format).namespace,
    fileProgressivo: 'H0001',
    tipoDocumento: 'TD01',
    data: '2026-08-06',
    numero: `2026/${format}-1`,
    importoTotaleDocumento: 122,
    divisa: 'EUR',
    destinationCode: format === 'FPA12' ? 'ABC123' : '0000000',
    pecDestinatario: format === 'FPA12' ? '' : 'cliente@example.com',
    transmitter: { email: 'info@horygon.com', phone: '0773000000' },
    company: {
      country: 'IT', vat: '03365990591', fiscalCode: '03365990591',
      denomination: 'HORYGON S.R.L.', regimeFiscale: 'RF01',
      address: 'Via Roma', streetNumber: '1', cap: '04100', city: 'Latina', province: 'LT',
      pec: 'info@horygon.com', phone: '0773000000',
      reaOffice: 'LT', reaNumber: '123456', shareCapital: 10000, liquidationState: 'LN'
    },
    customer: {
      denomination: format === 'FPA12' ? 'Comune di Test' : 'Cliente Test SRL',
      address: 'Via Milano', streetNumber: '10', cap: '20100', city: 'Milano', province: 'MI',
      country: 'IT', fiscalCode: '', vat: { country: 'IT', code: '01234567890' }
    },
    lines: [{
      numeroLinea: 1, descrizione: 'Fornitura test', quantita: 1, unitaMisura: 'NR',
      prezzoUnitario: 100, totaleRiga: 100, aliquotaIva: 22, importoIva: 22
    }],
    riepilogo: [{ aliquotaIva: 22, imponibile: 100, imposta: 22, esigibilitaIva: 'I' }],
    payment: {
      condizioniPagamento: 'TP02',
      details: [{ modalitaPagamento: 'MP05', dataScadenzaPagamento: '2026-08-31', importoPagamento: 122 }]
    }
  };
}

function fiscalCodes(payload, format = 'FPR12') {
  return runSdiFiscalChecks(buildOrdinaryInvoiceXml(payload), { format }).map((item) => item.code);
}

// fatture_sdi_flussi.fattura_id e' NOT NULL: serve una testata di appoggio.
function makeThrowawayInvoice(db) {
  return db.prepare(`
    INSERT INTO fatture (numero, tipo, data, note)
    VALUES (?, 'emessa', '2026-08-06', 'fixture test unicita SDI')
  `).run(`TEST-FIXTURE-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`).lastInsertRowid;
}

function makeSigningMaterial() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdi-firma-'));
  const keyPath = path.join(dir, 'signer.key');
  const certPath = path.join(dir, 'signer.pem');
  try {
    execFileSync('openssl', ['genrsa', '-out', keyPath, '2048'], { stdio: 'ignore' });
    execFileSync('openssl', [
      'req', '-x509', '-key', keyPath, '-out', certPath, '-days', '2',
      '-subj', '/C=IT/O=HORYGON S.R.L./CN=SDI-TEST'
    ], { stdio: 'ignore', env: Object.assign({}, process.env, { MSYS_NO_PATHCONV: '1' }) });
  } catch {
    return null;
  }
  return { dir, keyPath, certPath };
}

// --- Firma CAdES-BES (Specifiche tecniche SdI par. 2.1) --------------------

test('la firma CAdES-BES e verificabile e conserva i byte della fattura', (t) => {
  const material = makeSigningMaterial();
  if (!material) return t.skip('openssl non disponibile');

  const xml = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<p:FatturaElettronica versione="FPA12"><x>1</x></p:FatturaElettronica>', 'utf8');
  const p7m = signCadesBes({
    content: xml,
    certificatePem: fs.readFileSync(material.certPath),
    privateKeyPem: fs.readFileSync(material.keyPath)
  });

  const p7mPath = path.join(material.dir, 'fattura.xml.p7m');
  const outPath = path.join(material.dir, 'estratto.xml');
  fs.writeFileSync(p7mPath, p7m);
  execFileSync('openssl', ['cms', '-verify', '-in', p7mPath, '-inform', 'DER', '-noverify', '-out', outPath], { stdio: 'ignore' });

  // openssl scrive in text mode su Windows: normalizziamo i fine riga.
  const extracted = fs.readFileSync(outPath).toString('utf8').replace(/\r\n/g, '\n');
  assert.equal(extracted, xml.toString('utf8').replace(/\r\n/g, '\n'));

  const dump = execFileSync('openssl', ['asn1parse', '-in', p7mPath, '-inform', 'DER', '-i']).toString('utf8');
  assert.match(dump, /signingTime/);
  assert.match(dump, /messageDigest/);
  assert.match(dump, /contentType/);
  // L'attributo ESS distingue un CAdES-BES da un PKCS#7 generico.
  assert.match(dump, /signingCertificateV2/);
});

test('la firma rifiuta una chiave che non corrisponde al certificato', (t) => {
  const first = makeSigningMaterial();
  const second = makeSigningMaterial();
  if (!first || !second) return t.skip('openssl non disponibile');
  assert.throws(() => signCadesBes({
    content: Buffer.from('<x/>', 'utf8'),
    certificatePem: fs.readFileSync(first.certPath),
    privateKeyPem: fs.readFileSync(second.keyPath)
  }), /non corrisponde al certificato di firma/);
});

test('il lettore di certificati estrae issuer e serial come DER grezzo', (t) => {
  const material = makeSigningMaterial();
  if (!material) return t.skip('openssl non disponibile');
  const fields = readCertificateFields(certificateDer(fs.readFileSync(material.certPath)));
  assert.equal(fields.serialNumber[0], 0x02, 'il serial number deve essere un INTEGER DER');
  assert.equal(fields.issuer[0], 0x30, 'l issuer deve essere una SEQUENCE DER');
});

// --- Pre-controlli fiscali (Elenco dei controlli SdI 2.0) ------------------

test('una fattura coerente non produce nessun rilievo fiscale', () => {
  assert.deepEqual(fiscalCodes(makePayload('FPR12')), []);
  assert.deepEqual(fiscalCodes(makePayload('FPA12'), 'FPA12'), []);
});

test('Natura e AliquotaIVA devono essere coerenti (00400, 00401, 00429, 00430)', () => {
  const zeroRate = makePayload('FPR12');
  zeroRate.lines[0].aliquotaIva = 0;
  zeroRate.lines[0].importoIva = 0;
  zeroRate.riepilogo = [{ aliquotaIva: 0, imponibile: 100, imposta: 0 }];
  const missing = fiscalCodes(zeroRate);
  assert.ok(missing.includes('00400'));
  assert.ok(missing.includes('00429'));

  const withRate = makePayload('FPR12');
  withRate.lines[0].naturaIva = 'N3.5';
  withRate.riepilogo[0].naturaIva = 'N3.5';
  const unexpected = fiscalCodes(withRate);
  assert.ok(unexpected.includes('00401'));
  assert.ok(unexpected.includes('00430'));
});

test('le nature generiche N2 N3 N6 non sono piu ammesse (00445)', () => {
  const payload = makePayload('FPR12');
  payload.lines[0].aliquotaIva = 0;
  payload.lines[0].importoIva = 0;
  payload.lines[0].naturaIva = 'N3';
  payload.riepilogo = [{ aliquotaIva: 0, naturaIva: 'N3', imponibile: 100, imposta: 0 }];
  assert.ok(fiscalCodes(payload).includes('00445'));

  payload.lines[0].naturaIva = 'N3.5';
  payload.riepilogo[0].naturaIva = 'N3.5';
  assert.ok(!fiscalCodes(payload).includes('00445'));
});

test('PrezzoTotale viene confrontato con lo sconto per unita (00423)', () => {
  const payload = makePayload('FPR12');
  payload.lines[0].quantita = 2;
  payload.lines[0].prezzoUnitario = 50;
  payload.lines[0].totaleRiga = 90;
  payload.riepilogo = [{ aliquotaIva: 22, imponibile: 90, imposta: 19.8, esigibilitaIva: 'I' }];
  assert.ok(fiscalCodes(payload).includes('00423'));

  payload.lines[0].scontoMaggiorazione = [{ tipo: 'SC', importo: 5 }];
  assert.ok(!fiscalCodes(payload).includes('00423'));
});

test('gli sconti percentuali si applicano a cascata (00423)', () => {
  const payload = makePayload('FPR12');
  payload.lines[0].quantita = 1;
  payload.lines[0].prezzoUnitario = 100;
  // 10% e poi 10% a cascata: 100 -> 90 -> 81
  payload.lines[0].scontoMaggiorazione = [{ tipo: 'SC', percentuale: 10 }, { tipo: 'SC', percentuale: 10 }];
  payload.lines[0].totaleRiga = 81;
  payload.riepilogo = [{ aliquotaIva: 22, imponibile: 81, imposta: 17.82, esigibilitaIva: 'I' }];
  assert.ok(!fiscalCodes(payload).includes('00423'));

  payload.lines[0].totaleRiga = 80;
  payload.riepilogo = [{ aliquotaIva: 22, imponibile: 80, imposta: 17.6, esigibilitaIva: 'I' }];
  assert.ok(fiscalCodes(payload).includes('00423'));
});

test('Imposta e Imponibile rispettano le tolleranze dichiarate (00421, 00422)', () => {
  const wrongTax = makePayload('FPR12');
  wrongTax.riepilogo[0].imposta = 99;
  assert.ok(fiscalCodes(wrongTax).includes('00421'));

  // Tolleranza 00421: un centesimo e ammesso.
  const roundedTax = makePayload('FPR12');
  roundedTax.riepilogo[0].imposta = 22.01;
  assert.ok(!fiscalCodes(roundedTax).includes('00421'));

  const wrongBase = makePayload('FPR12');
  wrongBase.riepilogo[0].imponibile = 500;
  wrongBase.riepilogo[0].imposta = 110;
  assert.ok(fiscalCodes(wrongBase).includes('00422'));

  // Tolleranza 00422: un euro e ammesso.
  const roundedBase = makePayload('FPR12');
  roundedBase.riepilogo[0].imponibile = 100.5;
  roundedBase.riepilogo[0].imposta = 22.11;
  assert.ok(!fiscalCodes(roundedBase).includes('00422'));
});

test('ogni aliquota di riga deve avere un blocco di riepilogo (00443)', () => {
  const payload = makePayload('FPR12');
  payload.lines.push({
    numeroLinea: 2, descrizione: 'Seconda riga', quantita: 1, unitaMisura: 'NR',
    prezzoUnitario: 50, totaleRiga: 50, aliquotaIva: 10, importoIva: 5
  });
  assert.ok(fiscalCodes(payload).includes('00443'));
});

test('la lunghezza del CodiceDestinatario dipende dal formato (00427)', () => {
  const pa = makePayload('FPA12');
  pa.destinationCode = 'UMZGLCP';
  assert.ok(fiscalCodes(pa, 'FPA12').includes('00427'));

  const b2b = makePayload('FPR12');
  b2b.destinationCode = 'ESOJKL';
  b2b.pecDestinatario = '';
  assert.ok(fiscalCodes(b2b).includes('00427'));
});

test('il numero documento deve contenere almeno una cifra (00425)', () => {
  const payload = makePayload('FPR12');
  payload.numero = 'ABC/BIS';
  assert.ok(fiscalCodes(payload).includes('00425'));
});

test('una data futura viene intercettata (00403)', () => {
  const payload = makePayload('FPR12');
  payload.data = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  assert.ok(fiscalCodes(payload).includes('00403'));
});

// --- Regole di trasmissione nel tracciato ---------------------------------

test('PECDestinatario compare solo con CodiceDestinatario 0000000 e mai verso la PA', () => {
  const b2c = makePayload('FPR12');
  assert.match(buildOrdinaryInvoiceXml(b2c), /<PECDestinatario>cliente@example\.com<\/PECDestinatario>/);

  const withChannel = makePayload('FPR12');
  withChannel.destinationCode = 'UMZGLCP';
  assert.ok(!buildOrdinaryInvoiceXml(withChannel).includes('<PECDestinatario>'));

  const pa = makePayload('FPA12');
  pa.pecDestinatario = 'ufficio@pec.example.com';
  assert.ok(!buildOrdinaryInvoiceXml(pa).includes('<PECDestinatario>'));
});

test('ScontoMaggiorazione rispetta l ordine dello schema e valida', async () => {
  const payload = makePayload('FPR12');
  payload.lines[0].quantita = 2;
  payload.lines[0].prezzoUnitario = 50;
  payload.lines[0].scontoMaggiorazione = [{ tipo: 'SC', importo: 5 }];
  payload.lines[0].totaleRiga = 90;
  payload.riepilogo = [{ aliquotaIva: 22, imponibile: 90, imposta: 19.8, esigibilitaIva: 'I' }];
  const xml = buildOrdinaryInvoiceXml(payload);
  assert.match(xml, /<Tipo>SC<\/Tipo>/);
  assert.match(xml, /<Importo>5\.00000000<\/Importo>/);
  const validation = await validateInvoiceXml({ xml, format: 'FPR12' });
  assert.equal(validation.ok, true, JSON.stringify(validation.xsd.errors || validation.fiscal));
});

test('IstitutoFinanziario precede IBAN come richiede DettaglioPagamentoType', async () => {
  const payload = makePayload('FPR12');
  payload.payment.details[0].iban = 'IT60X0542811101000000123456';
  payload.payment.details[0].istitutoFinanziario = 'Banca di Test';
  const xml = buildOrdinaryInvoiceXml(payload);
  assert.ok(xml.indexOf('<IstitutoFinanziario>') < xml.indexOf('<IBAN>'));
  const validation = await validateInvoiceXml({ xml, format: 'FPR12' });
  assert.equal(validation.ok, true, JSON.stringify(validation.xsd.errors || validation.fiscal));
});

// --- Risposta RiceviFile: campo Errore ------------------------------------

function riceviFileResponse(inner) {
  return '<?xml version="1.0"?>'
    + '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>'
    + '<ns2:rispostaSdIRiceviFile xmlns:ns2="http://www.fatturapa.gov.it/sdi/ws/trasmissione/v1.0/types">'
    + inner
    + '</ns2:rispostaSdIRiceviFile></soapenv:Body></soapenv:Envelope>';
}

test('la presa in carico richiede IdentificativoSdI e assenza di Errore', () => {
  const parsed = parseRiceviFileResponse(riceviFileResponse(
    '<IdentificativoSdI>32477911</IdentificativoSdI><DataOraRicezione>2026-08-06T10:00:00.000+02:00</DataOraRicezione>'
  ));
  assert.equal(parsed.identificativoSdi, '32477911');
  assert.equal(parsed.accepted, true);
  assert.equal(parsed.retryable, false);
});

test('i codici EI01 EI02 EI03 non sono un invio riuscito', () => {
  const build = (errore) => parseRiceviFileResponse(riceviFileResponse(
    `<IdentificativoSdI>0</IdentificativoSdI><DataOraRicezione>2026-08-06T10:00:00.000+02:00</DataOraRicezione><Errore>${errore}</Errore>`
  ));

  const empty = build('EI01');
  assert.equal(empty.accepted, false);
  assert.equal(empty.errore, 'EI01');
  assert.match(empty.erroreDescrizione, /File allegato vuoto/);

  const unavailable = build('EI02');
  assert.equal(unavailable.accepted, false);
  assert.equal(unavailable.retryable, true, 'EI02 e ritentabile');

  const forbidden = build('EI03');
  assert.equal(forbidden.accepted, false);
  assert.equal(forbidden.retryable, false);
});

test('una risposta senza IdentificativoSdI non conferma la presa in carico', () => {
  const parsed = parseRiceviFileResponse(riceviFileResponse('<DataOraRicezione>2026-08-06T10:00:00.000+02:00</DataOraRicezione>'));
  assert.equal(parsed.accepted, false);
});

// --- Progressivo univoco (Specifiche tecniche par. 2.2) -------------------

test('il progressivo viene allocato da una sequenza persistente e crescente', () => {
  const values = [allocateOutboundProgressivo(), allocateOutboundProgressivo(), allocateOutboundProgressivo()];
  values.forEach((value) => assert.match(value, /^[A-Z0-9]{5}$/, `progressivo non conforme: ${value}`));
  assert.equal(new Set(values).size, 3, 'i progressivi devono essere tutti diversi');
});

test('il prefisso del progressivo viene normalizzato e limitato', () => {
  assert.equal(normalizePrefix('h'), 'H');
  assert.equal(normalizePrefix(' h-1 '), 'H1');
  assert.equal(normalizePrefix(''), '');
  assert.throws(() => normalizePrefix('ABCDE'), /piu corto/);
  assert.equal(encodeBase36(1, 4), '0001');
  assert.equal(encodeBase36(35, 4), '000Z');
});

test('il database rifiuta due invii fattura con lo stesso nome file', () => {
  const db = require('../src/db/database');
  const nomeFile = `IT03365990591_T${Date.now().toString(36).toUpperCase().slice(-4)}.xml`;
  const insert = () => db.prepare(`
    INSERT INTO fatture_sdi_flussi (fattura_id, direzione, modalita, tipo_messaggio, nome_file, stato)
    VALUES (?, 'outbound', 'test', 'fattura', ?, 'test_unicita')
  `).run(makeThrowawayInvoice(db), nomeFile);

  insert();
  assert.throws(insert, /UNIQUE|constraint/i, 'il secondo inserimento deve violare il vincolo');

  db.prepare("DELETE FROM fatture_sdi_flussi WHERE stato = 'test_unicita'").run();
  db.prepare("DELETE FROM fatture WHERE note = 'fixture test unicita SDI'").run();
});

// --- Guardrail invio in produzione ----------------------------------------

const { transmitGeneratedFlow } = require('../src/services/sdi-transmission');

test('un flusso generato in test non puo essere trasmesso in produzione', async () => {
  const db = require('../src/db/database');
  const flowId = db.prepare(`
    INSERT INTO fatture_sdi_flussi (fattura_id, direzione, modalita, tipo_messaggio, nome_file, stato, xml_path)
    VALUES (?, 'outbound', 'test', 'fattura', ?, 'test_guardrail', '/uploads/sdi-outbound/inesistente.xml')
  `).run(makeThrowawayInvoice(db), `IT03365990591_G${Date.now().toString(36).toUpperCase().slice(-4)}.xml`).lastInsertRowid;

  await assert.rejects(
    () => transmitGeneratedFlow(flowId, { mode: 'production' }),
    /generato in modalita "test" e non puo essere trasmesso in "production"/
  );

  db.prepare("DELETE FROM fatture_sdi_flussi WHERE stato = 'test_guardrail'").run();
  db.prepare("DELETE FROM fatture WHERE note = 'fixture test unicita SDI'").run();
});

test('un invio in produzione richiede sdi.mode impostato su production', async () => {
  const db = require('../src/db/database');
  const flowId = db.prepare(`
    INSERT INTO fatture_sdi_flussi (fattura_id, direzione, modalita, tipo_messaggio, nome_file, stato, xml_path)
    VALUES (?, 'outbound', 'production', 'fattura', ?, 'test_guardrail', '/uploads/sdi-outbound/inesistente.xml')
  `).run(makeThrowawayInvoice(db), `IT03365990591_P${Date.now().toString(36).toUpperCase().slice(-4)}.xml`).lastInsertRowid;

  // Il DB di sviluppo ha sdi.mode = test: l'invio deve fermarsi prima della rete.
  await assert.rejects(
    () => transmitGeneratedFlow(flowId, { mode: 'production' }),
    /sdi\.mode non e impostato su "production"/
  );

  db.prepare("DELETE FROM fatture_sdi_flussi WHERE stato = 'test_guardrail'").run();
  db.prepare("DELETE FROM fatture WHERE note = 'fixture test unicita SDI'").run();
});

// --- Verifica applicativa del certificato client SdI ----------------------

const express = require('express');
const http = require('http');

function startSdiApp() {
  const app = express();
  app.use('/api/sdi', require('../src/routes/sdi'));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function postInbound(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from('<test/>', 'utf8');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/sdi/ws/inbound',
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'text/xml', 'Content-Length': body.length }, headers)
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function setPolicy(value) {
  const db = require('../src/db/database');
  db.prepare(`INSERT INTO app_settings (key, value, type, updated_at) VALUES (?,?,'string',datetime('now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run('sdi.inbound.client_cert_policy', value);
}

test('con policy enforce una chiamata senza certificato client viene rifiutata', async (t) => {
  const { server, port } = await startSdiApp();
  t.after(() => server.close());
  setPolicy('enforce');
  try {
    assert.equal(await postInbound(port), 403);
    // Un certificato valido ma di un altro soggetto non basta.
    assert.equal(await postInbound(port, {
      'X-SSL-Client-Verify': 'SUCCESS',
      'X-SSL-Client-DN': 'CN=Altro Soggetto,O=Terzi'
    }), 403);
  } finally {
    setPolicy('log');
  }
});

test('con policy log la chiamata prosegue anche senza certificato client', async (t) => {
  const { server, port } = await startSdiApp();
  t.after(() => server.close());
  setPolicy('log');
  // 400 = body non SOAP: significa che la richiesta e arrivata al dispatcher.
  assert.equal(await postInbound(port), 400);
});

test('un certificato client SdI valido supera il controllo anche in enforce', async (t) => {
  const { server, port } = await startSdiApp();
  t.after(() => server.close());
  setPolicy('enforce');
  try {
    assert.equal(await postInbound(port, {
      'X-SSL-Client-Verify': 'SUCCESS',
      'X-SSL-Client-DN': 'C=IT,O=Agenzia delle Entrate,OU=Servizi Telematici,CN=Sistema Interscambio Fattura PA'
    }), 400);
  } finally {
    setPolicy('log');
  }
});
