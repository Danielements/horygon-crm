const express = require('express');
const router = express.Router();
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const db = require('../db/database');
const { getAiSettings, saveAiSettings } = require('../services/ai-settings');
const { writeAudit } = require('../services/audit');

router.use(authMiddleware);

router.get('/settings', requirePermesso('utenti', 'admin'), (req, res) => {
  res.json(getAiSettings());
});

router.put('/settings', requirePermesso('utenti', 'admin'), (req, res) => {
  const saved = saveAiSettings(req.body || {});
  writeAudit({ utente_id: req.user.id, azione: 'ai.settings.update', entita_tipo: 'ai', dettagli: { providers: Object.keys(req.body || {}) } });
  res.json(saved);
});

router.get('/usage-log', requirePermesso('utenti', 'admin'), (req, res) => {
  const rows = db.prepare('SELECT * FROM ai_usage_log ORDER BY creato_il DESC LIMIT 500').all();
  res.json(rows);
});

router.post('/test', requirePermesso('utenti', 'admin'), (req, res) => {
  const settings = getAiSettings();
  const openaiConfigured = !!settings?.openai?.api_key_configured;
  const claudeConfigured = !!settings?.claude?.api_key_configured;
  writeAudit({ utente_id: req.user.id, azione: 'ai.test.connection', entita_tipo: 'ai', dettagli: { openaiConfigured, claudeConfigured } });
  res.json({
    ok: openaiConfigured || claudeConfigured,
    message: openaiConfigured || claudeConfigured
      ? 'Configurazione provider AI presente. Le chiamate operative possono essere abilitate.'
      : 'Configura un provider AI in Impostazioni > AI'
  });
});

router.get('/status', (req, res) => {
  const settings = getAiSettings();
  res.json({
    enabled: !!settings?.openai?.api_key_configured || !!settings?.claude?.api_key_configured,
    message: (!!settings?.openai?.api_key_configured || !!settings?.claude?.api_key_configured)
      ? 'Provider AI configurato'
      : 'Configura un provider AI in Impostazioni > AI'
  });
});

router.post('/assist', (req, res) => {
  const prompt = String(req.body?.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'Prompt obbligatorio' });
  const lower = prompt.toLowerCase();
  const settings = getAiSettings();
  const providerEnabled = !!settings?.openai?.api_key_configured || !!settings?.claude?.api_key_configured;
  let result = {
    mode: providerEnabled ? 'assistant_ready' : 'local_assistant',
    answer: '',
    items: [],
    suggestions: [
      'Cerca clienti con CAP 04100',
      'Trova fatture passive scadute',
      'Mostrami ordini aperti',
      'Elenca spedizioni in transito',
      'Trova proforme aperte'
    ]
  };

  const capMatch = lower.match(/\bcap\s+(\d{4,6})\b/);
  if (capMatch) {
    const rows = db.prepare(`
      SELECT id, tipo, ragione_sociale, cap, citta, provincia
      FROM anagrafiche
      WHERE cap = ?
      ORDER BY ragione_sociale
      LIMIT 25
    `).all(capMatch[1]);
    result.answer = rows.length
      ? `Ho trovato ${rows.length} anagrafiche con CAP ${capMatch[1]}.`
      : `Non ho trovato anagrafiche con CAP ${capMatch[1]}.`;
    result.items = rows;
  } else if (lower.includes('fatture') && lower.includes('passiv') && (lower.includes('scad') || lower.includes('scadenza'))) {
    const rows = db.prepare(`
      SELECT f.id, f.numero, f.data, f.scadenza, f.totale, a.ragione_sociale
      FROM fatture f
      LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id
      WHERE COALESCE(f.direzione, CASE WHEN f.tipo = 'emessa' THEN 'attiva' ELSE 'passiva' END) = 'passiva'
        AND COALESCE(f.stato_pagamento, '') <> 'pagata'
        AND f.scadenza IS NOT NULL
        AND date(f.scadenza) <= date('now')
      ORDER BY f.scadenza ASC
      LIMIT 25
    `).all();
    result.answer = rows.length ? `Ci sono ${rows.length} fatture passive scadute.` : 'Non risultano fatture passive scadute.';
    result.items = rows;
  } else if (lower.includes('ordini apert')) {
    const rows = db.prepare(`
      SELECT o.id, o.codice_ordine, o.tipo, o.stato, o.data_ordine, a.ragione_sociale
      FROM ordini o
      LEFT JOIN anagrafiche a ON a.id = o.anagrafica_id
      WHERE lower(COALESCE(o.stato, '')) NOT IN ('consegnato','annullato','chiuso')
      ORDER BY COALESCE(o.data_ordine, o.creato_il) DESC
      LIMIT 25
    `).all();
    result.answer = rows.length ? `Ho trovato ${rows.length} ordini ancora aperti.` : 'Non risultano ordini aperti.';
    result.items = rows;
  } else if ((lower.includes('spedizion') || lower.includes('logistic')) && lower.includes('transito')) {
    const rows = db.prepare(`
      SELECT id, codice_spedizione, stato_spedizione, eta, tracking_number, container_number
      FROM spedizioni
      WHERE lower(COALESCE(stato_spedizione,'')) IN ('in_transito','arrivata al porto','in_dogana','sdoganata')
      ORDER BY COALESCE(eta, etd, creato_il)
      LIMIT 25
    `).all();
    result.answer = rows.length ? `Ho trovato ${rows.length} spedizioni operative in transito.` : 'Non risultano spedizioni in transito.';
    result.items = rows;
  } else if (lower.includes('proform')) {
    const rows = db.prepare(`
      SELECT p.id, p.numero_proforma, p.data, p.stato, p.totale, a.ragione_sociale as fornitore_nome
      FROM proforme_invoice p
      LEFT JOIN anagrafiche a ON a.id = p.fornitore_id
      WHERE lower(COALESCE(p.stato,'')) NOT IN ('chiusa','annullata')
      ORDER BY COALESCE(p.data, p.creato_il) DESC
      LIMIT 25
    `).all();
    result.answer = rows.length ? `Ho trovato ${rows.length} proforme ancora aperte.` : 'Non risultano proforme aperte.';
    result.items = rows;
  } else {
    result.answer = providerEnabled
      ? 'Provider AI configurato. Il prossimo step e collegare i prompt a funzioni CRM e, dove serve, a un modello esterno.'
      : 'Posso gia aiutarti con ricerche operative nel CRM. Per analisi avanzate e generazione testi, configura OpenAI o Claude in Impostazioni > AI.';
  }

  writeAudit({ utente_id: req.user.id, azione: 'ai.assist', entita_tipo: 'ai', dettagli: { prompt, mode: result.mode, items: result.items.length } });
  res.json(result);
});

module.exports = router;
