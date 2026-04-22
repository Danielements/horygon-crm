const db = require('../src/db/database');
const { scanAndImportAll } = require('../src/services/mepa-parser');

db.exec('DELETE FROM mepa_ordini; DELETE FROM mepa_import_log;');

const results = scanAndImportAll();
const summary = {
  results,
  rows: db.prepare('SELECT COUNT(*) n FROM mepa_ordini').get().n,
  cpv: db.prepare('SELECT COUNT(DISTINCT codice_cpv) n FROM mepa_ordini').get().n,
  value: db.prepare('SELECT SUM(valore_economico) v FROM mepa_ordini').get().v,
  top: db.prepare(`
    SELECT codice_cpv, descrizione_cpv, SUM(valore_economico) valore, SUM(n_ordini) ordini
    FROM mepa_ordini
    GROUP BY codice_cpv
    ORDER BY valore DESC
    LIMIT 15
  `).all(),
  guanti: db.prepare(`
    SELECT codice_cpv, descrizione_cpv, SUM(valore_economico) valore, SUM(n_ordini) ordini
    FROM mepa_ordini
    WHERE UPPER(descrizione_cpv) LIKE '%GUANTI%'
    GROUP BY codice_cpv, descrizione_cpv
    ORDER BY valore DESC
  `).all(),
};

console.log(JSON.stringify(summary, null, 2));
