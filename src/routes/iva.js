const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const { writeAudit } = require('../services/audit');
const {
  TIPO_TRATTAMENTO,
  getRegolaIvaById,
  listRegoleIva,
  listRegoleSelezionabili,
  validateRegolaIva
} = require('../services/iva');

router.use(authMiddleware);

// Permessi.
//
// La lettura chiede solo di essere autenticati: un commerciale deve poter
// scegliere il trattamento su una riga, e senza l'elenco non puo' farlo. La
// scrittura passa da `settings`, che nel modello gia' presente e' la sezione
// amministrativa: admin puo' modificare, solo il superadmin puo' cancellare
// (`can_delete` e' 0 su settings per il ruolo admin). E' esattamente la
// gerarchia richiesta, ottenuta senza aggiungere un secondo sistema di
// autorizzazione.
const canEdit = requirePermesso('settings', 'edit');
const canDelete = requirePermesso('settings', 'delete');

const s = (v) => (v === undefined || v === '' || v === null) ? null : String(v).trim();
const num = (v) => { const p = parseFloat(v); return Number.isFinite(p) ? p : null; };

router.get('/', (req, res) => {
  // `selezionabili=true` e' la vista per le tendine dei documenti: solo regole
  // attive e valide alla data indicata.
  if (String(req.query.selezionabili || '') === 'true') {
    return res.json(listRegoleSelezionabili(s(req.query.data)));
  }
  res.json(listRegoleIva({
    tipo_regola: s(req.query.tipo_regola),
    attiva: req.query.attiva,
    natura_iva: s(req.query.natura_iva),
    aliquota_iva: req.query.aliquota_iva,
    esigibilita_iva: s(req.query.esigibilita_iva),
    valida_al: s(req.query.valida_al),
    q: s(req.query.q)
  }));
});

router.get('/:id', (req, res) => {
  const regola = getRegolaIvaById(req.params.id);
  if (!regola) return res.status(404).json({ error: 'Regola IVA non trovata' });
  res.json({ ...regola, utilizzi: countUsages(regola.id) });
});

router.post('/', canEdit, (req, res) => {
  const b = req.body || {};
  const errors = validateRegolaIva(b);
  if (errors.length) return res.status(400).json({ error: errors.join(' | '), errors });
  const codice = s(b.codice);
  if (getRegolaIvaByCodiceRaw(codice)) {
    return res.status(400).json({ error: `Esiste gia una regola con codice ${codice}` });
  }
  try {
    const result = db.prepare(`
      INSERT INTO regole_iva (
        codice, tipo_regola, gruppo_esclusivo, descrizione, aliquota_iva, natura_iva,
        esigibilita_iva, etichetta_fattura, riferimento_normativo, note_uso,
        revisione_manuale, attiva, valido_dal, valido_al, priorita, fonte_url, verificato_il
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      codice,
      s(b.tipo_regola) || TIPO_TRATTAMENTO,
      s(b.gruppo_esclusivo),
      s(b.descrizione),
      num(b.aliquota_iva),
      s(b.natura_iva) ? s(b.natura_iva).toUpperCase() : null,
      s(b.esigibilita_iva) ? s(b.esigibilita_iva).toUpperCase() : null,
      s(b.etichetta_fattura),
      s(b.riferimento_normativo),
      s(b.note_uso),
      b.revisione_manuale ? 1 : 0,
      b.attiva === false || Number(b.attiva) === 0 ? 0 : 1,
      s(b.valido_dal),
      s(b.valido_al),
      Number.isFinite(Number(b.priorita)) ? Number(b.priorita) : 0,
      s(b.fonte_url),
      s(b.verificato_il)
    );
    const id = Number(result.lastInsertRowid);
    writeAudit({
      utente_id: req.user.id,
      azione: 'regola_iva_creata',
      entita_tipo: 'regola_iva',
      entita_id: id,
      dettagli: { codice, nuovo: getRegolaIvaById(id) }
    });
    res.json({ id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Campi modificabili. `codice` non c'e': e' la chiave con cui le righe storiche
// citano la regola, e rinominarlo scollegherebbe i documenti gia' emessi.
const UPDATABLE = [
  'tipo_regola', 'gruppo_esclusivo', 'descrizione', 'aliquota_iva', 'natura_iva',
  'esigibilita_iva', 'etichetta_fattura', 'riferimento_normativo', 'note_uso',
  'revisione_manuale', 'attiva', 'valido_dal', 'valido_al', 'priorita',
  'fonte_url', 'verificato_il'
];

router.patch('/:id', canEdit, (req, res) => {
  const precedente = getRegolaIvaById(req.params.id);
  if (!precedente) return res.status(404).json({ error: 'Regola IVA non trovata' });

  const b = req.body || {};
  // Si valida la regola come risultera' dopo la modifica, non il solo pezzo
  // inviato: altrimenti un PATCH che tocca la sola aliquota potrebbe lasciare
  // una Natura incompatibile gia' presente in tabella.
  const risultante = { ...precedente };
  for (const field of UPDATABLE) {
    if (b[field] !== undefined) risultante[field] = b[field];
  }
  const errors = validateRegolaIva(risultante, { isUpdate: true });
  if (errors.length) return res.status(400).json({ error: errors.join(' | '), errors });

  const utilizzi = countUsages(precedente.id);
  const cambiaMerito = ['aliquota_iva', 'natura_iva'].some((field) => (
    b[field] !== undefined && String(b[field] ?? '') !== String(precedente[field] ?? '')
  ));
  // Cambiare aliquota o Natura di una regola gia' usata non altera i documenti
  // (hanno il loro snapshot), ma rende la regola una cosa diversa da quella
  // che citano. Si chiede di dirlo esplicitamente.
  if (cambiaMerito && utilizzi.totale > 0 && b.conferma_modifica_sostanziale !== true) {
    return res.status(409).json({
      error: `La regola ${precedente.codice} e usata in ${utilizzi.totale} righe di documento. `
        + 'Cambiarne aliquota o Natura non tocca quei documenti, che conservano il proprio snapshot, '
        + 'ma cambia il significato del codice: preferire una regola nuova con validita successiva. '
        + 'Per procedere comunque inviare conferma_modifica_sostanziale = true.',
      utilizzi
    });
  }

  const sets = [];
  const params = [];
  for (const field of UPDATABLE) {
    if (b[field] === undefined) continue;
    sets.push(`${field} = ?`);
    if (field === 'revisione_manuale' || field === 'attiva') params.push(b[field] ? 1 : 0);
    else if (field === 'aliquota_iva' || field === 'priorita') params.push(num(b[field]));
    else if (field === 'natura_iva' || field === 'esigibilita_iva') params.push(s(b[field]) ? s(b[field]).toUpperCase() : null);
    else params.push(s(b[field]));
  }
  if (!sets.length) return res.json({ ok: true, invariata: true });

  sets.push("aggiornato_il = datetime('now')");
  params.push(precedente.id);
  try {
    db.prepare(`UPDATE regole_iva SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    const aggiornata = getRegolaIvaById(precedente.id);
    writeAudit({
      utente_id: req.user.id,
      azione: 'regola_iva_modificata',
      entita_tipo: 'regola_iva',
      entita_id: precedente.id,
      dettagli: {
        codice: precedente.codice,
        // Solo i campi cambiati davvero: un audit che ripete tutta la riga
        // non si legge.
        modifiche: UPDATABLE
          .filter((field) => b[field] !== undefined && String(precedente[field] ?? '') !== String(aggiornata[field] ?? ''))
          .map((field) => ({ campo: field, prima: precedente[field] ?? null, dopo: aggiornata[field] ?? null })),
        utilizzi: utilizzi.totale
      }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Cancellazione fisica solo per una regola mai usata. Tutto il resto si
// disattiva: le righe storiche continuano a citarla e devono restare leggibili.
router.delete('/:id', canDelete, (req, res) => {
  const regola = getRegolaIvaById(req.params.id);
  if (!regola) return res.status(404).json({ error: 'Regola IVA non trovata' });
  const utilizzi = countUsages(regola.id);
  if (utilizzi.totale > 0) {
    return res.status(409).json({
      error: `La regola ${regola.codice} e usata in ${utilizzi.totale} righe di documento e non puo essere eliminata. `
        + 'Disattivarla con attiva = false, eventualmente con valido_al, cosi resta leggibile nello storico.',
      utilizzi
    });
  }
  db.prepare('DELETE FROM regole_iva WHERE id = ?').run(regola.id);
  db.prepare('UPDATE prodotti SET regola_iva_id = NULL WHERE regola_iva_id = ?').run(regola.id);
  writeAudit({
    utente_id: req.user.id,
    azione: 'regola_iva_eliminata',
    entita_tipo: 'regola_iva',
    entita_id: regola.id,
    dettagli: { codice: regola.codice, regola }
  });
  res.json({ ok: true });
});

function getRegolaIvaByCodiceRaw(codice) {
  if (!codice) return null;
  return db.prepare('SELECT id FROM regole_iva WHERE codice = ?').get(codice);
}

// Quante righe di documento citano la regola. E' la domanda che decide se si
// puo' cancellare e se una modifica e' sostanziale.
function countUsages(regolaId) {
  const count = (table) => {
    try {
      return db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE regola_iva_id = ?`).get(regolaId).n;
    } catch {
      return 0;
    }
  };
  const preventivi = count('preventivi_righe');
  const ordini = count('ordini_righe');
  const fatture = count('fatture_righe');
  const prodotti = count('prodotti');
  return { preventivi, ordini, fatture, prodotti, totale: preventivi + ordini + fatture + prodotti };
}

module.exports = router;
