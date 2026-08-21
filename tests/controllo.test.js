const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpDb = path.join(os.tmpdir(), `horygon-ctrl-test-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const ctrl = require('../src/services/controllo-service');
const spese = require('../src/services/spese-service');
const db = require('../src/db/database');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
});

// --- unit puri -------------------------------------------------------------

test('canTransition: flusso rimborso valido', () => {
  assert.equal(ctrl.canTransition('DRAFT', 'TO_REVIEW'), true);
  assert.equal(ctrl.canTransition('TO_REVIEW', 'APPROVED'), true);
  assert.equal(ctrl.canTransition('APPROVED', 'PAID'), true);
  assert.equal(ctrl.canTransition('DRAFT', 'PAID'), false);   // niente scorciatoie
  assert.equal(ctrl.canTransition('PAID', 'DRAFT'), false);
});

test('budgetVariance: scostamento e percentuale', () => {
  assert.deepEqual(ctrl.budgetVariance(1000, 1200), { budget: 1000, consuntivo: 1200, scostamento: 200, perc: 120 });
  assert.equal(ctrl.budgetVariance(0, 50).perc, null);
});

// --- integrazione ----------------------------------------------------------

test('rimborso: aggrega spese anticipo, DRAFT->PAID genera uscita', () => {
  const s1 = spese.createSpesa({ data: '2026-08-01', fornitore_nome: 'Taxi', totale: 25, pagata_con: 'anticipo_personale' }, null, 1).id;
  const s2 = spese.createSpesa({ data: '2026-08-02', fornitore_nome: 'Hotel', totale: 90, pagata_con: 'anticipo_personale' }, null, 1).id;
  // una spesa aziendale NON deve entrare
  spese.createSpesa({ data: '2026-08-03', fornitore_nome: 'Cancelleria', totale: 10, pagata_con: 'azienda' }, null, 1);

  const disp = ctrl.anticipoDisponibili();
  assert.equal(disp.length, 2);

  const r = ctrl.createRimborso({ beneficiario: 'Mario', periodo: '2026-08' }, 1);
  const att = ctrl.attachSpese(r.id, [s1, s2]);
  assert.equal(att.totale, 115);

  ctrl.transitionRimborso(r.id, 'TO_REVIEW', 1);
  ctrl.transitionRimborso(r.id, 'APPROVED', 1);
  const paid = ctrl.transitionRimborso(r.id, 'PAID', 1, { pagato_il: '2026-08-31' });
  assert.ok(paid.pagamento_id > 0);

  const pag = db.prepare('SELECT verso, importo FROM cont_pagamenti WHERE id = ?').get(paid.pagamento_id);
  assert.equal(pag.verso, 'pagamento');
  assert.equal(pag.importo, 115);

  const dett = ctrl.getRimborso(r.id);
  assert.equal(dett.stato, 'PAID');
  assert.equal(dett.spese.length, 2);
});

test('rimborso: non modificabile fuori dalla bozza', () => {
  const s = spese.createSpesa({ data: '2026-09-01', fornitore_nome: 'Treno', totale: 50, pagata_con: 'anticipo_personale' }, null, 1).id;
  const r = ctrl.createRimborso({ beneficiario: 'Lucia' }, 1);
  ctrl.attachSpese(r.id, [s]);
  ctrl.transitionRimborso(r.id, 'TO_REVIEW', 1);
  assert.throws(() => ctrl.attachSpese(r.id, [s]));       // non piu in bozza
  assert.throws(() => ctrl.transitionRimborso(r.id, 'PAID', 1)); // salto di stato
});

test('report gestionale: budget vs consuntivo per categoria', () => {
  const cat = Number(db.prepare("INSERT INTO cont_categorie (nome, tipo) VALUES ('Trasferte','COST')").run().lastInsertRowid);
  spese.createSpesa({ data: '2026-10-05', fornitore_nome: 'Volo', totale: 300, categoria_id: cat }, null, 1);
  ctrl.createBudget({ periodo: '2026', categoria_id: cat, importo_budget: 1000 });

  const rep = ctrl.reportGestionale('2026');
  const riga = rep.righe.find((x) => x.categoria_id === cat);
  assert.equal(riga.budget, 1000);
  assert.equal(riga.consuntivo, 300);
  assert.equal(riga.scostamento, -700);
});
