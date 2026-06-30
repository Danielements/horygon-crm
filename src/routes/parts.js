const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');

const router = express.Router();

const PARTS_OPEN_STATUSES = ['nuova', 'in_lavorazione', 'in_attesa_dati_cliente', 'in_attesa_verifica_tecnica', 'oe_trovato', 'preventivo_pronto'];

function s(value) {
  return value === undefined || value === null || value === '' ? null : String(value).trim();
}

function i(value) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function json(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function nowSql() {
  return db.prepare(`SELECT datetime('now') AS value`).get().value;
}

function makeUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `parts-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function logPartEvent(partsRequestId, eventType, eventMessage, eventSource = 'crm', payload = null) {
  db.prepare(`
    INSERT INTO parts_request_events (parts_request_id, event_type, event_message, event_source, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(partsRequestId, eventType, s(eventMessage), s(eventSource), payload ? JSON.stringify(payload) : null);
}

function upsertConversationState(conversationId) {
  db.prepare(`
    UPDATE whatsapp_conversations
    SET last_message_at = (
      SELECT MAX(created_at) FROM whatsapp_messages WHERE conversation_id = whatsapp_conversations.id
    ),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(conversationId);
}

function ensureConversationByPhone(phone, partsRequestId = null, customerId = null) {
  const normalizedPhone = s(phone) || 'sconosciuto';
  let conversation = db.prepare(`
    SELECT *
    FROM whatsapp_conversations
    WHERE user_phone = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `).get(normalizedPhone);

  if (!conversation) {
    const result = db.prepare(`
      INSERT INTO whatsapp_conversations (conversation_uuid, customer_id, user_phone, parts_request_id, status, last_message_at)
      VALUES (?, ?, ?, ?, 'aperta', datetime('now'))
    `).run(makeUuid(), customerId, normalizedPhone, partsRequestId);
    conversation = db.prepare('SELECT * FROM whatsapp_conversations WHERE id = ?').get(Number(result.lastInsertRowid));
  } else if ((partsRequestId && !conversation.parts_request_id) || (customerId && !conversation.customer_id)) {
    db.prepare(`
      UPDATE whatsapp_conversations
      SET parts_request_id = COALESCE(parts_request_id, ?),
          customer_id = COALESCE(customer_id, ?),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(partsRequestId, customerId, conversation.id);
    conversation = db.prepare('SELECT * FROM whatsapp_conversations WHERE id = ?').get(conversation.id);
  }

  return conversation;
}

function parseBackendUrl() {
  const base = process.env.PARTS_BACKEND_BASE_URL;
  if (!base) return null;
  try {
    return new URL(base);
  } catch {
    return null;
  }
}

function forwardToPartsBackend(payload) {
  return new Promise((resolve) => {
    const parsed = parseBackendUrl();
    if (!parsed) return resolve({ skipped: true, reason: 'backend_non_configurato' });

    const endpoint = new URL('/api/intake/whatsapp', parsed);
    const body = JSON.stringify(payload || {});
    const client = endpoint.protocol === 'https:' ? https : http;
    const req = client.request({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80),
      path: `${endpoint.pathname}${endpoint.search}`,
      method: 'POST',
      timeout: Number(process.env.RTWS_TIMEOUT_MS || 12000),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(process.env.PARTS_BACKEND_API_KEY ? { 'x-api-key': process.env.PARTS_BACKEND_API_KEY } : {})
      }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsedBody = null;
        try { parsedBody = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ skipped: false, statusCode: res.statusCode || 0, body: parsedBody, raw });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (error) => resolve({ skipped: false, error: error.message }));
    req.write(body);
    req.end();
  });
}

function buildDashboard() {
  const query = db.prepare(`
    SELECT
      SUM(CASE WHEN date(created_at) = date('now') THEN 1 ELSE 0 END) AS requests_today,
      SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS requests_last_7_days,
      SUM(CASE WHEN status IN ('nuova','in_lavorazione','in_attesa_dati_cliente','in_attesa_verifica_tecnica','oe_trovato','preventivo_pronto') THEN 1 ELSE 0 END) AS requests_open,
      SUM(CASE WHEN status = 'in_attesa_dati_cliente' THEN 1 ELSE 0 END) AS waiting_customer,
      SUM(CASE WHEN status = 'in_attesa_verifica_tecnica' THEN 1 ELSE 0 END) AS waiting_technical,
      SUM(CASE WHEN status = 'completata' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN oe_code IS NOT NULL AND oe_code <> '' THEN 1 ELSE 0 END) AS oe_found,
      SUM(CASE WHEN status = 'errore_integrazione' THEN 1 ELSE 0 END) AS integration_errors
    FROM parts_requests
  `).get() || {};

  const messages = db.prepare(`
    SELECT
      SUM(CASE WHEN direction = 'inbound' AND date(created_at) = date('now') THEN 1 ELSE 0 END) AS inbound_today,
      SUM(CASE WHEN direction = 'outbound' AND date(created_at) = date('now') THEN 1 ELSE 0 END) AS outbound_today
    FROM whatsapp_messages
    WHERE internal_note = 0
  `).get() || {};

  const trend = db.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS total
    FROM parts_requests
    WHERE created_at >= datetime('now', '-13 days')
    GROUP BY date(created_at)
    ORDER BY day ASC
  `).all();

  const byStatus = db.prepare(`
    SELECT status, COUNT(*) AS total
    FROM parts_requests
    GROUP BY status
    ORDER BY total DESC, status ASC
  `).all();

  const byCategory = db.prepare(`
    SELECT COALESCE(normalized_part_category, 'non_classificata') AS category, COUNT(*) AS total
    FROM parts_requests
    GROUP BY COALESCE(normalized_part_category, 'non_classificata')
    ORDER BY total DESC, category ASC
    LIMIT 8
  `).all();

  const recent = db.prepare(`
    SELECT pr.id, pr.request_uuid, pr.user_phone, pr.status, pr.normalized_part_name, pr.normalized_part_category, pr.created_at,
           a.ragione_sociale AS customer_name
    FROM parts_requests pr
    LEFT JOIN anagrafiche a ON a.id = pr.customer_id
    ORDER BY pr.created_at DESC
    LIMIT 6
  `).all();

  const attention = db.prepare(`
    SELECT id, request_uuid, user_phone, status, original_message, created_at, updated_at
    FROM parts_requests
    WHERE status IN ('nuova', 'in_attesa_dati_cliente', 'errore_integrazione')
    ORDER BY updated_at ASC, created_at ASC
    LIMIT 6
  `).all();

  const errors = db.prepare(`
    SELECT pre.id, pre.parts_request_id, pre.event_message, pre.created_at, pr.request_uuid
    FROM parts_request_events pre
    LEFT JOIN parts_requests pr ON pr.id = pre.parts_request_id
    WHERE pre.event_type = 'errore_integrazione'
    ORDER BY pre.created_at DESC
    LIMIT 6
  `).all();

  return {
    kpis: {
      requests_today: query.requests_today || 0,
      requests_last_7_days: query.requests_last_7_days || 0,
      requests_open: query.requests_open || 0,
      waiting_customer: query.waiting_customer || 0,
      waiting_technical: query.waiting_technical || 0,
      completed: query.completed || 0,
      oe_found: query.oe_found || 0,
      integration_errors: query.integration_errors || 0,
      inbound_today: messages.inbound_today || 0,
      outbound_today: messages.outbound_today || 0
    },
    trend,
    byStatus,
    byCategory,
    recent,
    attention,
    errors
  };
}

function serializeRequestDetails(id) {
  const request = db.prepare(`
    SELECT pr.*, a.ragione_sociale AS customer_name, u.nome AS assigned_user_name
    FROM parts_requests pr
    LEFT JOIN anagrafiche a ON a.id = pr.customer_id
    LEFT JOIN utenti u ON u.id = pr.assigned_to_user_id
    WHERE pr.id = ?
  `).get(id);
  if (!request) return null;

  return {
    ...request,
    tags: json(request.tags_json, []),
    vehicle: db.prepare('SELECT * FROM parts_request_vehicle_data WHERE parts_request_id = ?').get(id) || null,
    oe_results: db.prepare(`
      SELECT * FROM parts_request_oe_results
      WHERE parts_request_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(id),
    equivalents: db.prepare(`
      SELECT * FROM parts_request_equivalents
      WHERE parts_request_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(id),
    notes: db.prepare(`
      SELECT n.*, u.nome AS author_name
      FROM parts_request_notes n
      LEFT JOIN utenti u ON u.id = n.author_user_id
      WHERE n.parts_request_id = ?
      ORDER BY n.created_at DESC, n.id DESC
    `).all(id),
    events: db.prepare(`
      SELECT *
      FROM parts_request_events
      WHERE parts_request_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(id)
  };
}

router.get('/webhook/whatsapp', (req, res) => {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && verifyToken && token === verifyToken) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Forbidden');
});

router.post('/webhook/whatsapp', async (req, res) => {
  const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value || {};
      const messages = Array.isArray(value?.messages) ? value.messages : [];
      for (const message of messages) {
        const phone = s(message?.from) || s(value?.contacts?.[0]?.wa_id) || 'sconosciuto';
        const bodyText = s(message?.text?.body) || s(message?.button?.text) || s(message?.interactive?.button_reply?.title) || '';
        const externalMessageId = s(message?.id);

        db.exec('BEGIN');
        try {
          const requestInsert = db.prepare(`
            INSERT INTO parts_requests (
              request_uuid, channel, external_message_id, user_phone, original_message,
              requested_part_text, status, source_system, last_message_at
            )
            VALUES (?, 'whatsapp', ?, ?, ?, ?, 'nuova', 'whatsapp_webhook', datetime('now'))
          `).run(makeUuid(), externalMessageId, phone, bodyText || '[messaggio senza testo]', bodyText || null);

          const partsRequestId = Number(requestInsert.lastInsertRowid);
          const conversation = ensureConversationByPhone(phone, partsRequestId, null);

          db.prepare(`
            INSERT INTO whatsapp_messages (
              conversation_id, direction, channel, external_message_id, message_type,
              body_text, media_url, media_mime_type, media_metadata_json, delivery_status,
              source_system, raw_payload_json
            )
            VALUES (?, 'inbound', 'whatsapp', ?, ?, ?, ?, ?, ?, 'received', 'whatsapp_webhook', ?)
          `).run(
            conversation.id,
            externalMessageId,
            s(message?.type) || 'text',
            bodyText,
            s(message?.image?.id) || s(message?.document?.id) || s(message?.audio?.id) || null,
            s(message?.image?.mime_type) || s(message?.document?.mime_type) || s(message?.audio?.mime_type) || null,
            JSON.stringify(message),
            JSON.stringify({ entry, change, value, message })
          );

          db.prepare(`
            UPDATE parts_requests
            SET updated_at = datetime('now'), last_message_at = datetime('now')
            WHERE id = ?
          `).run(partsRequestId);

          upsertConversationState(conversation.id);
          logPartEvent(partsRequestId, 'richiesta_ricevuta', 'Richiesta ricevuta da webhook WhatsApp', 'whatsapp_webhook', { phone, externalMessageId });

          const backendResult = await forwardToPartsBackend({
            originalMessage: bodyText,
            phone,
            externalMessageId,
            requestUuid: db.prepare('SELECT request_uuid FROM parts_requests WHERE id = ?').get(partsRequestId)?.request_uuid || null
          });

          if (!backendResult.skipped && !backendResult.error && backendResult.statusCode >= 200 && backendResult.statusCode < 300) {
            const body = backendResult.body || {};
            db.prepare(`
              UPDATE parts_requests
              SET plate = COALESCE(?, plate),
                  oe_code = COALESCE(?, oe_code),
                  requested_part_text = COALESCE(?, requested_part_text),
                  normalized_part_name = COALESCE(?, normalized_part_name),
                  normalized_part_category = COALESCE(?, normalized_part_category),
                  ai_summary = COALESCE(?, ai_summary),
                  whatsapp_reply_text = COALESCE(?, whatsapp_reply_text),
                  status = COALESCE(?, status),
                  updated_at = datetime('now')
              WHERE id = ?
            `).run(
              s(body.plate),
              s(body.oeCode),
              s(body.requestedPartText),
              s(body.normalizedPart?.name || body.normalizedPartName),
              s(body.normalizedPart?.category || body.normalizedPartCategory),
              s(body.aiSummary || body.originalMessage),
              s(body.whatsappText),
              s(body.status),
              partsRequestId
            );
            logPartEvent(partsRequestId, 'backend_sync', 'Richiesta inoltrata al backend ricambi', 'parts_backend', backendResult.body || { statusCode: backendResult.statusCode });
          } else if (backendResult.error) {
            db.prepare(`UPDATE parts_requests SET status = 'errore_integrazione', updated_at = datetime('now') WHERE id = ?`).run(partsRequestId);
            logPartEvent(partsRequestId, 'errore_integrazione', backendResult.error, 'parts_backend', backendResult);
          }

          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          console.error('parts webhook error', error);
        }
      }
    }
  }

  res.json({ ok: true });
});

router.use(authMiddleware);

router.get('/parts/dashboard', requirePermesso('ricambi', 'read'), (req, res) => {
  res.json(buildDashboard());
});

router.get('/parts/requests', requirePermesso('ricambi', 'read'), (req, res) => {
  const { q, status, assigned_to_user_id, channel, has_plate, has_oe, errors_only } = req.query || {};
  let sql = `
    SELECT pr.*, a.ragione_sociale AS customer_name, u.nome AS assigned_user_name,
           (
             SELECT body_text
             FROM whatsapp_messages wm
             JOIN whatsapp_conversations wc ON wc.id = wm.conversation_id
             WHERE wc.parts_request_id = pr.id AND wm.internal_note = 0
             ORDER BY wm.created_at DESC, wm.id DESC
             LIMIT 1
           ) AS last_message_preview
    FROM parts_requests pr
    LEFT JOIN anagrafiche a ON a.id = pr.customer_id
    LEFT JOIN utenti u ON u.id = pr.assigned_to_user_id
    WHERE 1 = 1
  `;
  const params = [];
  if (q) {
    sql += ` AND (
      pr.request_uuid LIKE ? OR pr.user_phone LIKE ? OR pr.original_message LIKE ? OR
      pr.plate LIKE ? OR pr.vin LIKE ? OR pr.requested_part_text LIKE ? OR
      pr.normalized_part_name LIKE ? OR pr.oe_code LIKE ?
    )`;
    const wildcard = `%${q}%`;
    params.push(wildcard, wildcard, wildcard, wildcard, wildcard, wildcard, wildcard, wildcard);
  }
  if (status) {
    sql += ' AND pr.status = ?';
    params.push(status);
  }
  if (assigned_to_user_id) {
    sql += ' AND pr.assigned_to_user_id = ?';
    params.push(assigned_to_user_id);
  }
  if (channel) {
    sql += ' AND pr.channel = ?';
    params.push(channel);
  }
  if (String(has_plate) === '1') sql += ` AND pr.plate IS NOT NULL AND pr.plate <> ''`;
  if (String(has_oe) === '1') sql += ` AND pr.oe_code IS NOT NULL AND pr.oe_code <> ''`;
  if (String(errors_only) === '1') sql += ` AND pr.status = 'errore_integrazione'`;

  const rows = db.prepare(`${sql} ORDER BY pr.updated_at DESC, pr.id DESC LIMIT 250`).all(...params);
  res.json(rows.map((row) => ({ ...row, tags: json(row.tags_json, []) })));
});

router.get('/parts/requests/:id', requirePermesso('ricambi', 'read'), (req, res) => {
  const data = serializeRequestDetails(Number(req.params.id));
  if (!data) return res.status(404).json({ error: 'Richiesta non trovata' });
  res.json(data);
});

router.post('/parts/requests', requirePermesso('ricambi', 'edit'), (req, res) => {
  const b = req.body || {};
  db.exec('BEGIN');
  try {
    const insert = db.prepare(`
      INSERT INTO parts_requests (
        request_uuid, channel, external_message_id, user_phone, customer_id, original_message,
        plate, vin, requested_part_text, normalized_part_name, normalized_part_category, oe_code,
        status, source_system, ai_summary, whatsapp_reply_text, assigned_to_user_id, priority,
        tags_json, last_message_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      makeUuid(),
      s(b.channel) || 'whatsapp',
      s(b.external_message_id),
      s(b.user_phone) || 'sconosciuto',
      i(b.customer_id),
      s(b.original_message) || 'Richiesta creata manualmente da CRM',
      s(b.plate),
      s(b.vin),
      s(b.requested_part_text),
      s(b.normalized_part_name),
      s(b.normalized_part_category),
      s(b.oe_code),
      s(b.status) || 'nuova',
      s(b.source_system) || 'crm_manual',
      s(b.ai_summary),
      s(b.whatsapp_reply_text),
      i(b.assigned_to_user_id),
      s(b.priority) || 'media',
      JSON.stringify(Array.isArray(b.tags) ? b.tags : []),
      nowSql()
    );
    const id = Number(insert.lastInsertRowid);

    if (b.vehicle && (b.vehicle.make || b.vehicle.model || b.vehicle.version || b.vehicle.engine_code || b.vehicle.ktype || b.vehicle.infocar_code)) {
      db.prepare(`
        INSERT INTO parts_request_vehicle_data (
          parts_request_id, make, model, version, engine_code, ktype, infocar_code, vehicle_source, raw_payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        s(b.vehicle.make),
        s(b.vehicle.model),
        s(b.vehicle.version),
        s(b.vehicle.engine_code),
        s(b.vehicle.ktype),
        s(b.vehicle.infocar_code),
        s(b.vehicle.vehicle_source) || 'crm_manual',
        b.vehicle.raw_payload_json ? JSON.stringify(b.vehicle.raw_payload_json) : null
      );
    }

    const conversation = ensureConversationByPhone(s(b.user_phone) || 'sconosciuto', id, i(b.customer_id));
    if (b.original_message) {
      db.prepare(`
        INSERT INTO whatsapp_messages (conversation_id, direction, channel, message_type, body_text, delivery_status, source_system)
        VALUES (?, 'inbound', 'whatsapp', 'text', ?, 'received', 'crm_manual')
      `).run(conversation.id, s(b.original_message));
      upsertConversationState(conversation.id);
    }
    logPartEvent(id, 'richiesta_creata', 'Richiesta ricambi creata da CRM', 'crm', { userId: req.user.id });
    db.exec('COMMIT');
    res.json({ id });
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    res.status(400).json({ error: error.message });
  }
});

router.patch('/parts/requests/:id/status', requirePermesso('ricambi', 'edit'), (req, res) => {
  const requestId = Number(req.params.id);
  const current = db.prepare('SELECT * FROM parts_requests WHERE id = ?').get(requestId);
  if (!current) return res.status(404).json({ error: 'Richiesta non trovata' });

  db.prepare(`
    UPDATE parts_requests
    SET status = ?, assigned_to_user_id = COALESCE(?, assigned_to_user_id), updated_at = datetime('now')
    WHERE id = ?
  `).run(s(req.body?.status) || current.status, i(req.body?.assigned_to_user_id), requestId);

  logPartEvent(requestId, 'stato_aggiornato', `Stato aggiornato a ${s(req.body?.status) || current.status}`, 'crm', {
    from: current.status,
    to: s(req.body?.status) || current.status,
    userId: req.user.id
  });

  res.json({ ok: true });
});

router.post('/parts/requests/:id/notes', requirePermesso('ricambi', 'edit'), (req, res) => {
  const requestId = Number(req.params.id);
  const current = db.prepare('SELECT id FROM parts_requests WHERE id = ?').get(requestId);
  if (!current) return res.status(404).json({ error: 'Richiesta non trovata' });
  const noteText = s(req.body?.note_text);
  if (!noteText) return res.status(400).json({ error: 'Nota obbligatoria' });

  const result = db.prepare(`
    INSERT INTO parts_request_notes (parts_request_id, author_user_id, note_text)
    VALUES (?, ?, ?)
  `).run(requestId, req.user.id, noteText);
  logPartEvent(requestId, 'nota_aggiunta', 'Nota interna aggiunta', 'crm', { userId: req.user.id });
  res.json({ id: Number(result.lastInsertRowid) });
});

router.get('/parts/conversations', requirePermesso('ricambi', 'read'), (req, res) => {
  const rows = db.prepare(`
    SELECT wc.*, pr.request_uuid, pr.status AS request_status, pr.normalized_part_name, pr.normalized_part_category,
           a.ragione_sociale AS customer_name,
           (
             SELECT body_text FROM whatsapp_messages
             WHERE conversation_id = wc.id
             ORDER BY created_at DESC, id DESC
             LIMIT 1
           ) AS last_message_body,
           (
             SELECT direction FROM whatsapp_messages
             WHERE conversation_id = wc.id
             ORDER BY created_at DESC, id DESC
             LIMIT 1
           ) AS last_message_direction
    FROM whatsapp_conversations wc
    LEFT JOIN parts_requests pr ON pr.id = wc.parts_request_id
    LEFT JOIN anagrafiche a ON a.id = wc.customer_id
    ORDER BY COALESCE(wc.last_message_at, wc.updated_at, wc.created_at) DESC, wc.id DESC
    LIMIT 200
  `).all();
  res.json(rows);
});

router.get('/parts/conversations/:id/messages', requirePermesso('ricambi', 'read'), (req, res) => {
  const conversation = db.prepare('SELECT * FROM whatsapp_conversations WHERE id = ?').get(Number(req.params.id));
  if (!conversation) return res.status(404).json({ error: 'Conversazione non trovata' });
  const messages = db.prepare(`
    SELECT *
    FROM whatsapp_messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(conversation.id);
  res.json({ conversation, messages });
});

router.post('/parts/conversations/:id/messages', requirePermesso('ricambi', 'edit'), (req, res) => {
  const conversation = db.prepare('SELECT * FROM whatsapp_conversations WHERE id = ?').get(Number(req.params.id));
  if (!conversation) return res.status(404).json({ error: 'Conversazione non trovata' });

  const bodyText = s(req.body?.body_text);
  const internalNote = req.body?.internal_note ? 1 : 0;
  if (!bodyText) return res.status(400).json({ error: 'Testo messaggio obbligatorio' });

  const result = db.prepare(`
    INSERT INTO whatsapp_messages (
      conversation_id, direction, channel, message_type, body_text, delivery_status, source_system, internal_note
    )
    VALUES (?, ?, 'whatsapp', 'text', ?, ?, 'crm_operator', ?)
  `).run(
    conversation.id,
    internalNote ? 'internal' : 'outbound',
    bodyText,
    internalNote ? 'saved' : 'queued',
    internalNote
  );

  upsertConversationState(conversation.id);

  if (conversation.parts_request_id) {
    db.prepare(`
      UPDATE parts_requests
      SET whatsapp_reply_text = ?, updated_at = datetime('now'), last_message_at = datetime('now')
      WHERE id = ?
    `).run(internalNote ? null : bodyText, conversation.parts_request_id);
    logPartEvent(
      conversation.parts_request_id,
      internalNote ? 'nota_chat_interna' : 'messaggio_whatsapp_inviato',
      internalNote ? 'Nota interna salvata in conversazione' : 'Messaggio outbound salvato da CRM',
      'crm',
      { userId: req.user.id, conversationId: conversation.id }
    );
  }

  res.json({ id: Number(result.lastInsertRowid) });
});

router.get('/parts/stats', requirePermesso('ricambi', 'read'), (req, res) => {
  const requestsByDay = db.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS total
    FROM parts_requests
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY date(created_at)
    ORDER BY day ASC
  `).all();

  const byCategory = db.prepare(`
    SELECT COALESCE(normalized_part_category, 'non_classificata') AS label, COUNT(*) AS total
    FROM parts_requests
    GROUP BY COALESCE(normalized_part_category, 'non_classificata')
    ORDER BY total DESC, label ASC
    LIMIT 12
  `).all();

  const byOperator = db.prepare(`
    SELECT COALESCE(u.nome, 'Non assegnata') AS label, COUNT(*) AS total
    FROM parts_requests pr
    LEFT JOIN utenti u ON u.id = pr.assigned_to_user_id
    GROUP BY COALESCE(u.nome, 'Non assegnata')
    ORDER BY total DESC, label ASC
  `).all();

  const messageVolume = db.prepare(`
    SELECT date(created_at) AS day,
           SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) AS inbound,
           SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound
    FROM whatsapp_messages
    WHERE internal_note = 0 AND created_at >= datetime('now', '-30 days')
    GROUP BY date(created_at)
    ORDER BY day ASC
  `).all();

  const funnel = db.prepare(`
    SELECT
      COUNT(*) AS total_requests,
      SUM(CASE WHEN status = 'completata' THEN 1 ELSE 0 END) AS completed_requests,
      SUM(CASE WHEN plate IS NOT NULL AND plate <> '' THEN 1 ELSE 0 END) AS with_plate,
      SUM(CASE WHEN oe_code IS NOT NULL AND oe_code <> '' THEN 1 ELSE 0 END) AS with_oe
    FROM parts_requests
  `).get() || {};

  res.json({ requestsByDay, byCategory, byOperator, messageVolume, funnel });
});

module.exports = router;
