// Contabilita Fase F: pacchetto per il commercialista esterno.
// Non fa contabilita fiscale: prepara una CHECKLIST "stato del mese" e un
// EXPORT ZIP (riepiloghi CSV + XML/P7M originali delle fatture del periodo).
// Gli originali non vengono mai modificati, solo copiati nell'archivio.

const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const { buildZip } = require('./zip-store');

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

const DIREZIONE_SQL = `COALESCE(f.direzione, CASE WHEN f.tipo = 'emessa' THEN 'attiva' ELSE 'passiva' END)`;

// Normalizza YYYY-MM (o accetta gia normalizzato). Ritorna il prefisso like.
function periodLike(periodo) {
  const p = String(periodo || '').trim();
  if (/^\d{4}-\d{2}$/.test(p)) return `${p}%`;
  if (/^\d{4}$/.test(p)) return `${p}%`;
  return `${new Date().toISOString().slice(0, 7)}%`;
}

// Checklist dello stato del mese. Ogni voce: { chiave, label, esito, count,
// dettaglio }. `pronto` e' true se non ci sono voci di attenzione bloccanti.
function statoMese(periodo) {
  const like = periodLike(periodo);

  const fatture = db.prepare(`SELECT f.id, f.numero, f.data, f.totale, f.anagrafica_id, f.cliente_fornitore_label
    FROM fatture f WHERE COALESCE(f.data,'') LIKE ?`).all(like);
  const fattureIncomplete = fatture.filter((f) =>
    !f.data || f.totale == null || (f.anagrafica_id == null && !f.cliente_fornitore_label));

  const speseNonClass = db.prepare(`SELECT COUNT(*) AS n FROM cont_spese
    WHERE stato != 'archiviata' AND categoria_id IS NULL AND centro_costo_id IS NULL AND commessa_id IS NULL
      AND COALESCE(data,'') LIKE ?`).get(like).n;

  const movNonRic = db.prepare(`SELECT COUNT(*) AS n FROM cont_movimenti_bancari
    WHERE stato_riconciliazione = 'da_riconciliare' AND COALESCE(data_operazione,'') LIKE ?`).get(like).n;

  const pagNonAlloc = db.prepare(`SELECT COUNT(*) AS n FROM cont_pagamenti p
    WHERE COALESCE(p.data,'') LIKE ? AND NOT EXISTS (SELECT 1 FROM cont_pagamenti_fatture pf WHERE pf.pagamento_id = p.id)`).get(like).n;

  const voci = [
    { chiave: 'fatture', label: 'Fatture del periodo', esito: 'ok', count: fatture.length, dettaglio: `${fatture.length} documenti` },
    { chiave: 'fatture_incomplete', label: 'Fatture con dati mancanti', esito: fattureIncomplete.length ? 'warn' : 'ok', count: fattureIncomplete.length, dettaglio: fattureIncomplete.length ? `${fattureIncomplete.length} da completare (data/importo/controparte)` : 'tutte complete' },
    { chiave: 'spese_non_classificate', label: 'Spese non classificate', esito: speseNonClass ? 'warn' : 'ok', count: speseNonClass, dettaglio: speseNonClass ? `${speseNonClass} senza categoria/centro/commessa` : 'tutte classificate' },
    { chiave: 'movimenti_non_riconciliati', label: 'Movimenti bancari non riconciliati', esito: movNonRic ? 'warn' : 'ok', count: movNonRic, dettaglio: movNonRic ? `${movNonRic} da riconciliare` : 'nessuno in sospeso' },
    { chiave: 'pagamenti_non_allocati', label: 'Pagamenti non abbinati', esito: pagNonAlloc ? 'warn' : 'ok', count: pagNonAlloc, dettaglio: pagNonAlloc ? `${pagNonAlloc} senza fattura` : 'tutti abbinati' }
  ];
  const pronto = voci.every((v) => v.esito === 'ok');
  return { periodo, pronto, voci };
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(header, rows) {
  return '﻿' + [header.join(';')].concat(rows.map((r) => r.map(csvEscape).join(';'))).join('\r\n');
}

// Costruisce lo ZIP del periodo: riepiloghi + XML/P7M originali. Ritorna
// { filename, buffer, conteggi }.
function buildExport(periodo) {
  const like = periodLike(periodo);
  const entries = [];

  const fatture = db.prepare(`SELECT f.id, f.numero, f.numero_documento, f.data, ${DIREZIONE_SQL} AS direzione,
      f.tipo_documento, f.imponibile, f.iva, f.totale, f.stato_pagamento,
      COALESCE(a.ragione_sociale, f.cliente_fornitore_label) AS controparte,
      f.xml_path, f.original_file_path, f.original_filename
    FROM fatture f LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id
    WHERE COALESCE(f.data,'') LIKE ? ORDER BY f.data, f.id`).all(like);

  entries.push({ name: 'riepilogo-fatture.csv', data: Buffer.from(toCsv(
    ['Numero', 'Data', 'Direzione', 'Tipo', 'Controparte', 'Imponibile', 'IVA', 'Totale', 'Stato pagamento'],
    fatture.map((f) => [f.numero || f.numero_documento, f.data, f.direzione, f.tipo_documento, f.controparte, f.imponibile, f.iva, f.totale, f.stato_pagamento])
  ), 'utf8') });

  const spese = db.prepare(`SELECT data, fornitore_nome, numero_documento, imponibile, iva, totale, metodo_pagamento, pagata_con
    FROM cont_spese WHERE stato != 'archiviata' AND COALESCE(data,'') LIKE ? ORDER BY data, id`).all(like);
  entries.push({ name: 'riepilogo-spese.csv', data: Buffer.from(toCsv(
    ['Data', 'Fornitore', 'N. documento', 'Imponibile', 'IVA', 'Totale', 'Metodo', 'Pagata con'],
    spese.map((s) => [s.data, s.fornitore_nome, s.numero_documento, s.imponibile, s.iva, s.totale, s.metodo_pagamento, s.pagata_con])
  ), 'utf8') });

  // XML/P7M originali delle fatture (mai modificati, solo copiati).
  let allegati = 0;
  const usati = new Set();
  for (const f of fatture) {
    const src = f.xml_path || f.original_file_path;
    if (!src) continue;
    try {
      if (!fs.existsSync(src)) continue;
      let base = f.original_filename || path.basename(src);
      let name = `fatture/${base}`;
      let i = 1;
      while (usati.has(name)) { name = `fatture/${f.id}-${base}`; if (usati.has(name)) name = `fatture/${f.id}-${i++}-${base}`; }
      usati.add(name);
      entries.push({ name, data: fs.readFileSync(src) });
      allegati++;
    } catch { /* un file illeggibile non blocca l'export */ }
  }

  const buffer = buildZip(entries);
  const filename = `commercialista-${String(periodo || '').replace(/[^\w-]/g, '') || 'periodo'}.zip`;
  return { filename, buffer, conteggi: { fatture: fatture.length, spese: spese.length, allegati } };
}

module.exports = { periodLike, statoMese, buildExport, toCsv };
