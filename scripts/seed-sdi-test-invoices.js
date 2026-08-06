const crypto = require('crypto');
const db = require('../src/db/database');
const { run: seedRecipients } = require('./seed-sdi-test-recipients');

const TODAY = '2026-08-06';

const INVOICES = [
  { code: 'ESOJKL', numero: 'TESTSDI001', imponibile: 101, description: 'Test SdI PA ESOJKL' },
  { code: 'VRRMFL', numero: 'TESTSDI002', imponibile: 102, description: 'Test SdI PA VRRMFL' },
  { code: 'ESOWLS', numero: 'TESTSDI003', imponibile: 103, description: 'Test SdI PA ESOWLS' },
  { code: 'UMZGLCP', numero: 'TESTSDI004', imponibile: 104, description: 'Test SdI B2B UMZGLCP' },
  { code: 'TLYFKZO', numero: 'TESTSDI005', imponibile: 105, description: 'Test SdI B2B TLYFKZO' },
  { code: 'SKXEJYN', numero: 'TESTSDI006', imponibile: 106, description: 'Test SdI B2B SKXEJYN' }
];

let result;
try {
  db.exec('BEGIN');
  const recipientsSeed = seedRecipients({ transaction: false });
  result = seedInvoices(recipientsSeed.recipients);
  db.exec('COMMIT');
} catch (error) {
  try { db.exec('ROLLBACK'); } catch {}
  throw error;
}

console.log(`Fatture TEST SDI create: ${result.created}`);
console.log(`Fatture TEST SDI aggiornate: ${result.updated}`);
result.invoices.forEach((invoice) => {
  console.log(`#${invoice.id} ${invoice.numero} -> ${invoice.recipient} (${invoice.code}) totale ${invoice.totale.toFixed(2)}`);
});

function seedInvoices(recipients) {
  let created = 0;
  let updated = 0;
  const invoices = [];
  const byCode = new Map(recipients.map((recipient) => [recipient.codice_destinatario, recipient]));

  for (const invoice of INVOICES) {
    const recipient = byCode.get(invoice.code) || findRecipient(invoice.code);
    if (!recipient?.id) throw new Error(`Anagrafica TEST SDI non trovata per codice ${invoice.code}`);
    const iva = round2(invoice.imponibile * 0.22);
    const totale = round2(invoice.imponibile + iva);
    const hashDocumento = buildDocumentHash({
      numero: invoice.numero,
      data: TODAY,
      partita_iva: recipient.piva,
      totale
    });

    const existing = db.prepare(`
      SELECT id
      FROM fatture
      WHERE numero = ?
        AND tipo = 'emessa'
        AND origine_importazione = 'sdi_test_seed'
      LIMIT 1
    `).get(invoice.numero);

    let invoiceId;
    if (existing) {
      invoiceId = existing.id;
      db.prepare(`
        UPDATE fatture
        SET numero=?,
            numero_documento=?,
            tipo='emessa',
            direzione='attiva',
            tipo_documento='TD01',
            anagrafica_id=?,
            data=?,
            scadenza=?,
            imponibile=?,
            iva=?,
            totale=?,
            stato='ricevuta',
            stato_pagamento='da_pagare',
            valuta='EUR',
            partita_iva=?,
            codice_fiscale=?,
            cliente_fornitore_label=?,
            note=?,
            hash_documento=?,
            origine_importazione='sdi_test_seed',
            stato_sdi=NULL,
            xml_path=NULL
        WHERE id=?
      `).run(
        invoice.numero,
        invoice.numero,
        recipient.id,
        TODAY,
        TODAY,
        invoice.imponibile,
        iva,
        totale,
        recipient.piva,
        recipient.cf,
        recipient.ragione_sociale,
        buildInvoiceNote(invoice.code),
        hashDocumento,
        invoiceId
      );
      db.prepare('DELETE FROM fatture_righe WHERE fattura_id = ?').run(invoiceId);
      db.prepare('DELETE FROM fatture_iva_riepilogo WHERE fattura_id = ?').run(invoiceId);
      updated += 1;
    } else {
      const insert = db.prepare(`
        INSERT INTO fatture (
          numero, numero_documento, tipo, direzione, tipo_documento, anagrafica_id, data, scadenza,
          imponibile, iva, totale, stato, stato_pagamento, valuta, partita_iva, codice_fiscale,
          cliente_fornitore_label, note, hash_documento, origine_importazione
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        invoice.numero,
        invoice.numero,
        'emessa',
        'attiva',
        'TD01',
        recipient.id,
        TODAY,
        TODAY,
        invoice.imponibile,
        iva,
        totale,
        'ricevuta',
        'da_pagare',
        'EUR',
        recipient.piva,
        recipient.cf,
        recipient.ragione_sociale,
        buildInvoiceNote(invoice.code),
        hashDocumento,
        'sdi_test_seed'
      );
      invoiceId = insert.lastInsertRowid;
      created += 1;
    }

    db.prepare(`
      INSERT INTO fatture_righe (
        fattura_id, descrizione, quantita, prezzo_unitario, imponibile, aliquota_iva, importo_iva, totale_riga
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(
      invoiceId,
      invoice.description,
      1,
      invoice.imponibile,
      invoice.imponibile,
      22,
      iva,
      invoice.imponibile
    );

    db.prepare(`
      INSERT INTO fatture_iva_riepilogo (
        fattura_id, aliquota_iva, imponibile, imposta, riferimento_normativo
      ) VALUES (?,?,?,?,?)
    `).run(invoiceId, 22, invoice.imponibile, iva, 'IVA ordinaria');

    invoices.push({
      id: invoiceId,
      numero: invoice.numero,
      code: invoice.code,
      recipient: recipient.ragione_sociale,
      totale
    });
  }

  return { created, updated, invoices };
}

function findRecipient(code) {
  return db.prepare(`
    SELECT id, ragione_sociale, piva, cf, codice_destinatario
    FROM anagrafiche
    WHERE codice_destinatario = ?
    LIMIT 1
  `).get(code);
}

function buildInvoiceNote(code) {
  return `Fattura TEST per accreditamento SdICoop codice destinatario ${code}. Eliminare prima della produzione.`;
}

function buildDocumentHash({ numero, data, partita_iva, totale }) {
  const raw = [numero || '', data || '', partita_iva || '', Number(totale || 0).toFixed(2)].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex');
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}
