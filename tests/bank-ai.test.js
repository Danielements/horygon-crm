const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpDb = path.join(os.tmpdir(), `horygon-bankai-test-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const ai = require('../src/services/bank-ai-extraction');
const bank = require('../src/services/bank-service');
const db = require('../src/db/database');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
});

// --- unit puri -------------------------------------------------------------

test('toNumber: formati misti', () => {
  assert.equal(ai.toNumber('1.234,56'), 1234.56);
  assert.equal(ai.toNumber('-72,00'), -72);
  assert.equal(ai.toNumber('1234.56'), 1234.56);
  assert.equal(ai.toNumber(12200), 12200);
  assert.equal(ai.toNumber(''), null);
});

test('parseAiJson: estrae JSON anche dentro fences markdown', () => {
  const txt = '```json\n{ "riepilogo": {"uscite": 72, "entrate": 100}, "movimenti": [ {"data":"2026-04-28","importo":-72,"descrizione":"CARTA PIZZERIA"} ] }\n```';
  const r = ai.parseAiJson(txt);
  assert.equal(r.movimenti.length, 1);
  assert.equal(r.movimenti[0].importo, -72);
  assert.equal(r.movimenti[0].data_operazione, '2026-04-28');
  assert.equal(r.riepilogo.uscite, 72);
});

test('verifyAgainstTotals: coerente sui totali reali UniCredit', () => {
  // riepilogo reale: uscite 2364,59 entrate 20006,00 saldo 0 -> 17641,41
  const movimenti = [
    { importo: 5000 }, { importo: 2806 }, { importo: 12200.0 }, // entrate = 20006
    { importo: -72 }, { importo: -340 }, { importo: -110 }, { importo: -54.99 },
    { importo: -58 }, { importo: -38.10 }, { importo: -12 }, { importo: -30 },
    { importo: -1591.75 }, { importo: -57.75 } // uscite = 2364.59
  ];
  const v = ai.verifyAgainstTotals(movimenti, { saldo_iniziale: 0, uscite: 2364.59, entrate: 20006, saldo_finale: 17641.41 });
  assert.equal(v.somma_entrate, 20006);
  assert.equal(v.somma_uscite, 2364.59);
  assert.equal(v.coerente, true);
  assert.equal(v.verifiche.saldo, true);
});

test('verifyAgainstTotals: incoerenza segnalata', () => {
  const v = ai.verifyAgainstTotals([{ importo: -100 }], { uscite: 250, entrate: 0 });
  assert.equal(v.coerente, false);
  assert.equal(v.verifiche.uscite, false);
  assert.equal(v.differenze.uscite, 150);
});

// --- estrazione con adapter finto ------------------------------------------

test('extractBankStatement: usa il callFn iniettato e verifica', async () => {
  const fakeCall = async () => JSON.stringify({
    riepilogo: { saldo_iniziale: 0, uscite: 72, entrate: 0, saldo_finale: -72 },
    movimenti: [{ data: '2026-04-28', importo: -72, descrizione: 'CARTA *3613 MECOJONI PIZZERIA' }]
  });
  const r = await ai.extractBankStatement(Buffer.from('%PDF-1.7 fake'), { callFn: fakeCall });
  assert.equal(r.movimenti.length, 1);
  assert.equal(r.verifica.coerente, true);
});

// --- import dei movimenti estratti (dedup) ---------------------------------

test('importParsedMovements: importa e deduplica', () => {
  const conto = Number(db.prepare("INSERT INTO cont_conti (nome) VALUES ('AI')").run().lastInsertRowid);
  const movimenti = [
    { data_operazione: '2026-04-28', importo: -72, descrizione: 'CARTA MECOJONI' },
    { data_operazione: '2026-06-19', importo: 12200, descrizione: 'BONIFICO QUBE3' }
  ];
  const r1 = bank.importParsedMovements({ conto_id: conto, movimenti, fileName: 'ec.pdf', userId: 1 });
  assert.equal(r1.importate, 2);
  const r2 = bank.importParsedMovements({ conto_id: conto, movimenti, fileName: 'ec.pdf', userId: 1 });
  assert.equal(r2.importate, 0);
  assert.equal(r2.duplicate, 2);
});
