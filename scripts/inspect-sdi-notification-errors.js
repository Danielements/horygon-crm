const db = require('../src/db/database');

const limit = Math.max(1, Math.min(Number(process.argv[2] || 20), 100));

const rows = db.prepare(`
  SELECT
    n.creato_il,
    n.tipo_notifica,
    n.stato_normalizzato,
    n.identificativo_sdi,
    n.nome_file_fattura,
    n.codice,
    n.descrizione,
    n.xml_path,
    f.numero,
    f.stato_sdi,
    a.ragione_sociale
  FROM fatture_sdi_notifiche n
  LEFT JOIN fatture f ON f.id = n.fattura_id
  LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id
  WHERE COALESCE(n.codice, '') <> ''
     OR COALESCE(n.descrizione, '') <> ''
     OR n.stato_normalizzato IN ('scarto', 'mancata_consegna', 'sconosciuto')
  ORDER BY n.id DESC
  LIMIT ?
`).all(limit);

if (!rows.length) {
  console.log('Nessuna notifica SDI con errore trovata.');
  process.exit(0);
}

for (const row of rows) {
  console.log([
    `${row.creato_il || '-'}`,
    `${row.tipo_notifica || '-'} / ${row.stato_normalizzato || '-'}`,
    `fattura=${row.numero || '-'}`,
    `cliente=${row.ragione_sociale || '-'}`,
    `sdi=${row.identificativo_sdi || '-'}`,
    `file=${row.nome_file_fattura || '-'}`,
    `codice=${row.codice || '-'}`,
    `descrizione=${row.descrizione || '-'}`,
    `xml=${row.xml_path || '-'}`
  ].join(' | '));
}
