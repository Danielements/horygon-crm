// Contabilita Fase G: automazione dei movimenti bancari.
// Classifica i movimenti da riconciliare in base alla causale:
//  - pagamenti carta  -> spesa NON documentata (fornitore = esercente)
//  - oneri/competenze -> spesa "oneri bancari"
//  - versamenti       -> entrata (voce di prima nota)
//  - bonifici con numero fattura -> auto-match con la fattura, MA solo se
//    importo e controparte coincidono (verifica doppia richiesta).
// Regole editabili in cont_regole per assegnare la categoria. Tutto reversibile.

const db = require('../db/database');
const cont = require('./contabilita-service');
const bank = require('./bank-service');
const spese = require('./spese-service');
const gest = require('./gestione-service');

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
const EPS = 0.005;

// --- parser puri (testabili senza DB) -------------------------------------

const RX = {
  card: /\bCARTA\s*\*?\s*\d{3,4}\b|contactless/i,
  fee: /COMPETENZE|IMPOSTA\s+DI\s+BOLLO|CANONE|COMMISSION|\bONERI\b|SPESE\s+TENUTA/i,
  versamento: /VERSAMENTO/i,
  bonifico: /BONIFICO/i
};

// Tipo movimento dalla causale + segno.
function detectType(descrizione, segno) {
  const d = String(descrizione || '');
  if (RX.card.test(d)) return 'carta';
  if (RX.versamento.test(d)) return 'versamento';
  if (RX.bonifico.test(d)) return segno < 0 ? 'bonifico_uscita' : 'bonifico_entrata';
  if (RX.fee.test(d)) return 'oneri_bancari';
  return 'altro';
}

// Esercente da un pagamento carta: il testo dopo "EUR <importo>", ripulito.
function extractMerchant(descrizione) {
  const d = String(descrizione || '');
  let m = d.match(/EUR\s+[\d.,]+\s+(.+?)(?:\s{2,}|$)/i);
  if (m) return normalizeName(m[1]);
  m = d.match(/CARTA\s*\*?\s*\d{3,4}[^A-Za-z0-9]*(?:DI\s+)?(?:EUR\s+[\d.,]+\s+)?(.+)/i);
  if (m) return normalizeName(m[1]);
  return null;
}

// Controparte di un bonifico: testo tra "A:"/"DA:" e "PER:".
function extractCounterparty(descrizione) {
  const d = String(descrizione || '');
  const m = d.match(/\b(?:A|DA):\s*(.+?)\s+PER:/i) || d.match(/\b(?:A|DA):\s*(.+?)(?:\s+TRN:|\s+COMM:|$)/i);
  return m ? normalizeName(m[1]) : null;
}

// Riferimento fattura dalla causale: "fattura n 596", "saldo fattura n° 36".
function extractInvoiceRef(descrizione) {
  const d = String(descrizione || '');
  const m = d.match(/fatt(?:ura)?\.?\s*(?:n[°.ro]*\s*)?([0-9]{1,6}(?:[/\-][0-9A-Za-z]+)?)/i);
  return m ? m[1].replace(/[/\-].*$/, '') : null; // tiene la parte numerica principale
}

function normalizeName(s) {
  return String(s || '').replace(/\s+/g, ' ').replace(/[.,;]+$/, '').trim() || null;
}

// Confronto nomi tollerante: una parola significativa in comune (>=4 lettere).
function nameMatches(a, b) {
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 4);
  const wa = norm(a), wb = norm(b);
  if (!wa.length || !wb.length) return false;
  return wa.some((w) => wb.includes(w));
}

// --- regole ---------------------------------------------------------------

function listRegole() {
  return db.prepare(`SELECT r.*, cat.nome AS categoria_nome, cc.nome AS centro_nome, co.nome AS commessa_nome
    FROM cont_regole r
    LEFT JOIN cont_categorie cat ON cat.id = r.categoria_id
    LEFT JOIN cont_centri_costo cc ON cc.id = r.centro_costo_id
    LEFT JOIN cont_commesse co ON co.id = r.commessa_id
    ORDER BY r.attiva DESC, r.priorita DESC, r.id`).all();
}

// Applica le regole a un testo (merchant/descrizione/controparte) e ritorna la
// prima che matcha (per priorita). Pura rispetto all'elenco regole passato.
function matchRule(fields, regole) {
  for (const r of regole) {
    if (!r.attiva) continue;
    const hay = String(fields[r.match_campo] || fields.descrizione || '').toLowerCase();
    const needle = String(r.match_valore || '').toLowerCase();
    if (!needle) continue;
    let ok = false;
    if (r.match_tipo === 'uguale') ok = hay === needle;
    else if (r.match_tipo === 'inizia') ok = hay.startsWith(needle);
    else if (r.match_tipo === 'regex') { try { ok = new RegExp(r.match_valore, 'i').test(hay); } catch { ok = false; } }
    else ok = hay.includes(needle);
    if (ok) return r;
  }
  return null;
}

// --- proposte -------------------------------------------------------------

const DIREZIONE_SQL = `COALESCE(f.direzione, CASE WHEN f.tipo = 'emessa' THEN 'attiva' ELSE 'passiva' END)`;

// Per un movimento, calcola la proposta di automazione.
function propostaPerMovimento(mov, regole) {
  const desc = mov.descrizione || '';
  const tipo = detectType(desc, mov.segno);
  const importo = Math.abs(round2(mov.importo));
  const regola = matchRule({ descrizione: desc, controparte: mov.controparte, merchant: extractMerchant(desc) }, regole);

  const base = { movimento_id: mov.id, data: mov.data_operazione, descrizione: desc, importo: round2(mov.importo), tipo };

  if (regola && regola.azione === 'ignora') {
    return { ...base, azione: 'ignora', motivo: `Regola "${regola.nome || regola.match_valore}"` };
  }

  if (tipo === 'carta' || tipo === 'oneri_bancari') {
    const merchant = tipo === 'oneri_bancari' ? 'Oneri bancari' : (extractMerchant(desc) || 'Spesa carta');
    return {
      ...base, azione: 'crea_spesa', sicura: true,
      spesa: { fornitore_nome: merchant, totale: importo, metodo_pagamento: tipo === 'carta' ? 'carta' : 'banca', data: mov.data_operazione, categoria_id: regola ? regola.categoria_id : null, centro_costo_id: regola ? regola.centro_costo_id : null, commessa_id: regola ? regola.commessa_id : null },
      categoria_nome: regola ? regola.categoria_nome : null,
      motivo: tipo === 'carta' ? 'Pagamento carta senza documento' : 'Oneri/competenze bancarie'
    };
  }

  if (tipo === 'versamento') {
    return { ...base, azione: 'entrata_manuale', sicura: true, descrizione_voce: normalizeName(desc) || 'Versamento', motivo: 'Versamento in conto' };
  }

  if (tipo === 'bonifico_uscita' || tipo === 'bonifico_entrata') {
    const direzione = tipo === 'bonifico_uscita' ? 'passiva' : 'attiva';
    const controparte = extractCounterparty(desc) || mov.controparte;
    const ref = extractInvoiceRef(desc);
    const candidata = trovaFatturaCandidata(direzione, importo, controparte, ref);
    if (candidata) {
      const importoOk = Math.abs(candidata.residuo - importo) <= EPS;
      const nomeOk = nameMatches(controparte, candidata.controparte);
      // Auto solo se importo E controparte coincidono e la fattura non risulta
      // gia' pagata (quel caso va confermato: collegarla registra l'incasso).
      const sicura = importoOk && nomeOk && !candidata.gia_pagata;
      const motivoPagata = candidata.gia_pagata ? ' — la fattura risulta gia segnata pagata: conferma per registrare l\'incasso reale' : '';
      return {
        ...base, azione: 'riconcilia_fattura', sicura,
        fattura: { id: candidata.id, numero: candidata.numero, controparte: candidata.controparte, residuo: candidata.residuo, gia_pagata: candidata.gia_pagata },
        verifiche: { importo: importoOk, controparte: nomeOk, riferimento: !!ref },
        motivo: `Bonifico ${direzione === 'passiva' ? 'a fornitore' : 'da cliente'}${ref ? ` (fattura ${ref})` : ''}${motivoPagata}`
      };
    }
    return { ...base, azione: 'manuale', motivo: `Bonifico ${direzione === 'passiva' ? 'uscita' : 'entrata'}: nessuna fattura corrispondente per importo/controparte` };
  }

  return { ...base, azione: 'manuale', motivo: 'Tipo non riconosciuto' };
}

// Cerca la fattura piu probabile: per numero (se presente), poi per importo,
// poi per controparte. Il pool esclude SOLO le fatture con incassi/pagamenti
// gia' REGISTRATI (residuo_registrato = totale - quote registrate): una fattura
// segnata "pagata" solo col flag manuale resta abbinabile (collegarla registra
// l'incasso vero) ed e' marcata gia_pagata per chiedere conferma.
function trovaFatturaCandidata(direzione, importo, controparte, ref) {
  const aperte = db.prepare(`
    SELECT f.id, f.numero, f.numero_documento, f.totale, f.stato, f.stato_pagamento,
           COALESCE(a.ragione_sociale, f.cliente_fornitore_label) AS controparte,
           (SELECT COALESCE(SUM(importo_quota),0) FROM cont_pagamenti_fatture pf WHERE pf.fattura_id = f.id) AS pagato
    FROM fatture f LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id
    WHERE ${DIREZIONE_SQL} = ?
  `).all(direzione)
    .map((f) => ({
      ...f,
      residuo: round2((Number(f.totale) || 0) - (Number(f.pagato) || 0)),   // residuo REGISTRATO
      gia_pagata: cont.effectiveResiduo(f.totale, f.pagato, f.stato_pagamento, f.stato) <= EPS
    }))
    .filter((f) => f.residuo > EPS);

  if (ref) {
    const perNumero = aperte.filter((f) => {
      const n = String(f.numero || f.numero_documento || '').replace(/[^0-9]/g, '');
      return n && n === String(ref).replace(/[^0-9]/g, '');
    });
    if (perNumero.length === 1) return perNumero[0];
    if (perNumero.length > 1) {
      const conImporto = perNumero.find((f) => Math.abs(f.residuo - importo) <= EPS);
      if (conImporto) return conImporto;
    }
  }
  const perImporto = aperte.filter((f) => Math.abs(f.residuo - importo) <= EPS);
  if (perImporto.length === 1) return perImporto[0];
  if (controparte) {
    const perNome = aperte.filter((f) => nameMatches(controparte, f.controparte));
    if (perNome.length === 1) return perNome[0];
    const perNomeImporto = perNome.find((f) => Math.abs(f.residuo - importo) <= EPS);
    if (perNomeImporto) return perNomeImporto;
  }
  return null;
}

// Calcola le proposte per tutti i movimenti da riconciliare (o un sottoinsieme).
function proposteMovimenti(filtri = {}) {
  const regole = listRegole();
  const where = ["stato_riconciliazione = 'da_riconciliare'"];
  const params = [];
  if (filtri.conto_id) { where.push('conto_id = ?'); params.push(Number(filtri.conto_id)); }
  const movs = db.prepare(`SELECT * FROM cont_movimenti_bancari WHERE ${where.join(' AND ')} ORDER BY data_operazione, id`).all(...params);
  const proposte = movs.map((m) => propostaPerMovimento(m, regole));
  const riepilogo = { totali: proposte.length, sicure: proposte.filter((p) => p.sicura).length, manuali: proposte.filter((p) => p.azione === 'manuale').length };
  return { proposte, riepilogo };
}

// --- applicazione (reversibile) -------------------------------------------

// Applica una singola proposta (identificata da movimento + azione). Ritorna il
// risultato. Non applica proposte 'manuale'.
function applicaProposta(movimentoId, override, userId) {
  const mov = db.prepare('SELECT * FROM cont_movimenti_bancari WHERE id = ?').get(Number(movimentoId));
  if (!mov) throw new Error('Movimento inesistente');
  if (mov.stato_riconciliazione !== 'da_riconciliare') throw new Error('Movimento gia elaborato');
  const regole = listRegole();
  const p = { ...propostaPerMovimento(mov, regole), ...(override || {}) };

  if (p.azione === 'crea_spesa') {
    const sp = spese.createSpesa({
      ...p.spesa,
      categoria_id: override && override.categoria_id !== undefined ? override.categoria_id : p.spesa.categoria_id,
      fonte: 'auto', origine_automatica: 1, movimento_bancario_id: mov.id
    }, null, userId);
    db.prepare("UPDATE cont_movimenti_bancari SET stato_riconciliazione = 'riconciliato' WHERE id = ?").run(mov.id);
    return { movimento_id: mov.id, azione: 'crea_spesa', spesa_id: sp.id };
  }

  if (p.azione === 'entrata_manuale') {
    const n = gest.addNotaManuale({ data: mov.data_operazione, descrizione: p.descrizione_voce || 'Versamento', verso: 'entrata', importo: Math.abs(round2(mov.importo)) }, userId);
    db.prepare("UPDATE cont_movimenti_bancari SET stato_riconciliazione = 'riconciliato' WHERE id = ?").run(mov.id);
    return { movimento_id: mov.id, azione: 'entrata_manuale', nota_id: n.id };
  }

  if (p.azione === 'riconcilia_fattura') {
    const fatturaId = (override && override.fattura_id) || (p.fattura && p.fattura.id);
    if (!fatturaId) throw new Error('Fattura non indicata');
    const residuo = cont.paidAmountForInvoice ? null : null;
    const quota = Math.min(Math.abs(round2(mov.importo)), p.fattura ? p.fattura.residuo : Math.abs(round2(mov.importo)));
    const r = bank.reconcile(mov.id, [{ fattura_id: Number(fatturaId), importo_quota: quota }], userId);
    return { movimento_id: mov.id, azione: 'riconcilia_fattura', ...r };
  }

  if (p.azione === 'ignora') {
    bank.ignoreMovement(mov.id);
    return { movimento_id: mov.id, azione: 'ignora' };
  }

  throw new Error('Proposta non applicabile automaticamente (manuale)');
}

// Applica in blocco solo le proposte SICURE (import massivo controllato).
function applicaSicure(filtri, userId) {
  const { proposte } = proposteMovimenti(filtri);
  const esiti = [];
  for (const p of proposte) {
    if (!p.sicura) continue;
    try { esiti.push({ ok: true, ...applicaProposta(p.movimento_id, null, userId) }); }
    catch (e) { esiti.push({ ok: false, movimento_id: p.movimento_id, errore: e.message }); }
  }
  return { applicate: esiti.filter((e) => e.ok).length, errori: esiti.filter((e) => !e.ok).length, esiti };
}

// Annulla l'elaborazione di un movimento: rimuove la spesa/pagamento/nota
// generati e riporta il movimento a "da_riconciliare".
function annullaElaborazione(movimentoId) {
  const id = Number(movimentoId);
  db.exec('BEGIN');
  try {
    // spese auto collegate
    db.prepare('DELETE FROM cont_spese WHERE movimento_bancario_id = ? AND origine_automatica = 1').run(id);
    // pagamenti collegati (e relative quote via cascade)
    const pagamenti = db.prepare('SELECT id FROM cont_pagamenti WHERE movimento_bancario_id = ?').all(id).map((r) => r.id);
    const fattureToccate = new Set();
    pagamenti.forEach((pid) => {
      db.prepare('SELECT fattura_id FROM cont_pagamenti_fatture WHERE pagamento_id = ?').all(pid).forEach((r) => fattureToccate.add(r.fattura_id));
      db.prepare('DELETE FROM cont_pagamenti WHERE id = ?').run(pid);
    });
    db.prepare("UPDATE cont_movimenti_bancari SET stato_riconciliazione = 'da_riconciliare' WHERE id = ?").run(id);
    db.exec('COMMIT');
    fattureToccate.forEach((fid) => cont.recomputeInvoicePaymentStatus(fid));
    return { movimento_id: id, annullato: true };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = {
  // parser puri
  detectType, extractMerchant, extractCounterparty, extractInvoiceRef, nameMatches, matchRule,
  // regole
  listRegole,
  // motore
  propostaPerMovimento, proposteMovimenti, applicaProposta, applicaSicure, annullaElaborazione,
  trovaFatturaCandidata
};
