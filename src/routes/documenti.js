const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const { sendMailToRecipients } = require('../services/google');
const { getDocumentPdf } = require('../services/document-pdf');
const { writeAudit } = require('../services/audit');

router.use(authMiddleware);

const s = (v) => (v === undefined || v === null || v === '') ? null : String(v).trim();

function enforcePerm(req, kind) {
  const { sezione, azione } = getPermissionForKind(kind);
  if (req.user?.ruolo_id === 4) return;
  const perm = db.prepare('SELECT * FROM permessi WHERE ruolo_id = ? AND sezione = ?').get(req.user?.ruolo_id, sezione);
  if (!perm || !perm[`can_${azione}`]) throw new Error('Forbidden');
}

function getPermissionForKind(kind) {
  if (kind === 'ddt') return { sezione: 'ddt', azione: 'read' };
  return { sezione: 'ordini', azione: 'read' };
}

function getDocumentQuery(kind) {
  if (kind === 'preventivo') {
    return {
      sql: `
        SELECT p.id, p.codice_preventivo AS codice, p.data_preventivo AS data_documento, p.anagrafica_id,
               a.ragione_sociale, a.email
        FROM preventivi p
        LEFT JOIN anagrafiche a ON a.id = p.anagrafica_id
        WHERE p.id = ?
      `,
      label: 'preventivo'
    };
  }
  if (kind === 'ordine') {
    return {
      sql: `
        SELECT o.id, o.codice_ordine AS codice, o.data_ordine AS data_documento, o.anagrafica_id,
               a.ragione_sociale, a.email
        FROM ordini o
        LEFT JOIN anagrafiche a ON a.id = o.anagrafica_id
        WHERE o.id = ?
      `,
      label: 'ordine'
    };
  }
  if (kind === 'ddt') {
    return {
      sql: `
        SELECT d.id, d.numero_ddt AS codice, d.data AS data_documento, d.destinatario_id AS anagrafica_id,
               a.ragione_sociale, a.email
        FROM ddt d
        LEFT JOIN anagrafiche a ON a.id = d.destinatario_id
        WHERE d.id = ?
      `,
      label: 'DDT'
    };
  }
  throw new Error('Tipo documento non supportato');
}

function getDocumentRow(kind, id) {
  const query = getDocumentQuery(kind);
  const row = db.prepare(query.sql).get(id);
  if (!row) throw new Error(`${query.label} non trovato`);
  return row;
}

function getDocumentLog(kind, id) {
  const rows = db.prepare(`
    SELECT l.*, u.nome AS utente_nome
    FROM audit_log l
    LEFT JOIN utenti u ON u.id = l.utente_id
    WHERE l.entita_tipo = ? AND l.entita_id = ?
      AND l.azione IN ('documento_inviato', 'documento_stato')
    ORDER BY l.creato_il DESC, l.id DESC
  `).all(kind, id);
  const events = rows.map((row) => {
    let details = {};
    try { details = row.dettagli ? JSON.parse(row.dettagli) : {}; } catch {}
    return {
      id: row.id,
      action: row.azione,
      created_at: row.creato_il,
      user: row.utente_nome || 'Sistema',
      details
    };
  });
  const sent = events.filter((event) => event.action === 'documento_inviato');
  return {
    sent_count: sent.length,
    last_sent_at: sent[0]?.created_at || null,
    events
  };
}

router.get('/:kind/:id/recipients', (req, res) => {
  try {
    const kind = s(req.params.kind)?.toLowerCase();
    enforcePerm(req, kind);
    const doc = getDocumentRow(kind, req.params.id);
    const contacts = doc.anagrafica_id ? db.prepare(`
      SELECT id, nome, cognome, ruolo, email
      FROM anagrafiche_contatti
      WHERE anagrafica_id = ? AND COALESCE(attivo, 1) = 1 AND email IS NOT NULL AND TRIM(email) <> ''
      ORDER BY COALESCE(cognome, ''), nome
    `).all(doc.anagrafica_id) : [];
    res.json({
      document: doc,
      contacts,
      emails: [
        ...(doc.email ? [{ label: `${doc.ragione_sociale || 'Anagrafica'} • email principale`, value: doc.email }] : []),
        ...contacts.map((contact) => ({
          label: `${[contact.nome, contact.cognome].filter(Boolean).join(' ')}${contact.ruolo ? ` • ${contact.ruolo}` : ''}`,
          value: contact.email
        }))
      ]
    });
  } catch (e) {
    if (e.message === 'Forbidden') return res.status(403).json({ error: 'Non autorizzato' });
    res.status(400).json({ error: e.message });
  }
});

router.get('/:kind/:id/log', (req, res) => {
  try {
    const kind = s(req.params.kind)?.toLowerCase();
    enforcePerm(req, kind);
    getDocumentRow(kind, req.params.id);
    res.json(getDocumentLog(kind, req.params.id));
  } catch (e) {
    if (e.message === 'Forbidden') return res.status(403).json({ error: 'Non autorizzato' });
    res.status(400).json({ error: e.message });
  }
});

router.post('/send', async (req, res) => {
  try {
    const kind = s(req.body.kind)?.toLowerCase();
    const id = req.body.id;
    const to = s(req.body.to);
    const subject = s(req.body.subject);
    const text = s(req.body.text);
    if (!kind || !id || !to || !subject || !text) {
      return res.status(400).json({ error: 'Documento, destinatario, oggetto e messaggio sono obbligatori' });
    }
    enforcePerm(req, kind);
    getDocumentRow(kind, id);
    const pdf = await getDocumentPdf(kind, id);
    const result = await sendMailToRecipients(
      req.user.id,
      [to],
      subject,
      text,
      [{ filename: pdf.filename, content: pdf.buffer, contentType: 'application/pdf' }]
    );
    if (!result.sent) {
      return res.status(400).json({ error: 'Invio email non riuscito. Verifica la connessione Google.' });
    }
    writeAudit({
      utente_id: req.user.id,
      azione: 'documento_inviato',
      entita_tipo: kind,
      entita_id: Number(id),
      dettagli: {
        to,
        subject,
        filename: pdf.filename,
        sent: result.sent,
        failed: result.failed || 0
      }
    });
    res.json({ ok: true, sent: result.sent, failed: result.failed || 0, log: getDocumentLog(kind, id) });
  } catch (e) {
    if (e.message === 'Forbidden') return res.status(403).json({ error: 'Non autorizzato' });
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
