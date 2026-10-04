const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpDb = path.join(os.tmpdir(), `horygon-musaabb-test-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const abb = require('../src/services/musa-abbonamenti-service');
const db = require('../src/db/database');

test.after(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch {} } });

const FASCE = [
  { id: 1, nome: 'MUSA BASIC', min_isbn: 1, max_isbn: 8, prezzo_mese: 4.90, gratis: 0, attiva: 1 },
  { id: 2, nome: 'MUSA PRO', min_isbn: 9, max_isbn: 24, prezzo_mese: 12.90, gratis: 0, attiva: 1 },
  { id: 3, nome: 'MUSA PREMIUM', min_isbn: 25, max_isbn: 100, prezzo_mese: 24.90, gratis: 0, attiva: 1 },
  { id: 4, nome: 'MUSA ENTERPRISE', min_isbn: 101, max_isbn: 400, prezzo_mese: 42.90, gratis: 0, attiva: 1 },
  { id: 5, nome: 'MUSA UNLIMITED', min_isbn: 401, max_isbn: null, prezzo_mese: 0, gratis: 1, min_approvati_perc: 20, attiva: 1 }
];

// --- puri ------------------------------------------------------------------

test('pickFascia: estremi di fascia inclusi', () => {
  assert.equal(abb.pickFascia(0, 0, FASCE), null);
  assert.equal(abb.pickFascia(8, 0, FASCE).nome, 'MUSA BASIC');
  assert.equal(abb.pickFascia(9, 0, FASCE).nome, 'MUSA PRO');
  assert.equal(abb.pickFascia(24, 0, FASCE).nome, 'MUSA PRO');
  assert.equal(abb.pickFascia(25, 0, FASCE).nome, 'MUSA PREMIUM');
  assert.equal(abb.pickFascia(100, 0, FASCE).nome, 'MUSA PREMIUM');
  assert.equal(abb.pickFascia(101, 0, FASCE).nome, 'MUSA ENTERPRISE');
  assert.equal(abb.pickFascia(400, 0, FASCE).nome, 'MUSA ENTERPRISE');
});

test('pickFascia: oltre 400 gratis solo con >=20% approvati, altrimenti ENTERPRISE', () => {
  const gratis = abb.pickFascia(420, 25, FASCE);
  assert.equal(gratis.gratis, true);
  assert.equal(gratis.prezzo_mese, 0);
  assert.equal(gratis.qualificata_gratis, true);

  const nonQualificato = abb.pickFascia(420, 10, FASCE);
  assert.equal(nonQualificato.gratis, false);
  assert.equal(nonQualificato.prezzo_mese, 42.90);     // fallback ENTERPRISE
  assert.equal(nonQualificato.fallback, true);
});

test('daysInMonth', () => {
  assert.equal(abb.daysInMonth('2026-02-10'), 28);
  assert.equal(abb.daysInMonth('2026-03-01'), 31);
  assert.equal(abb.daysInMonth('2024-02-01'), 29);     // bisestile
});

test('countsOnDay: presenza e approvati rispettano le date', () => {
  const rec = [
    { isbn: 'a', inserito_il: '2026-01-10', rimosso_il: null, approvato: 1, approvato_il: '2026-01-20' },
    { isbn: 'b', inserito_il: '2026-02-01', rimosso_il: '2026-02-15', approvato: 0 }
  ];
  assert.deepEqual(abb.countsOnDay(rec, '2026-01-09'), { present: 0, approved: 0 });
  assert.deepEqual(abb.countsOnDay(rec, '2026-01-15'), { present: 1, approved: 0 }); // non ancora approvato
  assert.deepEqual(abb.countsOnDay(rec, '2026-01-20'), { present: 1, approved: 1 });
  assert.deepEqual(abb.countsOnDay(rec, '2026-02-10'), { present: 2, approved: 1 });
  assert.deepEqual(abb.countsOnDay(rec, '2026-02-15'), { present: 1, approved: 1 }); // 'b' rimosso dal giorno stesso
});

test('ESEMPIO: BASIC 8 ISBN, 9o inserito il 1 marzo -> trimestre = 4,90+4,90+12,90 = 22,70', () => {
  const rec = [];
  for (let i = 0; i < 8; i++) rec.push({ isbn: `base${i}`, inserito_il: '2025-12-01', rimosso_il: null, approvato: 0 });
  rec.push({ isbn: 'nono', inserito_il: '2026-03-01', rimosso_il: null, approvato: 0 });
  const r = abb.computePeriodo(rec, '2026-01-01', '2026-03-31', FASCE);
  assert.equal(r.dovuto, 22.70);
  assert.equal(r.giorni_per_fascia['MUSA BASIC'].giorni, 59);  // gen 31 + feb 28
  assert.equal(r.giorni_per_fascia['MUSA PRO'].giorni, 31);    // marzo
  // gli importi per fascia devono sommare al dovuto (niente deriva di arrotondamento)
  assert.equal(r.giorni_per_fascia['MUSA BASIC'].importo, 9.80);
  assert.equal(r.giorni_per_fascia['MUSA PRO'].importo, 12.90);
  const somma = abb.round2(Object.values(r.giorni_per_fascia).reduce((s, x) => s + x.importo, 0));
  assert.equal(somma, r.dovuto);
});

test('ESEMPIO discesa: 9o rimosso a meta marzo torna a BASIC per i giorni restanti', () => {
  const rec = [];
  for (let i = 0; i < 8; i++) rec.push({ isbn: `base${i}`, inserito_il: '2025-12-01', rimosso_il: null, approvato: 0 });
  rec.push({ isbn: 'nono', inserito_il: '2026-03-01', rimosso_il: '2026-03-16', approvato: 0 });
  const r = abb.computePeriodo(rec, '2026-01-01', '2026-03-31', FASCE);
  // gen+feb BASIC = 9,80; mar: 15gg PRO (1-15) + 16gg BASIC (16-31)
  const atteso = abb.round2(4.90 + 4.90 + 15 * 12.90 / 31 + 16 * 4.90 / 31);
  assert.equal(r.dovuto, atteso);
  assert.ok(r.dovuto > 9.80 && r.dovuto < 22.70);
});

// --- integrazione (fasce auto-seedate su DB fresco) ------------------------

test('fasce seedate all\'avvio e calcolaTrimestre legge dal DB', () => {
  const fasce = abb.listFasce();
  assert.equal(fasce.length, 5);
  assert.equal(fasce[0].nome, 'MUSA BASIC');

  const e = Number(db.prepare("INSERT INTO musa_editori (nome) VALUES ('Editore X')").run().lastInsertRowid);
  for (let i = 0; i < 8; i++) abb.upsertIsbn(e, { isbn: `x${i}`, inserito_il: '2025-12-01' });
  abb.upsertIsbn(e, { isbn: 'x-nono', inserito_il: '2026-03-01' });
  const calc = abb.calcolaTrimestre(e, 2026, 1);
  assert.equal(calc.dovuto, 22.70);
  assert.equal(calc.credito_disponibile, 0);
  assert.equal(calc.importo_netto, 22.70);
});
