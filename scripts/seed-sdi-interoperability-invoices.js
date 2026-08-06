const crypto = require('crypto');
const db = require('../src/db/database');

const TODAY = new Date().toISOString().slice(0, 10);
const B2C_FISCAL_CODE = String(process.env.SDI_TEST_B2C_FISCAL_CODE || '01043931003').trim().toUpperCase();

const RECIPIENTS = [
  {
    tipo: 'cliente',
    ragione_sociale: 'CLIENTE TEST SDI XS00001 IMPOSSIBILITA RECAPITO',
    piva: 'IT01043931003',
    cf: '01043931003',
    codice_destinatario: 'XS00001',
    note: 'TEST WST04 B2B/B2C: codice destinatario fittizio per impossibilita di recapito.'
  },
  {
    tipo: 'cliente',
    ragione_sociale: 'CLIENTE TEST SDI B2C 0000000 SENZA PEC',
    piva: '',
    cf: B2C_FISCAL_CODE,
    codice_destinatario: '0000000',
    note: 'TEST B2C/no-channel: CodiceDestinatario 0000000 senza PECDestinatario per verificare RicevutaImpossibilitaRecapito. Per evitare 00306 usare SDI_TEST_B2C_FISCAL_CODE con un CF reale presente in Anagrafe Tributaria.'
  },
  {
    tipo: 'pa',
    ragione_sociale: 'PA TEST SDI ESOJKL DECORRENZA TERMINI',
    piva: 'IT90000000991',
    cf: '90000000991',
    codice_destinatario: 'ESOJKL',
    codice_ipa: 'ESOJKL',
    note: 'TEST WST03 B2G: ricezione fattura senza invio esito committente.'
  },
  {
    tipo: 'pa',
    ragione_sociale: 'PA TEST SDI VRRMFL NOTIFICA ESITO OE',
    piva: 'IT90000000993',
    cf: '90000000993',
    codice_destinatario: 'VRRMFL',
    codice_ipa: 'VRRMFL',
    note: 'TEST notifica esito a operatore economico: inviare EC01 dopo RiceviFatture/ER01.'
  },
  {
    tipo: 'pa',
    ragione_sociale: 'PA TEST SDI XS0000 ATTESTAZIONE',
    piva: 'IT90000000992',
    cf: '90000000992',
    codice_destinatario: 'XS0000',
    codice_ipa: 'XS0000',
    note: 'TEST WST04 B2G: codice destinatario fittizio per mancata consegna e attestazione. Richiede fattura FPA12 firmata.'
  }
];

const INVOICES = [
  {
    numero: 'TEST-MC-001',
    recipientCode: 'XS00001',
    imponibile: 131,
    expected: 'RicevutaImpossibilitaRecapito',
    note: 'Test mancata consegna/impossibilita recapito B2B/B2C. Non usare PECDestinatario.'
  },
  {
    numero: 'TEST-MC-B2C-0000000',
    recipientCode: '0000000',
    imponibile: 131.5,
    expected: 'RicevutaImpossibilitaRecapito',
    note: 'Prova definitiva B2C: FPR12 con CodiceDestinatario 0000000 e senza PECDestinatario.'
  },
  {
    numero: 'TEST-DT-001',
    recipientCode: 'ESOJKL',
    imponibile: 132,
    expected: 'NotificaDecorrenzaTermini',
    note: 'Test decorrenza termini PA. Dopo ricezione non inviare EC01/EC02.'
  },
  {
    numero: 'TEST-NE-001',
    recipientCode: 'VRRMFL',
    imponibile: 134,
    expected: 'NotificaEsito',
    note: 'Test notifica esito a operatore economico. Dopo RiceviFatture/ER01 inviare EC01 e attendere NotificaEsito su TrasmissioneFatture.'
  },
  {
    numero: 'TEST-AT-001',
    recipientCode: 'XS0000',
    imponibile: 133,
    expected: 'NotificaMancataConsegna + AttestazioneTrasmissioneFattura',
    note: 'Test attestazione PA. La fattura FPA12 deve essere firmata prima della trasmissione.'
  }
];

main();

function main() {
  db.exec('BEGIN');
  try {
    const recipients = RECIPIENTS.map(upsertRecipient);
    const invoices = INVOICES.map((invoice) => upsertInvoice(invoice, recipients));
    db.exec('COMMIT');
    invoices.forEach((invoice) => {
      console.log(`#${invoice.id} ${invoice.numero} -> ${invoice.recipientCode} atteso=${invoice.expected}`);
    });
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function upsertRecipient(recipient) {
  const existing = db.prepare(`
    SELECT id
    FROM anagrafiche
    WHERE ragione_sociale = ?
       OR (codice_destinatario = ? AND codice_destinatario <> '0000000')
    ORDER BY id
    LIMIT 1
  `).get(recipient.ragione_sociale, recipient.codice_destinatario);
  const values = [
    recipient.tipo,
    recipient.ragione_sociale,
    recipient.piva || '',
    recipient.cf || '',
    'Via Test SdI 1',
    '00100',
    'Roma',
    'RM',
    'IT',
    'test-sdi@example.com',
    '',
    recipient.codice_destinatario,
    recipient.tipo === 'pa' ? 'pa' : 'privato',
    recipient.tipo === 'pa' ? 'pa' : 'privato',
    recipient.tipo === 'pa' ? 1 : 0,
    recipient.note,
    1
  ];
  const id = existing
    ? (db.prepare(`
      UPDATE anagrafiche
      SET tipo=?, ragione_sociale=?, piva=?, cf=?, indirizzo=?, cap=?, citta=?, provincia=?, paese=?,
          email=?, pec=?, codice_destinatario=?, canale_cliente=?, tipologia_cliente=?, pa_mepa=?, note=?, attivo=?
      WHERE id=?
    `).run(...values, existing.id), existing.id)
    : db.prepare(`
      INSERT INTO anagrafiche (
        tipo, ragione_sociale, piva, cf, indirizzo, cap, citta, provincia, paese,
        email, pec, codice_destinatario, canale_cliente, tipologia_cliente, pa_mepa, note, attivo
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(...values).lastInsertRowid;
  if (recipient.tipo === 'pa') {
    db.prepare(`
      INSERT INTO pa_dettagli (anagrafica_id, codice_ipa, codice_univoco_sdi, categoria_pa, cpv_abituali)
      VALUES (?,?,?,?,?)
      ON CONFLICT(anagrafica_id) DO UPDATE SET
        codice_ipa=excluded.codice_ipa,
        codice_univoco_sdi=excluded.codice_univoco_sdi,
        categoria_pa=excluded.categoria_pa,
        cpv_abituali=excluded.cpv_abituali
    `).run(id, recipient.codice_ipa, recipient.codice_destinatario, 'TEST SDI', 'TEST');
  }
  return { ...recipient, id };
}

function upsertInvoice(invoice, recipients) {
  const recipient = recipients.find((item) => item.codice_destinatario === invoice.recipientCode);
  if (!recipient) throw new Error(`Anagrafica non trovata: ${invoice.recipientCode}`);
  const iva = round2(invoice.imponibile * 0.22);
  const totale = round2(invoice.imponibile + iva);
  const hashDocumento = buildDocumentHash({ numero: invoice.numero, data: TODAY, partita_iva: recipient.piva, totale });
  const existing = db.prepare(`
    SELECT id
    FROM fatture
    WHERE numero = ? AND origine_importazione = 'sdi_interop_seed'
    LIMIT 1
  `).get(invoice.numero);
  const common = [
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
    `${invoice.note} Callback atteso: ${invoice.expected}`,
    hashDocumento,
    'sdi_interop_seed'
  ];
  const id = existing
    ? (db.prepare(`
      UPDATE fatture
      SET numero=?, numero_documento=?, tipo=?, direzione=?, tipo_documento=?, anagrafica_id=?, data=?, scadenza=?,
          imponibile=?, iva=?, totale=?, stato=?, stato_pagamento=?, valuta=?, partita_iva=?, codice_fiscale=?,
          cliente_fornitore_label=?, note=?, hash_documento=?, origine_importazione=?, stato_sdi=NULL, xml_path=NULL
      WHERE id=?
    `).run(...common, existing.id), existing.id)
    : db.prepare(`
      INSERT INTO fatture (
        numero, numero_documento, tipo, direzione, tipo_documento, anagrafica_id, data, scadenza,
        imponibile, iva, totale, stato, stato_pagamento, valuta, partita_iva, codice_fiscale,
        cliente_fornitore_label, note, hash_documento, origine_importazione
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(...common).lastInsertRowid;
  db.prepare('DELETE FROM fatture_righe WHERE fattura_id = ?').run(id);
  db.prepare('DELETE FROM fatture_iva_riepilogo WHERE fattura_id = ?').run(id);
  db.prepare(`
    INSERT INTO fatture_righe (
      fattura_id, descrizione, quantita, prezzo_unitario, imponibile, aliquota_iva, importo_iva, totale_riga
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(id, `Interoperabilita ${invoice.numero}`, 1, invoice.imponibile, invoice.imponibile, 22, iva, invoice.imponibile);
  db.prepare(`
    INSERT INTO fatture_iva_riepilogo (
      fattura_id, aliquota_iva, imponibile, imposta, riferimento_normativo
    ) VALUES (?,?,?,?,?)
  `).run(id, 22, invoice.imponibile, iva, 'IVA ordinaria');
  return { id, ...invoice };
}

function buildDocumentHash({ numero, data, partita_iva, totale }) {
  return crypto.createHash('sha1').update([numero, data, partita_iva, Number(totale).toFixed(2)].join('|')).digest('hex');
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}
