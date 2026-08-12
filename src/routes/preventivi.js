const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const { createPreventivoPdfBuffer } = require('../services/document-pdf');
const { writeAudit } = require('../services/audit');
const { calcolaRiga, snapshotIvaPerProdotto } = require('../services/iva');

const s = (v) => (v === undefined || v === '' || v === null) ? null : v;
const n = (v) => { const p = parseFloat(v); return Number.isFinite(p) ? p : null; };
const i = (v) => { const p = parseInt(v, 10); return Number.isFinite(p) ? p : null; };

// Snapshot fiscale della riga preventivo.
//
// Se la riga non porta un trattamento proprio si prende quello predefinito
// dell'articolo, ma **una volta sola, adesso**: da qui in poi il dato vive
// sulla riga e non torna piu' a chiedere all'articolo come sta messo.
function preparePreventivoRiga(riga = {}) {
  const conTrattamento = riga.regola_iva_id || riga.codice_iva || riga.natura_iva
    || riga.aliquota_iva !== undefined && riga.aliquota_iva !== null && riga.aliquota_iva !== ''
    ? riga
    : { ...riga, ...(snapshotIvaPerProdotto(riga.prodotto_id) || {}) };
  return calcolaRiga(conTrattamento);
}

// Il preventivo guarda la giacenza, ma non la impegna e non blocca.
//
// Preventivare merce che non e' in magazzino e' legittimo: la si ordina al
// fornitore quando il cliente accetta. Quello che non deve succedere e'
// scoprirlo alla consegna, quindi il salvataggio risponde con l'elenco delle
// righe scoperte e l'interfaccia lo mostra.
//
// La formula della giacenza e' quella usata da tutti gli altri moduli, con le
// rettifiche contate: una lettura diversa qui darebbe due verita' diverse
// sullo stesso prodotto.
function verificaDisponibilita(righe = []) {
  const giacenza = db.prepare(`
    SELECT COALESCE(SUM(CASE
      WHEN tipo = 'carico' THEN quantita
      WHEN tipo IN ('scarico','reso') THEN -quantita
      WHEN tipo = 'rettifica' THEN quantita
      ELSE 0
    END), 0) AS q
    FROM magazzino_movimenti WHERE prodotto_id = ?
  `);
  const nome = db.prepare('SELECT nome, codice_interno FROM prodotti WHERE id = ?');

  const richiestoPerProdotto = new Map();
  (righe || []).forEach((riga) => {
    const prodottoId = i(riga.prodotto_id);
    const quantita = n(riga.quantita) || 0;
    if (!prodottoId || quantita <= 0) return;
    richiestoPerProdotto.set(prodottoId, (richiestoPerProdotto.get(prodottoId) || 0) + quantita);
  });

  const scoperte = [];
  for (const [prodottoId, richiesta] of richiestoPerProdotto) {
    const disponibile = Number(giacenza.get(prodottoId)?.q || 0);
    if (richiesta > disponibile) {
      const p = nome.get(prodottoId);
      scoperte.push({
        prodotto_id: prodottoId,
        prodotto: p?.nome || p?.codice_interno || `#${prodottoId}`,
        richiesta,
        disponibile,
        mancante: Math.round((richiesta - disponibile) * 100) / 100
      });
    }
  }
  return scoperte;
}

function insertPreventivoRighe(preventivoId, righe = []) {
  const ins = db.prepare(`
    INSERT INTO preventivi_righe (
      preventivo_id, prodotto_id, descrizione, quantita, prezzo_unitario, sconto,
      imponibile, aliquota_iva, natura_iva, importo_iva, totale_riga,
      regola_iva_id, codice_iva, riferimento_normativo
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  (righe || []).forEach((riga) => {
    const calc = preparePreventivoRiga(riga);
    ins.run(
      preventivoId,
      i(riga.prodotto_id),
      s(riga.descrizione),
      calc.quantita,
      calc.prezzo_unitario,
      calc.sconto,
      calc.imponibile,
      calc.aliquota_iva,
      calc.natura_iva,
      calc.importo_iva,
      calc.totale_riga,
      calc.regola_iva_id,
      calc.codice_iva,
      calc.riferimento_normativo
    );
  });
}

router.use(authMiddleware);

router.get('/', requirePermesso('ordini', 'read'), (req, res) => {
  const { stato, anagrafica_id, mine } = req.query;
  let sql = `
    SELECT p.*, a.ragione_sociale, cu.nome AS created_by_user_name,
      (
        SELECT COUNT(*)
        FROM audit_log l
        WHERE l.entita_tipo = 'preventivo' AND l.entita_id = p.id AND l.azione = 'documento_inviato'
      ) AS sent_count,
      (
        SELECT MAX(l.creato_il)
        FROM audit_log l
        WHERE l.entita_tipo = 'preventivo' AND l.entita_id = p.id AND l.azione = 'documento_inviato'
      ) AS last_sent_at
    FROM preventivi p
    LEFT JOIN anagrafiche a ON a.id = p.anagrafica_id
    LEFT JOIN utenti cu ON cu.id = p.created_by_user_id
    WHERE 1=1
  `;
  const params = [];
  if (stato) { sql += ' AND p.stato = ?'; params.push(stato); }
  if (anagrafica_id) { sql += ' AND p.anagrafica_id = ?'; params.push(anagrafica_id); }
  if (String(mine) === '1') { sql += ' AND p.created_by_user_id = ?'; params.push(req.user.id); }
  sql += ' ORDER BY COALESCE(p.data_preventivo, p.creato_il) DESC, p.id DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/mine', requirePermesso('ordini', 'read'), (req, res) => {
  const { stato } = req.query;
  let sql = `
    SELECT p.*, a.ragione_sociale, cu.nome AS created_by_user_name
    FROM preventivi p
    LEFT JOIN anagrafiche a ON a.id = p.anagrafica_id
    LEFT JOIN utenti cu ON cu.id = p.created_by_user_id
    WHERE p.created_by_user_id = ?
  `;
  const params = [req.user.id];
  if (stato) { sql += ' AND p.stato = ?'; params.push(stato); }
  sql += ' ORDER BY COALESCE(p.data_preventivo, p.creato_il) DESC, p.id DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', requirePermesso('ordini', 'read'), (req, res) => {
  const row = db.prepare(`
    SELECT p.*, a.ragione_sociale
    FROM preventivi p
    LEFT JOIN anagrafiche a ON a.id = p.anagrafica_id
    WHERE p.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Preventivo non trovato' });
  row.righe = db.prepare(`
    SELECT r.*, pr.nome, pr.codice_interno
    FROM preventivi_righe r
    LEFT JOIN prodotti pr ON pr.id = r.prodotto_id
    WHERE r.preventivo_id = ?
    ORDER BY r.id
  `).all(req.params.id);
  res.json(row);
});

router.get('/:id/pdf', requirePermesso('ordini', 'read'), async (req, res) => {
  try {
    const pdf = await createPreventivoPdfBuffer(req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=${pdf.filename}`);
    res.send(pdf.buffer);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

router.post('/', requirePermesso('ordini', 'edit'), (req, res) => {
  const b = req.body || {};
  try {
    const r = db.prepare(`
      INSERT INTO preventivi (
        codice_preventivo, anagrafica_id, stato, data_preventivo, data_scadenza,
        imponibile, iva, totale, valuta, note, created_by_user_id
      )
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      s(b.codice_preventivo),
      i(b.anagrafica_id),
      s(b.stato) || 'bozza',
      s(b.data_preventivo),
      s(b.data_scadenza),
      n(b.imponibile),
      n(b.iva),
      n(b.totale),
      s(b.valuta) || 'EUR',
      s(b.note),
      req.user.id
    );
    const id = r.lastInsertRowid;
    insertPreventivoRighe(id, b.righe);
    res.json({ id, disponibilita: verificaDisponibilita(b.righe) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', requirePermesso('ordini', 'edit'), (req, res) => {
  const b = req.body || {};
  try {
    db.prepare(`
      UPDATE preventivi
      SET codice_preventivo=?, anagrafica_id=?, stato=?, data_preventivo=?, data_scadenza=?, imponibile=?, iva=?, totale=?, valuta=?, note=?
      WHERE id=?
    `).run(
      s(b.codice_preventivo),
      i(b.anagrafica_id),
      s(b.stato) || 'bozza',
      s(b.data_preventivo),
      s(b.data_scadenza),
      n(b.imponibile),
      n(b.iva),
      n(b.totale),
      s(b.valuta) || 'EUR',
      s(b.note),
      req.params.id
    );
    db.prepare('DELETE FROM preventivi_righe WHERE preventivo_id = ?').run(req.params.id);
    insertPreventivoRighe(req.params.id, b.righe);
    res.json({ ok: true, disponibilita: verificaDisponibilita(b.righe) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/:id/stato', requirePermesso('ordini', 'edit'), (req, res) => {
  const nextState = s(req.body.stato);
  const current = db.prepare('SELECT id, stato, codice_preventivo FROM preventivi WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Preventivo non trovato' });
  db.prepare('UPDATE preventivi SET stato = ? WHERE id = ?').run(nextState, req.params.id);
  if ((current.stato || '') !== (nextState || '')) {
    writeAudit({
      utente_id: req.user.id,
      azione: 'documento_stato',
      entita_tipo: 'preventivo',
      entita_id: Number(req.params.id),
      dettagli: {
        codice: current.codice_preventivo,
        from: current.stato || null,
        to: nextState || null
      }
    });
  }
  res.json({ ok: true });
});

router.delete('/:id', requirePermesso('ordini', 'delete'), (req, res) => {
  const linkedOrder = db.prepare('SELECT id, codice_ordine FROM ordini WHERE preventivo_id = ? LIMIT 1').get(req.params.id);
  if (linkedOrder) {
    return res.status(400).json({ error: `Preventivo collegato all'ordine ${linkedOrder.codice_ordine || linkedOrder.id}` });
  }
  const result = db.prepare('DELETE FROM preventivi WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Preventivo non trovato' });
  res.json({ ok: true });
});

router.post('/:id/convert-to-order', requirePermesso('ordini', 'edit'), (req, res) => {
  const preventivo = db.prepare(`
    SELECT p.*, a.ragione_sociale
    FROM preventivi p
    LEFT JOIN anagrafiche a ON a.id = p.anagrafica_id
    WHERE p.id = ?
  `).get(req.params.id);
  if (!preventivo) return res.status(404).json({ error: 'Preventivo non trovato' });

  const existing = db.prepare('SELECT id, codice_ordine FROM ordini WHERE preventivo_id = ? LIMIT 1').get(req.params.id);
  if (existing) return res.status(400).json({ error: `Ordine già creato: ${existing.codice_ordine}` });

  // Si porta via anche il trattamento fiscale, non solo quantita' e prezzo:
  // l'IVA dell'ordine deve essere quella che il cliente ha accettato nel
  // preventivo, non quella che l'articolo ha oggi in anagrafica.
  const righe = db.prepare(`
    SELECT prodotto_id, descrizione, quantita, prezzo_unitario, sconto,
           imponibile, aliquota_iva, natura_iva, importo_iva, totale_riga,
           regola_iva_id, codice_iva, riferimento_normativo
    FROM preventivi_righe
    WHERE preventivo_id = ?
    ORDER BY id
  `).all(req.params.id);

  const codeBase = `ORD-${String(preventivo.codice_preventivo || preventivo.id).replace(/[^A-Za-z0-9-]/g, '').slice(-24)}`;
  let codiceOrdine = codeBase;
  let idx = 1;
  while (db.prepare('SELECT id FROM ordini WHERE codice_ordine = ?').get(codiceOrdine)) {
    idx += 1;
    codiceOrdine = `${codeBase}-${idx}`;
  }

  const orderResult = db.prepare(`
    INSERT INTO ordini (codice_ordine, tipo, anagrafica_id, canale, stato, data_ordine, data_consegna_prevista, imponibile, iva, totale, note, preventivo_id, created_by_user_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    codiceOrdine,
    'vendita',
    i(preventivo.anagrafica_id),
    'diretto',
    'ricevuto',
    s(preventivo.data_preventivo),
    s(preventivo.data_scadenza),
    n(preventivo.imponibile) || 0,
    n(preventivo.iva) || 0,
    n(preventivo.totale) || 0,
    s(preventivo.note),
    req.params.id,
    i(preventivo.created_by_user_id) || req.user.id
  );

  const ordineId = orderResult.lastInsertRowid;
  if (righe.length) {
    const ins = db.prepare(`
      INSERT INTO ordini_righe (
        ordine_id, prodotto_id, descrizione, quantita, prezzo_unitario, sconto,
        imponibile, aliquota_iva, natura_iva, importo_iva, totale_riga,
        regola_iva_id, codice_iva, riferimento_normativo
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    righe.forEach(riga => {
      // Copia, non ricalcolo: gli importi sono quelli approvati. Il motore
      // interviene solo se la riga del preventivo e' anteriore allo snapshot
      // e quindi non porta ancora gli importi.
      const calc = riga.imponibile === null || riga.imponibile === undefined
        ? calcolaRiga(riga)
        : riga;
      ins.run(
        ordineId,
        i(riga.prodotto_id),
        s(riga.descrizione),
        n(riga.quantita) || 0,
        n(riga.prezzo_unitario) || 0,
        n(riga.sconto) || 0,
        n(calc.imponibile),
        n(calc.aliquota_iva),
        s(calc.natura_iva),
        n(calc.importo_iva),
        n(calc.totale_riga),
        i(calc.regola_iva_id),
        s(calc.codice_iva),
        s(calc.riferimento_normativo)
      );
    });
  }

  if ((preventivo.stato || '') !== 'accettato') {
    db.prepare(`UPDATE preventivi SET stato = 'accettato' WHERE id = ?`).run(req.params.id);
    writeAudit({
      utente_id: req.user.id,
      azione: 'documento_stato',
      entita_tipo: 'preventivo',
      entita_id: Number(req.params.id),
      dettagli: {
        codice: preventivo.codice_preventivo,
        from: preventivo.stato || null,
        to: 'accettato',
        reason: 'conversione_ordine'
      }
    });
  }

  res.json({ ok: true, ordine_id: ordineId, codice_ordine: codiceOrdine });
});

module.exports = router;
