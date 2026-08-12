const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

// Seed delle regole IVA dal CSV normativo consegnato con il progetto.
//
// E' un upsert per `codice`, non un delete-and-insert: le regole sono
// referenziate dalle righe dei documenti storici, e ricrearle cambierebbe gli
// id sotto i piedi allo storico. Per lo stesso motivo qui non si cancella mai
// niente: una regola che esce dal CSV resta in tabella, al massimo si
// disattiva a mano.
//
// L'aggiornamento tocca solo i campi amministrativi (descrizione, note,
// riferimento normativo, priorita', fonte). **Aliquota e natura di una regola
// gia' esistente non vengono sovrascritte**: sono i dati con cui sono stati
// calcolati documenti veri, e cambiarli in silenzio riscriverebbe la storia.
// Se una regola cambia nel merito, si crea un codice nuovo e si chiude il
// vecchio con `valido_al`.

const CSV_PATH = path.resolve(__dirname, '../iva_rules_crm_import.csv');

function readRules(csvPath = CSV_PATH) {
  if (!fs.existsSync(csvPath)) return [];
  const raw = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '');
  return parse(raw, {
    delimiter: ';',
    columns: true,
    skip_empty_lines: true,
    trim: true,
    // Le note d'uso contengono virgolette e punti e virgola dentro campi
    // quotati: senza questo il parser si impunta a meta' file.
    relax_quotes: true
  });
}

// Il CSV scrive i booleani alla Python.
function toFlag(value, fallback = 0) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return fallback;
  return ['true', '1', 'si', 'sì', 'yes', 'x'].includes(text) ? 1 : 0;
}

function toText(value) {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}

function toNumber(value) {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  const parsed = Number(text.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function mapRow(row) {
  const tipoRegola = toText(row.rule_type) || 'VAT_TREATMENT';
  const naturaIva = toText(row.natura_sdi);
  const aliquota = toNumber(row.vat_rate);
  return {
    codice: toText(row.code),
    codice_sorgente: toText(row.id),
    tipo_regola: tipoRegola,
    gruppo_esclusivo: toText(row.exclusive_group),
    descrizione: toText(row.description),
    // Una regola di sola esigibilita' non porta aliquota: lasciarla a 0
    // la farebbe sembrare un'operazione a IVA zero, che e' un'altra cosa.
    aliquota_iva: tipoRegola === 'VAT_DUE' ? null : (aliquota ?? 0),
    natura_iva: naturaIva,
    esigibilita_iva: toText(row.esigibilita_sdi),
    etichetta_fattura: toText(row.invoice_label_suggested),
    riferimento_normativo: toText(row.normative_reference),
    note_uso: toText(row.use_case_notes),
    revisione_manuale: toFlag(row.manual_review, 0),
    attiva: toFlag(row.active, 1),
    valido_dal: toText(row.valid_from),
    valido_al: toText(row.valid_to),
    priorita: toNumber(row.priority) ?? 0,
    fonte_url: toText(row.source_url),
    verificato_il: toText(row.verified_on)
  };
}

function seedRegoleIva(db, csvPath = CSV_PATH) {
  let rows;
  try {
    rows = readRules(csvPath);
  } catch (error) {
    // Un CSV illeggibile non deve impedire l'avvio: le regole gia' in tabella
    // restano valide e i documenti usano comunque il proprio snapshot.
    return { inserted: 0, updated: 0, skipped: 0, error: error.message };
  }

  const insert = db.prepare(`
    INSERT INTO regole_iva (
      codice, codice_sorgente, tipo_regola, gruppo_esclusivo, descrizione,
      aliquota_iva, natura_iva, esigibilita_iva, etichetta_fattura,
      riferimento_normativo, note_uso, revisione_manuale, attiva,
      valido_dal, valido_al, priorita, fonte_url, verificato_il
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  // Nessun `attiva` qui dentro: se un amministratore ha disattivato una regola
  // dal CRUD, il seed al riavvio non deve riaccenderla.
  const update = db.prepare(`
    UPDATE regole_iva SET
      codice_sorgente = ?, tipo_regola = ?, gruppo_esclusivo = ?, descrizione = ?,
      etichetta_fattura = ?, riferimento_normativo = ?, note_uso = ?,
      revisione_manuale = ?, priorita = ?, fonte_url = ?, verificato_il = ?,
      aggiornato_il = datetime('now')
    WHERE codice = ?
  `);
  const existing = db.prepare('SELECT id FROM regole_iva WHERE codice = ?');

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const raw of rows) {
    const rule = mapRow(raw);
    if (!rule.codice) { skipped += 1; continue; }
    try {
      if (existing.get(rule.codice)) {
        update.run(
          rule.codice_sorgente, rule.tipo_regola, rule.gruppo_esclusivo, rule.descrizione,
          rule.etichetta_fattura, rule.riferimento_normativo, rule.note_uso,
          rule.revisione_manuale, rule.priorita, rule.fonte_url, rule.verificato_il,
          rule.codice
        );
        updated += 1;
      } else {
        insert.run(
          rule.codice, rule.codice_sorgente, rule.tipo_regola, rule.gruppo_esclusivo, rule.descrizione,
          rule.aliquota_iva, rule.natura_iva, rule.esigibilita_iva, rule.etichetta_fattura,
          rule.riferimento_normativo, rule.note_uso, rule.revisione_manuale, rule.attiva,
          rule.valido_dal, rule.valido_al, rule.priorita, rule.fonte_url, rule.verificato_il
        );
        inserted += 1;
      }
    } catch {
      skipped += 1;
    }
  }

  return { inserted, updated, skipped };
}

module.exports = { CSV_PATH, mapRow, readRules, seedRegoleIva };
