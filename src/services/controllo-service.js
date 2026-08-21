// Contabilita Fase E: anticipi, rimborsi (nota spese), budget e controllo di
// gestione (consuntivo vs budget). Report interni: non un bilancio.
//
// Rimborsi: aggregano spese pagate con anticipo personale (documentate a livello
// di spesa). Stati DRAFT -> TO_REVIEW -> APPROVED -> PAID; al pagamento si
// registra l'uscita di cassa (riuso cont_pagamenti).

const db = require('../db/database');
const cont = require('./contabilita-service');

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// --- transizioni di stato rimborso (pura) ---------------------------------

const RIMBORSO_FLOW = { DRAFT: ['TO_REVIEW'], TO_REVIEW: ['APPROVED', 'DRAFT'], APPROVED: ['PAID', 'TO_REVIEW'], PAID: [] };

function canTransition(from, to) {
  return (RIMBORSO_FLOW[from] || []).includes(to);
}

// Scostamento budget: consuntivo vs budget. Puro.
function budgetVariance(budget, consuntivo) {
  const b = round2(budget), c = round2(consuntivo);
  return { budget: b, consuntivo: c, scostamento: round2(c - b), perc: b ? round2((c / b) * 100) : null };
}

// --- rimborsi --------------------------------------------------------------

function anticipoDisponibili() {
  return db.prepare(`SELECT s.*, cat.nome AS categoria_nome
    FROM cont_spese s LEFT JOIN cont_categorie cat ON cat.id = s.categoria_id
    WHERE s.pagata_con = 'anticipo_personale' AND s.rimborso_id IS NULL AND s.stato != 'archiviata'
    ORDER BY s.data DESC, s.id DESC`).all();
}

function recomputeRimborsoTotale(rimborsoId) {
  const r = db.prepare('SELECT COALESCE(SUM(totale),0) AS tot FROM cont_spese WHERE rimborso_id = ?').get(Number(rimborsoId));
  const tot = round2(r.tot);
  db.prepare("UPDATE cont_rimborsi SET totale = ?, aggiornato_il = datetime('now') WHERE id = ?").run(tot, Number(rimborsoId));
  return tot;
}

function createRimborso(input, userId) {
  const info = db.prepare(`INSERT INTO cont_rimborsi (beneficiario, utente_id, periodo, note, creato_da)
    VALUES (?, ?, ?, ?, ?)`).run(input.beneficiario || null, input.utente_id ? Number(input.utente_id) : null,
    input.periodo || null, input.note || null, userId != null ? Number(userId) : null);
  return { id: Number(info.lastInsertRowid) };
}

function listRimborsi() {
  return db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM cont_spese s WHERE s.rimborso_id = r.id) AS n_spese
    FROM cont_rimborsi r ORDER BY r.creato_il DESC`).all();
}

function getRimborso(id) {
  const testata = db.prepare('SELECT * FROM cont_rimborsi WHERE id = ?').get(Number(id));
  if (!testata) throw new Error('Rimborso inesistente');
  const spese = db.prepare(`SELECT s.*, cat.nome AS categoria_nome, d.original_filename AS documento_nome
    FROM cont_spese s LEFT JOIN cont_categorie cat ON cat.id = s.categoria_id
    LEFT JOIN cont_documenti d ON d.id = s.documento_id
    WHERE s.rimborso_id = ? ORDER BY s.data, s.id`).all(Number(id));
  return { ...testata, spese };
}

function assertEditable(rimborsoId) {
  const r = db.prepare('SELECT stato FROM cont_rimborsi WHERE id = ?').get(Number(rimborsoId));
  if (!r) throw new Error('Rimborso inesistente');
  if (r.stato !== 'DRAFT') throw new Error('Il rimborso non e piu modificabile (non e in bozza)');
}

function attachSpese(rimborsoId, speseIds) {
  assertEditable(rimborsoId);
  const ids = (Array.isArray(speseIds) ? speseIds : []).map(Number).filter(Boolean);
  db.exec('BEGIN');
  try {
    const upd = db.prepare(`UPDATE cont_spese SET rimborso_id = ?
      WHERE id = ? AND pagata_con = 'anticipo_personale' AND rimborso_id IS NULL`);
    ids.forEach((id) => upd.run(Number(rimborsoId), id));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { totale: recomputeRimborsoTotale(rimborsoId) };
}

function detachSpesa(rimborsoId, spesaId) {
  assertEditable(rimborsoId);
  db.prepare('UPDATE cont_spese SET rimborso_id = NULL WHERE id = ? AND rimborso_id = ?').run(Number(spesaId), Number(rimborsoId));
  return { totale: recomputeRimborsoTotale(rimborsoId) };
}

// Cambia stato. Al passaggio a PAID registra l'uscita di cassa collegata.
function transitionRimborso(rimborsoId, to, userId, extra = {}) {
  const r = db.prepare('SELECT * FROM cont_rimborsi WHERE id = ?').get(Number(rimborsoId));
  if (!r) throw new Error('Rimborso inesistente');
  if (!canTransition(r.stato, to)) throw new Error(`Transizione non consentita: ${r.stato} -> ${to}`);
  if (to === 'TO_REVIEW' && round2(r.totale) <= 0) throw new Error('Rimborso vuoto: aggiungi almeno una spesa');

  let pagamentoId = r.pagamento_id;
  if (to === 'PAID') {
    const pag = cont.registerPayment({
      verso: 'pagamento', data: extra.pagato_il || new Date().toISOString().slice(0, 10),
      importo: round2(r.totale), metodo: extra.metodo || 'rimborso',
      note: `Rimborso nota spese #${r.id}${r.beneficiario ? ' - ' + r.beneficiario : ''}`
    }, userId);
    pagamentoId = pag.id;
  }
  db.prepare(`UPDATE cont_rimborsi SET stato = ?, approvato_da = ?, pagato_il = ?, pagamento_id = ?, aggiornato_il = datetime('now') WHERE id = ?`)
    .run(to,
      to === 'APPROVED' ? (userId != null ? Number(userId) : null) : r.approvato_da,
      to === 'PAID' ? (extra.pagato_il || new Date().toISOString().slice(0, 10)) : r.pagato_il,
      pagamentoId, Number(rimborsoId));
  return { id: Number(rimborsoId), stato: to, pagamento_id: pagamentoId };
}

// --- budget e controllo di gestione ---------------------------------------

function createBudget(input) {
  if (!input.periodo) throw new Error('Periodo obbligatorio');
  const importo = round2(input.importo_budget);
  if (!(importo > 0)) throw new Error('Importo budget non valido');
  const info = db.prepare(`INSERT INTO cont_budget (periodo, categoria_id, centro_costo_id, commessa_id, importo_budget, note)
    VALUES (?, ?, ?, ?, ?, ?)`).run(input.periodo, input.categoria_id || null, input.centro_costo_id || null,
    input.commessa_id || null, importo, input.note || null);
  return { id: Number(info.lastInsertRowid) };
}

function deleteBudget(id) {
  const info = db.prepare('DELETE FROM cont_budget WHERE id = ?').run(Number(id));
  return { deleted: info.changes > 0 };
}

function listBudget(periodo) {
  const where = periodo ? 'WHERE b.periodo = ?' : '';
  const params = periodo ? [periodo] : [];
  return db.prepare(`SELECT b.*, cat.nome AS categoria_nome, cc.nome AS centro_nome, co.nome AS commessa_nome
    FROM cont_budget b
    LEFT JOIN cont_categorie cat ON cat.id = b.categoria_id
    LEFT JOIN cont_centri_costo cc ON cc.id = b.centro_costo_id
    LEFT JOIN cont_commesse co ON co.id = b.commessa_id
    ${where} ORDER BY b.periodo, b.id`).all(...params);
}

// Consuntivo per categoria in un periodo (prefisso data, es. '2026' o
// '2026-08'): spese dirette + quote di classificazione delle fatture.
function consuntivoPerCategoria(periodo) {
  const like = `${periodo}%`;
  const acc = new Map();
  const add = (id, imp) => { if (id == null) return; acc.set(id, round2((acc.get(id) || 0) + imp)); };

  db.prepare(`SELECT categoria_id, COALESCE(SUM(totale),0) AS tot FROM cont_spese
    WHERE stato != 'archiviata' AND categoria_id IS NOT NULL AND COALESCE(data,'') LIKE ?
    GROUP BY categoria_id`).all(like).forEach((r) => add(r.categoria_id, r.tot));

  db.prepare(`SELECT c.categoria_id, COALESCE(SUM(c.importo),0) AS tot
    FROM cont_classificazioni c JOIN fatture f ON f.id = c.entita_id
    WHERE c.entita_tipo = 'fattura' AND c.categoria_id IS NOT NULL AND COALESCE(f.data,'') LIKE ?
    GROUP BY c.categoria_id`).all(like).forEach((r) => add(r.categoria_id, r.tot));

  return acc;
}

// Report: per ogni budget del periodo, budget vs consuntivo; piu le categorie
// con consuntivo ma senza budget.
function reportGestionale(periodo) {
  if (!periodo) periodo = String(new Date().getFullYear());
  const consuntivo = consuntivoPerCategoria(periodo);
  const budgets = db.prepare(`SELECT b.categoria_id, b.importo_budget, cat.nome AS categoria_nome
    FROM cont_budget b LEFT JOIN cont_categorie cat ON cat.id = b.categoria_id
    WHERE b.periodo = ? AND b.categoria_id IS NOT NULL`).all(periodo);

  const righe = [];
  const visti = new Set();
  budgets.forEach((b) => {
    visti.add(b.categoria_id);
    righe.push({ categoria_id: b.categoria_id, categoria_nome: b.categoria_nome, ...budgetVariance(b.importo_budget, consuntivo.get(b.categoria_id) || 0) });
  });
  for (const [catId, cons] of consuntivo.entries()) {
    if (visti.has(catId)) continue;
    const nome = db.prepare('SELECT nome FROM cont_categorie WHERE id = ?').get(catId);
    righe.push({ categoria_id: catId, categoria_nome: nome ? nome.nome : `#${catId}`, ...budgetVariance(0, cons) });
  }
  righe.sort((a, b) => b.consuntivo - a.consuntivo);
  const tot = righe.reduce((s, r) => ({ budget: s.budget + r.budget, consuntivo: s.consuntivo + r.consuntivo }), { budget: 0, consuntivo: 0 });
  return { periodo, righe, totali: { budget: round2(tot.budget), consuntivo: round2(tot.consuntivo), scostamento: round2(tot.consuntivo - tot.budget) } };
}

module.exports = {
  round2,
  canTransition,
  budgetVariance,
  RIMBORSO_FLOW,
  // rimborsi
  anticipoDisponibili,
  createRimborso,
  listRimborsi,
  getRimborso,
  attachSpese,
  detachSpesa,
  recomputeRimborsoTotale,
  transitionRimborso,
  // budget
  createBudget,
  deleteBudget,
  listBudget,
  consuntivoPerCategoria,
  reportGestionale
};
