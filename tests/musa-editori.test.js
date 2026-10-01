const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpDb = path.join(os.tmpdir(), `horygon-musaed-test-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const ed = require('../src/services/musa-editori-service');
const db = require('../src/db/database');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
});

const SCAGLIONI = [
  { min_libri: 1, max_libri: 8, prezzo: 9, attiva: 1 },
  { min_libri: 9, max_libri: 25, prezzo: 25, attiva: 1 },
  { min_libri: 26, max_libri: null, prezzo: 50, attiva: 1 }
];

// --- puro: scaglioni -------------------------------------------------------

test('pickTariffa: trova lo scaglione giusto, estremi inclusi', () => {
  assert.equal(ed.pickTariffa(1, SCAGLIONI).prezzo, 9);
  assert.equal(ed.pickTariffa(8, SCAGLIONI).prezzo, 9);
  assert.equal(ed.pickTariffa(9, SCAGLIONI).prezzo, 25);
  assert.equal(ed.pickTariffa(25, SCAGLIONI).prezzo, 25);
  assert.equal(ed.pickTariffa(26, SCAGLIONI).prezzo, 50);     // oltre, max null
  assert.equal(ed.pickTariffa(1000, SCAGLIONI).prezzo, 50);
  assert.equal(ed.pickTariffa(0, SCAGLIONI), null);           // sotto il minimo
});

test('computePrezzo: 0 se nessuno scaglione copre il conteggio', () => {
  assert.equal(ed.computePrezzo(5, SCAGLIONI).prezzo, 9);
  assert.equal(ed.computePrezzo(0, SCAGLIONI).prezzo, 0);
});

// --- integrazione ----------------------------------------------------------

function seedTariffe() { SCAGLIONI.forEach((t) => ed.createTariffa(t)); }

test('conteggio: prezzo sugli APPROVATI, fotografato nello storico', () => {
  seedTariffe();
  const e = ed.createEditore({ nome: 'Editore Alfa', email: 'a@ed.it' });
  // 15 approvati -> scaglione 9-25 -> 25€ (i caricati non contano per il prezzo)
  const c = ed.upsertConteggio({ editore_id: e.id, periodo: '2026-08', caricati: 40, approvati: 15, fonte: 'portale' });
  assert.equal(c.approvati, 15);
  assert.equal(c.prezzo_calcolato, 25);

  // upsert sullo stesso mese aggiorna (no duplicati)
  const c2 = ed.upsertConteggio({ editore_id: e.id, periodo: '2026-08', caricati: 40, approvati: 3, fonte: 'manuale' });
  assert.equal(c2.prezzo_calcolato, 9);
  assert.equal(ed.storicoEditore(e.id).length, 1);

  // cambiando la tariffa DOPO, lo storico gia salvato non cambia da solo
  const tariffe = ed.listTariffe();
  ed.updateTariffa(tariffe[0].id, { prezzo: 99 });
  assert.equal(ed.getConteggio(e.id, '2026-08').prezzo_calcolato, 9); // ancora 9
  // ri-upsert ricalcola col nuovo prezzo
  const c3 = ed.upsertConteggio({ editore_id: e.id, periodo: '2026-08', caricati: 40, approvati: 3 });
  assert.equal(c3.prezzo_calcolato, 99);
});

test('vistaMensile: include tutti gli editori attivi, anche a zero', () => {
  const e2 = ed.createEditore({ nome: 'Editore Beta' });
  const vista = ed.vistaMensile('2026-09'); // mese senza conteggi
  const beta = vista.find((v) => v.editore_id === e2.id);
  assert.ok(beta);
  assert.equal(beta.approvati, 0);
  assert.equal(beta.prezzo, 0);
  assert.equal(beta.registrato, false);
});
