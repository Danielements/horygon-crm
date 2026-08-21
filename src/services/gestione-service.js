// Contabilita Fase C: flussi gestionali.
// - Scadenzario: fatture con residuo aperto, in bucket temporali.
// - Prima nota: VISTA cronologica che unisce fatture, pagamenti/incassi,
//   movimenti bancari e voci manuali (cont_nota_manuale).
// - Cash flow: entrate/uscite di cassa per mese, dai pagamenti registrati.
// - Anomalie: controlli gestionali (sovra-pagato, scaduto, non riconciliato,
//   split incompleto, pagamenti non allocati).
// Report gestionale interno: non e' un bilancio ne' una liquidazione IVA.

const db = require('../db/database');

const EPS = 0.005;
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// --- helper puri (testabili senza DB) -------------------------------------

// Giorni tra due date ISO (b - a), interi.
function daysBetween(aISO, bISO) {
  const a = new Date(aISO), b = new Date(bISO);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.round((b - a) / 86400000);
}

// Bucket di scadenza dato il numero di giorni da oggi alla scadenza.
// Negativo = gia scaduto.
function bucketOf(giorniAllaScadenza) {
  if (giorniAllaScadenza == null) return 'senza_scadenza';
  if (giorniAllaScadenza < 0) return 'scaduto';
  if (giorniAllaScadenza <= 7) return 'e7';
  if (giorniAllaScadenza <= 30) return 'e30';
  if (giorniAllaScadenza <= 60) return 'e60';
  if (giorniAllaScadenza <= 90) return 'e90';
  return 'oltre';
}

const BUCKETS = ['scaduto', 'e7', 'e30', 'e60', 'e90', 'oltre', 'senza_scadenza'];

// Aggrega movimenti { mese:'YYYY-MM', importo(+/-) } in cash flow mensile con
// saldo progressivo. Puro.
function aggregateCashflow(movimenti, saldoIniziale = 0) {
  const perMese = new Map();
  for (const m of movimenti || []) {
    const mese = String(m.mese || '').slice(0, 7);
    if (!mese) continue;
    if (!perMese.has(mese)) perMese.set(mese, { mese, entrate: 0, uscite: 0 });
    const b = perMese.get(mese);
    const imp = Number(m.importo) || 0;
    if (imp >= 0) b.entrate += imp; else b.uscite += Math.abs(imp);
  }
  const mesi = [...perMese.values()].sort((a, b) => a.mese.localeCompare(b.mese));
  let saldo = round2(saldoIniziale);
  return mesi.map((b) => {
    const netto = round2(b.entrate - b.uscite);
    saldo = round2(saldo + netto);
    return { mese: b.mese, entrate: round2(b.entrate), uscite: round2(b.uscite), netto, saldo };
  });
}

// --- scadenzario -----------------------------------------------------------

const DIREZIONE_SQL = `COALESCE(f.direzione, CASE WHEN f.tipo = 'emessa' THEN 'attiva' ELSE 'passiva' END)`;

function openInvoices(direzione) {
  return db.prepare(`
    SELECT f.id, f.numero, f.numero_documento, f.data, f.scadenza, f.totale,
           COALESCE(a.ragione_sociale, f.cliente_fornitore_label) AS controparte,
           (SELECT COALESCE(SUM(importo_quota),0) FROM cont_pagamenti_fatture pf WHERE pf.fattura_id = f.id) AS pagato
    FROM fatture f LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id
    WHERE ${DIREZIONE_SQL} = ?
  `).all(direzione)
    .map((f) => ({ ...f, residuo: round2((Number(f.totale) || 0) - (Number(f.pagato) || 0)) }))
    .filter((f) => f.residuo > EPS);
}

function scadenzarioDirezione(direzione, oggi) {
  const items = openInvoices(direzione).map((f) => {
    const giorni = f.scadenza ? daysBetween(oggi, f.scadenza) : null;
    return { ...f, giorni_alla_scadenza: giorni, bucket: bucketOf(giorni) };
  });
  const totali = {};
  BUCKETS.forEach((b) => { totali[b] = 0; });
  let totale = 0;
  items.forEach((it) => { totali[it.bucket] = round2(totali[it.bucket] + it.residuo); totale = round2(totale + it.residuo); });
  return { totale, totali, items: items.sort((a, b) => String(a.scadenza || '').localeCompare(String(b.scadenza || ''))) };
}

function scadenzario(oggiISO) {
  const oggi = oggiISO || new Date().toISOString().slice(0, 10);
  return { oggi, da_incassare: scadenzarioDirezione('attiva', oggi), da_pagare: scadenzarioDirezione('passiva', oggi) };
}

// --- prima nota ------------------------------------------------------------

// Righe cronologiche da tutte le fonti. `modo`:
// - 'cassa' (default): eventi di cassa reali (pagamenti/incassi, movimenti banca
//   non riconciliati per non contarli due volte, voci manuali).
// - 'competenza': documenti (fatture) per data documento.
function primaNota(filters = {}) {
  const dal = filters.dal || '0000-01-01';
  const al = filters.al || '9999-12-31';
  const righe = [];

  // Pagamenti/incassi (cassa)
  db.prepare(`SELECT p.id, p.data, p.verso, p.importo, p.metodo, p.note,
      a.ragione_sociale AS controparte
    FROM cont_pagamenti p LEFT JOIN anagrafiche a ON a.id = p.anagrafica_id
    WHERE COALESCE(p.data,'') BETWEEN ? AND ?`).all(dal, al).forEach((p) => {
    righe.push({
      fonte: 'pagamento', ref_id: p.id, data: p.data,
      descrizione: p.note || (p.verso === 'incasso' ? 'Incasso' : 'Pagamento'),
      controparte: p.controparte || null, metodo: p.metodo || null,
      entrata: p.verso === 'incasso' ? round2(p.importo) : 0,
      uscita: p.verso === 'pagamento' ? round2(p.importo) : 0
    });
  });

  // Movimenti bancari NON riconciliati (per non duplicare i pagamenti gia' registrati)
  db.prepare(`SELECT id, data_operazione, descrizione, controparte, importo
    FROM cont_movimenti_bancari
    WHERE stato_riconciliazione IN ('da_riconciliare','ignorato')
      AND COALESCE(data_operazione,'') BETWEEN ? AND ?`).all(dal, al).forEach((m) => {
    righe.push({
      fonte: 'banca', ref_id: m.id, data: m.data_operazione,
      descrizione: m.descrizione || 'Movimento bancario', controparte: m.controparte || null,
      entrata: m.importo >= 0 ? round2(m.importo) : 0,
      uscita: m.importo < 0 ? round2(Math.abs(m.importo)) : 0
    });
  });

  // Voci manuali
  db.prepare(`SELECT id, data, descrizione, verso, importo FROM cont_nota_manuale
    WHERE COALESCE(data,'') BETWEEN ? AND ?`).all(dal, al).forEach((n) => {
    righe.push({
      fonte: 'manuale', ref_id: n.id, data: n.data,
      descrizione: n.descrizione || 'Voce manuale', controparte: null,
      entrata: n.verso === 'entrata' ? round2(n.importo) : 0,
      uscita: n.verso === 'uscita' ? round2(n.importo) : 0
    });
  });

  righe.sort((a, b) => String(a.data || '').localeCompare(String(b.data || '')) || a.fonte.localeCompare(b.fonte));
  let saldo = 0;
  righe.forEach((r) => { saldo = round2(saldo + r.entrata - r.uscita); r.saldo = saldo; });
  const totEntrate = round2(righe.reduce((s, r) => s + r.entrata, 0));
  const totUscite = round2(righe.reduce((s, r) => s + r.uscita, 0));
  return { righe, totali: { entrate: totEntrate, uscite: totUscite, netto: round2(totEntrate - totUscite) } };
}

// --- cash flow -------------------------------------------------------------

function cashflow(filters = {}) {
  const dal = filters.dal || '0000-01-01';
  const al = filters.al || '9999-12-31';
  // Cassa reale = pagamenti/incassi registrati.
  const movimenti = db.prepare(`SELECT substr(COALESCE(data, creato_il),1,7) AS mese,
      CASE WHEN verso='incasso' THEN importo ELSE -importo END AS importo
    FROM cont_pagamenti WHERE COALESCE(data,'') BETWEEN ? AND ?`).all(dal, al);
  const saldoIniziale = db.prepare('SELECT COALESCE(SUM(saldo_iniziale),0) AS s FROM cont_conti WHERE attivo = 1').get().s || 0;
  return { mesi: aggregateCashflow(movimenti, saldoIniziale), saldo_iniziale: round2(saldoIniziale) };
}

// --- anomalie --------------------------------------------------------------

function anomalie(oggiISO) {
  const oggi = oggiISO || new Date().toISOString().slice(0, 10);
  const out = [];

  // Fatture sovra-pagate
  db.prepare(`SELECT f.id, f.numero, f.totale,
      (SELECT COALESCE(SUM(importo_quota),0) FROM cont_pagamenti_fatture pf WHERE pf.fattura_id=f.id) AS pagato
    FROM fatture f`).all().forEach((f) => {
    if (round2(f.pagato) - round2(f.totale) > EPS) {
      out.push({ tipo: 'sovra_pagato', gravita: 'alta', entita: 'fattura', entita_id: f.id,
        messaggio: `Fattura ${f.numero || f.id}: pagato ${round2(f.pagato)} > totale ${round2(f.totale)}` });
    }
  });

  // Fatture scadute e non saldate
  db.prepare(`SELECT f.id, f.numero, f.scadenza, f.totale,
      ${DIREZIONE_SQL} AS direzione,
      (SELECT COALESCE(SUM(importo_quota),0) FROM cont_pagamenti_fatture pf WHERE pf.fattura_id=f.id) AS pagato
    FROM fatture f WHERE f.scadenza IS NOT NULL AND f.scadenza < ?`).all(oggi).forEach((f) => {
    const residuo = round2((Number(f.totale) || 0) - (Number(f.pagato) || 0));
    if (residuo > EPS) {
      out.push({ tipo: 'scaduto', gravita: 'media', entita: 'fattura', entita_id: f.id,
        messaggio: `Fattura ${f.numero || f.id} scaduta il ${f.scadenza}: residuo ${residuo} (${f.direzione === 'attiva' ? 'da incassare' : 'da pagare'})` });
    }
  });

  // Classificazioni che non sommano 100
  db.prepare(`SELECT entita_tipo, entita_id, ROUND(SUM(percentuale),2) AS somma
    FROM cont_classificazioni GROUP BY entita_tipo, entita_id HAVING ABS(SUM(percentuale)-100) > 0.01`).all().forEach((c) => {
    out.push({ tipo: 'split_incompleto', gravita: 'bassa', entita: c.entita_tipo, entita_id: c.entita_id,
      messaggio: `Classificazione ${c.entita_tipo} ${c.entita_id}: le percentuali sommano ${c.somma}, non 100` });
  });

  // Pagamenti non allocati ad alcuna fattura
  db.prepare(`SELECT p.id, p.data, p.importo, p.verso FROM cont_pagamenti p
    WHERE NOT EXISTS (SELECT 1 FROM cont_pagamenti_fatture pf WHERE pf.pagamento_id=p.id)`).all().forEach((p) => {
    out.push({ tipo: 'pagamento_non_allocato', gravita: 'bassa', entita: 'pagamento', entita_id: p.id,
      messaggio: `${p.verso === 'incasso' ? 'Incasso' : 'Pagamento'} del ${p.data || '?'} di ${round2(p.importo)} non abbinato a fatture` });
  });

  const perGravita = { alta: 0, media: 0, bassa: 0 };
  out.forEach((a) => { perGravita[a.gravita] = (perGravita[a.gravita] || 0) + 1; });
  return { totale: out.length, per_gravita: perGravita, anomalie: out };
}

// --- voci manuali (CRUD) ---------------------------------------------------

function addNotaManuale(input, userId) {
  const verso = input.verso === 'entrata' ? 'entrata' : 'uscita';
  const importo = round2(input.importo);
  if (!(importo > 0)) throw new Error('Importo non valido');
  const info = db.prepare(`INSERT INTO cont_nota_manuale (data, descrizione, verso, importo, categoria_id, centro_costo_id, commessa_id, note, creato_da)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.data || null, input.descrizione || null, verso, importo,
    input.categoria_id || null, input.centro_costo_id || null, input.commessa_id || null, input.note || null,
    userId != null ? Number(userId) : null);
  return { id: Number(info.lastInsertRowid) };
}

function deleteNotaManuale(id) {
  const info = db.prepare('DELETE FROM cont_nota_manuale WHERE id = ?').run(Number(id));
  return { deleted: info.changes > 0 };
}

module.exports = {
  round2,
  daysBetween,
  bucketOf,
  BUCKETS,
  aggregateCashflow,
  scadenzario,
  primaNota,
  cashflow,
  anomalie,
  addNotaManuale,
  deleteNotaManuale
};
