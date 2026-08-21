// Contabilita gestionale (pre-contabilita / controllo di gestione).
// Fase A: classificazione (categorie/centri di costo/commesse con split),
// pagamenti/incassi con abbinamento molti-a-molti alle fatture, e paymentStatus
// DERIVATO (mai una colonna hardcodata): la somma delle quote in
// cont_pagamenti_fatture determina UNPAID/PARTIALLY_PAID/PAID/OVERPAID, tenuto
// separato dallo stato SdI. La cache denormalizzata `fatture.stato_pagamento`
// (da_pagare/parziale/pagata) tiene veloci le liste.
//
// Le fatture NON si duplicano: la vista contabile legge da `fatture`.

const db = require('../db/database');

const CENTS = 100;
// Tolleranza di 1 centesimo: gli importi sono REAL e l'aritmetica in virgola
// mobile non va confrontata con ==.
const EPS = 0.005;

// --- helper puri (testabili senza DB) -------------------------------------

function round2(n) {
  return Math.round((Number(n) || 0) * CENTS) / CENTS;
}

// paymentStatus derivato da totale fattura e quota gia pagata. Puro.
function computePaymentStatus(totale, paid) {
  const tot = round2(totale);
  const pagato = round2(paid);
  if (pagato <= EPS) return 'UNPAID';
  if (pagato + EPS >= tot && pagato - tot > EPS) return 'OVERPAID';
  if (pagato + EPS >= tot) return 'PAID';
  return 'PARTIALLY_PAID';
}

// Stato pagamento EFFETTIVO: i pagamenti registrati hanno la precedenza; se non
// ce ne sono, si rispetta il flag manuale della fattura (stato='pagata' dal
// controllo rapido, o stato_pagamento='pagata'/'parziale' dalla scheda). Cosi'
// una fattura segnata pagata a mano non risulta piu "da incassare".
function effectivePaymentStatus(totale, pagato, statoPagamentoManuale, statoFattura) {
  if (round2(pagato) > EPS) return computePaymentStatus(totale, pagato);
  if (statoFattura === 'pagata' || statoPagamentoManuale === 'pagata') return 'PAID';
  if (statoPagamentoManuale === 'parziale') return 'PARTIALLY_PAID';
  return 'UNPAID';
}

// Residuo effettivo coerente con lo stato effettivo (una fattura pagata a mano
// ha residuo 0 anche senza incasso registrato).
function effectiveResiduo(totale, pagato, statoPagamentoManuale, statoFattura) {
  if (round2(pagato) > EPS) return round2(totale - pagato);
  if (statoFattura === 'pagata' || statoPagamentoManuale === 'pagata') return 0;
  return round2(totale - pagato);
}

// Mappa il paymentStatus derivato sulla cache italiana gia usata dall'UI
// fatture (da_pagare/parziale/pagata). OVERPAID resta 'pagata' in cache: il
// dettaglio sovra-pagamento vive nell'API contabile.
function paymentStatusToCache(status) {
  switch (status) {
    case 'PAID':
    case 'OVERPAID':
      return 'pagata';
    case 'PARTIALLY_PAID':
      return 'parziale';
    default:
      return 'da_pagare';
  }
}

// Valida uno split di classificazione: ogni riga deve avere almeno una
// dimensione (categoria/centro/commessa) e la somma delle percentuali deve fare
// 100 (con tolleranza). Puro. Ritorna { ok, error?, normalized }.
function validateSplit(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { ok: false, error: 'Nessuna riga di classificazione', normalized: [] };
  const normalized = [];
  let somma = 0;
  for (const r of list) {
    const categoria = r.categoria_id != null && r.categoria_id !== '' ? Number(r.categoria_id) : null;
    const centro = r.centro_costo_id != null && r.centro_costo_id !== '' ? Number(r.centro_costo_id) : null;
    const commessa = r.commessa_id != null && r.commessa_id !== '' ? Number(r.commessa_id) : null;
    if (categoria == null && centro == null && commessa == null) {
      return { ok: false, error: 'Ogni quota deve avere almeno categoria, centro di costo o commessa', normalized: [] };
    }
    const perc = round2(r.percentuale != null && r.percentuale !== '' ? r.percentuale : 0);
    if (!(perc > 0)) return { ok: false, error: 'Percentuale non valida', normalized: [] };
    somma += perc;
    normalized.push({ categoria_id: categoria, centro_costo_id: centro, commessa_id: commessa, percentuale: perc, note: r.note || null });
  }
  if (Math.abs(somma - 100) > EPS) {
    return { ok: false, error: `La somma delle percentuali e' ${round2(somma)}, deve essere 100`, normalized: [] };
  }
  return { ok: true, normalized };
}

// --- accesso DB ------------------------------------------------------------

function invoiceTotal(fatturaId) {
  const f = db.prepare('SELECT totale FROM fatture WHERE id = ?').get(Number(fatturaId));
  return f ? round2(f.totale) : 0;
}

function paidAmountForInvoice(fatturaId) {
  const r = db.prepare(
    'SELECT COALESCE(SUM(importo_quota), 0) AS pagato FROM cont_pagamenti_fatture WHERE fattura_id = ?'
  ).get(Number(fatturaId));
  return round2(r ? r.pagato : 0);
}

// Ricalcola lo stato pagamento di una fattura e aggiorna la cache. Ritorna il
// dettaglio { status, totale, paid, residuo }.
function recomputeInvoicePaymentStatus(fatturaId) {
  const totale = invoiceTotal(fatturaId);
  const paid = paidAmountForInvoice(fatturaId);
  const status = computePaymentStatus(totale, paid);
  db.prepare('UPDATE fatture SET stato_pagamento = ? WHERE id = ?').run(paymentStatusToCache(status), Number(fatturaId));
  return { fattura_id: Number(fatturaId), status, totale, paid, residuo: round2(totale - paid) };
}

// Registra un pagamento/incasso ed eventualmente lo abbina a una o piu fatture.
// allocazioni: [{ fattura_id, importo_quota }]. Se assenti/vuote, il pagamento
// resta non abbinato (registrato ma da riconciliare). Transazionale.
function registerPayment(input, userId) {
  const verso = input.verso === 'pagamento' ? 'pagamento' : 'incasso';
  const importo = round2(input.importo);
  if (!(importo > 0)) throw new Error('Importo non valido');
  const allocazioni = Array.isArray(input.allocazioni) ? input.allocazioni : [];

  const normAlloc = allocazioni
    .map((a) => ({ fattura_id: Number(a.fattura_id), importo_quota: round2(a.importo_quota) }))
    .filter((a) => a.fattura_id && a.importo_quota > 0);
  const sommaQuote = round2(normAlloc.reduce((s, a) => s + a.importo_quota, 0));
  if (sommaQuote - importo > EPS) {
    throw new Error(`Le quote abbinate (${sommaQuote}) superano l'importo del pagamento (${importo})`);
  }

  db.exec('BEGIN');
  try {
    const info = db.prepare(`
      INSERT INTO cont_pagamenti (tenant_id, verso, data, importo, metodo, movimento_bancario_id, anagrafica_id, stato, note, creato_da)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      verso,
      input.data || null,
      importo,
      input.metodo || null,
      input.movimento_bancario_id != null ? Number(input.movimento_bancario_id) : null,
      input.anagrafica_id != null ? Number(input.anagrafica_id) : null,
      input.stato || 'registrato',
      input.note || null,
      userId != null ? Number(userId) : null
    );
    const pagamentoId = Number(info.lastInsertRowid);

    const insAlloc = db.prepare(
      'INSERT INTO cont_pagamenti_fatture (pagamento_id, fattura_id, importo_quota) VALUES (?, ?, ?)'
    );
    for (const a of normAlloc) {
      insAlloc.run(pagamentoId, a.fattura_id, a.importo_quota);
    }
    db.exec('COMMIT');

    const stati = normAlloc.map((a) => recomputeInvoicePaymentStatus(a.fattura_id));
    return { id: pagamentoId, verso, importo, allocazioni: normAlloc, fatture: stati };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Elimina un pagamento (ON DELETE CASCADE rimuove le quote) e ricalcola le
// fatture toccate.
function deletePayment(pagamentoId) {
  const id = Number(pagamentoId);
  const toccate = db.prepare('SELECT DISTINCT fattura_id FROM cont_pagamenti_fatture WHERE pagamento_id = ?').all(id).map((r) => r.fattura_id);
  const info = db.prepare('DELETE FROM cont_pagamenti WHERE id = ?').run(id);
  toccate.forEach(recomputeInvoicePaymentStatus);
  return { deleted: info.changes > 0, ricalcolate: toccate };
}

function listPaymentsForInvoice(fatturaId) {
  return db.prepare(`
    SELECT pf.importo_quota, p.*
    FROM cont_pagamenti_fatture pf
    JOIN cont_pagamenti p ON p.id = pf.pagamento_id
    WHERE pf.fattura_id = ?
    ORDER BY p.data, p.id
  `).all(Number(fatturaId));
}

// Salva la classificazione (split) di un'entita: rimpiazza le righe esistenti.
// L'importo di ogni quota e' derivato dalla percentuale sul totale dell'entita.
function saveClassification(entitaTipo, entitaId, rows, userId) {
  const check = validateSplit(rows);
  if (!check.ok) throw new Error(check.error);
  const base = entitaTipo === 'fattura' ? invoiceTotal(entitaId) : null;

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM cont_classificazioni WHERE entita_tipo = ? AND entita_id = ?').run(entitaTipo, Number(entitaId));
    const ins = db.prepare(`
      INSERT INTO cont_classificazioni (tenant_id, entita_tipo, entita_id, categoria_id, centro_costo_id, commessa_id, percentuale, importo, note, creato_da)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of check.normalized) {
      const importo = base != null ? round2((base * r.percentuale) / 100) : null;
      ins.run(entitaTipo, Number(entitaId), r.categoria_id, r.centro_costo_id, r.commessa_id, r.percentuale, importo, r.note, userId != null ? Number(userId) : null);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getClassification(entitaTipo, entitaId);
}

function getClassification(entitaTipo, entitaId) {
  return db.prepare(`
    SELECT c.*, cat.nome AS categoria_nome, cc.nome AS centro_nome, co.nome AS commessa_nome
    FROM cont_classificazioni c
    LEFT JOIN cont_categorie cat ON cat.id = c.categoria_id
    LEFT JOIN cont_centri_costo cc ON cc.id = c.centro_costo_id
    LEFT JOIN cont_commesse co ON co.id = c.commessa_id
    WHERE c.entita_tipo = ? AND c.entita_id = ?
    ORDER BY c.id
  `).all(entitaTipo, Number(entitaId));
}

// --- vista contabile fatture ----------------------------------------------

// direzione derivata: la colonna `direzione` o, in fallback, il vecchio `tipo`.
const DIREZIONE_SQL = `COALESCE(f.direzione, CASE WHEN f.tipo = 'emessa' THEN 'attiva' ELSE 'passiva' END)`;

function listInvoicesContabile(filters = {}) {
  const where = ['1=1'];
  const params = [];
  if (filters.direzione) { where.push(`${DIREZIONE_SQL} = ?`); params.push(filters.direzione); }
  if (filters.tipo_documento) { where.push("COALESCE(f.tipo_documento, 'fattura') = ?"); params.push(filters.tipo_documento); }
  if (filters.stato_pagamento) { where.push("COALESCE(f.stato_pagamento, 'da_pagare') = ?"); params.push(filters.stato_pagamento); }
  if (filters.dal) { where.push('f.data >= ?'); params.push(filters.dal); }
  if (filters.al) { where.push('f.data <= ?'); params.push(filters.al); }

  const rows = db.prepare(`
    SELECT f.id, f.numero, f.numero_documento, f.data, f.scadenza, f.tipo_documento,
           ${DIREZIONE_SQL} AS direzione,
           f.imponibile, f.iva, f.totale, f.stato, f.stato_pagamento, f.stato_sdi,
           COALESCE(a.ragione_sociale, f.cliente_fornitore_label) AS controparte,
           (SELECT COALESCE(SUM(importo_quota),0) FROM cont_pagamenti_fatture pf WHERE pf.fattura_id = f.id) AS pagato,
           (SELECT COUNT(*) FROM cont_classificazioni c WHERE c.entita_tipo='fattura' AND c.entita_id = f.id) AS classificata
    FROM fatture f
    LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id
    WHERE ${where.join(' AND ')}
    ORDER BY f.data DESC, f.id DESC
    LIMIT ?
  `).all(...params, Number(filters.limit) || 500);

  return rows.map((r) => {
    const status = effectivePaymentStatus(r.totale, r.pagato, r.stato_pagamento, r.stato);
    return { ...r, payment_status: status, residuo: effectiveResiduo(r.totale, r.pagato, r.stato_pagamento, r.stato) };
  });
}

// --- dashboard KPI ---------------------------------------------------------

function dashboard(filters = {}) {
  const anno = filters.anno || String(new Date().getFullYear());
  const likeAnno = `${anno}-%`;

  const perDirezione = db.prepare(`
    SELECT ${DIREZIONE_SQL} AS direzione,
           COUNT(*) AS n,
           COALESCE(SUM(f.imponibile),0) AS imponibile,
           COALESCE(SUM(f.iva),0) AS iva,
           COALESCE(SUM(f.totale),0) AS totale
    FROM fatture f
    WHERE f.data LIKE ?
    GROUP BY direzione
  `).all(likeAnno);

  const attive = perDirezione.find((d) => d.direzione === 'attiva') || { n: 0, imponibile: 0, iva: 0, totale: 0 };
  const passive = perDirezione.find((d) => d.direzione === 'passiva') || { n: 0, imponibile: 0, iva: 0, totale: 0 };

  // Da incassare / da pagare: residuo per direzione su tutte le fatture (non
  // solo dell'anno: uno scaduto vecchio conta comunque).
  // Residuo per direzione, rispettando i pagamenti registrati e, in loro
  // assenza, il flag manuale "pagata" (stato o stato_pagamento).
  const residui = db.prepare(`
    SELECT ${DIREZIONE_SQL} AS direzione,
           COALESCE(SUM(
             CASE
               WHEN (SELECT COALESCE(SUM(importo_quota),0) FROM cont_pagamenti_fatture pf WHERE pf.fattura_id = f.id) > 0.005
                 THEN f.totale - (SELECT COALESCE(SUM(importo_quota),0) FROM cont_pagamenti_fatture pf WHERE pf.fattura_id = f.id)
               WHEN f.stato = 'pagata' OR f.stato_pagamento = 'pagata' THEN 0
               ELSE f.totale
             END
           ),0) AS residuo
    FROM fatture f
    GROUP BY direzione
  `).all();
  const daIncassare = round2((residui.find((d) => d.direzione === 'attiva') || {}).residuo || 0);
  const daPagare = round2((residui.find((d) => d.direzione === 'passiva') || {}).residuo || 0);

  // Spese documentate/manuali dell'anno (costi extra-fattura)
  const speseAnno = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(totale),0) AS tot
    FROM cont_spese WHERE stato != 'archiviata' AND COALESCE(data,'') LIKE ?`).get(likeAnno);

  const counts = {
    categorie: db.prepare('SELECT COUNT(*) AS n FROM cont_categorie WHERE attiva = 1').get().n,
    centri_costo: db.prepare('SELECT COUNT(*) AS n FROM cont_centri_costo WHERE attivo = 1').get().n,
    commesse_aperte: db.prepare("SELECT COUNT(*) AS n FROM cont_commesse WHERE stato = 'aperta'").get().n,
    pagamenti: db.prepare('SELECT COUNT(*) AS n FROM cont_pagamenti').get().n,
    spese: speseAnno.n
  };

  return {
    anno,
    attive: { n: attive.n, imponibile: round2(attive.imponibile), iva: round2(attive.iva), totale: round2(attive.totale) },
    passive: { n: passive.n, imponibile: round2(passive.imponibile), iva: round2(passive.iva), totale: round2(passive.totale) },
    margine_lordo: round2(attive.imponibile - passive.imponibile),
    da_incassare: daIncassare,
    da_pagare: daPagare,
    spese_documentate: round2(speseAnno.tot),
    counts
  };
}

// --- CRUD generico per le anagrafiche gestionali --------------------------

function listCategorie() {
  return db.prepare('SELECT * FROM cont_categorie ORDER BY ordine, nome').all();
}
function listCentri() {
  return db.prepare('SELECT * FROM cont_centri_costo ORDER BY nome').all();
}
function listCommesse() {
  return db.prepare(`
    SELECT c.*, a.ragione_sociale AS cliente_nome
    FROM cont_commesse c LEFT JOIN anagrafiche a ON a.id = c.anagrafica_id
    ORDER BY c.stato, c.nome
  `).all();
}

module.exports = {
  // puri
  round2,
  computePaymentStatus,
  effectivePaymentStatus,
  effectiveResiduo,
  paymentStatusToCache,
  validateSplit,
  // pagamenti
  invoiceTotal,
  paidAmountForInvoice,
  recomputeInvoicePaymentStatus,
  registerPayment,
  deletePayment,
  listPaymentsForInvoice,
  // classificazione
  saveClassification,
  getClassification,
  // viste
  listInvoicesContabile,
  dashboard,
  // crud
  listCategorie,
  listCentri,
  listCommesse
};
