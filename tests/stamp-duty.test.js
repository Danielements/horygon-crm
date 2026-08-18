const test = require('node:test');
const assert = require('node:assert/strict');
const {
  quarterOf, dueDateForQuarter, nonVatBase, evaluateWithRule, parseDatiBollo, computeInvoiceBolloStato
} = require('../src/services/stamp-duty-service');

const RULE = { id: 1, threshold: 77.47, required: 1, amount: 2.00, exclusion_code: 'N6,N7' };

test('quarterOf: trimestre dalla data', () => {
  assert.deepEqual(quarterOf('2026-03-15'), { year: 2026, quarter: 'Q1', label: '2026-Q1' });
  assert.deepEqual(quarterOf('2026-08-18'), { year: 2026, quarter: 'Q3', label: '2026-Q3' });
  assert.deepEqual(quarterOf('2026-12-31'), { year: 2026, quarter: 'Q4', label: '2026-Q4' });
  assert.equal(quarterOf(''), null);
});

test('dueDateForQuarter: scadenze indicative', () => {
  assert.equal(dueDateForQuarter(2026, 'Q3'), '2026-11-30');
  assert.equal(dueDateForQuarter(2026, 'Q4'), '2027-02-28');
});

test('nonVatBase: somma i non-IVA, esclude reverse charge e senza natura', () => {
  const riep = [
    { natura_iva: 'N4', imponibile: 100 },    // esente -> conta
    { natura_iva: 'N2.2', imponibile: 50 },    // non soggetta -> conta
    { natura_iva: 'N6.1', imponibile: 200 },   // reverse charge -> escluso
    { natura_iva: 'N7', imponibile: 300 },     // escluso
    { aliquota_iva: 22, natura_iva: null, imponibile: 1000 } // con IVA -> non conta
  ];
  assert.equal(nonVatBase(riep, ['N6', 'N7']), 150);
});

test('evaluateWithRule: bollo dovuto sopra soglia, non dovuto sotto', () => {
  const sopra = evaluateWithRule([{ natura_iva: 'N4', imponibile: 100 }], RULE);
  assert.equal(sopra.required, true);
  assert.equal(sopra.amount, 2.00);

  const sotto = evaluateWithRule([{ natura_iva: 'N4', imponibile: 50 }], RULE);
  assert.equal(sotto.required, false);
  assert.equal(sotto.amount, 0);

  const soloIva = evaluateWithRule([{ aliquota_iva: 22, imponibile: 1000 }], RULE);
  assert.equal(soloIva.required, false);
});

test('parseDatiBollo: legge BolloVirtuale/ImportoBollo', () => {
  const conBollo = parseDatiBollo('<X><DatiBollo><BolloVirtuale>SI</BolloVirtuale><ImportoBollo>2.00</ImportoBollo></DatiBollo></X>');
  assert.equal(conBollo.declared, true);
  assert.equal(conBollo.amount, 2.00);

  const senza = parseDatiBollo('<X><DatiGeneraliDocumento></DatiGeneraliDocumento></X>');
  assert.equal(senza.declared, false);
  assert.equal(senza.amount, null);
});

test('computeInvoiceBolloStato: mappa gli stati', () => {
  assert.equal(computeInvoiceBolloStato({ required: false, declared: false }), 'NOT_REQUIRED');
  assert.equal(computeInvoiceBolloStato({ required: true, declared: false }), 'REQUIRED_NOT_DECLARED');
  assert.equal(computeInvoiceBolloStato({ required: true, declared: true }), 'DECLARED');
  assert.equal(computeInvoiceBolloStato({ required: true, declared: true, settlement: { status: 'PAID' } }), 'PAID');
  assert.equal(computeInvoiceBolloStato({ required: true, declared: true, settlement: { status: 'RECONCILED' } }), 'RECONCILED');
});
