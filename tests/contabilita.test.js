const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// DB isolato: va impostato PRIMA di richiedere database.js (che legge DB_PATH a
// require-time e ci costruisce sopra tutto lo schema).
const tmpDb = path.join(os.tmpdir(), `horygon-cont-test-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const cont = require('../src/services/contabilita-service');
const db = require('../src/db/database');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
});

// --- unit puri -------------------------------------------------------------

test('computePaymentStatus: non pagata / parziale / pagata / sovra-pagata', () => {
  assert.equal(cont.computePaymentStatus(122, 0), 'UNPAID');
  assert.equal(cont.computePaymentStatus(122, 50), 'PARTIALLY_PAID');
  assert.equal(cont.computePaymentStatus(122, 122), 'PAID');
  assert.equal(cont.computePaymentStatus(122, 121.999), 'PAID');   // tolleranza centesimo
  assert.equal(cont.computePaymentStatus(122, 200), 'OVERPAID');
});

test('paymentStatusToCache: mappa sulla cache italiana', () => {
  assert.equal(cont.paymentStatusToCache('UNPAID'), 'da_pagare');
  assert.equal(cont.paymentStatusToCache('PARTIALLY_PAID'), 'parziale');
  assert.equal(cont.paymentStatusToCache('PAID'), 'pagata');
  assert.equal(cont.paymentStatusToCache('OVERPAID'), 'pagata');
});

test('validateSplit: 100% ok, somma diversa da 100 rifiutata', () => {
  const ok = cont.validateSplit([
    { centro_costo_id: 1, percentuale: 60 },
    { centro_costo_id: 2, percentuale: 40 }
  ]);
  assert.equal(ok.ok, true);
  assert.equal(ok.normalized.length, 2);

  const ko = cont.validateSplit([
    { centro_costo_id: 1, percentuale: 60 },
    { centro_costo_id: 2, percentuale: 30 }
  ]);
  assert.equal(ko.ok, false);

  const vuota = cont.validateSplit([{ percentuale: 100 }]);
  assert.equal(vuota.ok, false); // nessuna dimensione
});

// --- integrazione DB -------------------------------------------------------

function insertFattura({ numero, tipo, direzione, tipo_documento = 'fattura', totale, data = '2026-03-10' }) {
  const info = db.prepare(`INSERT INTO fatture (numero, tipo, direzione, tipo_documento, data, imponibile, iva, totale, stato_pagamento)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'da_pagare')`)
    .run(numero, tipo, direzione, tipo_documento, data, totale / 1.22, totale - totale / 1.22, totale);
  return Number(info.lastInsertRowid);
}

test('pagamenti: parziale poi saldo -> PAID, con cache aggiornata', () => {
  const id = insertFattura({ numero: 'A/1', tipo: 'emessa', direzione: 'attiva', totale: 122 });

  let r = cont.recomputeInvoicePaymentStatus(id);
  assert.equal(r.status, 'UNPAID');

  cont.registerPayment({ verso: 'incasso', importo: 50, allocazioni: [{ fattura_id: id, importo_quota: 50 }] }, 1);
  r = cont.recomputeInvoicePaymentStatus(id);
  assert.equal(r.status, 'PARTIALLY_PAID');
  assert.equal(r.residuo, 72);
  assert.equal(db.prepare('SELECT stato_pagamento FROM fatture WHERE id = ?').get(id).stato_pagamento, 'parziale');

  cont.registerPayment({ verso: 'incasso', importo: 72, allocazioni: [{ fattura_id: id, importo_quota: 72 }] }, 1);
  r = cont.recomputeInvoicePaymentStatus(id);
  assert.equal(r.status, 'PAID');
  assert.equal(db.prepare('SELECT stato_pagamento FROM fatture WHERE id = ?').get(id).stato_pagamento, 'pagata');
});

test('pagamenti: un pagamento su piu fatture (allocazione molti-a-molti)', () => {
  const a = insertFattura({ numero: 'A/2', tipo: 'emessa', direzione: 'attiva', totale: 100 });
  const b = insertFattura({ numero: 'A/3', tipo: 'emessa', direzione: 'attiva', totale: 200 });

  cont.registerPayment({ verso: 'incasso', importo: 300, allocazioni: [
    { fattura_id: a, importo_quota: 100 },
    { fattura_id: b, importo_quota: 200 }
  ] }, 1);

  assert.equal(cont.recomputeInvoicePaymentStatus(a).status, 'PAID');
  assert.equal(cont.recomputeInvoicePaymentStatus(b).status, 'PAID');
});

test('pagamenti: le quote non possono superare l\'importo del pagamento', () => {
  const id = insertFattura({ numero: 'A/4', tipo: 'emessa', direzione: 'attiva', totale: 100 });
  assert.throws(() => cont.registerPayment({ verso: 'incasso', importo: 50, allocazioni: [{ fattura_id: id, importo_quota: 80 }] }, 1));
});

test('nota di credito: e\' una fattura con tipo_documento nota_credito, riusata dalla vista', () => {
  const nota = insertFattura({ numero: 'NC/1', tipo: 'emessa', direzione: 'attiva', tipo_documento: 'nota_credito', totale: 50 });
  const vista = cont.listInvoicesContabile({ tipo_documento: 'nota_credito' });
  assert.ok(vista.some((f) => f.id === nota));
});

test('deletePayment: rimuove le quote e riporta la fattura a UNPAID', () => {
  const id = insertFattura({ numero: 'A/5', tipo: 'emessa', direzione: 'attiva', totale: 100 });
  const p = cont.registerPayment({ verso: 'incasso', importo: 100, allocazioni: [{ fattura_id: id, importo_quota: 100 }] }, 1);
  assert.equal(cont.recomputeInvoicePaymentStatus(id).status, 'PAID');
  cont.deletePayment(p.id);
  assert.equal(cont.recomputeInvoicePaymentStatus(id).status, 'UNPAID');
});

test('classificazione con split su centri di costo, importi derivati dal totale', () => {
  const id = insertFattura({ numero: 'A/6', tipo: 'ricevuta', direzione: 'passiva', totale: 1000 });
  const c1 = Number(db.prepare("INSERT INTO cont_centri_costo (nome) VALUES ('Officina')").run().lastInsertRowid);
  const c2 = Number(db.prepare("INSERT INTO cont_centri_costo (nome) VALUES ('Commerciale')").run().lastInsertRowid);

  const righe = cont.saveClassification('fattura', id, [
    { centro_costo_id: c1, percentuale: 60 },
    { centro_costo_id: c2, percentuale: 40 }
  ], 1);
  assert.equal(righe.length, 2);
  const tot = righe.reduce((s, r) => s + r.importo, 0);
  assert.equal(cont.round2(tot), 1000);
  assert.equal(righe.find((r) => r.centro_costo_id === c1).importo, 600);

  // Ri-salvare rimpiazza (non accumula).
  const righe2 = cont.saveClassification('fattura', id, [{ centro_costo_id: c1, percentuale: 100 }], 1);
  assert.equal(righe2.length, 1);
});
