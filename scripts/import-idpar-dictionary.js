#!/usr/bin/env node
'use strict';

// Importa data/rtws-idpar-dictionary.json (generato da rtws-dictionary-scan.js
// sull'host) nella tabella CRM rtws_idpar_dizionario.
// Fa UPSERT: aggiunge i nuovi idpar e aggiorna le descrizioni cambiate,
// preservando hit_count. Rilanciabile in sicurezza dopo ogni scansione.
//
// Va eseguito DENTRO il container (usa node:sqlite, richiede Node moderno):
//   docker compose exec horygon-crm node scripts/import-idpar-dictionary.js
//
// Opzionale: passare un percorso JSON alternativo come primo argomento.

require('../src/config/load-env');
const fs = require('fs');
const path = require('path');
const db = require('../src/db/database');

function main() {
  const jsonPath = process.argv[2] || path.resolve(__dirname, '..', 'data', 'rtws-idpar-dictionary.json');
  if (!fs.existsSync(jsonPath)) {
    console.error('File dizionario non trovato: ' + jsonPath);
    console.error('Genera prima il dizionario sull\'host con: node scripts/rtws-dictionary-scan.js <Marca> <Modello> <Versione>');
    process.exit(1);
  }

  let dict;
  try {
    dict = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    console.error('JSON non valido: ' + e.message);
    process.exit(1);
  }

  const entries = Object.keys(dict);
  console.log('Voci nel file: ' + entries.length + '  (' + jsonPath + ')');

  const upsert = db.prepare(`
    INSERT INTO rtws_idpar_dizionario (idpar, descrizione, fonte)
    VALUES (?, ?, 'scan')
    ON CONFLICT(idpar) DO UPDATE SET
      descrizione = excluded.descrizione,
      updated_at = datetime('now')
    WHERE rtws_idpar_dizionario.descrizione <> excluded.descrizione
  `);

  const before = db.prepare('SELECT COUNT(*) AS c FROM rtws_idpar_dizionario').get().c;

  db.exec('BEGIN');
  try {
    entries.forEach(function (idpar) {
      const n = parseInt(idpar, 10);
      const descr = String(dict[idpar] || '').trim();
      if (!Number.isNaN(n) && descr) upsert.run(n, descr);
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('Import fallito, rollback: ' + e.message);
    process.exit(1);
  }

  const after = db.prepare('SELECT COUNT(*) AS c FROM rtws_idpar_dizionario').get().c;
  console.log('Voci in tabella prima : ' + before);
  console.log('Voci in tabella dopo  : ' + after);
  console.log('Nuove voci aggiunte   : ' + (after - before));
  console.log('\nEsempi in tabella:');
  db.prepare('SELECT idpar, descrizione FROM rtws_idpar_dizionario ORDER BY idpar LIMIT 8').all().forEach(function (r) {
    console.log('  ' + r.idpar + '  ' + r.descrizione);
  });
  console.log('\nImport completato.');
}

main();
