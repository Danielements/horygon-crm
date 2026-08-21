const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../src/services/receipt-ai-extraction');

test('toNumber: formati italiani e con punto', () => {
  assert.equal(ai.toNumber('12,50'), 12.5);
  assert.equal(ai.toNumber('1.234,56'), 1234.56);
  assert.equal(ai.toNumber('40.00'), 40);
  assert.equal(ai.toNumber(''), null);
});

test('parseReceiptJson: estrae i campi, tollerante ai fences e ai null', () => {
  const txt = '```json\n{ "data":"2026-08-10", "fornitore_nome":"Autogrill", "fornitore_piva":"01234567890", "numero_documento":"12-45", "imponibile":10.25, "iva":2.25, "totale":12.50, "valuta":"EUR" }\n```';
  const r = ai.parseReceiptJson(txt);
  assert.equal(r.data, '2026-08-10');
  assert.equal(r.fornitore_nome, 'Autogrill');
  assert.equal(r.totale, 12.5);
  assert.equal(r.iva, 2.25);

  const soloTotale = ai.parseReceiptJson('{"totale":"5,00","imponibile":null,"iva":null}');
  assert.equal(soloTotale.totale, 5);
  assert.equal(soloTotale.imponibile, null);
  assert.equal(soloTotale.valuta, 'EUR');
});

test('extractReceipt: usa il callFn iniettato', async () => {
  const fake = async () => '{"data":"2026-08-11","fornitore_nome":"Ferramenta","totale":40,"imponibile":32.79,"iva":7.21}';
  const r = await ai.extractReceipt(Buffer.from('img'), { callFn: fake, mime: 'image/jpeg' });
  assert.equal(r.fornitore_nome, 'Ferramenta');
  assert.equal(r.totale, 40);
  assert.equal(r.imponibile, 32.79);
});
