const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const db = require('../src/db/database');
const { importDocument } = require('../src/services/sdi-import-pipeline');
const {
  classifyDocument,
  detectContentType,
  determineDirection,
  countInvoiceBodies,
  unwrapDocument
} = require('../src/services/sdi-document-classifier');
const { signCadesBes } = require('../src/services/sdi-cades');

const TENANT = 1;
const TENANT_IDS = { vatNumber: '03365990591', taxCode: '03365990591' };

function invoiceXml({ numero = '2026/001', cedente = '03365990591', cessionario = '01043931003', data = '2026-03-15', totale = '122.00' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2">
  <FatturaElettronicaHeader>
    <DatiTrasmissione><ProgressivoInvio>H0001</ProgressivoInvio><FormatoTrasmissione>FPR12</FormatoTrasmissione><CodiceDestinatario>UMZGLCP</CodiceDestinatario></DatiTrasmissione>
    <CedentePrestatore><DatiAnagrafici><IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${cedente}</IdCodice></IdFiscaleIVA><Anagrafica><Denominazione>Cedente Test</Denominazione></Anagrafica></DatiAnagrafici></CedentePrestatore>
    <CessionarioCommittente><DatiAnagrafici><IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${cessionario}</IdCodice></IdFiscaleIVA><Anagrafica><Denominazione>Cliente Test</Denominazione></Anagrafica></DatiAnagrafici></CessionarioCommittente>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali><DatiGeneraliDocumento><TipoDocumento>TD01</TipoDocumento><Divisa>EUR</Divisa><Data>${data}</Data><Numero>${numero}</Numero><ImportoTotaleDocumento>${totale}</ImportoTotaleDocumento></DatiGeneraliDocumento></DatiGenerali>
    <DatiBeniServizi>
      <DettaglioLinee><NumeroLinea>1</NumeroLinea><Descrizione>Fornitura</Descrizione><Quantita>1.00</Quantita><PrezzoUnitario>100.00</PrezzoUnitario><PrezzoTotale>100.00</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA></DettaglioLinee>
      <DatiRiepilogo><AliquotaIVA>22.00</AliquotaIVA><ImponibileImporto>100.00</ImponibileImporto><Imposta>22.00</Imposta></DatiRiepilogo>
    </DatiBeniServizi>
  </FatturaElettronicaBody>
</p:FatturaElettronica>`;
}

function cleanup() {
  db.prepare("DELETE FROM fatture_righe WHERE fattura_id IN (SELECT id FROM fatture WHERE numero LIKE '2026/%' OR numero LIKE 'TESTIMP%')").run();
  db.prepare("DELETE FROM fatture_iva_riepilogo WHERE fattura_id IN (SELECT id FROM fatture WHERE numero LIKE '2026/%' OR numero LIKE 'TESTIMP%')").run();
  db.prepare("DELETE FROM fatture WHERE numero LIKE '2026/%' OR numero LIKE 'TESTIMP%'").run();
  db.prepare("DELETE FROM audit_log WHERE azione LIKE 'SDI_HISTORICAL_%'").run();
}

function importXml(xml, options = {}) {
  return importDocument({
    tenantId: TENANT,
    buffer: Buffer.from(xml, 'utf8'),
    filename: options.filename || 'IT03365990591_H0001.xml',
    tenantIdentifiers: TENANT_IDS,
    ...options
  });
}

// --- classificazione -------------------------------------------------------

test('il formato reale si deduce dai byte, non dall estensione', () => {
  assert.equal(detectContentType(Buffer.from('<?xml version="1.0"?><x/>'), 'documento.p7m'), 'xml');
  assert.equal(detectContentType(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'documento.xml'), 'zip');
  assert.equal(detectContentType(Buffer.from([0x30, 0x82, 0x01, 0x00]), 'documento.xml'), 'p7m');
  assert.equal(detectContentType(Buffer.alloc(0), 'vuoto.xml'), 'empty');
});

test('i tipi di documento SdI vengono riconosciuti dalla radice', () => {
  const cases = [
    ['<FatturaElettronica/>', 'FATTURA'],
    ['<p:FatturaElettronicaSemplificata xmlns:p="x"/>', 'FATTURA_SEMPLIFICATA'],
    ['<RicevutaConsegna/>', 'RICEVUTA_CONSEGNA'],
    ['<NotificaScarto/>', 'NOTIFICA_SCARTO'],
    ['<RicevutaImpossibilitaRecapito/>', 'RICEVUTA_IMPOSSIBILITA_RECAPITO'],
    ['<NotificaDecorrenzaTermini/>', 'NOTIFICA_DECORRENZA_TERMINI'],
    ['<AttestazioneTrasmissioneFattura/>', 'ATTESTAZIONE_TRASMISSIONE'],
    ['<MetadatiInvioFile/>', 'METADATI_INVIO_FILE'],
    ['<QualcosaDiIgnoto/>', 'UNKNOWN']
  ];
  cases.forEach(([xml, expected]) => {
    assert.equal(classifyDocument(Buffer.from(xml)).type, expected, xml);
  });
});

test('la direzione si deduce dal confronto con gli identificativi del tenant', () => {
  const emessa = determineDirection(invoiceXml({ cedente: '03365990591', cessionario: '01043931003' }), TENANT_IDS);
  assert.equal(emessa.direction, 'OUTGOING');

  const ricevuta = determineDirection(invoiceXml({ cedente: '01043931003', cessionario: '03365990591' }), TENANT_IDS);
  assert.equal(ricevuta.direction, 'INCOMING');

  const estranea = determineDirection(invoiceXml({ cedente: '11111111111', cessionario: '22222222222' }), TENANT_IDS);
  assert.equal(estranea.direction, 'UNKNOWN');
  assert.match(estranea.reason, /ne come cedente ne come cessionario/);

  const auto = determineDirection(invoiceXml({ cedente: '03365990591', cessionario: '03365990591' }), TENANT_IDS);
  assert.equal(auto.direction, 'OUTGOING');
});

test('i lotti con piu corpi fattura vengono contati', () => {
  assert.equal(countInvoiceBodies(invoiceXml()), 1);
  const lotto = invoiceXml().replace('</p:FatturaElettronica>', '<FatturaElettronicaBody/></p:FatturaElettronica>');
  assert.equal(countInvoiceBodies(lotto), 2);
});

// --- import ---------------------------------------------------------------

test('una fattura storica viene importata e non e piu trasmissibile', () => {
  cleanup();
  const result = importXml(invoiceXml({ numero: '2026/001' }));
  assert.equal(result.outcome, 'IMPORTED');
  assert.equal(result.direction, 'OUTGOING');

  const row = db.prepare('SELECT * FROM fatture WHERE id = ?').get(result.fatturaId);
  assert.equal(row.source, 'SDI_HISTORICAL_SYNC');
  assert.equal(row.sdi_send_allowed, 0, 'una fattura storica non deve essere ritrasmettibile');
  assert.equal(row.tenant_id, TENANT);
  assert.equal(row.direzione, 'attiva');
  assert.ok(row.original_sha256);
  assert.ok(row.original_file_path);

  const righe = db.prepare('SELECT COUNT(*) n FROM fatture_righe WHERE fattura_id = ?').get(result.fatturaId).n;
  const riepiloghi = db.prepare('SELECT COUNT(*) n FROM fatture_iva_riepilogo WHERE fattura_id = ?').get(result.fatturaId).n;
  assert.equal(righe, 1);
  assert.equal(riepiloghi, 1);
  cleanup();
});

test('lo stesso documento importato due volte non crea duplicati', () => {
  cleanup();
  const xml = invoiceXml({ numero: '2026/002' });
  const first = importXml(xml);
  const second = importXml(xml);
  assert.equal(first.outcome, 'IMPORTED');
  assert.equal(second.outcome, 'DUPLICATE');
  assert.equal(second.fatturaId, first.fatturaId);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM fatture WHERE numero = '2026/002'").get().n, 1);
  cleanup();
});

test('lo stesso documento con nome file diverso resta un duplicato', () => {
  cleanup();
  const xml = invoiceXml({ numero: '2026/003' });
  importXml(xml, { filename: 'IT03365990591_AAAAA.xml' });
  const second = importXml(xml, { filename: 'IT03365990591_BBBBB.xml' });
  assert.equal(second.outcome, 'DUPLICATE');
  assert.equal(second.dedupLevel, 'ORIGINAL_SHA256', 'il nome file non e la chiave');
  cleanup();
});

test('la versione firmata e quella in chiaro dello stesso documento non si duplicano', (t) => {
  cleanup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-'));
  const keyPath = path.join(dir, 'k.key');
  const certPath = path.join(dir, 'c.pem');
  try {
    execFileSync('openssl', ['genrsa', '-out', keyPath, '2048'], { stdio: 'ignore' });
    execFileSync('openssl', ['req', '-x509', '-key', keyPath, '-out', certPath, '-days', '2', '-subj', '/C=IT/O=T/CN=T'],
      { stdio: 'ignore', env: Object.assign({}, process.env, { MSYS_NO_PATHCONV: '1' }) });
  } catch {
    cleanup();
    return t.skip('openssl non disponibile');
  }

  const xml = invoiceXml({ numero: '2026/004' });
  const p7m = signCadesBes({
    content: Buffer.from(xml, 'utf8'),
    certificatePem: fs.readFileSync(certPath),
    privateKeyPem: fs.readFileSync(keyPath)
  });

  const signed = importDocument({
    tenantId: TENANT, buffer: p7m, filename: 'IT03365990591_H0004.xml.p7m', tenantIdentifiers: TENANT_IDS
  });
  assert.equal(signed.outcome, 'IMPORTED');

  const plain = importXml(xml, { filename: 'IT03365990591_H0004.xml' });
  assert.equal(plain.outcome, 'DUPLICATE', 'il p7m e il suo XML sono lo stesso documento');
  assert.equal(plain.fatturaId, signed.fatturaId);
  cleanup();
});

test('lo storico arricchisce una fattura gia presente nel CRM invece di duplicarla', () => {
  cleanup();
  const inserted = db.prepare(`
    INSERT INTO fatture (tenant_id, numero, numero_documento, tipo, direzione, data, totale, source, sdi_send_allowed)
    VALUES (?, '2026/005', '2026/005', 'emessa', 'attiva', '2026-03-15', 122, 'CRM', 1)
  `).run(TENANT);
  const existingId = Number(inserted.lastInsertRowid);
  db.prepare('UPDATE fatture SET original_filename = ? WHERE id = ?').run('IT03365990591_H0005.xml', existingId);

  const result = importXml(invoiceXml({ numero: '2026/005' }), { filename: 'IT03365990591_H0005.xml' });
  assert.equal(result.outcome, 'DUPLICATE');
  assert.equal(result.fatturaId, existingId);
  assert.equal(result.enriched, true);

  const row = db.prepare('SELECT * FROM fatture WHERE id = ?').get(existingId);
  assert.equal(row.source, 'CRM', 'la provenienza originale non viene sovrascritta');
  assert.equal(row.original_sha256 !== null, true, 'lo storico ha aggiunto l hash del file originale');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM fatture WHERE numero = '2026/005'").get().n, 1);
  cleanup();
});

test('in dry-run non viene scritto nulla', () => {
  cleanup();
  const result = importXml(invoiceXml({ numero: '2026/006' }), { dryRun: true });
  assert.equal(result.outcome, 'WOULD_IMPORT');
  assert.equal(result.direction, 'OUTGOING');
  assert.equal(result.numero, '2026/006');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM fatture WHERE numero = '2026/006'").get().n, 0);
  cleanup();
});

test('notifiche, tipi sconosciuti e contenuti non XML non bloccano il job', () => {
  cleanup();
  const notifica = importXml('<?xml version="1.0"?><RicevutaConsegna><IdentificativoSdI>123</IdentificativoSdI></RicevutaConsegna>');
  assert.equal(notifica.outcome, 'NOTIFICATION');
  assert.equal(notifica.documentType, 'RICEVUTA_CONSEGNA');

  const ignoto = importXml('<?xml version="1.0"?><DocumentoMisterioso/>');
  assert.equal(ignoto.outcome, 'UNKNOWN');

  const binario = importDocument({
    tenantId: TENANT, buffer: Buffer.from([0x00, 0x01, 0x02, 0x03]), filename: 'strano.bin', tenantIdentifiers: TENANT_IDS
  });
  assert.equal(binario.outcome, 'STORED_NON_XML');
  cleanup();
});

test('un lotto viene segnalato e non importato come fattura singola', () => {
  cleanup();
  const lotto = invoiceXml({ numero: '2026/007' }).replace('</p:FatturaElettronica>', '<FatturaElettronicaBody/></p:FatturaElettronica>');
  const result = importXml(lotto);
  assert.equal(result.outcome, 'LOTTO');
  assert.equal(result.bodies, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM fatture WHERE numero = '2026/007'").get().n, 0);
  cleanup();
});

test('una fattura di terzi viene marcata UNKNOWN per riconciliazione manuale', () => {
  cleanup();
  const result = importXml(invoiceXml({ numero: '2026/008', cedente: '11111111111', cessionario: '22222222222' }));
  assert.equal(result.outcome, 'IMPORTED');
  assert.equal(result.direction, 'UNKNOWN');
  const row = db.prepare('SELECT direzione FROM fatture WHERE id = ?').get(result.fatturaId);
  assert.equal(row.direzione, 'sconosciuta');
  cleanup();
});

test('un XML corrotto non solleva ma viene classificato', () => {
  cleanup();
  const result = importXml('<?xml version="1.0"?><FatturaElettronica><rotto>');
  assert.ok(['IMPORTED', 'FAILED', 'UNKNOWN'].includes(result.outcome), `outcome inatteso: ${result.outcome}`);
  cleanup();
});

test('un p7m corrotto viene archiviato senza interrompere', () => {
  cleanup();
  const finto = Buffer.concat([Buffer.from([0x30, 0x82, 0x01, 0x00]), Buffer.alloc(60, 0xff)]);
  const result = importDocument({
    tenantId: TENANT, buffer: finto, filename: 'corrotto.xml.p7m', tenantIdentifiers: TENANT_IDS
  });
  assert.equal(result.outcome, 'STORED_NON_XML');
  assert.ok(result.note);
  cleanup();
});

test('l import produce audit', () => {
  cleanup();
  importXml(invoiceXml({ numero: '2026/009' }));
  importXml(invoiceXml({ numero: '2026/009' }));
  const imported = db.prepare("SELECT COUNT(*) n FROM audit_log WHERE azione = 'SDI_HISTORICAL_DOCUMENT_IMPORTED'").get().n;
  const duplicates = db.prepare("SELECT COUNT(*) n FROM audit_log WHERE azione = 'SDI_HISTORICAL_DUPLICATE_FOUND'").get().n;
  assert.equal(imported, 1);
  assert.equal(duplicates, 1);
  cleanup();
});

test('il p7m originale non viene mai sostituito dall XML estratto', () => {
  const xml = Buffer.from(invoiceXml({ numero: '2026/010' }), 'utf8');
  const unwrapped = unwrapDocument(xml, 'IT03365990591_H0010.xml');
  assert.equal(unwrapped.signed, false);
  assert.deepEqual(unwrapped.original, xml);
  assert.deepEqual(unwrapped.xml, xml);
});
