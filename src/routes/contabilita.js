const express = require('express');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const csvParse = require('csv-parse/sync');
const router = express.Router();
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const { writeAudit } = require('../services/audit');
const svc = require('../services/stamp-duty-service');
const cont = require('../services/contabilita-service');
const bank = require('../services/bank-service');
const gest = require('../services/gestione-service');
const spese = require('../services/spese-service');
const ctrl = require('../services/controllo-service');
const commercialista = require('../services/commercialista-service');
const auto = require('../services/automazione-service');
const aiProvider = require('../services/ai-provider');
const bankAi = require('../services/bank-ai-extraction');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads/contabilita';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

// Legge un CSV/XLSX in righe-oggetto chiavate dall'intestazione. Per i CSV si
// usa csv-parse tenendo i valori come TESTO (XLSX interpreterebbe "122,00" come
// 12200, formato migliaia US): l'importo lo normalizza bank-service col
// separatore decimale scelto. Per gli XLSX i numeri sono gia numeri reali.
function parseUploadedRows(filePath, originalName) {
  const ext = String(originalName || filePath).toLowerCase().split('.').pop();
  if (ext === 'csv' || ext === 'txt') {
    const text = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/)[0] || '';
    const delimiter = firstLine.includes(';') ? ';' : (firstLine.includes('\t') ? '\t' : ',');
    const righe = csvParse.parse(text, { delimiter, columns: true, skip_empty_lines: true, relax_column_count: true, trim: true, bom: true });
    const colonne = righe.length ? Object.keys(righe[0]) : firstLine.split(delimiter).map((s) => s.trim());
    return { colonne, righe };
  }
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
  if (!matrix.length) return { colonne: [], righe: [] };
  const header = matrix[0].map((h) => String(h).trim());
  const righe = matrix.slice(1).map((arr) => {
    const o = {};
    header.forEach((h, i) => { o[h] = arr[i] != null ? arr[i] : ''; });
    return o;
  });
  return { colonne: header, righe };
}

router.use(authMiddleware);

// ===========================================================================
// Fase A — Fondamenta contabilita gestionale
// ===========================================================================

const canRead = requirePermesso('contabilita', 'read');
const canEdit = requirePermesso('contabilita', 'edit');
const canDelete = requirePermesso('contabilita', 'delete');

// --- Dashboard ------------------------------------------------------------
router.get('/dashboard', canRead, (req, res) => {
  try { res.json(cont.dashboard({ anno: req.query.anno })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Vista contabile fatture (riusa le fatture SdI, non le duplica) --------
router.get('/fatture', canRead, (req, res) => {
  try {
    res.json({ fatture: cont.listInvoicesContabile({
      direzione: req.query.direzione,
      tipo_documento: req.query.tipo_documento,
      stato_pagamento: req.query.stato_pagamento,
      dal: req.query.dal,
      al: req.query.al,
      limit: req.query.limit
    }) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/fatture/:id/dettaglio', canRead, (req, res) => {
  try {
    const id = Number(req.params.id);
    res.json({
      pagamenti: cont.listPaymentsForInvoice(id),
      classificazione: cont.getClassification('fattura', id),
      stato: cont.recomputeInvoicePaymentStatus(id)
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Pagamenti / incassi ---------------------------------------------------
router.post('/fatture/:id/pagamenti', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    const id = Number(req.params.id);
    const r = cont.registerPayment({
      verso: b.verso,
      data: b.data,
      importo: b.importo,
      metodo: b.metodo,
      anagrafica_id: b.anagrafica_id,
      note: b.note,
      allocazioni: [{ fattura_id: id, importo_quota: b.importo_quota != null ? b.importo_quota : b.importo }]
    }, req.user.id);
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.pagamento.registra', entita_tipo: 'fattura', entita_id: id, dettagli: { pagamento_id: r.id, importo: r.importo } });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/pagamenti', canEdit, (req, res) => {
  try {
    const r = cont.registerPayment(req.body || {}, req.user.id);
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.pagamento.registra', entita_tipo: 'pagamento', entita_id: r.id, dettagli: { importo: r.importo, verso: r.verso, allocazioni: r.allocazioni.length } });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/pagamenti/:id', canDelete, (req, res) => {
  try {
    const r = cont.deletePayment(Number(req.params.id));
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.pagamento.elimina', entita_tipo: 'pagamento', entita_id: Number(req.params.id), dettagli: r });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Classificazione (split categoria/centro/commessa) ---------------------
router.post('/classifica', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    if (!b.entita_tipo || !b.entita_id) throw new Error('entita_tipo ed entita_id obbligatori');
    const r = cont.saveClassification(b.entita_tipo, Number(b.entita_id), b.righe || b.rows || [], req.user.id);
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.classifica', entita_tipo: b.entita_tipo, entita_id: Number(b.entita_id), dettagli: { quote: r.length } });
    res.json({ classificazione: r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- CRUD categorie --------------------------------------------------------
router.get('/categorie', canRead, (req, res) => {
  try { res.json({ categorie: cont.listCategorie() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/categorie', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    if (!b.nome) throw new Error('Nome obbligatorio');
    const info = db.prepare(`INSERT INTO cont_categorie (nome, tipo, parent_id, colore, ordine, attiva)
      VALUES (?, ?, ?, ?, ?, ?)`).run(b.nome, b.tipo || 'COST', b.parent_id || null, b.colore || null, b.ordine || 0, b.attiva === 0 ? 0 : 1);
    res.json({ id: Number(info.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/categorie/:id', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    db.prepare(`UPDATE cont_categorie SET nome = COALESCE(?, nome), tipo = COALESCE(?, tipo),
      parent_id = ?, colore = ?, ordine = COALESCE(?, ordine), attiva = COALESCE(?, attiva) WHERE id = ?`)
      .run(b.nome ?? null, b.tipo ?? null, b.parent_id ?? null, b.colore ?? null, b.ordine ?? null, b.attiva ?? null, Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/categorie/:id', canDelete, (req, res) => {
  try {
    // Soft: disattiva, non cancella (le classificazioni storiche restano valide).
    db.prepare('UPDATE cont_categorie SET attiva = 0 WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- CRUD centri di costo --------------------------------------------------
router.get('/centri-costo', canRead, (req, res) => {
  try { res.json({ centri: cont.listCentri() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/centri-costo', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    if (!b.nome) throw new Error('Nome obbligatorio');
    const info = db.prepare(`INSERT INTO cont_centri_costo (nome, codice, parent_id, note, attivo)
      VALUES (?, ?, ?, ?, ?)`).run(b.nome, b.codice || null, b.parent_id || null, b.note || null, b.attivo === 0 ? 0 : 1);
    res.json({ id: Number(info.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/centri-costo/:id', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    db.prepare(`UPDATE cont_centri_costo SET nome = COALESCE(?, nome), codice = ?, parent_id = ?,
      note = ?, attivo = COALESCE(?, attivo) WHERE id = ?`)
      .run(b.nome ?? null, b.codice ?? null, b.parent_id ?? null, b.note ?? null, b.attivo ?? null, Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/centri-costo/:id', canDelete, (req, res) => {
  try {
    db.prepare('UPDATE cont_centri_costo SET attivo = 0 WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- CRUD commesse ---------------------------------------------------------
router.get('/commesse', canRead, (req, res) => {
  try { res.json({ commesse: cont.listCommesse() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/commesse', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    if (!b.nome) throw new Error('Nome obbligatorio');
    const info = db.prepare(`INSERT INTO cont_commesse
      (nome, codice, anagrafica_id, valore_previsto, budget, data_inizio, data_fine, stato, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(b.nome, b.codice || null, b.anagrafica_id || null,
        b.valore_previsto != null ? Number(b.valore_previsto) : null,
        b.budget != null ? Number(b.budget) : null,
        b.data_inizio || null, b.data_fine || null, b.stato || 'aperta', b.note || null);
    res.json({ id: Number(info.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/commesse/:id', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    db.prepare(`UPDATE cont_commesse SET nome = COALESCE(?, nome), codice = ?, anagrafica_id = ?,
      valore_previsto = ?, budget = ?, data_inizio = ?, data_fine = ?, stato = COALESCE(?, stato), note = ? WHERE id = ?`)
      .run(b.nome ?? null, b.codice ?? null, b.anagrafica_id ?? null,
        b.valore_previsto != null ? Number(b.valore_previsto) : null,
        b.budget != null ? Number(b.budget) : null,
        b.data_inizio ?? null, b.data_fine ?? null, b.stato ?? null, b.note ?? null, Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/commesse/:id', canDelete, (req, res) => {
  try {
    db.prepare("UPDATE cont_commesse SET stato = 'chiusa' WHERE id = ?").run(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ===========================================================================
// Fase B — Banca e riconciliazione
// ===========================================================================

// --- Conti -----------------------------------------------------------------
router.get('/conti', canRead, (req, res) => {
  try { res.json({ conti: bank.listConti() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/conti', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    if (!b.nome) throw new Error('Nome obbligatorio');
    const info = db.prepare(`INSERT INTO cont_conti (nome, iban, intestatario, valuta, saldo_iniziale, attivo)
      VALUES (?, ?, ?, ?, ?, ?)`).run(b.nome, b.iban || null, b.intestatario || null, b.valuta || 'EUR',
      b.saldo_iniziale != null ? Number(b.saldo_iniziale) : 0, b.attivo === 0 ? 0 : 1);
    res.json({ id: Number(info.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/conti/:id', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    db.prepare(`UPDATE cont_conti SET nome = COALESCE(?, nome), iban = ?, intestatario = ?,
      valuta = COALESCE(?, valuta), saldo_iniziale = COALESCE(?, saldo_iniziale), attivo = COALESCE(?, attivo) WHERE id = ?`)
      .run(b.nome ?? null, b.iban ?? null, b.intestatario ?? null, b.valuta ?? null,
        b.saldo_iniziale != null ? Number(b.saldo_iniziale) : null, b.attivo ?? null, Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Template di mapping ---------------------------------------------------
router.get('/banca/template', canRead, (req, res) => {
  try { res.json({ template: bank.listTemplate() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/banca/template', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    if (!b.nome) throw new Error('Nome obbligatorio');
    const mapping = typeof b.mapping === 'string' ? b.mapping : JSON.stringify(b.mapping || {});
    if (b.id) {
      db.prepare(`UPDATE cont_banca_template SET nome = ?, mapping = ?, formato_data = ?, separatore = ?, decimale = ? WHERE id = ?`)
        .run(b.nome, mapping, b.formato_data || null, b.separatore || ',', b.decimale || ',', Number(b.id));
      return res.json({ id: Number(b.id) });
    }
    const info = db.prepare(`INSERT INTO cont_banca_template (nome, mapping, formato_data, separatore, decimale)
      VALUES (?, ?, ?, ?, ?)`).run(b.nome, mapping, b.formato_data || null, b.separatore || ',', b.decimale || ',');
    res.json({ id: Number(info.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Upload/preview/import estratto conto ----------------------------------
router.post('/banca/preview', canEdit, upload.single('file'), (req, res) => {
  try {
    if (!req.file) throw new Error('File mancante');
    const parsed = parseUploadedRows(req.file.path, req.file.originalname);
    res.json({ colonne: parsed.colonne, righe_totali: parsed.righe.length, anteprima: parsed.righe.slice(0, 15), file_path: req.file.path });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/banca/import', canEdit, upload.single('file'), (req, res) => {
  const b = req.body || {};
  try {
    // Il file puo arrivare col multipart, oppure si riusa un file_path del preview.
    const filePath = req.file ? req.file.path : b.file_path;
    if (!filePath) throw new Error('File mancante');
    if (!b.conto_id) throw new Error('Conto obbligatorio');

    let template = null;
    if (b.template_id) {
      template = bank.listTemplate().find((t) => t.id === Number(b.template_id)) || null;
    } else if (b.mapping) {
      template = { mapping: typeof b.mapping === 'string' ? JSON.parse(b.mapping) : b.mapping, decimale: b.decimale || ',', formato_data: b.formato_data || null };
    }
    if (!template || !template.mapping || !Object.keys(template.mapping).length) throw new Error('Mapping colonne obbligatorio');

    const parsed = parseUploadedRows(filePath, (req.file && req.file.originalname) || b.file_name || filePath);
    const r = bank.importMovements({ conto_id: Number(b.conto_id), template, rows: parsed.righe, fileName: (req.file && req.file.originalname) || null, userId: req.user.id });
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.banca.import', entita_tipo: 'cont_conto', entita_id: Number(b.conto_id), dettagli: r });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Import PDF via AI (disattivabile) -------------------------------------
// Stato AI: se non configurata/abilitata, il frontend nasconde l'opzione PDF.
router.get('/banca/ai-stato', canRead, (req, res) => {
  res.json({ configurata: aiProvider.isConfigured(), abilitata: aiProvider.isEnabled(), modello: aiProvider.DEFAULT_MODEL });
});

// Analizza un PDF di estratto conto con l'AI e verifica i movimenti contro i
// totali del riepilogo. NON importa: ritorna l'anteprima da confermare.
router.post('/banca/pdf-analizza', canEdit, upload.single('file'), async (req, res) => {
  try {
    if (!aiProvider.isEnabled()) throw new Error('Estrazione AI non disponibile (chiave assente o disattivata)');
    if (!req.file) throw new Error('File PDF mancante');
    const buf = fs.readFileSync(req.file.path);
    const mime = req.file.mimetype && req.file.mimetype.startsWith('image/') ? req.file.mimetype : 'application/pdf';
    const result = await bankAi.extractBankStatement(buf, { mime, filename: req.file.originalname });
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.banca.pdf-analizza', entita_tipo: 'file', entita_id: null, dettagli: { movimenti: result.movimenti.length, coerente: result.verifica.coerente } });
    res.json(result);
  } catch (e) {
    try {
      db.prepare(`INSERT INTO system_log (livello, origine, messaggio, dettagli) VALUES ('error','contabilita-banca-ai',?,?)`)
        .run(e.message, JSON.stringify({ file: req.file && req.file.originalname }));
    } catch {}
    res.status(400).json({ error: e.message });
  }
});

// Importa i movimenti gia' estratti/confermati dall'anteprima AI.
router.post('/banca/importa-parsed', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    if (!b.conto_id) throw new Error('Conto obbligatorio');
    const r = bank.importParsedMovements({ conto_id: Number(b.conto_id), movimenti: b.movimenti || [], fileName: b.file_name || 'estratto-pdf', userId: req.user.id, source: 'AI_PDF' });
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.banca.importa-parsed', entita_tipo: 'cont_conto', entita_id: Number(b.conto_id), dettagli: r });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Movimenti -------------------------------------------------------------
router.get('/movimenti', canRead, (req, res) => {
  try {
    res.json({ movimenti: bank.listMovimenti({ conto_id: req.query.conto_id, stato: req.query.stato, dal: req.query.dal, al: req.query.al, limit: req.query.limit }) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Riconciliazione -------------------------------------------------------
router.get('/riconciliazione/:movimentoId/proposte', canRead, (req, res) => {
  try { res.json({ candidati: bank.reconciliationCandidates(Number(req.params.movimentoId), Number(req.query.limit) || 10) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/riconciliazione/:movimentoId/abbina', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    const r = bank.reconcile(Number(req.params.movimentoId), b.allocazioni || b.righe || [], req.user.id);
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.riconcilia.abbina', entita_tipo: 'cont_movimento', entita_id: Number(req.params.movimentoId), dettagli: { stato: r.stato, pagamento_id: r.pagamento_id } });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/riconciliazione/:movimentoId/ignora', canEdit, (req, res) => {
  try {
    const r = bank.ignoreMovement(Number(req.params.movimentoId));
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.riconcilia.ignora', entita_tipo: 'cont_movimento', entita_id: Number(req.params.movimentoId), dettagli: r });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ===========================================================================
// Fase C — Flussi gestionali: scadenzario, prima nota, cash flow, anomalie
// ===========================================================================

router.get('/scadenze', canRead, (req, res) => {
  try { res.json(gest.scadenzario(req.query.oggi)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/cashflow', canRead, (req, res) => {
  try { res.json(gest.cashflow({ dal: req.query.dal, al: req.query.al })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/anomalie', canRead, (req, res) => {
  try { res.json(gest.anomalie(req.query.oggi)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/prima-nota', canRead, (req, res) => {
  try { res.json(gest.primaNota({ dal: req.query.dal, al: req.query.al })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Export prima nota in CSV (separatore ; per Excel italiano).
router.get('/prima-nota/export', canRead, (req, res) => {
  try {
    const { righe } = gest.primaNota({ dal: req.query.dal, al: req.query.al });
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['Data', 'Fonte', 'Descrizione', 'Controparte', 'Entrata', 'Uscita', 'Saldo'];
    const lines = [header.join(';')].concat(righe.map((r) => [r.data, r.fonte, r.descrizione, r.controparte, r.entrata, r.uscita, r.saldo].map(esc).join(';')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="prima-nota.csv"');
    res.send('﻿' + lines.join('\r\n'));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/nota-manuale', canEdit, (req, res) => {
  try {
    const r = gest.addNotaManuale(req.body || {}, req.user.id);
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.nota-manuale.crea', entita_tipo: 'cont_nota_manuale', entita_id: r.id, dettagli: {} });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/nota-manuale/:id', canDelete, (req, res) => {
  try { res.json(gest.deleteNotaManuale(Number(req.params.id))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ===========================================================================
// Fase D (core) — Spese documentate e manuali (nessuna estrazione AI)
// ===========================================================================

router.get('/spese', canRead, (req, res) => {
  try { res.json({ spese: spese.listSpese({ stato: req.query.stato, dal: req.query.dal, al: req.query.al, categoria_id: req.query.categoria_id }) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Crea una spesa. Il documento (foto/PDF) e' opzionale: se presente viene
// archiviato con SHA-256 e validato (MIME + magic bytes); l'upload non viene
// mai bloccato dai campi (si compila a mano).
router.post('/spese', canEdit, upload.single('file'), (req, res) => {
  try {
    let documentoId = null;
    if (req.file) {
      try {
        const doc = spese.saveDocumento(req.file, req.user.id);
        documentoId = doc.id;
      } catch (docErr) {
        try { fs.unlinkSync(req.file.path); } catch {}
        throw docErr;
      }
    }
    const r = spese.createSpesa(req.body || {}, documentoId, req.user.id);
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.spesa.crea', entita_tipo: 'cont_spesa', entita_id: r.id, dettagli: { documento_id: documentoId } });
    res.json({ ...r, documento_id: documentoId });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/spese/:id', canEdit, (req, res) => {
  try {
    const r = spese.updateSpesa(Number(req.params.id), req.body || {});
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.spesa.modifica', entita_tipo: 'cont_spesa', entita_id: Number(req.params.id), dettagli: {} });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/spese/:id', canDelete, (req, res) => {
  try {
    const r = spese.deleteSpesa(Number(req.params.id));
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.spesa.elimina', entita_tipo: 'cont_spesa', entita_id: Number(req.params.id), dettagli: r });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Scarica il documento allegato a una spesa.
router.get('/spese/:id/documento', canRead, (req, res) => {
  try {
    const s = db.prepare('SELECT documento_id FROM cont_spese WHERE id = ?').get(Number(req.params.id));
    if (!s || !s.documento_id) return res.status(404).json({ error: 'Nessun documento' });
    const doc = spese.getDocumento(s.documento_id);
    if (!doc || !fs.existsSync(doc.path)) return res.status(404).json({ error: 'File non trovato' });
    res.setHeader('Content-Type', doc.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${(doc.original_filename || 'documento').replace(/[^\w.\-]/g, '_')}"`);
    fs.createReadStream(doc.path).pipe(res);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ===========================================================================
// Fase E — Anticipi, rimborsi (nota spese), budget, controllo di gestione
// ===========================================================================

// --- Rimborsi --------------------------------------------------------------
router.get('/rimborsi', canRead, (req, res) => {
  try { res.json({ rimborsi: ctrl.listRimborsi() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/rimborsi/anticipi-disponibili', canRead, (req, res) => {
  try { res.json({ spese: ctrl.anticipoDisponibili() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/rimborsi/:id', canRead, (req, res) => {
  try { res.json(ctrl.getRimborso(Number(req.params.id))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/rimborsi', canEdit, (req, res) => {
  try {
    const r = ctrl.createRimborso(req.body || {}, req.user.id);
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.rimborso.crea', entita_tipo: 'cont_rimborso', entita_id: r.id, dettagli: {} });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/rimborsi/:id/spese', canEdit, (req, res) => {
  try { res.json(ctrl.attachSpese(Number(req.params.id), (req.body || {}).spese_ids || [])); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/rimborsi/:id/spese/:spesaId', canEdit, (req, res) => {
  try { res.json(ctrl.detachSpesa(Number(req.params.id), Number(req.params.spesaId))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/rimborsi/:id/stato', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    const r = ctrl.transitionRimborso(Number(req.params.id), b.stato, req.user.id, { pagato_il: b.pagato_il, metodo: b.metodo });
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.rimborso.stato', entita_tipo: 'cont_rimborso', entita_id: Number(req.params.id), dettagli: { stato: b.stato } });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Budget e report gestionale --------------------------------------------
router.get('/budget', canRead, (req, res) => {
  try { res.json({ budget: ctrl.listBudget(req.query.periodo) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/budget', canEdit, (req, res) => {
  try {
    const r = ctrl.createBudget(req.body || {});
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.budget.crea', entita_tipo: 'cont_budget', entita_id: r.id, dettagli: {} });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/budget/:id', canDelete, (req, res) => {
  try { res.json(ctrl.deleteBudget(Number(req.params.id))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/report-gestionale', canRead, (req, res) => {
  try { res.json(ctrl.reportGestionale(req.query.periodo)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ===========================================================================
// Fase G — Automazione movimenti bancari (regole, spese auto, auto-match)
// ===========================================================================

router.get('/automazione/proposte', canRead, (req, res) => {
  try { res.json(auto.proposteMovimenti({ conto_id: req.query.conto_id })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/automazione/applica', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    if (!b.movimento_id) throw new Error('movimento_id obbligatorio');
    const r = auto.applicaProposta(Number(b.movimento_id), b.override || null, req.user.id);
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.automazione.applica', entita_tipo: 'cont_movimento', entita_id: Number(b.movimento_id), dettagli: r });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/automazione/applica-sicure', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    const r = auto.applicaSicure({ conto_id: b.conto_id }, req.user.id);
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.automazione.applica-sicure', entita_tipo: 'cont_conto', entita_id: b.conto_id ? Number(b.conto_id) : null, dettagli: { applicate: r.applicate, errori: r.errori } });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/automazione/:movimentoId/annulla', canEdit, (req, res) => {
  try {
    const r = auto.annullaElaborazione(Number(req.params.movimentoId));
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.automazione.annulla', entita_tipo: 'cont_movimento', entita_id: Number(req.params.movimentoId), dettagli: r });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Regole di automazione (editabili) -------------------------------------
router.get('/regole', canRead, (req, res) => {
  try { res.json({ regole: auto.listRegole() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/regole', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    if (!b.match_valore) throw new Error('Valore da cercare obbligatorio');
    const info = db.prepare(`INSERT INTO cont_regole (nome, match_campo, match_tipo, match_valore, azione, categoria_id, centro_costo_id, commessa_id, priorita, attiva)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      b.nome || null, b.match_campo || 'descrizione', b.match_tipo || 'contiene', b.match_valore,
      b.azione || 'categoria', b.categoria_id || null, b.centro_costo_id || null, b.commessa_id || null,
      b.priorita || 0, b.attiva === 0 ? 0 : 1);
    res.json({ id: Number(info.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/regole/:id', canEdit, (req, res) => {
  const b = req.body || {};
  try {
    db.prepare(`UPDATE cont_regole SET nome=?, match_campo=COALESCE(?,match_campo), match_tipo=COALESCE(?,match_tipo),
      match_valore=COALESCE(?,match_valore), azione=COALESCE(?,azione), categoria_id=?, centro_costo_id=?, commessa_id=?,
      priorita=COALESCE(?,priorita), attiva=COALESCE(?,attiva) WHERE id=?`).run(
      b.nome ?? null, b.match_campo ?? null, b.match_tipo ?? null, b.match_valore ?? null, b.azione ?? null,
      b.categoria_id ?? null, b.centro_costo_id ?? null, b.commessa_id ?? null, b.priorita ?? null, b.attiva ?? null, Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/regole/:id', canDelete, (req, res) => {
  try { db.prepare('DELETE FROM cont_regole WHERE id = ?').run(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ===========================================================================
// Fase F — Commercialista: checklist stato-mese + export ZIP con originali
// ===========================================================================

router.get('/commercialista/stato', canRead, (req, res) => {
  try { res.json(commercialista.statoMese(req.query.periodo)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/commercialista/export', canRead, (req, res) => {
  try {
    const { filename, buffer, conteggi } = commercialista.buildExport(req.query.periodo);
    writeAudit({ utente_id: req.user.id, azione: 'contabilita.commercialista.export', entita_tipo: 'periodo', entita_id: null, dettagli: { periodo: req.query.periodo, ...conteggi } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Export-Conteggi', JSON.stringify(conteggi));
    res.send(buffer);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ===========================================================================
// Bollo (Fase 3) — il bollo lavora sulle fatture: usa il permesso 'fatture'.
// ===========================================================================

// Ricalcola il bollo su tutte le fatture (popola le esistenti).
router.post('/bollo/ricalcola', requirePermesso('fatture', 'edit'), (req, res) => {
  try {
    const r = svc.recomputeAllInvoices({});
    writeAudit({ utente_id: req.user.id, azione: 'bollo.ricalcola', entita_tipo: 'fattura', entita_id: null, dettagli: r });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/bollo/dashboard', requirePermesso('fatture', 'read'), (req, res) => {
  try { res.json({ settlements: svc.getBolloDashboard({}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/bollo/settlement/:id/fatture', requirePermesso('fatture', 'read'), (req, res) => {
  try { res.json({ fatture: svc.settlementInvoices(Number(req.params.id)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Registra il pagamento del settlement trimestrale (un solo versamento, non 2 EUR
// a fattura). Handoff manuale: portale AdE / dati F24 / registrazione.
router.post('/bollo/settlement/:id/paga', requirePermesso('fatture', 'edit'), (req, res) => {
  const b = req.body || {};
  try {
    const s = svc.paySettlement(Number(req.params.id), {
      method: b.method || null,
      taxCode: b.taxCode || b.tax_code || null,
      paidAt: b.paidAt || b.paid_at || null,
      receiptPath: b.receiptPath || null,
      officialAmount: (b.officialAmount != null && b.officialAmount !== '') ? Number(b.officialAmount) : null,
      notes: b.notes || null
    });
    writeAudit({ utente_id: req.user.id, azione: 'bollo.settlement.paga', entita_tipo: 'stamp_duty_settlement', entita_id: Number(req.params.id), dettagli: { method: b.method, taxCode: b.taxCode } });
    res.json(s);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/bollo/settlement/:id/riconcilia', requirePermesso('fatture', 'edit'), (req, res) => {
  try {
    const s = svc.reconcileSettlement(Number(req.params.id));
    writeAudit({ utente_id: req.user.id, azione: 'bollo.settlement.riconcilia', entita_tipo: 'stamp_duty_settlement', entita_id: Number(req.params.id), dettagli: {} });
    res.json(s);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
