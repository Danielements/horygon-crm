// Contabilita Fase B: banca e riconciliazione.
// Import estratti conto CSV/XLSX con template di mapping colonne (nessuna banca
// cablata), idempotente via fingerprint UNIQUE. Riconciliazione: propone i
// candidati con un matchScore pesato e, all'abbinamento, riusa il modello
// pagamenti della Fase A (un movimento -> un pagamento collegato che aggiorna
// il paymentStatus derivato delle fatture).

const crypto = require('crypto');
const db = require('../db/database');
const cont = require('./contabilita-service');

const EPS = 0.005;

// --- helper puri (testabili senza DB) -------------------------------------

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Importo da testo: gestisce il formato italiano "1.234,56" e quello con punto
// decimale "1234.56". `decimale` indica il separatore decimale della banca.
function parseAmount(raw, decimale = ',') {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return raw;
  let s = String(raw).trim().replace(/\s|€|EUR/gi, '');
  if (!s) return null;
  // Segno finale stile "1.234,56-" (alcune banche).
  let sign = 1;
  if (/^-/.test(s) || /-$/.test(s)) sign = -1;
  s = s.replace(/[+-]/g, '');
  if (decimale === ',') {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  const n = Number(s);
  return Number.isNaN(n) ? null : sign * n;
}

// Data verso ISO YYYY-MM-DD. Gestisce Date, "DD/MM/YYYY", "YYYY-MM-DD",
// "DD-MM-YYYY", "DD.MM.YYYY".
function parseDate(raw) {
  if (!raw && raw !== 0) return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return `${raw.getFullYear()}-${String(raw.getMonth() + 1).padStart(2, '0')}-${String(raw.getDate()).padStart(2, '0')}`;
  }
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    let y = m[3];
    if (y.length === 2) y = (Number(y) > 70 ? '19' : '20') + y;
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

// Applica un template di mapping a una riga (oggetto colonna->valore). Il
// mapping e' { campo: nomeColonna }. Supporta importo unico con segno, oppure
// due colonne entrata/uscita.
function normalizeMovement(row, template = {}) {
  const map = template.mapping || {};
  const decimale = template.decimale || ',';
  const get = (campo) => {
    const col = map[campo];
    if (!col) return null;
    const v = row[col];
    return v == null ? null : v;
  };

  let importo = null;
  if (map.importo) {
    importo = parseAmount(get('importo'), decimale);
  } else {
    const entrata = parseAmount(get('entrata'), decimale);
    const uscita = parseAmount(get('uscita'), decimale);
    if (entrata != null && Math.abs(entrata) > EPS) importo = Math.abs(entrata);
    else if (uscita != null && Math.abs(uscita) > EPS) importo = -Math.abs(uscita);
    else importo = 0;
  }

  const clean = (v) => (v == null ? null : String(v).trim() || null);
  return {
    data_operazione: parseDate(get('data_operazione')),
    data_valuta: parseDate(get('data_valuta')),
    importo: importo != null ? round2(importo) : null,
    segno: importo == null ? null : (importo >= 0 ? 1 : -1),
    descrizione: clean(get('descrizione')),
    controparte: clean(get('controparte')),
    iban_controparte: clean(get('iban_controparte')),
    trn: clean(get('trn')),
    cro: clean(get('cro')),
    transaction_id: clean(get('transaction_id'))
  };
}

// Fingerprint per idempotenza: conto + data + importo + descrizione + trn/cro.
function computeFingerprint(conto_id, m) {
  const parts = [
    conto_id,
    m.data_operazione || '',
    m.importo != null ? m.importo.toFixed(2) : '',
    (m.descrizione || '').toLowerCase().replace(/\s+/g, ' ').trim(),
    m.trn || '',
    m.cro || '',
    m.transaction_id || ''
  ].join('|');
  return crypto.createHash('sha256').update(parts).digest('hex');
}

// Punteggio di abbinamento movimento<->fattura, 0..1. Pesato su importo, numero
// fattura nella descrizione, controparte, prossimita di data. Puro.
function matchScore(movimento, fattura) {
  let score = 0;
  const desc = `${movimento.descrizione || ''} ${movimento.controparte || ''}`.toLowerCase();
  const residuo = round2(fattura.residuo != null ? fattura.residuo : fattura.totale);

  // Importo: il movimento (in valore assoluto) copre il residuo? (peso 0.45)
  const abim = Math.abs(round2(movimento.importo));
  if (residuo > 0) {
    if (Math.abs(abim - residuo) <= EPS) score += 0.45;
    else if (abim <= residuo + EPS) score += 0.25;        // pagamento parziale plausibile
    else if (Math.abs(abim - round2(fattura.totale)) <= EPS) score += 0.35;
  }

  // Numero fattura citato in descrizione (peso 0.30).
  const numero = String(fattura.numero || fattura.numero_documento || '').toLowerCase().trim();
  if (numero && numero.length >= 2 && desc.includes(numero)) score += 0.30;

  // Controparte / ragione sociale (peso 0.20).
  const contro = String(fattura.controparte || '').toLowerCase().trim();
  if (contro && contro.length >= 3) {
    const primaParola = contro.split(/\s+/)[0];
    if (desc.includes(contro) || (primaParola.length >= 3 && desc.includes(primaParola))) score += 0.20;
  }

  // Prossimita temporale movimento<->scadenza/data (peso 0.05).
  const rifData = fattura.scadenza || fattura.data;
  if (movimento.data_operazione && rifData) {
    const giorni = Math.abs((new Date(movimento.data_operazione) - new Date(rifData)) / 86400000);
    if (giorni <= 45) score += 0.05;
  }

  return Math.min(1, round2(score));
}

// Direzione fattura attesa dal segno del movimento: entrata -> attiva (incasso),
// uscita -> passiva (pagamento).
function expectedDirection(segno) {
  return segno >= 0 ? 'attiva' : 'passiva';
}

// --- accesso DB ------------------------------------------------------------

function listConti() {
  return db.prepare('SELECT * FROM cont_conti ORDER BY attivo DESC, nome').all();
}
function listTemplate() {
  return db.prepare('SELECT * FROM cont_banca_template ORDER BY nome').all().map((t) => ({
    ...t, mapping: t.mapping ? JSON.parse(t.mapping) : {}
  }));
}

// Importa un batch di movimenti gia normalizzati (array di oggetti riga +
// template). Idempotente: fingerprint UNIQUE, INSERT OR IGNORE. Transazionale.
function importMovements({ conto_id, template, rows, fileName, userId }) {
  const conto = db.prepare('SELECT id FROM cont_conti WHERE id = ?').get(Number(conto_id));
  if (!conto) throw new Error('Conto inesistente');
  const list = Array.isArray(rows) ? rows : [];

  db.exec('BEGIN');
  try {
    const imp = db.prepare(`INSERT INTO cont_banca_import (conto_id, template_id, file_origine, righe_totali, creato_da)
      VALUES (?, ?, ?, ?, ?)`).run(Number(conto_id), template && template.id ? Number(template.id) : null, fileName || null, list.length, userId != null ? Number(userId) : null);
    const importId = Number(imp.lastInsertRowid);

    const ins = db.prepare(`INSERT OR IGNORE INTO cont_movimenti_bancari
      (conto_id, data_operazione, data_valuta, importo, segno, descrizione, controparte, iban_controparte, trn, cro, transaction_id, raw_data, fingerprint, import_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    let importate = 0, duplicate = 0, scartate = 0;
    for (const raw of list) {
      const m = normalizeMovement(raw, template || {});
      if (m.importo == null || !m.data_operazione) { scartate++; continue; }
      const fp = computeFingerprint(Number(conto_id), m);
      const r = ins.run(Number(conto_id), m.data_operazione, m.data_valuta, m.importo, m.segno,
        m.descrizione, m.controparte, m.iban_controparte, m.trn, m.cro, m.transaction_id,
        JSON.stringify(raw), fp, importId);
      if (r.changes > 0) importate++; else duplicate++;
    }
    db.prepare('UPDATE cont_banca_import SET righe_importate = ?, righe_duplicate = ? WHERE id = ?').run(importate, duplicate, importId);
    db.exec('COMMIT');
    return { import_id: importId, righe_totali: list.length, importate, duplicate, scartate };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Importa movimenti GIA' normalizzati (es. estratti dall'AI dal PDF), con la
// stessa idempotenza dell'import da file. movimenti: [{data_operazione, importo,
// descrizione, controparte?, data_valuta?}].
function importParsedMovements({ conto_id, movimenti, fileName, userId, source }) {
  const conto = db.prepare('SELECT id FROM cont_conti WHERE id = ?').get(Number(conto_id));
  if (!conto) throw new Error('Conto inesistente');
  const list = Array.isArray(movimenti) ? movimenti : [];

  db.exec('BEGIN');
  try {
    const imp = db.prepare(`INSERT INTO cont_banca_import (conto_id, file_origine, righe_totali, creato_da)
      VALUES (?, ?, ?, ?)`).run(Number(conto_id), fileName || null, list.length, userId != null ? Number(userId) : null);
    const importId = Number(imp.lastInsertRowid);
    const ins = db.prepare(`INSERT OR IGNORE INTO cont_movimenti_bancari
      (conto_id, data_operazione, data_valuta, importo, segno, descrizione, controparte, iban_controparte, trn, cro, transaction_id, raw_data, fingerprint, import_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    let importate = 0, duplicate = 0, scartate = 0;
    for (const raw of list) {
      const importo = round2(raw.importo);
      const data = raw.data_operazione ? String(raw.data_operazione).slice(0, 10) : null;
      if (importo == null || Number.isNaN(importo) || !data) { scartate++; continue; }
      const m = { data_operazione: data, importo, descrizione: raw.descrizione || null, trn: raw.trn || null, cro: raw.cro || null, transaction_id: raw.transaction_id || null };
      const fp = computeFingerprint(Number(conto_id), m);
      const r = ins.run(Number(conto_id), data, raw.data_valuta || null, importo, importo >= 0 ? 1 : -1,
        m.descrizione, raw.controparte || null, raw.iban_controparte || null, m.trn, m.cro, m.transaction_id,
        JSON.stringify(raw), fp, importId);
      if (r.changes > 0) importate++; else duplicate++;
    }
    db.prepare('UPDATE cont_banca_import SET righe_importate = ?, righe_duplicate = ? WHERE id = ?').run(importate, duplicate, importId);
    db.exec('COMMIT');
    return { import_id: importId, righe_totali: list.length, importate, duplicate, scartate };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function listMovimenti(filters = {}) {
  const where = ['1=1'];
  const params = [];
  if (filters.conto_id) { where.push('conto_id = ?'); params.push(Number(filters.conto_id)); }
  if (filters.stato) { where.push('stato_riconciliazione = ?'); params.push(filters.stato); }
  if (filters.dal) { where.push('data_operazione >= ?'); params.push(filters.dal); }
  if (filters.al) { where.push('data_operazione <= ?'); params.push(filters.al); }
  return db.prepare(`SELECT * FROM cont_movimenti_bancari WHERE ${where.join(' AND ')}
    ORDER BY data_operazione DESC, id DESC LIMIT ?`).all(...params, Number(filters.limit) || 500);
}

const DIREZIONE_SQL = `COALESCE(f.direzione, CASE WHEN f.tipo = 'emessa' THEN 'attiva' ELSE 'passiva' END)`;

// Candidati per un movimento: fatture con residuo aperto nella direzione attesa
// dal segno, ordinate per matchScore.
function reconciliationCandidates(movimentoId, limit = 10) {
  const mov = db.prepare('SELECT * FROM cont_movimenti_bancari WHERE id = ?').get(Number(movimentoId));
  if (!mov) throw new Error('Movimento inesistente');
  const direzione = expectedDirection(mov.segno);

  const fatture = db.prepare(`
    SELECT f.id, f.numero, f.numero_documento, f.data, f.scadenza, f.totale, f.stato, f.stato_pagamento,
           ${DIREZIONE_SQL} AS direzione,
           COALESCE(a.ragione_sociale, f.cliente_fornitore_label) AS controparte,
           (SELECT COALESCE(SUM(importo_quota),0) FROM cont_pagamenti_fatture pf WHERE pf.fattura_id = f.id) AS pagato
    FROM fatture f LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id
    WHERE ${DIREZIONE_SQL} = ?
  `).all(direzione).map((f) => ({ ...f, residuo: cont.effectiveResiduo(f.totale, f.pagato, f.stato_pagamento, f.stato) }))
    .filter((f) => f.residuo > EPS);

  return fatture
    .map((f) => ({ ...f, score: matchScore(mov, f) }))
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// Abbina un movimento a una o piu fatture: crea un pagamento collegato al
// movimento e aggiorna gli stati. allocazioni: [{fattura_id, importo_quota}].
function reconcile(movimentoId, allocazioni, userId) {
  const mov = db.prepare('SELECT * FROM cont_movimenti_bancari WHERE id = ?').get(Number(movimentoId));
  if (!mov) throw new Error('Movimento inesistente');
  if (mov.stato_riconciliazione === 'riconciliato') throw new Error('Movimento gia riconciliato');

  const norm = (Array.isArray(allocazioni) ? allocazioni : [])
    .map((a) => ({ fattura_id: Number(a.fattura_id), importo_quota: round2(a.importo_quota) }))
    .filter((a) => a.fattura_id && a.importo_quota > 0);
  if (!norm.length) throw new Error('Nessuna allocazione');

  const sommaQuote = round2(norm.reduce((s, a) => s + a.importo_quota, 0));
  const importoMov = Math.abs(round2(mov.importo));
  if (sommaQuote - importoMov > EPS) throw new Error(`Le quote (${sommaQuote}) superano l'importo del movimento (${importoMov})`);

  const pagamento = cont.registerPayment({
    verso: mov.segno >= 0 ? 'incasso' : 'pagamento',
    data: mov.data_operazione,
    importo: importoMov,
    metodo: 'banca',
    movimento_bancario_id: Number(movimentoId),
    note: mov.descrizione || null,
    allocazioni: norm
  }, userId);

  const stato = Math.abs(sommaQuote - importoMov) <= EPS ? 'riconciliato' : 'parziale';
  db.prepare('UPDATE cont_movimenti_bancari SET stato_riconciliazione = ? WHERE id = ?').run(stato, Number(movimentoId));
  return { movimento_id: Number(movimentoId), stato, pagamento_id: pagamento.id, fatture: pagamento.fatture };
}

function ignoreMovement(movimentoId) {
  const info = db.prepare("UPDATE cont_movimenti_bancari SET stato_riconciliazione = 'ignorato' WHERE id = ?").run(Number(movimentoId));
  return { updated: info.changes > 0 };
}

module.exports = {
  // puri
  round2,
  parseAmount,
  parseDate,
  normalizeMovement,
  computeFingerprint,
  matchScore,
  expectedDirection,
  // db
  listConti,
  listTemplate,
  importMovements,
  importParsedMovements,
  listMovimenti,
  reconciliationCandidates,
  reconcile,
  ignoreMovement
};
