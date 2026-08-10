// Legge e imposta la configurazione fiscale del tenant, cioe' la riga di
// sdi_fiscal_configuration senza la quale i Servizi Massivi non partono:
// resolveTenantVatNumber non trova la partita IVA e ogni job si ferma subito.
//
//   node scripts/sdi-fiscal-config.js                      # mostra lo stato
//   node scripts/sdi-fiscal-config.js --set \
//     --piva=03365990591 --cf=03365990591 \
//     --massivi --provider --confirm
//
// Va eseguito dentro il container, dove il database e' quello vero:
//   docker compose exec app node scripts/sdi-fiscal-config.js
//
// Le flag:
//   --massivi   Servizi Massivi attivi sull'identificativo fiscale (07.08.2026)
//   --provider  censimento del canale su Fatture e Corrispettivi completato.
//               Senza, SdI risponde ER02 "utente non abilitato" e il job muore
//               dopo aver consumato una firma qualificata.

const db = require('../src/db/database');

const args = process.argv.slice(2);
const set = args.includes('--set');
const confirm = args.includes('--confirm');

function flagValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : fallback;
}

const tenantId = Number(flagValue('tenant', '1')) || 1;

function show(title) {
  const row = db.prepare('SELECT * FROM sdi_fiscal_configuration WHERE tenant_id = ?').get(tenantId);
  console.log(`\n${title}`);
  if (!row) {
    console.log(`  nessuna configurazione per il tenant ${tenantId}`);
    return null;
  }
  Object.entries(row).forEach(([key, value]) => {
    console.log(`  ${key.padEnd(36)} ${value === null ? '-' : value}`);
  });
  return row;
}

const before = show(`Configurazione fiscale, tenant ${tenantId}:`);

if (!set) {
  console.log('\nSola lettura. Per modificare: --set --piva=... --cf=... --massivi --provider --confirm');
  process.exit(0);
}

const piva = normalizeVat(flagValue('piva', before ? before.vat_number : ''));
const cf = String(flagValue('cf', before ? before.tax_code : '') || '').trim().toUpperCase();
const recipientCode = flagValue('codice-destinatario', before ? before.recipient_code : null);

if (!piva && !cf) {
  console.error('\nServe almeno --piva o --cf: senza, la direzione delle fatture importate resta sconosciuta.');
  process.exit(1);
}
if (piva && !/^\d{11}$/.test(piva)) {
  console.error(`\nPartita IVA non conforme al tracciato (11 cifre): ${piva}`);
  process.exit(1);
}

const massivi = args.includes('--massivi') ? 1 : (before ? Number(before.massive_services_enabled) : 0);
const provider = args.includes('--provider') ? 1 : (before ? Number(before.massive_services_provider_enabled) : 0);
const storico = args.includes('--no-storico') ? 0 : 1;

console.log('\nValori da scrivere:');
console.log(`  vat_number                           ${piva || '-'}`);
console.log(`  tax_code                             ${cf || '-'}`);
console.log(`  recipient_code                       ${recipientCode || '-'}`);
console.log(`  massive_services_enabled             ${massivi}`);
console.log(`  massive_services_provider_enabled    ${provider}`);
console.log(`  historical_sync_enabled              ${storico}`);

if (!confirm) {
  console.log('\nDry-run: nessuna modifica applicata. Aggiungi --confirm per scrivere.');
  process.exit(0);
}

try {
  db.prepare(`
    INSERT INTO sdi_fiscal_configuration
      (tenant_id, vat_number, tax_code, recipient_code, massive_services_enabled,
       massive_services_provider_enabled, historical_sync_enabled, aggiornato_il)
    VALUES (?,?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(tenant_id) DO UPDATE SET
      vat_number = excluded.vat_number,
      tax_code = excluded.tax_code,
      recipient_code = COALESCE(excluded.recipient_code, sdi_fiscal_configuration.recipient_code),
      massive_services_enabled = excluded.massive_services_enabled,
      massive_services_provider_enabled = excluded.massive_services_provider_enabled,
      historical_sync_enabled = excluded.historical_sync_enabled,
      aggiornato_il = datetime('now')
  `).run(tenantId, piva || null, cf || null, recipientCode || null, massivi, provider, storico);
} catch (error) {
  console.error(`\nScrittura fallita: ${error.message}`);
  process.exit(1);
}

// Nel container e' montato solo horygon.db, non i sidecar -wal/-shm: senza
// checkpoint la scrittura resta nel WAL e sparisce al primo rebuild.
try {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  console.log('\nCheckpoint WAL eseguito: la configurazione e nel file del database.');
} catch (error) {
  console.error(`\nATTENZIONE: checkpoint WAL fallito (${error.message}). La modifica potrebbe andare persa al prossimo rebuild.`);
}

show('Configurazione dopo la scrittura:');

function normalizeVat(value) {
  return String(value || '').trim().replace(/\s+/g, '').replace(/^IT/i, '');
}
