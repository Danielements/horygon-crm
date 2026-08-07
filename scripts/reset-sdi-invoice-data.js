// Azzera i dati fattura e i flussi SdI, lasciando intatto tutto il resto del CRM.
//
// Di default gira in dry-run: mostra cosa verrebbe cancellato senza toccare nulla.
// Per eseguire davvero serve --confirm.
//
//   node scripts/reset-sdi-invoice-data.js                 # dry-run
//   node scripts/reset-sdi-invoice-data.js --confirm       # esegue
//   node scripts/reset-sdi-invoice-data.js --confirm --reset-progressivo
//
// NON tocca: anagrafiche, prodotti, ordini, preventivi, DDT, magazzino, MEPA,
// RdO, CIG, utenti, ruoli, permessi, app_settings, sdi_schema_registry,
// google_tokens, audit_log, system_log.

const fs = require('fs');
const path = require('path');
const db = require('../src/db/database');

// Ordine di cancellazione: prima i figli, poi i padri.
const TARGET_TABLES = [
  'fatture_righe',
  'fatture_iva_riepilogo',
  'fatture_sdi_notifiche',
  'sdi_interoperability_tests',
  'fatture_sdi_flussi',
  'fatture'
];

const PRESERVED_TABLES = [
  'anagrafiche', 'prodotti', 'ordini', 'preventivi', 'ddt', 'magazzino_movimenti',
  'mepa_ordini', 'rdo_rows', 'mepa_cpv_catalog', 'utenti', 'ruoli', 'permessi',
  'app_settings', 'sdi_schema_registry', 'google_tokens', 'audit_log', 'system_log'
];

const confirm = process.argv.includes('--confirm');
const resetProgressivo = process.argv.includes('--reset-progressivo');

function countRows(table) {
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  } catch {
    return null;
  }
}

function snapshot(tables) {
  return tables.map((table) => ({ table, rows: countRows(table) }));
}

function printTable(rows, title) {
  console.log(`\n${title}`);
  rows.forEach(({ table, rows: n }) => {
    console.log(`  ${String(n === null ? 'n/d' : n).padStart(8)}  ${table}`);
  });
}

function backupDatabase() {
  const source = process.env.DB_PATH || path.resolve(__dirname, '../horygon.db');
  if (!fs.existsSync(source)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const destination = `${source}.backup-${stamp}`;
  // Checkpoint del WAL prima della copia: nel container i sidecar non sono
  // montati e senza checkpoint il backup risulterebbe incompleto.
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
  fs.copyFileSync(source, destination);
  return destination;
}

const before = snapshot(TARGET_TABLES);
printTable(before, 'Tabelle che verrebbero azzerate:');
printTable(snapshot(PRESERVED_TABLES), 'Tabelle preservate (non toccate):');

const progressivo = db.prepare("SELECT valore FROM sdi_progressivi WHERE chiave = 'outbound_file'").get();
console.log(`\nSequenza progressivi SdI: ${progressivo ? progressivo.valore : 'non inizializzata'}`);
if (progressivo && !resetProgressivo) {
  console.log('  La sequenza NON viene azzerata: i nomi file gia inviati al SdI');
  console.log('  restano bruciati per sempre (controllo 00002). Usa --reset-progressivo');
  console.log('  solo se sai che quei progressivi non sono mai arrivati al SdI.');
}

const totalToDelete = before.reduce((sum, row) => sum + (row.rows || 0), 0);

if (!confirm) {
  console.log(`\n--- DRY RUN --- ${totalToDelete} righe verrebbero cancellate. Nessuna modifica effettuata.`);
  console.log('Per eseguire davvero: aggiungi --confirm');
  process.exit(0);
}

const backup = backupDatabase();
console.log(`\nBackup creato: ${backup || 'NON CREATO (percorso database non trovato)'}`);

db.exec('BEGIN');
try {
  TARGET_TABLES.forEach((table) => {
    try { db.prepare(`DELETE FROM ${table}`).run(); } catch (error) {
      console.error(`  errore su ${table}: ${error.message}`);
      throw error;
    }
  });
  if (resetProgressivo) {
    db.prepare("DELETE FROM sdi_progressivi WHERE chiave = 'outbound_file'").run();
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  console.error(`\nAnnullato, nessuna modifica applicata: ${error.message}`);
  process.exit(1);
}

// Nel container e' montato solo horygon.db, non i sidecar -wal/-shm: senza
// checkpoint le modifiche restano nel WAL, che vive nel layer scrivibile e
// viene buttato via al primo "docker compose up --build". Sopravvivono al
// restart ma non alla ricreazione del container.
try {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  console.log('\nCheckpoint WAL eseguito: le modifiche sono nel file del database.');
} catch (error) {
  console.error(`\nATTENZIONE: checkpoint WAL fallito (${error.message}). Le modifiche potrebbero andare perse al prossimo rebuild del container.`);
}

printTable(snapshot(TARGET_TABLES), 'Dopo la cancellazione:');
console.log(`\nFatto. ${totalToDelete} righe rimosse. Backup: ${backup}`);
