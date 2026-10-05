// MUSA — Abbonamenti editori a consumo giornaliero.
// Fasce sul numero di ISBN PRESENTI in piattaforma ogni giorno; tariffa
// giornaliera = prezzo mensile / giorni del mese; fatturazione trimestrale =
// somma dei giorni. La fascia gratis richiede una % minima di approvati; se non
// raggiunta, si paga la fascia a pagamento piu' alta. Il motore e' PURO e
// ricostruisce il conteggio di ogni giorno dalle date dei singoli ISBN.

const db = require('../db/database');

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// --- helper puri ------------------------------------------------------------

function daysInMonth(dayISO) {
  const m = String(dayISO).match(/^(\d{4})-(\d{2})/);
  if (!m) return 30;
  return new Date(Number(m[1]), Number(m[2]), 0).getDate();
}

// Elenco dei giorni 'YYYY-MM-DD' da `from` a `to` inclusi (UTC, no problemi DST).
function eachDay(fromISO, toISO) {
  const out = [];
  let t = Date.parse(`${fromISO}T00:00:00Z`);
  const end = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(t) || Number.isNaN(end)) return out;
  for (; t <= end; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

// Conteggio ISBN presenti e approvati in un dato giorno. Presente se inserito
// entro il giorno e non ancora rimosso (la rimozione vale dal giorno stesso).
function countsOnDay(isbnRecords, dayISO) {
  let present = 0, approved = 0;
  for (const r of isbnRecords || []) {
    const ins = r.inserito_il;
    if (!ins || ins > dayISO) continue;
    const rem = r.rimosso_il;
    if (rem && dayISO >= rem) continue;
    present++;
    if (r.approvato && (!r.approvato_il || r.approvato_il <= dayISO)) approved++;
  }
  return { present, approved };
}

// Sceglie la fascia per un conteggio. Se cade nella fascia gratis ma la % di
// approvati non raggiunge la soglia, applica la fascia a pagamento piu' alta.
// Ritorna { nome, prezzo_mese, gratis, qualificata_gratis }.
function pickFascia(present, approvedPerc, fasce) {
  if (!(present > 0)) return null;
  const attive = (fasce || []).filter((f) => f.attiva === undefined || f.attiva)
    .slice().sort((a, b) => (a.min_isbn || 0) - (b.min_isbn || 0));
  const f = attive.find((x) => present >= (x.min_isbn || 0) && (x.max_isbn == null || present <= x.max_isbn));
  if (!f) return null;
  if (f.gratis) {
    const soglia = f.min_approvati_perc != null ? Number(f.min_approvati_perc) : 0;
    if (approvedPerc >= soglia) {
      return { id: f.id, nome: f.nome, prezzo_mese: 0, gratis: true, qualificata_gratis: true };
    }
    // Non qualificata al gratis: fascia a pagamento piu' alta.
    const pagamento = attive.filter((x) => !x.gratis);
    const top = pagamento[pagamento.length - 1];
    return top
      ? { id: top.id, nome: top.nome, prezzo_mese: round2(top.prezzo_mese), gratis: false, qualificata_gratis: false, fallback: true }
      : { id: f.id, nome: f.nome, prezzo_mese: 0, gratis: true, qualificata_gratis: false };
  }
  return { id: f.id, nome: f.nome, prezzo_mese: round2(f.prezzo_mese), gratis: false, qualificata_gratis: false };
}

// Tariffa del giorno = prezzo mensile / giorni del mese (0 se gratis o nessuna).
function dailyRate(fascia, dayISO) {
  if (!fascia || fascia.gratis) return 0;
  return fascia.prezzo_mese / daysInMonth(dayISO);
}

// Calcola il dovuto su un periodo [from,to] dalle date ISBN. Ritorna il totale
// e il dettaglio giorni/importo per fascia. Puro.
function computePeriodo(isbnRecords, fromISO, toISO, fasce) {
  const perFascia = {};
  let dovuto = 0;
  for (const day of eachDay(fromISO, toISO)) {
    const { present, approved } = countsOnDay(isbnRecords, day);
    const perc = present > 0 ? (approved / present) * 100 : 0;
    const fascia = pickFascia(present, perc, fasce);
    const nome = fascia ? fascia.nome : 'Nessun abbonamento';
    const rate = dailyRate(fascia, day);
    dovuto += rate;
    if (!perFascia[nome]) perFascia[nome] = { giorni: 0, importo: 0, gratis: fascia ? !!fascia.gratis : false };
    perFascia[nome].giorni += 1;
    perFascia[nome].importo += rate;   // accumulo grezzo: arrotondo solo alla fine
  }
  Object.keys(perFascia).forEach((k) => { perFascia[k].importo = round2(perFascia[k].importo); });
  return { dovuto: round2(dovuto), giorni_per_fascia: perFascia };
}

function quarterRange(anno, trimestre) {
  const q = Number(trimestre);
  const startMonth = (q - 1) * 3 + 1;              // 1,4,7,10
  const endMonth = startMonth + 2;                  // 3,6,9,12
  const from = `${anno}-${String(startMonth).padStart(2, '0')}-01`;
  const lastDay = new Date(Number(anno), endMonth, 0).getDate();
  const to = `${anno}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { from, to };
}

// --- accesso DB -------------------------------------------------------------

function listFasce() {
  return db.prepare('SELECT * FROM musa_abbonamenti_fasce ORDER BY ordine, min_isbn').all();
}
function createFascia(b) {
  if (!b.nome || b.min_isbn == null) throw new Error('Nome e min_isbn obbligatori');
  const info = db.prepare(`INSERT INTO musa_abbonamenti_fasce (nome, min_isbn, max_isbn, prezzo_mese, gratis, min_approvati_perc, valuta, ordine, attiva)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    b.nome, Number(b.min_isbn), b.max_isbn != null && b.max_isbn !== '' ? Number(b.max_isbn) : null,
    round2(b.prezzo_mese), b.gratis ? 1 : 0, b.min_approvati_perc != null && b.min_approvati_perc !== '' ? Number(b.min_approvati_perc) : null,
    b.valuta || 'EUR', b.ordine || 0, b.attiva === 0 ? 0 : 1);
  return { id: Number(info.lastInsertRowid) };
}
function updateFascia(id, b) {
  db.prepare(`UPDATE musa_abbonamenti_fasce SET nome = COALESCE(?, nome), min_isbn = COALESCE(?, min_isbn),
    max_isbn = ?, prezzo_mese = COALESCE(?, prezzo_mese), gratis = COALESCE(?, gratis),
    min_approvati_perc = ?, ordine = COALESCE(?, ordine), attiva = COALESCE(?, attiva) WHERE id = ?`).run(
    b.nome ?? null, b.min_isbn != null ? Number(b.min_isbn) : null,
    b.max_isbn != null && b.max_isbn !== '' ? Number(b.max_isbn) : null,
    b.prezzo_mese != null ? round2(b.prezzo_mese) : null, b.gratis != null ? (b.gratis ? 1 : 0) : null,
    b.min_approvati_perc != null && b.min_approvati_perc !== '' ? Number(b.min_approvati_perc) : null,
    b.ordine ?? null, b.attiva ?? null, Number(id));
  return { ok: true };
}
function deleteFascia(id) { db.prepare('DELETE FROM musa_abbonamenti_fasce WHERE id = ?').run(Number(id)); return { ok: true }; }

function loadIsbn(editoreId) {
  return db.prepare('SELECT * FROM musa_editori_isbn WHERE editore_id = ?').all(Number(editoreId));
}

// Upsert di un ISBN (dal portale o manuale). Chiave: editore+isbn.
function upsertIsbn(editoreId, rec) {
  if (!rec || !rec.isbn) throw new Error('ISBN obbligatorio');
  db.prepare(`INSERT INTO musa_editori_isbn (editore_id, isbn, inserito_il, rimosso_il, approvato, approvato_il, external_id, richiesta_cancellazione, richiesta_cancellazione_il, visibile_editore, aggiornato_il)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(editore_id, isbn) DO UPDATE SET
      inserito_il = excluded.inserito_il, rimosso_il = excluded.rimosso_il,
      approvato = excluded.approvato, approvato_il = excluded.approvato_il,
      external_id = excluded.external_id, richiesta_cancellazione = excluded.richiesta_cancellazione,
      richiesta_cancellazione_il = excluded.richiesta_cancellazione_il, visibile_editore = excluded.visibile_editore,
      aggiornato_il = datetime('now')`)
    .run(Number(editoreId), String(rec.isbn), rec.inserito_il || null, rec.rimosso_il || null,
      rec.approvato ? 1 : 0, rec.approvato_il || null, rec.external_id || null,
      rec.richiesta_cancellazione ? 1 : 0, rec.richiesta_cancellazione_il || null,
      rec.visibile_editore === false ? 0 : 1);
  return { ok: true };
}

// Credito disponibile = somma del ledger.
function creditoDisponibile(editoreId) {
  const r = db.prepare('SELECT COALESCE(SUM(importo),0) AS c FROM musa_editori_credito WHERE editore_id = ?').get(Number(editoreId));
  return round2(r.c);
}

// Calcola (senza fatturare) il dovuto di un trimestre per un editore, con il
// credito disponibile e l'importo netto.
function calcolaTrimestre(editoreId, anno, trimestre) {
  const { from, to } = quarterRange(anno, trimestre);
  const isbn = loadIsbn(editoreId);
  const fasce = listFasce();
  const r = computePeriodo(isbn, from, to, fasce);
  const credito = creditoDisponibile(editoreId);
  const credito_usato = Math.min(r.dovuto, Math.max(0, credito));
  return {
    editore_id: Number(editoreId), anno: Number(anno), trimestre: Number(trimestre),
    periodo: { from, to }, dovuto: r.dovuto, giorni_per_fascia: r.giorni_per_fascia,
    credito_disponibile: credito, credito_usato: round2(credito_usato),
    importo_netto: round2(r.dovuto - credito_usato)
  };
}

// --- ingestione dal portale MUSA (sync completo) ---------------------------

// L'email dal portale a volte e' una stringa, a volte un oggetto {email,...}.
function normalizeEmail(email) {
  if (!email) return null;
  if (typeof email === 'object') return (email.email || '').toString().trim() || null;
  return String(email).trim() || null;
}

// ISBN valido = 13 cifre (978/979...). Solo per segnalazione, non blocca.
function isbnValido(isbn) {
  return /^[0-9]{13}$/.test(String(isbn || '').replace(/[^0-9]/g, ''));
}

function upsertEditoreByExternal(ed) {
  const email = normalizeEmail(ed.email);
  const ex = db.prepare('SELECT id FROM musa_editori WHERE external_id = ?').get(ed.external_id);
  if (ex) {
    db.prepare(`UPDATE musa_editori SET nome = COALESCE(?, nome), piva = COALESCE(?, piva), codice_fiscale = COALESCE(?, codice_fiscale),
      email = COALESCE(?, email), pec = COALESCE(?, pec), indirizzo = COALESCE(?, indirizzo),
      codice_destinatario = COALESCE(?, codice_destinatario), iban = COALESCE(?, iban) WHERE id = ?`)
      .run(ed.ragione_sociale || null, ed.partita_iva || null, ed.codice_fiscale || null, email, normalizeEmail(ed.pec), ed.indirizzo || null, ed.codice_destinatario || null, ed.iban || null, ex.id);
    return ex.id;
  }
  const info = db.prepare('INSERT INTO musa_editori (nome, email, piva, codice_fiscale, pec, external_id, indirizzo, codice_destinatario, iban) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ed.ragione_sociale || '(senza nome)', email, ed.partita_iva || null, ed.codice_fiscale || null, normalizeEmail(ed.pec), ed.external_id || null, ed.indirizzo || null, ed.codice_destinatario || null, ed.iban || null);
  return Number(info.lastInsertRowid);
}

// Scarica il payload dal portale MUSA (URL + chiave in ENV MUSA_PORTALE_URL).
// fetchFn iniettabile per i test. La chiave sta SOLO in ENV, mai nel codice.
async function fetchPortale(options = {}) {
  const url = options.url || process.env.MUSA_PORTALE_URL;
  if (!url) throw new Error('MUSA_PORTALE_URL non configurato');
  const fn = options.fetchFn || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 60000);
  let res;
  try { res = await fn(url, { signal: controller.signal }); } finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`Portale MUSA HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !Array.isArray(data.editori)) throw new Error('Risposta portale senza "editori"');
  return data;
}

// Scarica dal portale e sincronizza in un colpo solo.
async function pullDalPortale(options = {}) {
  const payload = await fetchPortale(options);
  return syncPortale(payload, options.oggi);
}

function portaleConfigurato() { return !!process.env.MUSA_PORTALE_URL; }

// Crea (o collega) il cliente Stripe di un editore dai suoi dati anagrafici.
// L'editore MUSA e' il cliente: usa ragione sociale, email, P.IVA, CF, portale.
async function creaClienteStripe(editoreId) {
  const stripe = require('./stripe-client');
  if (!stripe.isEnabled()) throw new Error('Stripe non configurato per MUSA');
  const e = db.prepare('SELECT * FROM musa_editori WHERE id = ?').get(Number(editoreId));
  if (!e) throw new Error('Editore inesistente');
  if (e.stripe_customer_id) return { id: e.stripe_customer_id, gia_presente: true };
  const metadata = {};
  if (e.piva) metadata.piva = e.piva;
  if (e.codice_fiscale) metadata.codice_fiscale = e.codice_fiscale;
  if (e.external_id) metadata.portale_id = e.external_id;
  if (e.codice_destinatario) metadata.codice_destinatario = e.codice_destinatario;
  if (e.indirizzo) metadata.indirizzo = e.indirizzo;
  const cust = await stripe.createCustomer({ name: e.nome || undefined, email: e.email || undefined, metadata });
  db.prepare('UPDATE musa_editori SET stripe_customer_id = ? WHERE id = ?').run(cust.id, e.id);
  return { id: cust.id, gia_presente: false };
}

// Crea in blocco i clienti Stripe mancanti, SOLO per gli editori con P.IVA
// (anagrafica fiscale completa).
async function creaClientiStripeMancanti() {
  const eds = db.prepare("SELECT id, nome FROM musa_editori WHERE (stripe_customer_id IS NULL OR stripe_customer_id = '') AND piva IS NOT NULL AND TRIM(piva) <> ''").all();
  let creati = 0; const errori = [];
  for (const e of eds) {
    try { await creaClienteStripe(e.id); creati++; }
    catch (err) { errori.push(`${e.nome}: ${err.message}`); }
  }
  const senzaPiva = db.prepare("SELECT COUNT(*) AS n FROM musa_editori WHERE (stripe_customer_id IS NULL OR stripe_customer_id = '') AND (piva IS NULL OR TRIM(piva) = '')").get().n;
  return { candidati: eds.length, creati, errori, saltati_senza_piva: senzaPiva };
}

// Ingoia il payload { generato_il, editori:[...] }: crea/aggiorna editori per
// external_id, upserta gli ISBN e fa la controprova col riepilogo del portale.
function syncPortale(payload, oggiISO) {
  const oggi = oggiISO || new Date().toISOString().slice(0, 10);
  const fasce = listFasce();
  const editoriIn = (payload && payload.editori) || [];
  const dettaglio = [];
  const warnings = [];
  const d10 = (v) => (v ? String(v).slice(0, 10) : null);

  const eventi = [];
  const fasciaNome = (recs) => { const { present, approved } = countsOnDay(recs, oggi); const p = present > 0 ? (approved / present) * 100 : 0; const f = pickFascia(present, p, fasce); return { nome: f ? f.nome : null, prezzo: f ? f.prezzo_mese : 0 }; };

  for (const ed of editoriIn) {
    if (!ed.external_id) { warnings.push(`Editore "${ed.ragione_sociale || '?'}" senza external_id: saltato`); continue; }
    // Stato PRIMA del sync (per il diff/governance).
    const pre = db.prepare('SELECT id, piva FROM musa_editori WHERE external_id = ?').get(ed.external_id);
    const isNew = !pre;
    const preMap = {};
    if (pre) loadIsbn(pre.id).forEach((r) => { preMap[r.isbn] = r; });
    const preFascia = pre ? fasciaNome(loadIsbn(pre.id)) : { nome: null };

    const editoreId = upsertEditoreByExternal(ed);
    const nomeEd = ed.ragione_sociale || '(senza nome)';
    const pushEv = (tipo, dettaglio, extra) => eventi.push({ editore_id: editoreId, editore_nome: nomeEd, tipo, dettaglio: dettaglio || null, ...(extra || {}) });

    const seen = new Set();
    let salvati = 0, duplicati = 0, invalidi = 0, aggiunti = 0, rimossi = 0, nuoveCanc = 0;
    for (const r of (ed.isbn || [])) {
      if (!r.isbn) continue;
      if (seen.has(r.isbn)) duplicati++;
      seen.add(r.isbn);
      if (!isbnValido(r.isbn)) invalidi++;
      const old = preMap[r.isbn];
      if (!old) aggiunti++;
      if (old && !old.rimosso_il && d10(r.rimosso_il)) rimossi++;
      if (r.richiesta_cancellazione && !(old && old.richiesta_cancellazione)) { nuoveCanc++; pushEv('richiesta_cancellazione', `${r.isbn} — ${r.titolo || ''}`.trim()); }
      upsertIsbn(editoreId, { isbn: r.isbn, inserito_il: d10(r.inserito_il), rimosso_il: d10(r.rimosso_il), approvato: !!r.approvato, approvato_il: d10(r.approvato_il), richiesta_cancellazione: !!r.richiesta_cancellazione, richiesta_cancellazione_il: d10(r.richiesta_cancellazione_il), visibile_editore: r.visibile_editore });
      salvati++;
    }

    // Eventi di governance.
    if (isNew) pushEv('editore_nuovo', nomeEd);
    if (aggiunti) pushEv('isbn_aggiunto', `${aggiunti} ISBN aggiunti`);
    if (rimossi) pushEv('isbn_rimosso', `${rimossi} ISBN rimossi`);
    if (!isNew && pre && !pre.piva && ed.partita_iva) pushEv('piva_arrivata', ed.partita_iva);
    const postFascia = fasciaNome(loadIsbn(editoreId));
    if (!isNew && preFascia.nome !== postFascia.nome) {
      const su = (postFascia.prezzo || 0) >= (preFascia.prezzo || 0);
      pushEv(su ? 'fascia_su' : 'fascia_giu', `${preFascia.nome || 'nessuna'} → ${postFascia.nome || 'nessuna'}`, { fascia_da: preFascia.nome, fascia_a: postFascia.nome });
    }

    const recs = loadIsbn(editoreId);
    const { present, approved } = countsOnDay(recs, oggi);
    const perc = present > 0 ? (approved / present) * 100 : 0;
    const fascia = pickFascia(present, perc, fasce);
    const rip = ed.riepilogo || {};
    const match = rip.isbn_presenti == null ? null : (present === Number(rip.isbn_presenti));
    if (match === false) warnings.push(`${ed.ragione_sociale}: presenti ${present} ≠ portale ${rip.isbn_presenti}${duplicati ? ' (ISBN duplicati)' : ''}`);
    if (duplicati) warnings.push(`${ed.ragione_sociale}: ${duplicati} ISBN duplicati nel payload`);
    if (invalidi) warnings.push(`${ed.ragione_sociale}: ${invalidi} ISBN non validi (≠ 13 cifre)`);
    if (!ed.partita_iva) warnings.push(`${ed.ragione_sociale}: partita IVA assente (serve per fatturare)`);
    dettaglio.push({
      editore_id: editoreId, ragione_sociale: ed.ragione_sociale, isbn_ricevuti: salvati,
      presenti: present, approvati: approved,
      portale_presenti: rip.isbn_presenti != null ? Number(rip.isbn_presenti) : null,
      portale_approvati: rip.isbn_approvati != null ? Number(rip.isbn_approvati) : null,
      match, fascia_oggi: fascia ? fascia.nome : 'nessuna', prezzo_mese: fascia ? fascia.prezzo_mese : 0
    });
  }
  // Persisto gli eventi di governance.
  const insEv = db.prepare(`INSERT INTO musa_abbonamenti_eventi (editore_id, editore_nome, tipo, dettaglio, fascia_da, fascia_a) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const e of eventi) insEv.run(e.editore_id, e.editore_nome, e.tipo, e.dettaglio, e.fascia_da || null, e.fascia_a || null);
  return { generato_il: payload && payload.generato_il, editori: dettaglio.length, dettaglio, warnings, eventi };
}

function listEventi(limit = 100) {
  return db.prepare('SELECT * FROM musa_abbonamenti_eventi ORDER BY creato_il DESC, id DESC LIMIT ?').all(Number(limit) || 100);
}

module.exports = {
  round2, daysInMonth, eachDay, countsOnDay, pickFascia, dailyRate, computePeriodo, quarterRange,
  listFasce, createFascia, updateFascia, deleteFascia,
  loadIsbn, upsertIsbn, creditoDisponibile, calcolaTrimestre,
  normalizeEmail, isbnValido, upsertEditoreByExternal, syncPortale, listEventi,
  fetchPortale, pullDalPortale, portaleConfigurato,
  creaClienteStripe, creaClientiStripeMancanti
};
