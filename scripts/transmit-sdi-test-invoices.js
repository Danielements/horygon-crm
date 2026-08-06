const db = require('../src/db/database');
const { transmitInvoiceToSdiTest } = require('../src/services/sdi-transmission');

const DEFAULT_NUMBERS = [
  'TESTSDI001',
  'TESTSDI002',
  'TESTSDI003',
  'TESTSDI004',
  'TESTSDI005',
  'TESTSDI006'
];

const requestedNumbers = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_NUMBERS;

main().catch((error) => {
  console.error(`Invio batch SDI TEST interrotto: ${error.message}`);
  if (error.stack) console.error(error.stack);
  process.exitCode = 1;
});

async function main() {
  const invoices = loadInvoices(requestedNumbers);
  if (!invoices.length) throw new Error('Nessuna fattura TEST SDI trovata');

  console.log(`Invio SDI TEST di ${invoices.length} fatture`);
  for (const invoice of invoices) {
    await transmitOne(invoice);
  }
}

function loadInvoices(numbers) {
  const placeholders = numbers.map(() => '?').join(',');
  return db.prepare(`
    SELECT
      f.id,
      f.numero,
      f.totale,
      a.ragione_sociale,
      a.codice_destinatario
    FROM fatture f
    LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id
    WHERE f.numero IN (${placeholders})
      AND f.tipo = 'emessa'
      AND f.origine_importazione = 'sdi_test_seed'
    ORDER BY f.numero
  `).all(...numbers);
}

async function transmitOne(invoice) {
  process.stdout.write(`${invoice.numero} -> ${invoice.ragione_sociale || '-'} (${invoice.codice_destinatario || '-'}) ... `);
  const result = await transmitInvoiceToSdiTest(invoice.id);
  if (!result.transmission?.success) {
    const status = result.transmission?.statusCode || 'ERR';
    const fault = result.transmission?.fault?.faultstring || result.transmission?.statusMessage || 'errore sconosciuto';
    console.log(`KO ${status} ${fault}`);
    return;
  }
  console.log(`OK SdI ${result.transmission.identificativoSdi} file ${result.filename}`);
}
