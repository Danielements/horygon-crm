// MUSA — Editori: tariffe a scaglioni (modificabili), anagrafica editori e
// conteggi mensili. Il prezzo si calcola sui libri APPROVATI e viene fotografato
// nel conteggio (lo storico non cambia se poi ritocchi le tariffe). La struttura
// e' pronta per collegare la fatturazione Stripe (vedi fatturaConteggio).

const db = require('../db/database');
const stripe = require('./stripe-client');
const musa = require('./musa-service');

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// --- puro: scelta dello scaglione -----------------------------------------
// Trova lo scaglione attivo che contiene `count` (max_libri null = infinito).
// Puro rispetto all'elenco tariffe passato.
function pickTariffa(count, tariffe) {
  const n = Number(count) || 0;
  const attive = (tariffe || []).filter((t) => t.attiva === undefined || t.attiva)
    .slice().sort((a, b) => (a.min_libri || 0) - (b.min_libri || 0));
  return attive.find((t) => n >= (t.min_libri || 0) && (t.max_libri == null || n <= t.max_libri)) || null;
}

function computePrezzo(approvati, tariffe) {
  const t = pickTariffa(approvati, tariffe);
  return { prezzo: t ? round2(t.prezzo) : 0, tariffa_id: t ? t.id : null, valuta: (t && t.valuta) || 'EUR' };
}

// --- tariffe ---------------------------------------------------------------
function listTariffe() {
  return db.prepare('SELECT * FROM musa_tariffe ORDER BY min_libri').all();
}
function createTariffa(b) {
  if (b.min_libri == null || b.prezzo == null) throw new Error('min_libri e prezzo obbligatori');
  const info = db.prepare(`INSERT INTO musa_tariffe (min_libri, max_libri, prezzo, valuta, attiva, note)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    Number(b.min_libri), b.max_libri != null && b.max_libri !== '' ? Number(b.max_libri) : null,
    round2(b.prezzo), b.valuta || 'EUR', b.attiva === 0 ? 0 : 1, b.note || null);
  return { id: Number(info.lastInsertRowid) };
}
function updateTariffa(id, b) {
  db.prepare(`UPDATE musa_tariffe SET min_libri = COALESCE(?, min_libri), max_libri = ?,
    prezzo = COALESCE(?, prezzo), valuta = COALESCE(?, valuta), attiva = COALESCE(?, attiva), note = ? WHERE id = ?`)
    .run(b.min_libri != null ? Number(b.min_libri) : null,
      b.max_libri != null && b.max_libri !== '' ? Number(b.max_libri) : null,
      b.prezzo != null ? round2(b.prezzo) : null, b.valuta ?? null, b.attiva ?? null, b.note ?? null, Number(id));
  return { ok: true };
}
function deleteTariffa(id) { db.prepare('DELETE FROM musa_tariffe WHERE id = ?').run(Number(id)); return { ok: true }; }

// --- editori ---------------------------------------------------------------
function listEditori() {
  return db.prepare('SELECT * FROM musa_editori ORDER BY attivo DESC, nome').all();
}
function createEditore(b) {
  if (!b.nome) throw new Error('Nome obbligatorio');
  const info = db.prepare(`INSERT INTO musa_editori (nome, email, piva, external_id, note)
    VALUES (?, ?, ?, ?, ?)`).run(b.nome, b.email || null, b.piva || null, b.external_id || null, b.note || null);
  return { id: Number(info.lastInsertRowid) };
}
function updateEditore(id, b) {
  db.prepare(`UPDATE musa_editori SET nome = COALESCE(?, nome), email = ?, piva = ?, external_id = ?,
    stripe_customer_id = COALESCE(?, stripe_customer_id), attivo = COALESCE(?, attivo), note = ? WHERE id = ?`)
    .run(b.nome ?? null, b.email ?? null, b.piva ?? null, b.external_id ?? null, b.stripe_customer_id ?? null, b.attivo ?? null, b.note ?? null, Number(id));
  return { ok: true };
}

// --- conteggi mensili ------------------------------------------------------
// Upsert del conteggio editore+periodo. Ricalcola il prezzo dallo scaglione
// attivo sugli approvati e lo fotografa. fonte: 'manuale' | 'portale'.
function upsertConteggio({ editore_id, periodo, caricati, approvati, fonte }) {
  if (!editore_id || !/^\d{4}-\d{2}$/.test(String(periodo || ''))) throw new Error('editore_id e periodo (YYYY-MM) obbligatori');
  const ed = db.prepare('SELECT id FROM musa_editori WHERE id = ?').get(Number(editore_id));
  if (!ed) throw new Error('Editore inesistente');
  const appr = Math.max(0, Number(approvati) || 0);
  const car = Math.max(0, Number(caricati) || 0);
  const calc = computePrezzo(appr, listTariffe());
  db.prepare(`INSERT INTO musa_editori_conteggi (editore_id, periodo, caricati, approvati, prezzo_calcolato, tariffa_id, valuta, fonte, aggiornato_il)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(editore_id, periodo) DO UPDATE SET
      caricati = excluded.caricati, approvati = excluded.approvati,
      prezzo_calcolato = excluded.prezzo_calcolato, tariffa_id = excluded.tariffa_id,
      valuta = excluded.valuta, fonte = excluded.fonte, aggiornato_il = datetime('now')`)
    .run(Number(editore_id), periodo, car, appr, calc.prezzo, calc.tariffa_id, calc.valuta, fonte === 'portale' ? 'portale' : 'manuale');
  return getConteggio(Number(editore_id), periodo);
}

function getConteggio(editoreId, periodo) {
  return db.prepare(`SELECT c.*, e.nome AS editore_nome, e.email AS editore_email, e.stripe_customer_id
    FROM musa_editori_conteggi c JOIN musa_editori e ON e.id = c.editore_id
    WHERE c.editore_id = ? AND c.periodo = ?`).get(Number(editoreId), periodo);
}

function listConteggi({ periodo, editore_id } = {}) {
  const where = ['1=1'];
  const params = [];
  if (periodo) { where.push('c.periodo = ?'); params.push(periodo); }
  if (editore_id) { where.push('c.editore_id = ?'); params.push(Number(editore_id)); }
  return db.prepare(`SELECT c.*, e.nome AS editore_nome, e.email AS editore_email, e.stripe_customer_id
    FROM musa_editori_conteggi c JOIN musa_editori e ON e.id = c.editore_id
    WHERE ${where.join(' AND ')} ORDER BY c.periodo DESC, e.nome`).all(...params);
}

// Vista mensile: tutti gli editori attivi con il conteggio del periodo (anche a
// zero se non c'e' ancora), cosi' si vede subito chi manca.
function vistaMensile(periodo) {
  const editori = db.prepare('SELECT * FROM musa_editori WHERE attivo = 1 ORDER BY nome').all();
  return editori.map((e) => {
    const c = db.prepare('SELECT * FROM musa_editori_conteggi WHERE editore_id = ? AND periodo = ?').get(e.id, periodo);
    return {
      editore_id: e.id, editore_nome: e.nome, email: e.email, stripe_customer_id: e.stripe_customer_id,
      periodo,
      caricati: c ? c.caricati : 0, approvati: c ? c.approvati : 0,
      prezzo: c ? c.prezzo_calcolato : 0, valuta: c ? c.valuta : 'EUR',
      fatturato: c ? !!c.fatturato : false, stripe_invoice_id: c ? c.stripe_invoice_id : null,
      conteggio_id: c ? c.id : null, registrato: !!c
    };
  });
}

function storicoEditore(editoreId) {
  return db.prepare('SELECT * FROM musa_editori_conteggi WHERE editore_id = ? ORDER BY periodo DESC').all(Number(editoreId));
}

// --- hook fatturazione Stripe (pronto da collegare) ------------------------
// Crea la fattura Stripe per un conteggio (editore+periodo) con l'importo del
// mese. Richiede Stripe configurato. Collega/crea il cliente Stripe dell'editore.
async function fatturaConteggio(conteggioId, { invia } = {}) {
  if (!stripe.isEnabled()) throw new Error('Stripe non configurato per MUSA');
  const c = db.prepare(`SELECT c.*, e.nome AS editore_nome, e.email AS editore_email, e.piva AS editore_piva, e.stripe_customer_id
    FROM musa_editori_conteggi c JOIN musa_editori e ON e.id = c.editore_id WHERE c.id = ?`).get(Number(conteggioId));
  if (!c) throw new Error('Conteggio inesistente');
  if (!(c.prezzo_calcolato > 0)) throw new Error('Importo del mese a zero: niente da fatturare');

  let customerId = c.stripe_customer_id;
  if (!customerId) {
    const cust = await stripe.createCustomer({
      name: c.editore_nome, email: c.editore_email || undefined,
      metadata: c.editore_piva ? { piva: c.editore_piva } : undefined
    });
    customerId = cust.id;
    db.prepare('UPDATE musa_editori SET stripe_customer_id = ? WHERE id = ?').run(customerId, c.editore_id);
  }

  const inv = await musa.createInvoice({
    customer_id: customerId,
    righe: [{ descrizione: `Canone MUSA ${c.periodo} — ${c.approvati} libri approvati`, importo: c.prezzo_calcolato, quantita: 1 }],
    valuta: (c.valuta || 'eur').toLowerCase(),
    invia: !!invia
  });
  db.prepare('UPDATE musa_editori_conteggi SET fatturato = 1, stripe_invoice_id = ? WHERE id = ?').run(inv.id, Number(conteggioId));
  return inv;
}

module.exports = {
  round2, pickTariffa, computePrezzo,
  listTariffe, createTariffa, updateTariffa, deleteTariffa,
  listEditori, createEditore, updateEditore,
  upsertConteggio, getConteggio, listConteggi, vistaMensile, storicoEditore,
  fatturaConteggio
};
