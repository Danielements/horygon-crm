const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpDb = path.join(os.tmpdir(), `horygon-comm-test-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const { buildZip } = require('../src/services/zip-store');
const { readZip } = require('../src/services/safe-zip-reader');
const commercialista = require('../src/services/commercialista-service');
const spese = require('../src/services/spese-service');
const db = require('../src/db/database');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
});

// --- zip-store round-trip --------------------------------------------------

test('buildZip: archivio valido, rileggibile da yauzl con contenuti intatti', async () => {
  const buf = buildZip([
    { name: 'a.txt', data: Buffer.from('ciao mondo', 'utf8') },
    { name: 'cartella/b.csv', data: Buffer.from('x;y\r\n1;2', 'utf8') }
  ]);
  const p = path.join(os.tmpdir(), `ztest-${process.pid}.zip`);
  fs.writeFileSync(p, buf);
  const { entries } = await readZip(p);
  const byName = Object.fromEntries(entries.map((e) => [e.name, e.buffer.toString('utf8')]));
  assert.equal(byName['a.txt'], 'ciao mondo');
  assert.equal(byName['cartella/b.csv'], 'x;y\r\n1;2');
  fs.unlinkSync(p);
});

// --- checklist stato mese --------------------------------------------------

test('statoMese: segnala spese non classificate e pagamenti non allocati', () => {
  db.prepare(`INSERT INTO fatture (numero, tipo, direzione, data, imponibile, iva, totale)
    VALUES ('C1','emessa','attiva','2026-07-10', 100, 22, 122)`).run();
  spese.createSpesa({ data: '2026-07-15', fornitore_nome: 'Bar', totale: 5 }, null, 1); // senza categoria

  const stato = commercialista.statoMese('2026-07');
  const spesaVoce = stato.voci.find((v) => v.chiave === 'spese_non_classificate');
  assert.equal(spesaVoce.esito, 'warn');
  assert.equal(spesaVoce.count, 1);
  assert.equal(stato.pronto, false);
});

test('statoMese: mese pulito risulta pronto', () => {
  const stato = commercialista.statoMese('2020-01'); // periodo vuoto
  assert.equal(stato.pronto, true);
  assert.ok(stato.voci.every((v) => v.esito === 'ok'));
});

// --- export ZIP ------------------------------------------------------------

test('buildExport: include riepiloghi CSV del periodo', async () => {
  db.prepare(`INSERT INTO fatture (numero, tipo, direzione, data, imponibile, iva, totale)
    VALUES ('E1','emessa','attiva','2026-06-05', 200, 44, 244)`).run();
  const exp = commercialista.buildExport('2026-06');
  assert.ok(exp.filename.endsWith('.zip'));
  assert.equal(exp.conteggi.fatture, 1);

  const p = path.join(os.tmpdir(), `exp-${process.pid}.zip`);
  fs.writeFileSync(p, exp.buffer);
  const { entries } = await readZip(p);
  const names = entries.map((e) => e.name);
  assert.ok(names.includes('riepilogo-fatture.csv'));
  assert.ok(names.includes('riepilogo-spese.csv'));
  const fatt = entries.find((e) => e.name === 'riepilogo-fatture.csv').buffer.toString('utf8');
  assert.ok(fatt.includes('E1'));
  fs.unlinkSync(p);
});
