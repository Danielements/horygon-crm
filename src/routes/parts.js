const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');

const router = express.Router();

const PARTS_OPEN_STATUSES = ['nuova', 'in_lavorazione', 'in_attesa_dati_cliente', 'in_attesa_verifica_tecnica', 'oe_trovato', 'preventivo_pronto'];
const rtwsSessions = new Map();

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

function normalizePlate(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlDecode(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function getXmlTagValue(xml, tag) {
  const match = String(xml || '').match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? xmlDecode(match[1]).trim() : '';
}

function getXmlTagBlock(xml, tag) {
  const match = String(xml || '').match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? match[1] : '';
}

function collectXmlBlocks(xml, tag) {
  return [...String(xml || '').matchAll(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'ig'))].map((match) => match[1]);
}

function guessPartCategory(text) {
  const lower = String(text || '').toLowerCase();
  if (/(parabrezza|lunotto|cristall|vetro|scendente|raschiavetro|alzacristall|fisso porta)/.test(lower)) return 'cristalli';
  if (/(specchietto|retrovisore)/.test(lower)) return 'retrovisori';
  if (/(fanale|faro|stop)/.test(lower)) return 'illuminazione';
  return 'ricambio_generico';
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

function getRtwsServiceUrl() {
  const base = process.env.RTWS_WSDL_URL;
  if (!base) return '';
  return String(base).replace(/\?wsdl$/i, '').replace(/\?WSDL$/i, '');
}

function isRtwsConfigured() {
  return !!(
    getRtwsServiceUrl() &&
    process.env.RTWS_AZIENDA_NAME &&
    process.env.RTWS_PASSWORD &&
    process.env.RTWS_PRODUCT_LISTINI
  );
}

function buildSoap12Envelope(methodName, innerXml) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <${methodName} xmlns="http://tempuri.org/">
      ${innerXml}
    </${methodName}>
  </soap:Body>
</soap:Envelope>`;
}

function callRtwsSoap(methodName, innerXml) {
  return new Promise((resolve) => {
    const serviceUrl = getRtwsServiceUrl();
    if (!serviceUrl) return resolve({ ok: false, error: 'RTWS_WSDL_URL non configurato' });
    const endpoint = new URL(serviceUrl);
    const xml = buildSoap12Envelope(methodName, innerXml);
    const req = https.request({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port || 443,
      path: endpoint.pathname,
      method: 'POST',
      timeout: Number(process.env.RTWS_TIMEOUT_MS || 12000),
      headers: {
        'Content-Type': `application/soap+xml; charset=utf-8; action="http://tempuri.org/${methodName}"`,
        'Content-Length': Buffer.byteLength(xml)
      }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        if ((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300) {
          resolve({ ok: true, rawXml: raw, statusCode: res.statusCode || 0 });
          return;
        }
        resolve({ ok: false, rawXml: raw, statusCode: res.statusCode || 0, error: getXmlTagValue(raw, 'faultstring') || `RTWS HTTP ${res.statusCode}` });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => resolve({ ok: false, error: error.message }));
    req.write(xml);
    req.end();
  });
}

async function getRtwsSession(productName) {
  const cacheKey = String(productName || '');
  const cached = rtwsSessions.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now + 30000) return cached.sessionId;

  const loginXml = `
    <aziendaName>${xmlEscape(process.env.RTWS_AZIENDA_NAME || '')}</aziendaName>
    <clientName>${xmlEscape(process.env.RTWS_CLIENT_NAME || '')}</clientName>
    <password>${xmlEscape(process.env.RTWS_PASSWORD || '')}</password>
    <productName>${xmlEscape(productName || '')}</productName>
  `;
  const result = await callRtwsSoap('Login', loginXml);
  if (!result.ok) throw new Error(result.error || 'Login RTWS fallito');
  const loginState = getXmlTagValue(result.rawXml, 'LoginState');
  const sessionId = getXmlTagValue(result.rawXml, 'SessionId');
  const errorMsg = getXmlTagValue(result.rawXml, 'ErrorMsg');
  if (loginState !== 'SUCCESS' || !sessionId) {
    throw new Error(errorMsg || `Login RTWS non riuscito (${loginState || 'UNKNOWN'})`);
  }
  const ttlSeconds = Number(process.env.RTWS_SESSION_TTL_SECONDS || 600);
  rtwsSessions.set(cacheKey, { sessionId, expiresAt: now + Math.max(ttlSeconds - 30, 60) * 1000 });
  return sessionId;
}

function parseRtwsGlassItems(rawXml) {
  return collectXmlBlocks(getXmlTagBlock(rawXml, 'Items'), 'Item').map((block) => ({
    eurocode: getXmlTagValue(block, 'Eurocode') || '',
    oe_code: getXmlTagValue(block, 'Oe') || '',
    price: getXmlTagValue(block, 'Prezzo') || '',
    id_marca: getXmlTagValue(block, 'IdMar') || '',
    description: getXmlTagValue(block, 'Dspar') || ''
  })).filter((item) => item.oe_code || item.eurocode || item.description);
}

async function rtwsCheckEurocodeDaTargaOE2({ plate, oeCode = '', eurocode = '', ricercaVin = 0 }) {
  if (!isRtwsConfigured()) {
    return { status: 'NOT_CONFIGURED', message: 'RTWS non configurato', items: [] };
  }
  const sessionId = await getRtwsSession(process.env.RTWS_PRODUCT_LISTINI);
  const body = `
    <sessionId>${xmlEscape(sessionId)}</sessionId>
    <context>
      <Targa>${xmlEscape(normalizePlate(plate))}</Targa>
      <Oe>${xmlEscape(oeCode || '')}</Oe>
      <Eurocode>${xmlEscape(eurocode || '')}</Eurocode>
      <RicercaVin>${ricercaVin ? 1 : 0}</RicercaVin>
    </context>
  `;
  const result = await callRtwsSoap('CheckEurocodeDaTargaOE2', body);
  if (!result.ok) {
    return { status: 'ERROR', message: result.error || 'Chiamata RTWS fallita', items: [], rawXml: result.rawXml || '' };
  }
  const stateCode = getXmlTagValue(result.rawXml, 'Code');
  const stateDescription = getXmlTagValue(result.rawXml, 'Description');
  const items = parseRtwsGlassItems(result.rawXml);
  return {
    status: String(stateCode || '') === '0' ? (items.length ? 'READY' : 'EMPTY') : 'ERROR',
    message: stateDescription || (items.length ? 'Risultati cristalli recuperati da RTWS_LISTINI tramite targa.' : 'Nessun cristallo trovato per la targa indicata.'),
    items,
    rawXml: result.rawXml,
    stateCode: stateCode || ''
  };
}

function parseWhatsappResponseBody(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isWhatsappConfigured() {
  return !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

function sendWhatsAppText(to, bodyText) {
  return new Promise((resolve) => {
    if (!isWhatsappConfigured()) return resolve({ skipped: true, reason: 'whatsapp_non_configurato' });
    const version = process.env.WHATSAPP_API_VERSION || 'v20.0';
    const endpoint = new URL(`https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`);
    const payload = JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: String(to || ''),
      type: 'text',
      text: { preview_url: false, body: String(bodyText || '') }
    });
    const req = https.request({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: 443,
      path: endpoint.pathname,
      method: 'POST',
      timeout: Number(process.env.RTWS_TIMEOUT_MS || 12000),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`
      }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({
        skipped: false,
        statusCode: res.statusCode || 0,
        raw,
        body: parseWhatsappResponseBody(raw)
      }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => resolve({ skipped: false, error: error.message }));
    req.write(payload);
    req.end();
  });
}

async function triangulateWithOpenAI(messageText) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !messageText) {
    return { skipped: true, reason: 'openai_non_configurato' };
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.2,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'parts_whatsapp_triage',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              intent: { type: 'string' },
              request_is_valid: { type: 'boolean' },
              suggested_service: { type: 'string' },
              confidence: { type: 'number' },
              ai_summary: { type: 'string' },
              requested_part_text: { type: 'string' },
              normalized_part_name: { type: 'string' },
              normalized_part_category: { type: 'string' },
              plate: { type: 'string' },
              vin: { type: 'string' },
              oe_code: { type: 'string' },
              missing_data: {
                type: 'array',
                items: { type: 'string' }
              },
              status: { type: 'string' },
              operator_reply_text: { type: 'string' }
            },
            required: ['intent', 'request_is_valid', 'suggested_service', 'confidence', 'ai_summary', 'requested_part_text', 'normalized_part_name', 'normalized_part_category', 'plate', 'vin', 'oe_code', 'missing_data', 'status', 'operator_reply_text']
          }
        }
      },
      messages: [
        {
          role: 'system',
          content: 'Sei un assistente di triage per richieste ricambi automotive WhatsApp. Estrai targa, VIN, OE e tipo ricambio se presenti. Valuta se la richiesta è interpretabile con alta affidabilità. Oggi il servizio tecnico disponibile via targa è RTWS_LISTINI CheckEurocodeDaTargaOE2 ed è utile solo per cristalli/vetri/alzacristalli/raschiavetro e ricambi collegati ai cristalli. suggested_service deve essere uno tra RTWS_LISTINI_CHECK_EUROCODE_TARGA_OE2, MANUAL_REVIEW, WAITING_DATA. Usa stati tra nuova, in_attesa_dati_cliente, in_attesa_verifica_tecnica, oe_trovato. Se la richiesta non è chiaramente legata ai cristalli, evita falsi positivi e chiedi i dati mancanti o segnala revisione manuale.'
        },
        {
          role: 'user',
          content: messageText
        }
      ]
    })
  });

  const raw = await response.text();
  const parsed = parseWhatsappResponseBody(raw);
  if (!response.ok) {
    return { skipped: false, error: parsed?.error?.message || raw || `OpenAI HTTP ${response.status}` };
  }
  const content = parsed?.choices?.[0]?.message?.content;
  if (!content) return { skipped: false, error: 'Risposta OpenAI vuota' };
  try {
    return { skipped: false, data: JSON.parse(content) };
  } catch {
    return { skipped: false, error: 'JSON OpenAI non valido', raw: content };
  }
}

function chooseBestGlassItem(items = [], requestedPartText = '') {
  if (!items.length) return null;
  const tokens = String(requestedPartText || '')
    .toLowerCase()
    .split(/[^a-z0-9àèéìòù]+/i)
    .filter((token) => token.length >= 4);
  if (!tokens.length) return items[0];
  const ranked = items
    .map((item) => {
      const haystack = `${item.description} ${item.oe_code} ${item.eurocode}`.toLowerCase();
      const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
      return { item, score };
    })
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.item || items[0];
}

function buildGlassReplyText(selectedItem, itemsCount) {
  if (!selectedItem) {
    return 'Richiesta cristalli acquisita ma non sono emersi risultati puntuali dalla targa. Ti chiediamo una foto del libretto o il dettaglio del cristallo richiesto.';
  }
  const parts = [
    'Richiesta cristalli acquisita e verificata tramite targa.',
    '',
    `Descrizione: ${selectedItem.description || 'Ricambio cristalli'}`,
    `Codice OE: ${selectedItem.oe_code || '-'}`,
    selectedItem.eurocode ? `Eurocode: ${selectedItem.eurocode}` : null,
    selectedItem.price ? `Prezzo listino indicativo: EUR ${selectedItem.price}` : null,
    itemsCount > 1 ? `Sono disponibili anche altre ${itemsCount - 1} varianti collegate al veicolo.` : null
  ].filter(Boolean);
  return parts.join('\n');
}

async function resolvePartsMessage({ message, channel = 'whatsapp' }) {
  const text = String(message || '').trim();
  if (!text) return { status: 'ERROR', error: 'message obbligatorio' };

  const aiResult = await triangulateWithOpenAI(text);
  const ai = aiResult.data || {};
  const parsed = {
    originalText: text,
    plate: normalizePlate(ai.plate || ''),
    oeCode: s(ai.oe_code) || '',
    requestedPartText: s(ai.requested_part_text) || text,
    confidence: ai.confidence ?? 0
  };
  const normalizedPart = {
    name: s(ai.normalized_part_name) || parsed.requestedPartText,
    category: s(ai.normalized_part_category) || guessPartCategory(parsed.requestedPartText)
  };
  const glassEligible = ai.request_is_valid !== false
    && parsed.plate
    && (String(ai.suggested_service || '') === 'RTWS_LISTINI_CHECK_EUROCODE_TARGA_OE2' || normalizedPart.category === 'cristalli');

  let glassCatalog = { status: 'SKIPPED', message: 'Nessun servizio tecnico eseguito', items: [] };
  let whatsappText = s(ai.operator_reply_text) || '';
  let status = s(ai.status) || 'nuova';

  if (glassEligible) {
    glassCatalog = await rtwsCheckEurocodeDaTargaOE2({ plate: parsed.plate, oeCode: parsed.oeCode });
    const selectedItem = chooseBestGlassItem(glassCatalog.items, parsed.requestedPartText);
    if (selectedItem) {
      parsed.oeCode = selectedItem.oe_code || parsed.oeCode;
      whatsappText = buildGlassReplyText(selectedItem, glassCatalog.items.length);
      status = 'oe_trovato';
    } else {
      whatsappText = whatsappText || 'Ho identificato una richiesta cristalli, ma dalla sola targa non emerge un risultato univoco. Indicami meglio quale vetro o allega una foto del ricambio.';
      status = 'in_attesa_verifica_tecnica';
    }
  } else if (!parsed.plate) {
    whatsappText = whatsappText || 'Per usare i servizi attivi oggi ho bisogno almeno della targa. Inviami targa e tipo di cristallo/ricambio richiesto.';
    status = 'in_attesa_dati_cliente';
  } else if (normalizedPart.category !== 'cristalli') {
    whatsappText = whatsappText || 'Al momento con i servizi RTWS attivi posso lavorare in automatico soprattutto sui cristalli da targa. Ho preso in carico la richiesta e la faccio verificare manualmente.';
    status = 'in_attesa_verifica_tecnica';
  }

  return {
    status: glassCatalog.status === 'ERROR' ? 'ERROR' : 'OK',
    parsed,
    vehicle: null,
    normalizedPart,
    dbrtResult: {},
    glassCatalog,
    oeCatalog: {},
    oeResults: glassCatalog.items || [],
    equivalents: {},
    missingData: ai.missing_data || [],
    whatsappText,
    aiRequest: {
      intent: ai.intent || 'automotive_parts_resolution',
      request_is_valid: ai.request_is_valid !== false,
      suggested_service: ai.suggested_service || (glassEligible ? 'RTWS_LISTINI_CHECK_EUROCODE_TARGA_OE2' : 'MANUAL_REVIEW'),
      instruction: 'Triage AI e scelta del servizio RTWS più utile con minimizzazione dei falsi positivi.',
      availableSources: ['OPENAI', 'RTWS_LISTINI', 'RTWS_BDRT'],
      parsed,
      normalizedPart
    },
    aiSummary: s(ai.ai_summary) || null,
    resolvedStatus: status
  };
}

function persistResolvedPayload(partsRequestId, resolved) {
  const parsed = resolved?.parsed || {};
  const normalizedPart = resolved?.normalizedPart || {};
  const items = Array.isArray(resolved?.oeResults) ? resolved.oeResults : [];

  db.prepare(`
    UPDATE parts_requests
    SET plate = COALESCE(NULLIF(?, ''), plate),
        vin = COALESCE(NULLIF(?, ''), vin),
        oe_code = COALESCE(NULLIF(?, ''), oe_code),
        requested_part_text = COALESCE(NULLIF(?, ''), requested_part_text),
        normalized_part_name = COALESCE(NULLIF(?, ''), normalized_part_name),
        normalized_part_category = COALESCE(NULLIF(?, ''), normalized_part_category),
        ai_summary = COALESCE(NULLIF(?, ''), ai_summary),
        whatsapp_reply_text = COALESCE(NULLIF(?, ''), whatsapp_reply_text),
        status = COALESCE(NULLIF(?, ''), status),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    s(parsed.plate),
    s(parsed.vin),
    s(parsed.oeCode),
    s(parsed.requestedPartText),
    s(normalizedPart.name),
    s(normalizedPart.category),
    s(resolved.aiSummary),
    s(resolved.whatsappText),
    s(resolved.resolvedStatus),
    partsRequestId
  );

  db.prepare('DELETE FROM parts_request_oe_results WHERE parts_request_id = ?').run(partsRequestId);
  const insertOe = db.prepare(`
    INSERT INTO parts_request_oe_results (parts_request_id, oe_code, description, list_price, source, raw_payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  items.forEach((item) => {
    insertOe.run(
      partsRequestId,
      s(item.oe_code),
      s(item.description || item.eurocode || 'Ricambio cristalli'),
      item.price ? Number(String(item.price).replace(',', '.')) : null,
      'RTWS_LISTINI',
      JSON.stringify(item)
    );
  });
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
  if (!verifyToken) {
    return res.status(500).send('WHATSAPP_VERIFY_TOKEN non configurato');
  }
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

          const resolved = await resolvePartsMessage({ message: bodyText, channel: 'whatsapp' });
          if (resolved.status === 'ERROR') {
            db.prepare(`UPDATE parts_requests SET status = 'errore_integrazione', updated_at = datetime('now') WHERE id = ?`).run(partsRequestId);
            logPartEvent(partsRequestId, 'errore_integrazione', resolved.error || 'Resolve ricambi fallito', 'parts_resolver', resolved);
          } else {
            persistResolvedPayload(partsRequestId, resolved);
            logPartEvent(partsRequestId, 'ai_triage', 'Triage AI completato', 'openai', resolved.aiRequest || {});
            if (resolved.glassCatalog?.status === 'READY') {
              logPartEvent(partsRequestId, 'rtws_listini', resolved.glassCatalog.message || 'RTWS_LISTINI eseguito', 'rtws_listini', {
                items: resolved.glassCatalog.items?.slice(0, 20) || [],
                stateCode: resolved.glassCatalog.stateCode || ''
              });
            } else if (resolved.glassCatalog?.status === 'ERROR') {
              logPartEvent(partsRequestId, 'errore_integrazione', resolved.glassCatalog.message || 'Errore RTWS_LISTINI', 'rtws_listini', resolved.glassCatalog);
            }

            if (resolved.whatsappText) {
              const whatsappSend = await sendWhatsAppText(phone, resolved.whatsappText);
              db.prepare(`
                INSERT INTO whatsapp_messages (
                  conversation_id, direction, channel, external_message_id, message_type,
                  body_text, delivery_status, error_message, source_system, raw_payload_json
                )
                VALUES (?, 'outbound', 'whatsapp', ?, 'text', ?, ?, ?, 'openai_auto_reply', ?)
              `).run(
                conversation.id,
                s(whatsappSend.body?.messages?.[0]?.id),
                resolved.whatsappText,
                whatsappSend.error ? 'error' : (whatsappSend.statusCode >= 200 && whatsappSend.statusCode < 300 ? 'sent' : 'error'),
                whatsappSend.error || s(whatsappSend.body?.error?.message),
                JSON.stringify(whatsappSend)
              );
              upsertConversationState(conversation.id);
              logPartEvent(
                partsRequestId,
                whatsappSend.error ? 'errore_integrazione' : 'messaggio_whatsapp_inviato',
                whatsappSend.error ? `Invio WhatsApp fallito: ${whatsappSend.error}` : 'Risposta automatica WhatsApp inviata',
                'whatsapp_meta',
                whatsappSend
              );
            }
          }

          const backendResult = await forwardToPartsBackend({
            originalMessage: bodyText,
            phone,
            externalMessageId,
            requestUuid: db.prepare('SELECT request_uuid FROM parts_requests WHERE id = ?').get(partsRequestId)?.request_uuid || null
          });
          if (!backendResult.skipped && !backendResult.error && backendResult.statusCode >= 200 && backendResult.statusCode < 300) {
            logPartEvent(partsRequestId, 'backend_sync', 'Richiesta inoltrata al backend ricambi', 'parts_backend', backendResult.body || { statusCode: backendResult.statusCode });
          } else if (backendResult.error) {
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

router.post('/parts/resolve', requirePermesso('ricambi', 'read'), async (req, res) => {
  const resolved = await resolvePartsMessage({
    message: req.body?.message,
    channel: req.body?.channel || 'crm'
  });
  if (resolved.status === 'ERROR') {
    return res.status(400).json(resolved);
  }
  res.json(resolved);
});

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

router.post('/parts/conversations/:id/messages', requirePermesso('ricambi', 'edit'), async (req, res) => {
  const conversation = db.prepare('SELECT * FROM whatsapp_conversations WHERE id = ?').get(Number(req.params.id));
  if (!conversation) return res.status(404).json({ error: 'Conversazione non trovata' });

  const bodyText = s(req.body?.body_text);
  const internalNote = req.body?.internal_note ? 1 : 0;
  if (!bodyText) return res.status(400).json({ error: 'Testo messaggio obbligatorio' });

  const outboundResult = internalNote ? { skipped: true } : await sendWhatsAppText(conversation.user_phone, bodyText);
  const result = db.prepare(`
    INSERT INTO whatsapp_messages (
      conversation_id, direction, channel, external_message_id, message_type, body_text,
      delivery_status, error_message, source_system, raw_payload_json, internal_note
    )
    VALUES (?, ?, 'whatsapp', ?, 'text', ?, ?, ?, 'crm_operator', ?, ?)
  `).run(
    conversation.id,
    internalNote ? 'internal' : 'outbound',
    internalNote ? null : s(outboundResult.body?.messages?.[0]?.id),
    bodyText,
    internalNote ? 'saved' : (outboundResult.error ? 'error' : (outboundResult.statusCode >= 200 && outboundResult.statusCode < 300 ? 'sent' : 'error')),
    internalNote ? null : (outboundResult.error || s(outboundResult.body?.error?.message)),
    internalNote ? null : JSON.stringify(outboundResult),
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
      internalNote ? 'Nota interna salvata in conversazione' : (outboundResult.error ? `Invio WhatsApp fallito: ${outboundResult.error}` : 'Messaggio outbound inviato via WhatsApp Meta'),
      'crm',
      { userId: req.user.id, conversationId: conversation.id }
    );
  }

  res.json({ id: Number(result.lastInsertRowid), sent: !internalNote && !outboundResult.error, error: outboundResult.error || null });
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
