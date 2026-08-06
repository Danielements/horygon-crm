const crypto = require('crypto');
const db = require('../src/db/database');

const CUSTOMER = {
  tipo: 'cliente',
  ragione_sociale: 'CLIENTE TEST SDI B2B',
  piva: 'IT01043931003',
  cf: '01043931003',
  indirizzo: 'Viale Roma 543',
  cap: '07100',
  citta: 'Sassari',
  provincia: 'SS',
  paese: 'IT',
  email: 'test-sdi@example.com',
  pec: '',
  codice_destinatario: 'UMZGLCP',
  note: 'Cliente test per interoperabilita SdICoop. Eliminare prima della produzione.'
};

const INVOICE = {
  numero: 'TEST-SDI-001',
  data: '2026-08-06',
  scadenza: '2026-08-06',
  imponibile: 100,
  iva: 22,
  totale: 122
};

const LINE = {
  descrizione: 'Test interoperabilita SdICoop CRM Horygon',
  quantita: 1,
  prezzo_unitario: 100,
  imponibile: 100,
  aliquota_iva: 22,
  importo_iva: 22,
  totale_riga: 100
};

function upsert() {
  const existingCustomer = db.prepare(`
    SELECT id
    FROM anagrafiche
    WHERE piva IN (?, ?) OR ragione_sociale = ?
    ORDER BY id
    LIMIT 1
  `).get(CUSTOMER.piva, CUSTOMER.piva.replace(/^IT/, ''), CUSTOMER.ragione_sociale);

  let customerId = existingCustomer?.id || null;
  if (customerId) {
    db.prepare(`
      UPDATE anagrafiche
      SET tipo=?, ragione_sociale=?, piva=?, cf=?, indirizzo=?, cap=?, citta=?, provincia=?, paese=?,
          email=?, pec=?, codice_destinatario=?, canale_cliente='privato', tipologia_cliente='privato',
          note=?, attivo=1
      WHERE id=?
    `).run(
      CUSTOMER.tipo,
      CUSTOMER.ragione_sociale,
      CUSTOMER.piva,
      CUSTOMER.cf,
      CUSTOMER.indirizzo,
      CUSTOMER.cap,
      CUSTOMER.citta,
      CUSTOMER.provincia,
      CUSTOMER.paese,
      CUSTOMER.email,
      CUSTOMER.pec,
      CUSTOMER.codice_destinatario,
      CUSTOMER.note,
      customerId
    );
  } else {
    const result = db.prepare(`
      INSERT INTO anagrafiche (
        tipo, ragione_sociale, piva, cf, indirizzo, cap, citta, provincia, paese,
        email, pec, codice_destinatario, canale_cliente, tipologia_cliente, note, attivo
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
    `).run(
      CUSTOMER.tipo,
      CUSTOMER.ragione_sociale,
      CUSTOMER.piva,
      CUSTOMER.cf,
      CUSTOMER.indirizzo,
      CUSTOMER.cap,
      CUSTOMER.citta,
      CUSTOMER.provincia,
      CUSTOMER.paese,
      CUSTOMER.email,
      CUSTOMER.pec,
      CUSTOMER.codice_destinatario,
      'privato',
      'privato',
      CUSTOMER.note
    );
    customerId = result.lastInsertRowid;
  }

  const hashDocumento = buildDocumentHash({
    numero: INVOICE.numero,
    data: INVOICE.data,
    partita_iva: CUSTOMER.piva,
    totale: INVOICE.totale
  });

  const existingInvoice = db.prepare(`
    SELECT id
    FROM fatture
    WHERE numero = ? AND tipo = 'emessa' AND origine_importazione = 'sdi_test_seed'
    LIMIT 1
  `).get(INVOICE.numero);

  let invoiceId = existingInvoice?.id || null;
  if (invoiceId) {
    db.prepare(`
      UPDATE fatture
      SET numero=?, numero_documento=?, tipo='emessa', direzione='attiva', tipo_documento='TD01',
          anagrafica_id=?, data=?, scadenza=?, imponibile=?, iva=?, totale=?, stato='ricevuta',
          stato_pagamento='da_pagare', valuta='EUR', partita_iva=?, codice_fiscale=?,
          cliente_fornitore_label=?, note=?, hash_documento=?, origine_importazione='sdi_test_seed',
          stato_sdi=NULL, xml_path=NULL
      WHERE id=?
    `).run(
      INVOICE.numero,
      INVOICE.numero,
      customerId,
      INVOICE.data,
      INVOICE.scadenza,
      INVOICE.imponibile,
      INVOICE.iva,
      INVOICE.totale,
      CUSTOMER.piva,
      CUSTOMER.cf,
      CUSTOMER.ragione_sociale,
      'Fattura test per invio SDI in ambiente TEST. Eliminare prima della produzione.',
      hashDocumento,
      invoiceId
    );
    db.prepare('DELETE FROM fatture_righe WHERE fattura_id = ?').run(invoiceId);
    db.prepare('DELETE FROM fatture_iva_riepilogo WHERE fattura_id = ?').run(invoiceId);
  } else {
    const result = db.prepare(`
      INSERT INTO fatture (
        numero, numero_documento, tipo, direzione, tipo_documento, anagrafica_id, data, scadenza,
        imponibile, iva, totale, stato, stato_pagamento, valuta, partita_iva, codice_fiscale,
        cliente_fornitore_label, note, hash_documento, origine_importazione
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      INVOICE.numero,
      INVOICE.numero,
      'emessa',
      'attiva',
      'TD01',
      customerId,
      INVOICE.data,
      INVOICE.scadenza,
      INVOICE.imponibile,
      INVOICE.iva,
      INVOICE.totale,
      'ricevuta',
      'da_pagare',
      'EUR',
      CUSTOMER.piva,
      CUSTOMER.cf,
      CUSTOMER.ragione_sociale,
      'Fattura test per invio SDI in ambiente TEST. Eliminare prima della produzione.',
      hashDocumento,
      'sdi_test_seed'
    );
    invoiceId = result.lastInsertRowid;
  }

  db.prepare(`
    INSERT INTO fatture_righe (
      fattura_id, descrizione, quantita, prezzo_unitario, imponibile, aliquota_iva, importo_iva, totale_riga
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(
    invoiceId,
    LINE.descrizione,
    LINE.quantita,
    LINE.prezzo_unitario,
    LINE.imponibile,
    LINE.aliquota_iva,
    LINE.importo_iva,
    LINE.totale_riga
  );

  db.prepare(`
    INSERT INTO fatture_iva_riepilogo (
      fattura_id, aliquota_iva, imponibile, imposta, riferimento_normativo
    ) VALUES (?,?,?,?,?)
  `).run(invoiceId, 22, 100, 22, 'IVA ordinaria');

  return { customerId, invoiceId };
}

let result;
try {
  db.exec('BEGIN');
  result = upsert();
  db.exec('COMMIT');
} catch (error) {
  try { db.exec('ROLLBACK'); } catch {}
  throw error;
}

console.log(`Cliente test SDI: ${result.customerId}`);
console.log(`Fattura test SDI: ${result.invoiceId}`);
console.log(`Numero: ${INVOICE.numero}`);
console.log(`Codice destinatario: ${CUSTOMER.codice_destinatario}`);

function buildDocumentHash({ numero, data, partita_iva, totale }) {
  const raw = [numero || '', data || '', partita_iva || '', Number(totale || 0).toFixed(2)].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex');
}
