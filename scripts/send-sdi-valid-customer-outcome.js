const db = require('../src/db/database');
const { sendEsitoCommittenteToSdiTest } = require('../src/services/sdi-esito-committente');
const { registerManualInteroperabilityTest } = require('../src/services/sdi-interoperability');

const invoiceRef = process.argv[2];
const outcome = process.argv[3] || 'EC01';

main().catch((error) => {
  console.error(`Invio esito committente interrotto: ${error.message}`);
  if (error.stack) console.error(error.stack);
  process.exitCode = 1;
});

async function main() {
  if (!invoiceRef) throw new Error('Uso: node scripts/send-sdi-valid-customer-outcome.js <fatturaId|numero> [EC01|EC02]');
  const invoice = loadInvoice(invoiceRef);
  if (!invoice) throw new Error(`Fattura non trovata: ${invoiceRef}`);
  const result = await sendEsitoCommittenteToSdiTest(invoice.id, {
    esito: outcome,
    descrizione: outcome === 'EC02' ? 'Esito negativo test interoperabilita' : ''
  });
  registerManualInteroperabilityTest({
    test_name: 'Notifica esito a Operatore Economico',
    fattura_id: invoice.id,
    flow_id: result.flowId,
    nome_file: result.filename,
    codice_destinatario: invoice.codice_destinatario || invoice.codice_univoco_sdi || null,
    identificativo_sdi: invoice.sdi_id || null,
    data_invio: new Date().toISOString(),
    callback_atteso: 'NotificaEsito',
    callback_ricevuto: result.esitoRisposta || null,
    http_status: result.statusCode,
    stato_portale: null,
    note: 'Invio EC valido via SdIRiceviNotifica; attendere callback TrasmissioneFatture/NotificaEsito',
    payload_meta: JSON.stringify({ flowSide: 'outbound_esito_committente', result })
  });
  console.log(`Fattura ${invoice.id} ${invoice.numero}: inviato ${outcome}`);
  console.log(`Risposta SdI: ${result.esitoRisposta || '-'} accepted=${result.accepted} success=${result.success}`);
  console.log(`File: ${result.filename}`);
}

function loadInvoice(ref) {
  const byId = /^\d+$/.test(String(ref))
    ? db.prepare(`
      SELECT f.*, a.codice_destinatario, p.codice_univoco_sdi
      FROM fatture f
      LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id
      LEFT JOIN pa_dettagli p ON p.anagrafica_id = a.id
      WHERE f.id = ?
    `).get(Number(ref))
    : null;
  if (byId) return byId;
  return db.prepare(`
    SELECT f.*, a.codice_destinatario, p.codice_univoco_sdi
    FROM fatture f
    LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id
    LEFT JOIN pa_dettagli p ON p.anagrafica_id = a.id
    WHERE f.numero = ? OR f.numero_documento = ?
    ORDER BY f.id DESC
    LIMIT 1
  `).get(ref, ref);
}
