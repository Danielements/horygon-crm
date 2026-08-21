const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpDb = path.join(os.tmpdir(), `horygon-spese-test-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const spese = require('../src/services/spese-service');
const gest = require('../src/services/gestione-service');
const db = require('../src/db/database');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
});

// --- unit puri -------------------------------------------------------------

test('sniffFileType: riconosce JPG/PNG/PDF, rifiuta il resto', () => {
  assert.equal(spese.sniffFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(spese.sniffFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), 'image/png');
  assert.equal(spese.sniffFileType(Buffer.from('%PDF-1.7 rest padding', 'ascii')), 'application/pdf');
  assert.equal(spese.sniffFileType(Buffer.from('MZ eseguibile windows!!', 'ascii')), null);
});

test('validateSpesa: totale obbligatorio, coerenza imponibile+iva', () => {
  assert.equal(spese.validateSpesa({ totale: 0 }).ok, false);
  assert.equal(spese.validateSpesa({ totale: 122 }).ok, true);
  assert.equal(spese.validateSpesa({ totale: 122, imponibile: 100, iva: 22 }).ok, true);
  assert.equal(spese.validateSpesa({ totale: 122, imponibile: 100, iva: 10 }).ok, false); // 110 != 122
});

// --- integrazione ----------------------------------------------------------

test('createSpesa manuale + listSpese', () => {
  const r = spese.createSpesa({ data: '2026-08-10', fornitore_nome: 'Autogrill', totale: 15.5, metodo_pagamento: 'contanti' }, null, 1);
  assert.ok(r.id > 0);
  const list = spese.listSpese({});
  assert.ok(list.some((s) => s.id === r.id && s.fornitore_nome === 'Autogrill'));
});

test('saveDocumento: rifiuta un file non ammesso (magic bytes)', () => {
  const p = path.join(os.tmpdir(), `bad-${process.pid}.bin`);
  fs.writeFileSync(p, Buffer.from('MZ not an image', 'ascii'));
  assert.throws(() => spese.saveDocumento({ path: p, originalname: 'x.jpg' }, 1));
  fs.unlinkSync(p);
});

test('saveDocumento: accetta un PNG e collega la spesa', () => {
  const p = path.join(os.tmpdir(), `ok-${process.pid}.png`);
  fs.writeFileSync(p, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]));
  const doc = spese.saveDocumento({ path: p, originalname: 'ricevuta.png' }, 1);
  assert.equal(doc.mime, 'image/png');
  assert.ok(doc.sha256.length === 64);
  const s = spese.createSpesa({ data: '2026-08-11', fornitore_nome: 'Ferramenta', totale: 40 }, doc.id, 1);
  const row = spese.listSpese({}).find((x) => x.id === s.id);
  assert.equal(row.documento_id, doc.id);
  assert.equal(row.documento_nome, 'ricevuta.png');
  fs.unlinkSync(p);
});

test('le spese confermate entrano in prima nota come uscite', () => {
  spese.createSpesa({ data: '2026-09-05', fornitore_nome: 'Cancelleria', totale: 33.33 }, null, 1);
  const pn = gest.primaNota({ dal: '2026-09-01', al: '2026-09-30' });
  const riga = pn.righe.find((r) => r.fonte === 'spesa' && r.uscita === 33.33);
  assert.ok(riga, 'la spesa deve comparire in prima nota');
  assert.equal(pn.totali.uscite, 33.33);
});
