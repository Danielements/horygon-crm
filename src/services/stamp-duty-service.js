// Bollo virtuale: obbligo dichiarato per fattura, versamento TRIMESTRALE
// aggregato. Non esiste un pagamento da 2 EUR per fattura: le fatture con bollo
// dello stesso trimestre puntano a un unico StampDutySettlement.
//
// Regole in tabella `stamp_duty_rule` (modificabili, con validita' temporale):
// non si usa "IVA==0 -> bollo". La correttezza fiscale dei casi limite (N3
// export/intra) va confermata col commercialista.

const db = require('../db/database');

// --- helper puri (testabili senza DB) -------------------------------------

// Trimestre dalla data documento: { year, quarter:'Q3', label:'2026-Q3' }.
function quarterOf(dateISO) {
  const m = String(dateISO || '').match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const year = Number(m[1]);
  const quarterNumber = Math.floor((Number(m[2]) - 1) / 3) + 1;
  return { year, quarter: `Q${quarterNumber}`, label: `${year}-Q${quarterNumber}` };
}

// Scadenza INDICATIVA del versamento (l'esatta dipende da soglie/differimenti
// AdE: va confermata; `due_date` sul settlement e' modificabile).
function dueDateForQuarter(year, quarter) {
  const map = {
    Q1: `${year}-05-31`,
    Q2: `${year}-09-30`,
    Q3: `${year}-11-30`,
    Q4: `${year + 1}-02-28`
  };
  return map[quarter] || null;
}

// Somma degli imponibili "senza IVA" (natura valorizzata), esclusi i codici
// dell'esclusione (per codice esatto o per prefisso, es. N6 -> N6.1..N6.9).
function nonVatBase(riepilogo, exclusionCodes = []) {
  const excl = exclusionCodes.map((c) => String(c).trim()).filter(Boolean);
  const escluso = (nat) => excl.some((code) => nat === code || nat.startsWith(code + '.'));
  return (riepilogo || []).reduce((sum, r) => {
    const nat = String(r.natura_iva || r.naturaIva || '').trim();
    if (!nat) return sum; // ha aliquota -> soggetta a IVA -> non concorre al bollo
    if (escluso(nat)) return sum;
    const imp = Number(r.imponibile ?? r.imponibileImporto ?? 0) || 0;
    return sum + imp;
  }, 0);
}

// Valuta il bollo contro una regola. Pura.
function evaluateWithRule(riepilogo, rule) {
  const exclusion = String(rule.exclusion_code || '').split(',').map((s) => s.trim()).filter(Boolean);
  const base = nonVatBase(riepilogo, exclusion);
  const threshold = Number(rule.threshold ?? 77.47);
  const amount = Number(rule.amount ?? 2.00);
  if (rule.required && base > threshold) {
    return { required: true, amount, base, ruleId: rule.id || null, reason: `Importi non soggetti/esenti ${base.toFixed(2)} > soglia ${threshold.toFixed(2)}` };
  }
  return { required: false, amount: 0, base, ruleId: rule.id || null, reason: base > 0 ? `Base non-IVA ${base.toFixed(2)} <= soglia ${threshold.toFixed(2)}` : 'Nessun importo non soggetto a IVA' };
}

// Legge DatiBollo dall'XML di una fattura importata.
function parseDatiBollo(xmlText) {
  const block = String(xmlText || '').match(/<DatiBollo\b[^>]*>([\s\S]*?)<\/DatiBollo>/i);
  if (!block) return { declared: false, amount: null };
  const bv = block[1].match(/<BolloVirtuale>\s*([^<]*)<\/BolloVirtuale>/i);
  const im = block[1].match(/<ImportoBollo>\s*([^<]*)<\/ImportoBollo>/i);
  const declared = bv ? /^\s*SI\s*$/i.test(bv[1]) : true; // DatiBollo presente ~ dichiarato
  const amount = im ? Number(String(im[1]).replace(',', '.')) : (declared ? 2.00 : null);
  return { declared, amount: Number.isFinite(amount) ? amount : null };
}

// Stato bollo della singola fattura.
function computeInvoiceBolloStato({ required, declared, settlement }) {
  if (!required && !declared) return 'NOT_REQUIRED';
  if (required && !declared) return 'REQUIRED_NOT_DECLARED';
  if (settlement) {
    if (settlement.status === 'RECONCILED') return 'RECONCILED';
    if (settlement.status === 'PAID') return 'PAID';
  }
  return 'DECLARED';
}

// --- DB -------------------------------------------------------------------

function loadDefaultRule(now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  return db.prepare(`
    SELECT * FROM stamp_duty_rule
    WHERE attiva = 1
      AND (valid_from IS NULL OR valid_from <= ?)
      AND (valid_to IS NULL OR valid_to >= ?)
    ORDER BY priorita DESC, id ASC LIMIT 1
  `).get(today, today);
}

function evaluateStampDuty(riepilogo, { now = new Date() } = {}) {
  const rule = loadDefaultRule(now);
  if (!rule) return { required: false, amount: 0, base: 0, ruleId: null, reason: 'Nessuna regola bollo attiva' };
  return evaluateWithRule(riepilogo, rule);
}

function getOrCreateSettlement({ tenantId = 1, year, quarter }) {
  let s = db.prepare('SELECT * FROM stamp_duty_settlement WHERE tenant_id = ? AND year = ? AND quarter = ?').get(tenantId, year, quarter);
  if (!s) {
    const due = dueDateForQuarter(year, quarter);
    const r = db.prepare('INSERT INTO stamp_duty_settlement (tenant_id, year, quarter, due_date, status) VALUES (?,?,?,?,?)')
      .run(tenantId, year, quarter, due, 'OPEN');
    s = db.prepare('SELECT * FROM stamp_duty_settlement WHERE id = ?').get(Number(r.lastInsertRowid));
  }
  return s;
}

function recalcSettlement(settlementId) {
  const row = db.prepare('SELECT COALESCE(SUM(bollo_importo),0) AS tot, COUNT(*) AS n FROM fatture WHERE bollo_settlement_id = ? AND bollo_dichiarato = 1').get(settlementId);
  db.prepare("UPDATE stamp_duty_settlement SET calculated_amount = ?, aggiornato_il = datetime('now') WHERE id = ?").run(row.tot || 0, settlementId);
  return { calculatedAmount: row.tot || 0, fatture: row.n || 0 };
}

// Ricalcola i campi bollo di una fattura, assegna trimestre + settlement e
// aggiorna il totale del trimestre. Rispetta il dichiarato dall'XML sulle
// importate; sulle CRM il dichiarato segue il dovuto.
function recomputeStampDutyForInvoice(fatturaId, { tenantId = 1 } = {}) {
  const f = db.prepare('SELECT id, data, source, bollo_fonte, bollo_dichiarato, bollo_importo FROM fatture WHERE id = ?').get(fatturaId);
  if (!f) return null;
  const riepilogo = db.prepare('SELECT aliquota_iva, natura_iva, imponibile FROM fatture_iva_riepilogo WHERE fattura_id = ?').all(fatturaId);
  const ev = evaluateStampDuty(riepilogo);
  const q = quarterOf(f.data);

  const importedFromXml = String(f.bollo_fonte || '') === 'XML';
  const declared = importedFromXml ? (f.bollo_dichiarato ? 1 : 0) : (ev.required ? 1 : 0);
  const importo = importedFromXml && f.bollo_importo ? Number(f.bollo_importo) : (ev.required ? ev.amount : 0);
  const fonte = importedFromXml ? 'XML' : 'CRM';

  let settlementId = null;
  let settlement = null;
  if (declared && q) {
    settlement = getOrCreateSettlement({ tenantId, year: q.year, quarter: q.quarter });
    settlementId = settlement.id;
  }
  const stato = computeInvoiceBolloStato({ required: ev.required, declared: !!declared, settlement });

  db.prepare(`
    UPDATE fatture SET
      bollo_dovuto = ?, bollo_dichiarato = ?, bollo_importo = ?, bollo_trimestre = ?,
      bollo_fonte = ?, bollo_settlement_id = ?, bollo_stato = ?
    WHERE id = ?
  `).run(
    ev.required ? 1 : 0, declared, importo, q ? q.label : null,
    (declared || ev.required) ? fonte : null, settlementId, stato, fatturaId
  );

  if (settlementId) recalcSettlement(settlementId);
  return { fatturaId, required: ev.required, declared: !!declared, importo, trimestre: q ? q.label : null, settlementId, stato };
}

// Segna sull'import il bollo dichiarato letto dall'XML (chiamata dal ramo import,
// in Fase 3b). Salva fonte=XML e i valori, poi ricalcola.
function applyImportedDatiBollo(fatturaId, xmlText, { tenantId = 1 } = {}) {
  const parsed = parseDatiBollo(xmlText);
  db.prepare('UPDATE fatture SET bollo_fonte = ?, bollo_dichiarato = ?, bollo_importo = ? WHERE id = ?')
    .run(parsed.declared ? 'XML' : null, parsed.declared ? 1 : 0, parsed.amount || 0, fatturaId);
  return recomputeStampDutyForInvoice(fatturaId, { tenantId });
}

// Ricalcola il bollo di tutte le fatture (emesse e ricevute): popola le esistenti.
function recomputeAllInvoices({ tenantId = 1 } = {}) {
  const ids = db.prepare("SELECT id FROM fatture WHERE tipo IN ('emessa','ricevuta') OR direzione IN ('attiva','passiva')").all();
  let processate = 0;
  let conBollo = 0;
  for (const { id } of ids) {
    const r = recomputeStampDutyForInvoice(id, { tenantId });
    if (r) { processate += 1; if (r.declared) conBollo += 1; }
  }
  return { processate, conBollo };
}

// Dashboard bollo per trimestre.
function getBolloDashboard({ tenantId = 1 } = {}) {
  const settlements = db.prepare('SELECT * FROM stamp_duty_settlement WHERE tenant_id = ? ORDER BY year DESC, quarter DESC').all(tenantId);
  return settlements.map((s) => {
    const c = db.prepare(`
      SELECT COUNT(*) AS fatture,
             SUM(CASE WHEN bollo_fonte = 'ADE_LIST_A' THEN 1 ELSE 0 END) AS ade_a,
             SUM(CASE WHEN bollo_fonte = 'ADE_LIST_B' THEN 1 ELSE 0 END) AS ade_b
      FROM fatture WHERE bollo_settlement_id = ? AND bollo_dichiarato = 1
    `).get(s.id);
    return { ...s, fatture: c.fatture || 0, adeListA: c.ade_a || 0, adeListB: c.ade_b || 0 };
  });
}

function settlementInvoices(settlementId) {
  return db.prepare(`
    SELECT id, numero, data, totale, bollo_importo, bollo_fonte, bollo_stato,
           COALESCE((SELECT ragione_sociale FROM anagrafiche WHERE id = fatture.anagrafica_id), cliente_fornitore_label) AS controparte
    FROM fatture WHERE bollo_settlement_id = ? AND bollo_dichiarato = 1 ORDER BY data
  `).all(settlementId);
}

// Registra il pagamento del settlement (handoff manuale: portale AdE / F24 /
// registrazione). Non c'e' un pagamento da 2 EUR per fattura: e' l'aggregato.
function paySettlement(settlementId, { method = null, taxCode = null, paidAt = null, receiptPath = null, officialAmount = null, notes = null } = {}) {
  const s = db.prepare('SELECT * FROM stamp_duty_settlement WHERE id = ?').get(settlementId);
  if (!s) throw new Error('Settlement non trovato');
  db.prepare(`
    UPDATE stamp_duty_settlement
    SET status = 'PAID', payment_method = ?, tax_code = ?, paid_at = ?, receipt_path = ?,
        official_ade_amount = COALESCE(?, official_ade_amount), notes = COALESCE(?, notes),
        aggiornato_il = datetime('now')
    WHERE id = ?
  `).run(method, taxCode, paidAt || new Date().toISOString().slice(0, 10), receiptPath, officialAmount, notes, settlementId);
  db.prepare("UPDATE fatture SET bollo_stato = 'PAID' WHERE bollo_settlement_id = ? AND bollo_dichiarato = 1").run(settlementId);
  return db.prepare('SELECT * FROM stamp_duty_settlement WHERE id = ?').get(settlementId);
}

function reconcileSettlement(settlementId) {
  const s = db.prepare('SELECT * FROM stamp_duty_settlement WHERE id = ?').get(settlementId);
  if (!s) throw new Error('Settlement non trovato');
  db.prepare("UPDATE stamp_duty_settlement SET status = 'RECONCILED', aggiornato_il = datetime('now') WHERE id = ?").run(settlementId);
  db.prepare("UPDATE fatture SET bollo_stato = 'RECONCILED' WHERE bollo_settlement_id = ? AND bollo_dichiarato = 1").run(settlementId);
  return db.prepare('SELECT * FROM stamp_duty_settlement WHERE id = ?').get(settlementId);
}

module.exports = {
  quarterOf,
  dueDateForQuarter,
  nonVatBase,
  evaluateWithRule,
  parseDatiBollo,
  computeInvoiceBolloStato,
  loadDefaultRule,
  evaluateStampDuty,
  getOrCreateSettlement,
  recalcSettlement,
  recomputeStampDutyForInvoice,
  applyImportedDatiBollo,
  recomputeAllInvoices,
  getBolloDashboard,
  settlementInvoices,
  paySettlement,
  reconcileSettlement
};
