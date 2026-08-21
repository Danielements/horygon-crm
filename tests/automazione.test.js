const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpDb = path.join(os.tmpdir(), `horygon-auto-test-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const auto = require('../src/services/automazione-service');
const bank = require('../src/services/bank-service');
const cont = require('../src/services/contabilita-service');
const db = require('../src/db/database');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
});

// --- parser puri (causali reali UniCredit) ---------------------------------

test('detectType: carta / bonifici / oneri / versamento', () => {
  assert.equal(auto.detectType('PAGAMENTO Contactless del 28/04/2026 CARTA *3613 DI EUR 72,00 MECOJONI PIZZERIA ROMA', -1), 'carta');
  assert.equal(auto.detectType('BONIFICO ISTANTANEO A: Tirso Spelta SRL PER: Fattura n 596', -1), 'bonifico_uscita');
  assert.equal(auto.detectType('BONIFICO SEPA DA: MUSA TECH S.R.L. PER: affitto monitor', 1), 'bonifico_entrata');
  assert.equal(auto.detectType('COMPETENZE (INTERESSI/ONERI)', -1), 'oneri_bancari');
  assert.equal(auto.detectType('VERSAMENTO SU SPORTELLO AUTOMATICO', 1), 'versamento');
});

test('extractMerchant: esercente dal pagamento carta', () => {
  assert.equal(auto.extractMerchant('CARTA *3613 DI EUR 72,00 MECOJONI PIZZERIA ROMA'), 'MECOJONI PIZZERIA ROMA');
  assert.equal(auto.extractMerchant('CARTA *3613 DI EUR 340,00 FORD EUROTEAM LATINA'), 'FORD EUROTEAM LATINA');
});

test('extractCounterparty: controparte del bonifico', () => {
  assert.equal(auto.extractCounterparty('BONIFICO ISTANTANEO A: Tirso Spelta SRL PER: Fattura n 596 / 1E TRN: 119'), 'Tirso Spelta SRL');
  assert.equal(auto.extractCounterparty('BONIFICO SEPA DA: MUSA TECH S.R.L. PER: affitto monitor'), 'MUSA TECH S.R.L');
});

test('extractInvoiceRef: numero fattura dalla causale', () => {
  assert.equal(auto.extractInvoiceRef('PER: Fattura n 596 / 1E TRN: 119'), '596');
  assert.equal(auto.extractInvoiceRef('PER: saldo fattura n° 36 COMM: 12,00'), '36');
  assert.equal(auto.extractInvoiceRef('acconto compenso 2026'), null);
});

test('nameMatches: tollerante su parole significative', () => {
  assert.equal(auto.nameMatches('Tirso Spelta SRL', 'TIRSO SPELTA S.R.L.'), true);
  assert.equal(auto.nameMatches('MUSA TECH S.R.L', 'Musa Tech srl'), true);
  assert.equal(auto.nameMatches('Tirso Spelta', 'Bartolucci Martina'), false);
});

// --- integrazione: proposte e applicazione ---------------------------------

function conto() { return Number(db.prepare("INSERT INTO cont_conti (nome) VALUES ('UC')").run().lastInsertRowid); }
function importa(contoId, rows) {
  return bank.importMovements({ conto_id: contoId, template: { mapping: { data_operazione: 'Data', importo: 'Importo', descrizione: 'Causale' } }, rows, userId: 1 });
}
function insertFattura({ numero, tipo, direzione, totale }) {
  return Number(db.prepare(`INSERT INTO fatture (numero, tipo, direzione, tipo_documento, data, imponibile, iva, totale, stato_pagamento, cliente_fornitore_label)
    VALUES (?, ?, ?, 'fattura', '2026-05-01', ?, ?, ?, 'da_pagare', ?)`)
    .run(numero, tipo, direzione, totale / 1.22, totale - totale / 1.22, totale, direzione === 'passiva' ? 'Tirso Spelta SRL' : 'MUSA TECH SRL').lastInsertRowid);
}

test('proposta carta -> crea_spesa non documentata; applica e annulla', () => {
  const c = conto();
  importa(c, [{ Data: '28/04/2026', Importo: '-72,00', Causale: 'CARTA *3613 DI EUR 72,00 MECOJONI PIZZERIA ROMA' }]);
  const mov = bank.listMovimenti({ conto_id: c })[0];

  const { proposte } = auto.proposteMovimenti({ conto_id: c });
  assert.equal(proposte[0].azione, 'crea_spesa');
  assert.equal(proposte[0].spesa.fornitore_nome, 'MECOJONI PIZZERIA ROMA');
  assert.equal(proposte[0].sicura, true);

  const app = auto.applicaProposta(mov.id, null, 1);
  assert.ok(app.spesa_id > 0);
  assert.equal(bank.listMovimenti({ conto_id: c })[0].stato_riconciliazione, 'riconciliato');
  const sp = db.prepare('SELECT fornitore_nome, origine_automatica, fonte FROM cont_spese WHERE id = ?').get(app.spesa_id);
  assert.equal(sp.origine_automatica, 1);
  assert.equal(sp.fonte, 'auto');

  // annullo: la spesa sparisce, il movimento torna da riconciliare
  auto.annullaElaborazione(mov.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cont_spese WHERE id = ?').get(app.spesa_id).n, 0);
  assert.equal(bank.listMovimenti({ conto_id: c })[0].stato_riconciliazione, 'da_riconciliare');
});

test('bonifico a fornitore con numero fattura + importo -> auto-match sicuro', () => {
  const c = conto();
  const f = insertFattura({ numero: '596', tipo: 'ricevuta', direzione: 'passiva', totale: 1591.75 });
  importa(c, [{ Data: '11/05/2026', Importo: '-1.591,75', Causale: 'BONIFICO ISTANTANEO A: Tirso Spelta SRL PER: Fattura n 596 / 1E TRN: 119' }]);
  const mov = bank.listMovimenti({ conto_id: c })[0];

  const { proposte } = auto.proposteMovimenti({ conto_id: c });
  assert.equal(proposte[0].azione, 'riconcilia_fattura');
  assert.equal(proposte[0].fattura.id, f);
  assert.equal(proposte[0].sicura, true);           // importo e controparte coincidono
  assert.equal(proposte[0].verifiche.importo, true);
  assert.equal(proposte[0].verifiche.controparte, true);

  auto.applicaProposta(mov.id, null, 1);
  assert.equal(cont.recomputeInvoicePaymentStatus(f).status, 'PAID');
});

test('bonifico con controparte diversa NON e sicuro (verifica nomi)', () => {
  const c = conto();
  insertFattura({ numero: '999', tipo: 'ricevuta', direzione: 'passiva', totale: 500 });
  importa(c, [{ Data: '11/05/2026', Importo: '-500,00', Causale: 'BONIFICO A: ALTRO FORNITORE SPA PER: Fattura n 999' }]);
  const { proposte } = auto.proposteMovimenti({ conto_id: c });
  // importo coincide ma il nome no -> proposta non sicura (richiede conferma)
  if (proposte[0].azione === 'riconcilia_fattura') assert.equal(proposte[0].sicura, false);
});

test('applicaSicure: elabora in blocco solo le proposte certe', () => {
  const c = conto();
  importa(c, [
    { Data: '28/04/2026', Importo: '-72,00', Causale: 'CARTA *3613 DI EUR 72,00 MECOJONI PIZZERIA' },
    { Data: '30/06/2026', Importo: '-1,50', Causale: 'COMPETENZE (INTERESSI/ONERI)' }
  ]);
  const r = auto.applicaSicure({ conto_id: c }, 1);
  assert.equal(r.applicate, 2);
  assert.equal(r.errori, 0);
  const spese = db.prepare('SELECT fornitore_nome FROM cont_spese ORDER BY id').all().map((s) => s.fornitore_nome);
  assert.ok(spese.includes('Oneri bancari'));
});

test('regole: una regola assegna la categoria alla spesa carta', () => {
  const cat = Number(db.prepare("INSERT INTO cont_categorie (nome, tipo) VALUES ('Ristorazione','COST')").run().lastInsertRowid);
  db.prepare(`INSERT INTO cont_regole (nome, match_campo, match_tipo, match_valore, azione, categoria_id)
    VALUES ('Pizzerie','descrizione','contiene','PIZZERIA','categoria',?)`).run(cat);
  const c = conto();
  importa(c, [{ Data: '28/04/2026', Importo: '-72,00', Causale: 'CARTA *3613 DI EUR 72,00 MECOJONI PIZZERIA ROMA' }]);
  const { proposte } = auto.proposteMovimenti({ conto_id: c });
  assert.equal(proposte[0].spesa.categoria_id, cat);
  assert.equal(proposte[0].categoria_nome, 'Ristorazione');
});
