const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpDb = path.join(os.tmpdir(), `horygon-gest-test-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const gest = require('../src/services/gestione-service');
const cont = require('../src/services/contabilita-service');
const db = require('../src/db/database');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
});

// --- unit puri -------------------------------------------------------------

test('bucketOf: scaduto/7/30/60/90/oltre/senza', () => {
  assert.equal(gest.bucketOf(-1), 'scaduto');
  assert.equal(gest.bucketOf(0), 'e7');
  assert.equal(gest.bucketOf(7), 'e7');
  assert.equal(gest.bucketOf(8), 'e30');
  assert.equal(gest.bucketOf(30), 'e30');
  assert.equal(gest.bucketOf(61), 'e90');
  assert.equal(gest.bucketOf(120), 'oltre');
  assert.equal(gest.bucketOf(null), 'senza_scadenza');
});

test('daysBetween', () => {
  assert.equal(gest.daysBetween('2026-03-01', '2026-03-08'), 7);
  assert.equal(gest.daysBetween('2026-03-10', '2026-03-01'), -9);
});

test('aggregateCashflow: netto e saldo progressivo', () => {
  const r = gest.aggregateCashflow([
    { mese: '2026-01', importo: 1000 },
    { mese: '2026-01', importo: -400 },
    { mese: '2026-02', importo: -100 }
  ], 500);
  assert.equal(r.length, 2);
  assert.deepEqual({ mese: r[0].mese, netto: r[0].netto, saldo: r[0].saldo }, { mese: '2026-01', netto: 600, saldo: 1100 });
  assert.deepEqual({ mese: r[1].mese, netto: r[1].netto, saldo: r[1].saldo }, { mese: '2026-02', netto: -100, saldo: 1000 });
});

// --- integrazione ----------------------------------------------------------

function insertFattura({ numero, tipo, direzione, totale, data = '2026-03-10', scad }) {
  return Number(db.prepare(`INSERT INTO fatture (numero, tipo, direzione, tipo_documento, data, scadenza, imponibile, iva, totale, stato_pagamento)
    VALUES (?, ?, ?, 'fattura', ?, ?, ?, ?, ?, 'da_pagare')`)
    .run(numero, tipo, direzione, data, scad || null, totale / 1.22, totale - totale / 1.22, totale).lastInsertRowid);
}

test('scadenzario: bucket per residuo e direzione', () => {
  insertFattura({ numero: 'S1', tipo: 'emessa', direzione: 'attiva', totale: 100, scad: '2026-01-01' }); // scaduto @oggi 2026-03-01
  insertFattura({ numero: 'S2', tipo: 'emessa', direzione: 'attiva', totale: 200, scad: '2026-03-05' }); // e7
  insertFattura({ numero: 'S3', tipo: 'ricevuta', direzione: 'passiva', totale: 300, scad: '2026-04-15' }); // e60

  const sc = gest.scadenzario('2026-03-01');
  assert.equal(sc.da_incassare.totali.scaduto, 100);
  assert.equal(sc.da_incassare.totali.e7, 200);
  assert.equal(sc.da_incassare.totale, 300);
  assert.equal(sc.da_pagare.totali.e60, 300);
});

test('prima nota: unisce pagamenti e voci manuali con saldo', () => {
  const f = insertFattura({ numero: 'P1', tipo: 'emessa', direzione: 'attiva', totale: 500 });
  cont.registerPayment({ verso: 'incasso', data: '2026-03-12', importo: 500, allocazioni: [{ fattura_id: f, importo_quota: 500 }] }, 1);
  gest.addNotaManuale({ data: '2026-03-15', descrizione: 'Commissioni banca', verso: 'uscita', importo: 20 }, 1);

  const pn = gest.primaNota({ dal: '2026-03-01', al: '2026-03-31' });
  assert.equal(pn.totali.entrate, 500);
  assert.equal(pn.totali.uscite, 20);
  assert.equal(pn.totali.netto, 480);
  assert.equal(pn.righe[pn.righe.length - 1].saldo, 480);
});

test('anomalie: rileva scaduto e pagamento non allocato', () => {
  insertFattura({ numero: 'A1', tipo: 'emessa', direzione: 'attiva', totale: 999, scad: '2026-01-01' });
  cont.registerPayment({ verso: 'incasso', data: '2026-03-01', importo: 50 }, 1); // non allocato

  const an = gest.anomalie('2026-03-20');
  assert.ok(an.anomalie.some((a) => a.tipo === 'scaduto'));
  assert.ok(an.anomalie.some((a) => a.tipo === 'pagamento_non_allocato'));
  assert.ok(an.totale >= 2);
});
