const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const db = require('../src/db/database');
const { signCadesBes, extractCmsCertificates } = require('../src/services/sdi-cades');
const {
  attachSignedFile,
  getDocumentToSign,
  verifySignedFile,
  STATO_FIRMA_RICHIESTA,
  STATO_FIRMA_VERIFICATA
} = require('../src/services/sdi-firma-esterna');
const { transmitGeneratedFlow } = require('../src/services/sdi-transmission');

const ROOT = path.resolve(__dirname, '..');
const XML = '<?xml version="1.0" encoding="UTF-8"?>\n<p:FatturaElettronica versione="FPA12"><x>1</x></p:FatturaElettronica>';

function material() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firma-'));
  const keyPath = path.join(dir, 'k.key');
  const certPath = path.join(dir, 'c.pem');
  try {
    execFileSync('openssl', ['genrsa', '-out', keyPath, '2048'], { stdio: 'ignore' });
    execFileSync('openssl', ['req', '-x509', '-key', keyPath, '-out', certPath, '-days', '2',
      '-subj', '/C=IT/O=Poste Italiane/CN=FURFARI DANIELE'],
    { stdio: 'ignore', env: Object.assign({}, process.env, { MSYS_NO_PATHCONV: '1' }) });
  } catch {
    return null;
  }
  return { dir, keyPath, certPath };
}

function sign(xml, m) {
  return signCadesBes({
    content: Buffer.from(xml, 'utf8'),
    certificatePem: fs.readFileSync(m.certPath),
    privateKeyPem: fs.readFileSync(m.keyPath)
  });
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Crea un flusso in attesa di firma, con l'XML davvero su disco.
function seedFlow(xml = XML) {
  const fattura = db.prepare(`
    INSERT INTO fatture (tenant_id, numero, tipo, data, note)
    VALUES (1, ?, 'emessa', '2026-08-07', 'fixture firma esterna')
  `).run(`FIRMA-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`).lastInsertRowid;

  const dir = path.join(ROOT, 'uploads', 'sdi-outbound', 'test-firma');
  fs.mkdirSync(dir, { recursive: true });
  const hash = sha256(Buffer.from(xml, 'utf8'));
  const file = path.join(dir, `${hash}_IT03365990591_F0001.xml`);
  fs.writeFileSync(file, xml, 'utf8');
  const relative = `/${path.relative(ROOT, file).replace(/\\/g, '/')}`;

  const flowId = db.prepare(`
    INSERT INTO fatture_sdi_flussi
      (fattura_id, direzione, modalita, tipo_messaggio, nome_file, stato, xml_path,
       sdi_xml_sha256, sdi_xml_immutabile_path)
    VALUES (?, 'outbound', 'production', 'fattura', ?, ?, ?, ?, ?)
  `).run(fattura, `IT03365990591_F${Date.now().toString(36).slice(-4).toUpperCase()}.xml`,
    STATO_FIRMA_RICHIESTA, relative, hash, relative).lastInsertRowid;

  return { flowId: Number(flowId), fatturaId: Number(fattura), xmlSha256: hash };
}

function cleanup() {
  db.prepare("DELETE FROM fatture_sdi_flussi WHERE fattura_id IN (SELECT id FROM fatture WHERE note = 'fixture firma esterna')").run();
  db.prepare("DELETE FROM fatture WHERE note = 'fixture firma esterna'").run();
  db.prepare("DELETE FROM audit_log WHERE azione LIKE 'sdi.firma.%'").run();
}

test('il documento da firmare viene consegnato con il nome atteso da SdI', () => {
  cleanup();
  const { flowId, xmlSha256 } = seedFlow();
  const doc = getDocumentToSign(flowId);
  assert.equal(doc.buffer.toString('utf8'), XML);
  assert.equal(doc.xmlSha256, xmlSha256);
  assert.match(doc.signedFilename, /\.xml\.p7m$/);
  cleanup();
});

test('un p7m che contiene lo stesso XML viene accettato', (t) => {
  const m = material();
  if (!m) return t.skip('openssl non disponibile');
  cleanup();
  const { flowId, fatturaId } = seedFlow();

  const result = attachSignedFile({ flowId, signedBuffer: sign(XML, m), filename: 'firmato.xml.p7m' });
  assert.equal(result.stato, STATO_FIRMA_VERIFICATA);
  assert.match(result.filename, /\.p7m$/);
  assert.match(result.signer.subject, /FURFARI DANIELE/);
  assert.ok(result.nonVerificabileInLocale.length, 'va dichiarato cosa resta in capo a SdI');

  const flow = db.prepare('SELECT * FROM fatture_sdi_flussi WHERE id = ?').get(flowId);
  assert.equal(flow.stato, STATO_FIRMA_VERIFICATA);
  assert.equal(flow.firma_applicata, 'CAdES-BES');
  assert.match(flow.xml_path, /\.p7m$/, 'il file da trasmettere e ora il firmato');
  assert.equal(db.prepare('SELECT stato_sdi FROM fatture WHERE id = ?').get(fatturaId).stato_sdi, STATO_FIRMA_VERIFICATA);
  cleanup();
});

test('un p7m che contiene un XML diverso viene rifiutato senza scrivere nulla', (t) => {
  const m = material();
  if (!m) return t.skip('openssl non disponibile');
  cleanup();
  const { flowId } = seedFlow();

  // Lo scenario da impedire: si scarica un documento, se ne firma un altro,
  // e il CRM lo assocerebbe alla fattura sbagliata.
  const alterato = XML.replace('<x>1</x>', '<x>999</x>');
  assert.throws(
    () => attachSignedFile({ flowId, signedBuffer: sign(alterato, m) }),
    (error) => error.code === 'SIGNED_DOCUMENT_MISMATCH'
  );

  const flow = db.prepare('SELECT * FROM fatture_sdi_flussi WHERE id = ?').get(flowId);
  assert.equal(flow.stato, STATO_FIRMA_RICHIESTA, 'il flusso resta in attesa');
  assert.equal(flow.firma_applicata, null);
  const rifiuti = db.prepare("SELECT COUNT(*) n FROM audit_log WHERE azione = 'sdi.firma.rifiutata'").get().n;
  assert.equal(rifiuti, 1, 'il rifiuto deve lasciare traccia in audit');
  cleanup();
});

test('un file che non e un p7m viene rifiutato con un messaggio comprensibile', () => {
  cleanup();
  const { flowId } = seedFlow();
  assert.throws(
    () => attachSignedFile({ flowId, signedBuffer: Buffer.from('<?xml version="1.0"?><x/>') }),
    /non e un P7M leggibile/
  );
  assert.throws(() => attachSignedFile({ flowId, signedBuffer: Buffer.alloc(0) }), /mancante o vuoto/);
  cleanup();
});

test('un certificato di firma scaduto viene bloccato prima dell invio', (t) => {
  const m = material();
  if (!m) return t.skip('openssl non disponibile');
  const p7m = sign(XML, m);
  // Il certificato di prova scade fra due giorni: verificando a data futura
  // deve risultare scaduto, come farebbe SdI con il controllo 00100.
  assert.throws(
    () => verifySignedFile({
      signedBuffer: p7m,
      expectedXmlSha256: sha256(Buffer.from(XML, 'utf8')),
      now: new Date(Date.now() + 10 * 24 * 3600 * 1000)
    }),
    /scaduto/
  );
});

test('un flusso in attesa di firma non puo essere trasmesso', async () => {
  cleanup();
  const { flowId } = seedFlow();
  await assert.rejects(
    () => transmitGeneratedFlow(flowId, { mode: 'production' }),
    /attende il file firmato/
  );
  cleanup();
});

test('non si puo caricare due volte il file firmato', (t) => {
  const m = material();
  if (!m) return t.skip('openssl non disponibile');
  cleanup();
  const { flowId } = seedFlow();
  attachSignedFile({ flowId, signedBuffer: sign(XML, m) });
  assert.throws(() => attachSignedFile({ flowId, signedBuffer: sign(XML, m) }), /gia un file firmato/);
  cleanup();
});

test('i certificati inclusi nel p7m sono estraibili', (t) => {
  const m = material();
  if (!m) return t.skip('openssl non disponibile');
  const certificates = extractCmsCertificates(sign(XML, m));
  assert.equal(certificates.length, 1);
  const parsed = new crypto.X509Certificate(certificates[0]);
  assert.match(parsed.subject, /FURFARI DANIELE/);
});
