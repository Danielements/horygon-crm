const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpDb = path.join(os.tmpdir(), `horygon-bank-test-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const bank = require('../src/services/bank-service');
const cont = require('../src/services/contabilita-service');
const db = require('../src/db/database');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
});

// --- unit puri -------------------------------------------------------------

test('parseAmount: formato italiano e con punto decimale', () => {
  assert.equal(bank.parseAmount('1.234,56'), 1234.56);
  assert.equal(bank.parseAmount('-1.234,56'), -1234.56);
  assert.equal(bank.parseAmount('1234.56', '.'), 1234.56);
  assert.equal(bank.parseAmount('1.234,56-'), -1234.56);
  assert.equal(bank.parseAmount('€ 50,00'), 50);
  assert.equal(bank.parseAmount(''), null);
});

test('parseDate: vari formati verso ISO', () => {
  assert.equal(bank.parseDate('15/03/2026'), '2026-03-15');
  assert.equal(bank.parseDate('2026-03-15'), '2026-03-15');
  assert.equal(bank.parseDate('15.03.2026'), '2026-03-15');
  assert.equal(bank.parseDate(new Date(2026, 2, 15)), '2026-03-15');
  assert.equal(bank.parseDate('boh'), null);
});

test('normalizeMovement: importo unico con segno', () => {
  const tpl = { mapping: { data_operazione: 'Data', importo: 'Importo', descrizione: 'Causale' }, decimale: ',' };
  const m = bank.normalizeMovement({ Data: '10/03/2026', Importo: '-120,50', Causale: 'Bonifico ACME' }, tpl);
  assert.equal(m.data_operazione, '2026-03-10');
  assert.equal(m.importo, -120.5);
  assert.equal(m.segno, -1);
  assert.equal(m.descrizione, 'Bonifico ACME');
});

test('normalizeMovement: colonne entrata/uscita separate', () => {
  const tpl = { mapping: { data_operazione: 'Data', entrata: 'Avere', uscita: 'Dare' }, decimale: ',' };
  const entra = bank.normalizeMovement({ Data: '10/03/2026', Avere: '500,00', Dare: '' }, tpl);
  assert.equal(entra.importo, 500);
  assert.equal(entra.segno, 1);
  const esce = bank.normalizeMovement({ Data: '10/03/2026', Avere: '', Dare: '200,00' }, tpl);
  assert.equal(esce.importo, -200);
  assert.equal(esce.segno, -1);
});

test('computeFingerprint: stabile e sensibile al conto', () => {
  const m = { data_operazione: '2026-03-10', importo: -120.5, descrizione: 'Bonifico ACME', trn: 'T1' };
  const a = bank.computeFingerprint(1, m);
  assert.equal(a, bank.computeFingerprint(1, m));           // stabile
  assert.notEqual(a, bank.computeFingerprint(2, m));        // conto diverso
});

test('matchScore: importo esatto + numero in descrizione vince', () => {
  const mov = { importo: 122, descrizione: 'Pagamento fattura 45/2026 ACME SRL', controparte: '', data_operazione: '2026-03-20' };
  const buona = bank.matchScore(mov, { numero: '45/2026', totale: 122, residuo: 122, controparte: 'ACME SRL', scadenza: '2026-03-31' });
  const scarsa = bank.matchScore(mov, { numero: '99/2026', totale: 500, residuo: 500, controparte: 'BETA SPA', scadenza: '2026-01-01' });
  assert.ok(buona > 0.7);
  assert.ok(buona > scarsa);
});

test('expectedDirection: segno -> direzione fattura', () => {
  assert.equal(bank.expectedDirection(1), 'attiva');
  assert.equal(bank.expectedDirection(-1), 'passiva');
});

// --- integrazione DB -------------------------------------------------------

function insertFattura({ numero, tipo, direzione, totale, data = '2026-03-10', scad = '2026-03-31' }) {
  return Number(db.prepare(`INSERT INTO fatture (numero, tipo, direzione, tipo_documento, data, scadenza, imponibile, iva, totale, stato_pagamento)
    VALUES (?, ?, ?, 'fattura', ?, ?, ?, ?, ?, 'da_pagare')`)
    .run(numero, tipo, direzione, data, scad, totale / 1.22, totale - totale / 1.22, totale).lastInsertRowid);
}

test('import: idempotente (ricaricare lo stesso estratto non duplica)', () => {
  const conto = Number(db.prepare("INSERT INTO cont_conti (nome) VALUES ('Conto Test')").run().lastInsertRowid);
  const tpl = { mapping: { data_operazione: 'Data', importo: 'Importo', descrizione: 'Causale' }, decimale: ',' };
  const rows = [
    { Data: '10/03/2026', Importo: '500,00', Causale: 'Incasso A' },
    { Data: '11/03/2026', Importo: '-120,00', Causale: 'Pagamento B' }
  ];
  const r1 = bank.importMovements({ conto_id: conto, template: tpl, rows, fileName: 'ec.csv', userId: 1 });
  assert.equal(r1.importate, 2);
  assert.equal(r1.duplicate, 0);
  const r2 = bank.importMovements({ conto_id: conto, template: tpl, rows, fileName: 'ec.csv', userId: 1 });
  assert.equal(r2.importate, 0);
  assert.equal(r2.duplicate, 2);
});

test('riconciliazione 1:1 -> fattura PAID e movimento riconciliato', () => {
  const conto = Number(db.prepare("INSERT INTO cont_conti (nome) VALUES ('C2')").run().lastInsertRowid);
  const f = insertFattura({ numero: '45/2026', tipo: 'emessa', direzione: 'attiva', totale: 122 });
  bank.importMovements({ conto_id: conto, template: { mapping: { data_operazione: 'Data', importo: 'Importo', descrizione: 'Causale' } },
    rows: [{ Data: '20/03/2026', Importo: '122,00', Causale: 'Bonifico fattura 45/2026' }], userId: 1 });
  const mov = bank.listMovimenti({ conto_id: conto })[0];

  const cand = bank.reconciliationCandidates(mov.id);
  assert.ok(cand.length >= 1);
  assert.equal(cand[0].id, f);

  const r = bank.reconcile(mov.id, [{ fattura_id: f, importo_quota: 122 }], 1);
  assert.equal(r.stato, 'riconciliato');
  assert.equal(cont.recomputeInvoicePaymentStatus(f).status, 'PAID');
});

test('acconto: movimento interamente allocato e riconciliato, fattura PARTIALLY_PAID', () => {
  // Un movimento da 400 tutto assegnato e' "riconciliato" dal lato movimento;
  // la fattura da 1000 resta parzialmente pagata (concetti distinti).
  const conto = Number(db.prepare("INSERT INTO cont_conti (nome) VALUES ('C3')").run().lastInsertRowid);
  const f = insertFattura({ numero: '46/2026', tipo: 'emessa', direzione: 'attiva', totale: 1000 });
  bank.importMovements({ conto_id: conto, template: { mapping: { data_operazione: 'Data', importo: 'Importo', descrizione: 'Causale' } },
    rows: [{ Data: '20/03/2026', Importo: '400,00', Causale: 'Acconto 46/2026' }], userId: 1 });
  const mov = bank.listMovimenti({ conto_id: conto })[0];
  const r = bank.reconcile(mov.id, [{ fattura_id: f, importo_quota: 400 }], 1);
  assert.equal(r.stato, 'riconciliato');
  assert.equal(cont.recomputeInvoicePaymentStatus(f).status, 'PARTIALLY_PAID');
});

test('movimento sotto-allocato -> stato parziale', () => {
  // Movimento da 400 ma solo 300 assegnati a fatture: il movimento resta parziale.
  const conto = Number(db.prepare("INSERT INTO cont_conti (nome) VALUES ('C3b')").run().lastInsertRowid);
  const f = insertFattura({ numero: '46b/2026', tipo: 'emessa', direzione: 'attiva', totale: 300 });
  bank.importMovements({ conto_id: conto, template: { mapping: { data_operazione: 'Data', importo: 'Importo', descrizione: 'Causale' } },
    rows: [{ Data: '20/03/2026', Importo: '400,00', Causale: 'Bonifico cumulativo' }], userId: 1 });
  const mov = bank.listMovimenti({ conto_id: conto })[0];
  const r = bank.reconcile(mov.id, [{ fattura_id: f, importo_quota: 300 }], 1);
  assert.equal(r.stato, 'parziale');
  assert.equal(cont.recomputeInvoicePaymentStatus(f).status, 'PAID');
});

test('riconciliazione un movimento -> piu fatture', () => {
  const conto = Number(db.prepare("INSERT INTO cont_conti (nome) VALUES ('C4')").run().lastInsertRowid);
  const f1 = insertFattura({ numero: '47/2026', tipo: 'emessa', direzione: 'attiva', totale: 100 });
  const f2 = insertFattura({ numero: '48/2026', tipo: 'emessa', direzione: 'attiva', totale: 200 });
  bank.importMovements({ conto_id: conto, template: { mapping: { data_operazione: 'Data', importo: 'Importo', descrizione: 'Causale' } },
    rows: [{ Data: '20/03/2026', Importo: '300,00', Causale: 'Saldo 47 e 48' }], userId: 1 });
  const mov = bank.listMovimenti({ conto_id: conto })[0];
  const r = bank.reconcile(mov.id, [{ fattura_id: f1, importo_quota: 100 }, { fattura_id: f2, importo_quota: 200 }], 1);
  assert.equal(r.stato, 'riconciliato');
  assert.equal(cont.recomputeInvoicePaymentStatus(f1).status, 'PAID');
  assert.equal(cont.recomputeInvoicePaymentStatus(f2).status, 'PAID');
});
