const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const { createPreventivoPdfBuffer } = require('../services/document-pdf');

const router = express.Router();

const PARTS_OPEN_STATUSES = ['nuova', 'in_lavorazione', 'in_attesa_dati_cliente', 'in_attesa_verifica_tecnica', 'oe_trovato', 'preventivo_pronto'];
const rtwsSessions = new Map();
let partsInboundProcessingQueue = Promise.resolve();

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

function getActiveRequestWindowMinutes() {
  const parsed = parseInt(process.env.PARTS_ACTIVE_REQUEST_WINDOW_MINUTES || '3', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}

function makeUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `parts-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeCompactDate() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function slugToken(value, fallback = 'ITEM') {
  const clean = String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return clean || fallback;
}

function normalizePlate(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function extractPlateFromText(value) {
  const compact = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, ' ');
  const patterns = [
    /\b([A-Z]{2}\s?\d{3}\s?[A-Z]{2})\b/g,
    /\b([A-Z]{2}\s?\d{4}\s?[A-Z])\b/g,
    /\b([A-Z]{1}\s?\d{5}\s?[A-Z]{1})\b/g
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(compact);
    if (match?.[1]) return normalizePlate(match[1]);
  }

  return '';
}

function extractVinFromText(value) {
  const compact = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, ' ');
  const match = compact.match(/\b([A-HJ-NPR-Z0-9]{17})\b/);
  return match?.[1] || '';
}

function extractOeCodeFromText(value) {
  const compact = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, ' ');
  const extractedPlate = extractPlateFromText(value);
  const candidates = [...compact.matchAll(/\b([A-Z0-9]{6,18})\b/g)]
    .map((match) => match[1])
    .filter((token) => /\d/.test(token) && /[A-Z]/.test(token))
    .filter((token) => token !== extractedPlate)
    .filter((token) => !/^[A-Z]{2}\d{3}[A-Z]{2}$/.test(token))
    .filter((token) => !/^[A-Z]{2}\d{4}[A-Z]$/.test(token))
    .filter((token) => !/^[A-Z]\d{5}[A-Z]$/.test(token));
  return candidates[0] || '';
}

function deriveRequestedPartText(value, plate = '', vin = '', oeCode = '') {
  let text = String(value || '');

  [plate, vin, oeCode].filter(Boolean).forEach((token) => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(escaped, 'ig'), ' ');
  });

  text = text
    .replace(/\b(targa|plate|vin|oe|oem|codice|cod\.?|richiesta|ricambio|pezzo|mi serve|serve|cerco|per auto|auto)\b/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text || String(value || '').trim();
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
  if (/(fren|pastigli|disch|pinz|tambur|ganasc|ceppi|cilindrett)/.test(lower)) return 'freni';
  if (/(filtro|filtri|abitacolo|olio|aria|carburante)/.test(lower)) return 'filtri';
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

function closeStalePartsRequestsForPhone(phone) {
  if (!phone) return [];
  const windowMinutes = getActiveRequestWindowMinutes();
  const staleRows = db.prepare(`
    SELECT id, request_uuid, status, last_message_at, updated_at, created_at
    FROM parts_requests
    WHERE user_phone = ?
      AND status IN (${PARTS_OPEN_STATUSES.map(() => '?').join(', ')})
      AND COALESCE(last_message_at, updated_at, created_at) < datetime('now', ?)
    ORDER BY id ASC
  `).all(phone, ...PARTS_OPEN_STATUSES, `-${windowMinutes} minutes`);

  for (const row of staleRows) {
    db.prepare(`
      UPDATE parts_requests
      SET status = 'completata',
          updated_at = datetime('now')
      WHERE id = ?
    `).run(row.id);
    logPartEvent(row.id, 'ricerca_chiusa_timeout', `Ricerca chiusa automaticamente dopo ${windowMinutes} minuti di inattivita`, 'crm', {
      previousStatus: row.status,
      inactivityWindowMinutes: windowMinutes
    });
  }

  return staleRows;
}

function findOrCreateCategoryId(categoryName = 'Ricambi') {
  const normalizedName = s(categoryName) || 'Ricambi';
  let row = db.prepare('SELECT id FROM categorie WHERE nome = ? LIMIT 1').get(normalizedName);
  if (row?.id) return row.id;
  const insert = db.prepare('INSERT INTO categorie (nome, descrizione) VALUES (?, ?)').run(normalizedName, 'Categoria automatica ricambi');
  return Number(insert.lastInsertRowid);
}

function createUniqueProductCode(baseToken) {
  const base = `RIC-${slugToken(baseToken, 'RTWS')}`;
  let candidate = base;
  let index = 1;
  while (db.prepare('SELECT id FROM prodotti WHERE codice_interno = ? LIMIT 1').get(candidate)) {
    index += 1;
    candidate = `${base}-${index}`;
  }
  return candidate;
}

function createUniquePreventivoCode() {
  const base = `PRE-RIC-${makeCompactDate()}`;
  let candidate = base;
  let index = 1;
  while (db.prepare('SELECT id FROM preventivi WHERE codice_preventivo = ? LIMIT 1').get(candidate)) {
    index += 1;
    candidate = `${base}-${index}`;
  }
  return candidate;
}

function pickQuotedItem(request) {
  if (request?.intake_state?.slots?.selected_glass_option) return request.intake_state.slots.selected_glass_option;
  if (Array.isArray(request?.oe_results) && request.oe_results.length) {
    const raw = json(request.oe_results[0].raw_payload_json, null);
    return raw || {
      oe_code: request.oe_results[0].oe_code,
      description: request.oe_results[0].description,
      price: request.oe_results[0].list_price
    };
  }
  if (request?.oe_code || request?.normalized_part_name) {
    return {
      oe_code: request.oe_code,
      description: request.normalized_part_name || request.requested_part_text || 'Ricambio ricambi',
      price: null
    };
  }
  return null;
}

function ensureQuoteProductForRequest(request, item) {
  const oeCode = s(item?.oe_code) || s(request?.oe_code) || null;
  const eurocode = s(item?.eurocode) || null;
  const description = s(item?.description) || s(request?.normalized_part_name) || s(request?.requested_part_text) || 'Ricambio ricambi';
  const price = item?.price !== undefined && item?.price !== null
    ? Number(String(item.price).replace(',', '.'))
    : (request?.oe_results?.[0]?.list_price || null);
  const categoryId = findOrCreateCategoryId('Ricambi');
  const searchCode = oeCode ? `RIC-${slugToken(oeCode, 'RTWS')}` : null;

  let product = null;
  if (request?.linked_product_id) {
    product = db.prepare('SELECT * FROM prodotti WHERE id = ? LIMIT 1').get(request.linked_product_id);
  }
  if (!product && searchCode) {
    product = db.prepare('SELECT * FROM prodotti WHERE codice_interno = ? LIMIT 1').get(searchCode);
  }
  if (!product && oeCode) {
    product = db.prepare('SELECT * FROM prodotti WHERE barcode = ? LIMIT 1').get(oeCode);
  }

  const tags = ['ricambi', 'rtws', request?.normalized_part_category || 'ricambio_generico', oeCode].filter(Boolean).join(', ');

  if (!product) {
    const code = searchCode || createUniqueProductCode(oeCode || eurocode || description);
    const insert = db.prepare(`
      INSERT INTO prodotti (codice_interno, barcode, nome, descrizione, categoria_id, unita_misura, tags, attivo)
      VALUES (?, ?, ?, ?, ?, 'pz', ?, 1)
    `).run(code, oeCode, description, [description, eurocode ? `Eurocode: ${eurocode}` : null, 'Creato automaticamente da richiesta ricambi'].filter(Boolean).join('\n'), categoryId, tags);
    product = db.prepare('SELECT * FROM prodotti WHERE id = ?').get(Number(insert.lastInsertRowid));
  } else {
    db.prepare(`
      UPDATE prodotti
      SET barcode = COALESCE(?, barcode),
          nome = COALESCE(NULLIF(?, ''), nome),
          descrizione = COALESCE(NULLIF(?, ''), descrizione),
          categoria_id = COALESCE(?, categoria_id),
          tags = COALESCE(NULLIF(?, ''), tags),
          attivo = 1
      WHERE id = ?
    `).run(oeCode, description, [description, eurocode ? `Eurocode: ${eurocode}` : null, 'Aggiornato automaticamente da richiesta ricambi'].filter(Boolean).join('\n'), categoryId, tags, product.id);
    product = db.prepare('SELECT * FROM prodotti WHERE id = ?').get(product.id);
  }

  if (price !== null && Number.isFinite(price)) {
    const latestListino = db.prepare(`
      SELECT *
      FROM prodotti_listini
      WHERE prodotto_id = ? AND canale = 'diretto'
      ORDER BY id DESC
      LIMIT 1
    `).get(product.id);
    if (!latestListino || Number(latestListino.prezzo) !== Number(price)) {
      db.prepare(`
        INSERT INTO prodotti_listini (prodotto_id, canale, prezzo, cpv, valido_dal)
        VALUES (?, 'diretto', ?, ?, date('now'))
      `).run(product.id, price, eurocode || null);
    }
  }

  return {
    product,
    price: price !== null && Number.isFinite(price) ? price : 0,
    eurocode,
    oeCode,
    description
  };
}

function createDraftQuoteFromRequest(request, quotedProduct) {
  const qty = 1;
  const imponibile = Number(quotedProduct.price || 0) * qty;
  const aliquotaIva = 22;
  const importoIva = Number((imponibile * aliquotaIva / 100).toFixed(2));
  const totale = Number((imponibile + importoIva).toFixed(2));
  const codicePreventivo = createUniquePreventivoCode();
  const note = [
    'Preventivo generato automaticamente da richiesta ricambi.',
    request?.request_uuid ? `Richiesta: ${request.request_uuid}` : null,
    request?.plate ? `Targa: ${request.plate}` : null
  ].filter(Boolean).join('\n');

  const insert = db.prepare(`
    INSERT INTO preventivi (
      codice_preventivo, anagrafica_id, stato, data_preventivo, imponibile, iva, totale, valuta, note
    )
    VALUES (?, ?, 'bozza', date('now'), ?, ?, ?, 'EUR', ?)
  `).run(codicePreventivo, i(request?.customer_id), imponibile, importoIva, totale, note);
  const preventivoId = Number(insert.lastInsertRowid);

  db.prepare(`
    INSERT INTO preventivi_righe (
      preventivo_id, prodotto_id, descrizione, quantita, prezzo_unitario, sconto,
      imponibile, aliquota_iva, importo_iva, totale_riga
    )
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `).run(
    preventivoId,
    quotedProduct.product.id,
    quotedProduct.description,
    qty,
    quotedProduct.price,
    imponibile,
    aliquotaIva,
    importoIva,
    totale
  );

  return {
    preventivoId,
    codicePreventivo,
    qty,
    imponibile,
    importoIva,
    totale
  };
}

function buildQuotePdfQuestionText(selectedItem) {
  const lines = [
    'Perfetto, ho identificato il ricambio selezionato.',
    selectedItem?.description ? `Descrizione: ${selectedItem.description}` : null,
    selectedItem?.oe_code ? `Codice OE: ${selectedItem.oe_code}` : null,
    selectedItem?.eurocode ? `Eurocode: ${selectedItem.eurocode}` : null,
    selectedItem?.price ? `Prezzo indicativo: EUR ${selectedItem.price}` : null,
    '',
    'Vuoi che ti prepari subito un preventivo PDF? Rispondi SI oppure NO.'
  ].filter(Boolean);
  return lines.join('\n');
}

function buildQuotePdfCaption(quote) {
  return `Preventivo ${quote?.codicePreventivo || ''}`.trim();
}

function makePublicPreventivoToken() {
  return crypto.randomUUID ? crypto.randomUUID() : `preventivo-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function ensurePublicPreventivoToken(preventivoId) {
  const current = db.prepare('SELECT public_token FROM preventivi WHERE id = ? LIMIT 1').get(preventivoId);
  if (current?.public_token) return current.public_token;
  const token = makePublicPreventivoToken();
  db.prepare('UPDATE preventivi SET public_token = ? WHERE id = ?').run(token, preventivoId);
  return token;
}

function buildPublicPreventivoPdfUrl(preventivoId, token = '') {
  const baseUrl = String(process.env.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
  return `${baseUrl}/api/public/preventivi/${encodeURIComponent(token || ensurePublicPreventivoToken(preventivoId))}/pdf`;
}

async function createQuoteArtifactsFromRequestId(requestId) {
  const current = serializeRequestDetails(requestId);
  if (!current) throw new Error('Richiesta non trovata');

  const quotedItem = pickQuotedItem(current);
  if (!quotedItem) {
    throw new Error('Nessun ricambio selezionato o risultato tecnico disponibile per creare il preventivo');
  }

  const quotedProduct = ensureQuoteProductForRequest(current, quotedItem);
  const quote = createDraftQuoteFromRequest(current, quotedProduct);

  db.prepare(`
    UPDATE parts_requests
    SET linked_product_id = ?,
        linked_preventivo_id = ?,
        status = 'preventivo_pronto',
        updated_at = datetime('now')
    WHERE id = ?
  `).run(quotedProduct.product.id, quote.preventivoId, requestId);

  logPartEvent(requestId, 'prodotto_creato', 'Articolo creato/aggiornato per preventivo', 'crm', {
    productId: quotedProduct.product.id,
    codice_interno: quotedProduct.product.codice_interno,
    oe_code: quotedProduct.oeCode,
    eurocode: quotedProduct.eurocode
  });
  logPartEvent(requestId, 'preventivo_creato', 'Preventivo bozza creato automaticamente dalla richiesta ricambi', 'crm', {
    preventivoId: quote.preventivoId,
    codice_preventivo: quote.codicePreventivo,
    total: quote.totale,
    qty: quote.qty
  });

  const publicToken = ensurePublicPreventivoToken(quote.preventivoId);
  const pdf = await createPreventivoPdfBuffer(quote.preventivoId);
  return {
    quotedProduct,
    quote,
    pdf,
    publicPdfUrl: buildPublicPreventivoPdfUrl(quote.preventivoId, publicToken)
  };
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
  } else if ((partsRequestId && conversation.parts_request_id !== partsRequestId) || (customerId && !conversation.customer_id)) {
    db.prepare(`
      UPDATE whatsapp_conversations
      SET parts_request_id = COALESCE(?, parts_request_id),
          customer_id = COALESCE(customer_id, ?),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(partsRequestId, customerId, conversation.id);
    conversation = db.prepare('SELECT * FROM whatsapp_conversations WHERE id = ?').get(conversation.id);
  }

  return conversation;
}

function getLatestConversationContext(phone, currentPartsRequestId = null) {
  if (!phone) return null;
  return db.prepare(`
    SELECT
      id,
      plate,
      vin,
      oe_code,
      requested_part_text,
      normalized_part_name,
      normalized_part_category,
      ai_summary,
      whatsapp_reply_text,
      status,
      created_at,
      updated_at
    FROM parts_requests
    WHERE user_phone = ?
      AND (? IS NULL OR id <> ?)
      AND (
        COALESCE(plate, '') <> ''
        OR COALESCE(vin, '') <> ''
        OR COALESCE(oe_code, '') <> ''
        OR COALESCE(requested_part_text, '') <> ''
        OR COALESCE(normalized_part_category, '') <> ''
      )
    ORDER BY id DESC
    LIMIT 1
  `).get(phone, currentPartsRequestId, currentPartsRequestId);
}

function getActivePartsRequestForPhone(phone) {
  if (!phone) return null;
  const windowMinutes = getActiveRequestWindowMinutes();
  return db.prepare(`
    SELECT *
    FROM parts_requests
    WHERE user_phone = ?
      AND status IN ('nuova', 'in_lavorazione', 'in_attesa_dati_cliente', 'in_attesa_verifica_tecnica', 'oe_trovato', 'preventivo_pronto')
      AND COALESCE(last_message_at, updated_at, created_at) >= datetime('now', ?)
    ORDER BY last_message_at DESC, id DESC
    LIMIT 1
  `).get(phone, `-${windowMinutes} minutes`);
}

function getIntakeState(partsRequestId) {
  if (!partsRequestId) return null;
  const row = db.prepare(`
    SELECT *
    FROM parts_request_intake_state
    WHERE parts_request_id = ?
    LIMIT 1
  `).get(partsRequestId);
  if (!row) return null;
  return {
    ...row,
    pendingSlot: s(row.pending_slot),
    pendingQuestion: s(row.pending_question),
    slots: json(row.slots_json, {}) || {}
  };
}

function saveIntakeState(partsRequestId, intakeState = {}) {
  const payload = {
    stage: s(intakeState.stage) || 'new',
    pendingSlot: s(intakeState.pendingSlot),
    pendingQuestion: s(intakeState.pendingQuestion),
    slots: intakeState.slots || {}
  };

  db.prepare(`
    INSERT INTO parts_request_intake_state (
      parts_request_id, stage, pending_slot, pending_question, slots_json
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(parts_request_id) DO UPDATE SET
      stage = excluded.stage,
      pending_slot = excluded.pending_slot,
      pending_question = excluded.pending_question,
      slots_json = excluded.slots_json,
      updated_at = datetime('now')
  `).run(
    partsRequestId,
    payload.stage,
    payload.pendingSlot,
    payload.pendingQuestion,
    JSON.stringify(payload.slots)
  );
}

function detectSide(text) {
  const lower = String(text || '').toLowerCase();
  if (/\b(sinistr|sx)\b/.test(lower)) return 'sinistro';
  if (/\b(destr|dx)\b/.test(lower)) return 'destro';
  return '';
}

function detectAxle(text) {
  const lower = String(text || '').toLowerCase();
  if (/\b(anteriore|anteriori|ant)\b/.test(lower)) return 'anteriore';
  if (/\b(posteriore|posteriori|post)\b/.test(lower)) return 'posteriore';
  return '';
}

function detectGlassPosition(text) {
  const lower = String(text || '').toLowerCase();
  if (/parabrezza/.test(lower)) return 'parabrezza_anteriore';
  if (/lunotto/.test(lower)) return 'lunotto_posteriore';
  if (/(scendente|vetro laterale|cristallo laterale)/.test(lower)) {
    const axle = detectAxle(lower);
    const side = detectSide(lower);
    return ['vetro_laterale', axle, side].filter(Boolean).join('_');
  }
  if (/raschiavetro/.test(lower)) {
    const axle = detectAxle(lower);
    const side = detectSide(lower);
    return ['raschiavetro', axle, side].filter(Boolean).join('_');
  }
  return '';
}

function detectBrakeComponent(text) {
  const lower = String(text || '').toLowerCase();
  if (/pastigli/.test(lower)) return 'pastiglie';
  if (/disch/.test(lower)) return 'dischi';
  if (/pinz/.test(lower)) return 'pinza';
  if (/tambur/.test(lower)) return 'tamburo';
  if (/ganasc|ceppi/.test(lower)) return 'ganasce';
  if (/cilindrett/.test(lower)) return 'cilindretto';
  return '';
}

function detectFilterType(text) {
  const lower = String(text || '').toLowerCase();
  if (/abitacolo|antipolline/.test(lower)) return 'abitacolo';
  if (/\baria\b/.test(lower)) return 'aria';
  if (/\bolio\b/.test(lower)) return 'olio';
  if (/carburante|gasolio|benzina/.test(lower)) return 'carburante';
  return '';
}

function mergeIntakeSlots({ parsed, normalizedPart, context, intakeState }) {
  const existing = intakeState?.slots || {};
  const sourceText = `${parsed?.requestedPartText || ''} ${parsed?.originalText || ''} ${normalizedPart?.name || ''}`.trim();
  const category = s(normalizedPart?.category) || s(existing.part_category) || s(context?.normalized_part_category) || guessPartCategory(sourceText);
  const partName = s(normalizedPart?.name) || s(existing.part_name) || s(context?.normalized_part_name) || s(parsed?.requestedPartText);

  return {
    plate: s(parsed?.plate) || s(existing.plate) || s(context?.plate) || '',
    vin: s(parsed?.vin) || s(existing.vin) || s(context?.vin) || '',
    oe_code: s(parsed?.oeCode) || s(existing.oe_code) || s(context?.oe_code) || '',
    part_category: category || '',
    part_name: partName || '',
    glass_position: detectGlassPosition(sourceText) || s(existing.glass_position) || '',
    side: detectSide(sourceText) || s(existing.side) || '',
    axle: detectAxle(sourceText) || s(existing.axle) || '',
    brake_component: detectBrakeComponent(sourceText) || s(existing.brake_component) || '',
    filter_type: detectFilterType(sourceText) || s(existing.filter_type) || ''
  };
}

function buildIntakeDecision(slots = {}) {
  if (!slots.plate) {
    return {
      ready: false,
      stage: 'waiting_plate',
      pendingSlot: 'plate',
      question: 'Per proseguire ho bisogno della targa del veicolo.'
    };
  }

  switch (slots.part_category) {
    case 'cristalli':
      if (!slots.glass_position) {
        return {
          ready: false,
          stage: 'waiting_glass_position',
          pendingSlot: 'glass_position',
          question: 'Ho preso la targa. Dimmi quale cristallo ti serve: parabrezza, lunotto oppure vetro laterale.'
        };
      }
      return { ready: true, stage: 'ready_for_service', pendingSlot: null, question: null };
    case 'freni':
      if (!slots.brake_component) {
        return {
          ready: false,
          stage: 'waiting_brake_component',
          pendingSlot: 'brake_component',
          question: 'Ho preso la targa. Per i freni dimmi se ti servono pastiglie, dischi, pinza o altro.'
        };
      }
      if (!slots.axle) {
        return {
          ready: false,
          stage: 'waiting_axle',
          pendingSlot: 'axle',
          question: 'Perfetto. Mi confermi se ti servono anteriori o posteriori?'
        };
      }
      return { ready: true, stage: 'ready_for_ai', pendingSlot: null, question: null };
    case 'filtri':
      if (!slots.filter_type) {
        return {
          ready: false,
          stage: 'waiting_filter_type',
          pendingSlot: 'filter_type',
          question: 'Ho preso la targa. Dimmi quale filtro ti serve: aria, olio, abitacolo o carburante.'
        };
      }
      return { ready: true, stage: 'ready_for_ai', pendingSlot: null, question: null };
    case 'retrovisori':
      if (!slots.side) {
        return {
          ready: false,
          stage: 'waiting_side',
          pendingSlot: 'side',
          question: 'Ho preso la targa. Mi serve sapere se il ricambio e destro o sinistro.'
        };
      }
      return { ready: true, stage: 'ready_for_ai', pendingSlot: null, question: null };
    case 'illuminazione':
      if (!slots.side) {
        return {
          ready: false,
          stage: 'waiting_side',
          pendingSlot: 'side',
          question: 'Ho preso la targa. Mi confermi se ti serve lato destro o sinistro?'
        };
      }
      return { ready: true, stage: 'ready_for_ai', pendingSlot: null, question: null };
    default:
      if (!slots.part_name || slots.part_name.length < 4) {
        return {
          ready: false,
          stage: 'waiting_part_name',
          pendingSlot: 'part_name',
          question: 'Ho preso la targa. Dimmi meglio quale ricambio ti serve.'
        };
      }
      return { ready: true, stage: 'ready_for_ai', pendingSlot: null, question: null };
  }
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

async function sendWhatsAppDocumentBuffer(to, buffer, filename, caption = '') {
  if (!isWhatsappConfigured()) return { skipped: true, reason: 'whatsapp_non_configurato' };
  const version = process.env.WHATSAPP_API_VERSION || 'v20.0';
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const authHeaders = { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` };

  const uploadEndpoint = `https://graph.facebook.com/${version}/${phoneNumberId}/media`;
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), filename);

  const uploadResponse = await fetch(uploadEndpoint, {
    method: 'POST',
    headers: authHeaders,
    body: form
  });
  const uploadRaw = await uploadResponse.text();
  const uploadBody = parseWhatsappResponseBody(uploadRaw);
  if (!uploadResponse.ok || !uploadBody?.id) {
    return {
      skipped: false,
      stage: 'upload',
      statusCode: uploadResponse.status,
      raw: uploadRaw,
      body: uploadBody,
      error: uploadBody?.error?.message || uploadRaw || `WhatsApp media upload HTTP ${uploadResponse.status}`
    };
  }

  const messageEndpoint = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(to || ''),
    type: 'document',
    document: {
      id: uploadBody.id,
      filename: String(filename || 'preventivo.pdf')
    }
  };
  if (caption) payload.document.caption = String(caption);

  const sendResponse = await fetch(messageEndpoint, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const sendRaw = await sendResponse.text();
  const sendBody = parseWhatsappResponseBody(sendRaw);
  return {
    skipped: false,
    stage: 'message',
    statusCode: sendResponse.status,
    raw: sendRaw,
    body: sendBody,
    mediaId: uploadBody.id,
    error: sendResponse.ok ? null : (sendBody?.error?.message || sendRaw || `WhatsApp document send HTTP ${sendResponse.status}`)
  };
}

function isTelegramConfigured() {
  return !!process.env.TELEGRAM_BOT_TOKEN;
}

async function callTelegramApi(method, body, isMultipart = false) {
  if (!isTelegramConfigured()) return { skipped: true, reason: 'telegram_non_configurato' };
  const endpoint = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: isMultipart ? undefined : { 'Content-Type': 'application/json' },
    body: isMultipart ? body : JSON.stringify(body || {})
  });
  const raw = await response.text();
  const parsed = parseWhatsappResponseBody(raw);
  return {
    skipped: false,
    statusCode: response.status,
    raw,
    body: parsed,
    error: response.ok && parsed?.ok !== false ? null : (parsed?.description || raw || `Telegram ${method} HTTP ${response.status}`)
  };
}

async function sendTelegramText(chatId, bodyText) {
  return callTelegramApi('sendMessage', {
    chat_id: String(chatId || ''),
    text: String(bodyText || '')
  });
}

async function sendTelegramDocumentBuffer(chatId, buffer, filename, caption = '') {
  const form = new FormData();
  form.append('chat_id', String(chatId || ''));
  form.append('document', new Blob([buffer], { type: 'application/pdf' }), filename || 'preventivo.pdf');
  if (caption) form.append('caption', String(caption));
  return callTelegramApi('sendDocument', form, true);
}

async function triangulateWithOpenAI(messageText) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  if (!apiKey || !messageText) {
    return { skipped: true, reason: 'openai_non_configurato', meta: { model } };
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
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
    return {
      skipped: false,
      error: parsed?.error?.message || raw || `OpenAI HTTP ${response.status}`,
      meta: { model, statusCode: response.status, raw, parsed }
    };
  }
  const content = parsed?.choices?.[0]?.message?.content;
  if (!content) {
    return {
      skipped: false,
      error: 'Risposta OpenAI vuota',
      meta: { model, statusCode: response.status, raw, parsed }
    };
  }
  try {
    return {
      skipped: false,
      data: JSON.parse(content),
      meta: { model, statusCode: response.status, raw, parsed, content }
    };
  } catch {
    return {
      skipped: false,
      error: 'JSON OpenAI non valido',
      raw: content,
      meta: { model, statusCode: response.status, raw, parsed, content }
    };
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

function detectRequestedGlassKind(text) {
  const lower = String(text || '').toLowerCase();
  if (/parabrezza/.test(lower)) return 'parabrezza';
  if (/lunotto/.test(lower)) return 'lunotto';
  if (/(vetro laterale|cristallo laterale|scendente)/.test(lower)) return 'vetro_laterale';
  if (/raschiavetro/.test(lower)) return 'raschiavetro';
  return '';
}

function isGlassAccessoryDescription(description = '') {
  return /(sensore|tergi|spazzol|braccio|meccanismo|motorino|ugello|pompa)/i.test(String(description || ''));
}

function isConfidentGlassSelection(selectedItem, requestedPartText = '', options = []) {
  if (!selectedItem) return false;
  const requestedKind = detectRequestedGlassKind(requestedPartText);
  const description = String(selectedItem.description || '').toLowerCase();
  if (!requestedKind) return options.length <= 1;
  if (requestedKind === 'parabrezza') return /\bparabrezza\b/i.test(description) && !isGlassAccessoryDescription(description);
  if (requestedKind === 'lunotto') return /\blunotto\b/i.test(description);
  if (requestedKind === 'vetro_laterale') return /(vetro|cristallo|scendente)/i.test(description);
  if (requestedKind === 'raschiavetro') return /raschiavetro/i.test(description);
  return options.length <= 1;
}

function buildGlassOptions(items = [], requestedPartText = '') {
  if (!items.length) return [];
  const requestedKind = detectRequestedGlassKind(requestedPartText);
  const tokens = String(requestedPartText || '')
    .toLowerCase()
    .split(/[^a-z0-9àèéìòù]+/i)
    .filter((token) => token.length >= 3);

  let scopedItems = items;
  if (requestedKind === 'parabrezza') {
    const direct = items.filter((item) => /parabrezza/i.test(item.description || ''));
    const nonAccessory = direct.filter((item) => !isGlassAccessoryDescription(item.description || ''));
    scopedItems = nonAccessory.length ? nonAccessory : (direct.length ? direct : items.filter((item) => !isGlassAccessoryDescription(item.description || '')));
  } else if (requestedKind === 'lunotto') {
    const direct = items.filter((item) => /lunotto/i.test(item.description || ''));
    scopedItems = direct.length ? direct : items;
  } else if (requestedKind === 'vetro_laterale') {
    const direct = items.filter((item) => /(vetro|cristallo|scendente)/i.test(item.description || ''));
    scopedItems = direct.length ? direct : items;
  }

  const ranked = items
    .map((item) => {
      const haystack = `${item.description} ${item.oe_code} ${item.eurocode}`.toLowerCase();
      const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
      const kindBonus = requestedKind && haystack.includes(requestedKind.replace('_', ' ')) ? 5 : 0;
      const accessoryPenalty = requestedKind === 'parabrezza' && isGlassAccessoryDescription(item.description || '') ? -5 : 0;
      return { item, score: score + kindBonus + accessoryPenalty };
    })
    .filter((entry) => scopedItems.includes(entry.item))
    .sort((a, b) => b.score - a.score);

  const seen = new Set();
  const options = [];

  for (const entry of ranked) {
    const label = (entry.item.description || entry.item.oe_code || entry.item.eurocode || 'Ricambio cristalli').trim();
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(entry.item);
  }

  return options;
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

function buildGlassOptionsReplyText(options = [], itemsCount = 0) {
  if (!options.length) {
    return 'Ho identificato una richiesta cristalli, ma dalla sola targa non emerge un risultato univoco. Indicami meglio quale vetro o allega una foto del ricambio.';
  }

  const lines = [
    'Ho trovato piu varianti compatibili dalla targa.',
    'Ti elenco le varianti trovate in RTWS:'
  ];

  options.forEach((item, index) => {
    const parts = [
      `${index + 1}. ${item.description || 'Ricambio cristalli'}`,
      item.oe_code ? `OE ${item.oe_code}` : null,
      item.eurocode ? `Eurocode ${item.eurocode}` : null
    ].filter(Boolean);
    lines.push(parts.join(' - '));
  });

  if (itemsCount > options.length) {
    lines.push(`Ci sono anche altre ${itemsCount - options.length} varianti nel catalogo.`);
  }
  lines.push('Rispondi con il numero corretto oppure mandami una foto del libretto/ricambio.');

  return lines.join('\n');
}

async function resolvePartsMessage({ message, channel = 'whatsapp', context = null }) {
  const text = String(message || '').trim();
  if (!text) return { status: 'ERROR', error: 'message obbligatorio' };

  const aiResult = await triangulateWithOpenAI(text);
  const ai = aiResult.data || {};
  const previousContext = context || {};
  const fallbackPlate = extractPlateFromText(text);
  const fallbackVin = extractVinFromText(text);
  const fallbackOeCode = extractOeCodeFromText(text);
  const resolvedPlate = normalizePlate(ai.plate || fallbackPlate || previousContext.plate || '');
  const resolvedVin = s(ai.vin) || fallbackVin || s(previousContext.vin) || '';
  const resolvedOeCode = s(ai.oe_code) || fallbackOeCode || s(previousContext.oe_code) || '';
  const resolvedRequestedPartText = s(ai.requested_part_text)
    || deriveRequestedPartText(text, resolvedPlate, resolvedVin, resolvedOeCode)
    || s(previousContext.requested_part_text)
    || s(previousContext.normalized_part_name)
    || text;
  const parsed = {
    originalText: text,
    plate: resolvedPlate,
    vin: resolvedVin,
    oeCode: resolvedOeCode,
    requestedPartText: resolvedRequestedPartText,
    confidence: ai.confidence ?? 0
  };
  const normalizedPart = {
    name: s(ai.normalized_part_name) || s(previousContext.normalized_part_name) || parsed.requestedPartText,
    category: s(ai.normalized_part_category) || s(previousContext.normalized_part_category) || guessPartCategory(parsed.requestedPartText)
  };
  const glassEligible = ai.request_is_valid !== false
    && parsed.plate
    && (String(ai.suggested_service || '') === 'RTWS_LISTINI_CHECK_EUROCODE_TARGA_OE2' || normalizedPart.category === 'cristalli');

  let glassCatalog = { status: 'SKIPPED', message: 'Nessun servizio tecnico eseguito', items: [] };
  let whatsappText = s(ai.operator_reply_text) || '';
  let status = s(ai.status) || 'nuova';
  let options = [];
  let selectedItem = null;
  let confidentSelection = false;

  if (glassEligible) {
    glassCatalog = await rtwsCheckEurocodeDaTargaOE2({ plate: parsed.plate, oeCode: parsed.oeCode });
    selectedItem = chooseBestGlassItem(glassCatalog.items, parsed.requestedPartText);
    options = buildGlassOptions(glassCatalog.items, parsed.requestedPartText);
    confidentSelection = isConfidentGlassSelection(selectedItem, parsed.requestedPartText, options);
    if (selectedItem && options.length <= 1 && confidentSelection) {
      parsed.oeCode = selectedItem.oe_code || parsed.oeCode;
      whatsappText = buildQuotePdfQuestionText(selectedItem);
      status = 'oe_trovato';
    } else if (options.length > 1) {
      whatsappText = buildGlassOptionsReplyText(options, glassCatalog.items.length);
      status = 'in_attesa_verifica_tecnica';
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
      normalizedPart,
      extraction: {
        plate_source: ai.plate ? 'openai' : (fallbackPlate ? 'regex' : 'missing'),
        vin_source: ai.vin ? 'openai' : (fallbackVin ? 'regex' : 'missing'),
        oe_source: ai.oe_code ? 'openai' : (fallbackOeCode ? 'regex' : 'missing')
      },
      conversationContext: previousContext ? {
        plate: s(previousContext.plate) || null,
        vin: s(previousContext.vin) || null,
        oe_code: s(previousContext.oe_code) || null,
        requested_part_text: s(previousContext.requested_part_text) || null,
        normalized_part_name: s(previousContext.normalized_part_name) || null,
        normalized_part_category: s(previousContext.normalized_part_category) || null
      } : null,
      openai: {
        skipped: !!aiResult.skipped,
        error: aiResult.error || null,
        model: aiResult.meta?.model || null,
        statusCode: aiResult.meta?.statusCode || null,
        raw: aiResult.meta?.content || aiResult.meta?.raw || aiResult.raw || null,
        parsed: aiResult.data || aiResult.meta?.parsed || null
      }
    },
    aiSummary: s(ai.ai_summary) || null,
    resolvedStatus: status
  };
}

async function resolvePartsMessageV2({ message, channel = 'whatsapp', context = null, intakeState = null }) {
  const text = String(message || '').trim();
  if (!text) return { status: 'ERROR', error: 'message obbligatorio' };

  const previousContext = context || {};
  const previousIntakeState = intakeState || { slots: {} };
  const normalizedAnswer = text.toLowerCase();
  const yesAnswer = /^(si|sì|yes|ok|va bene|procedi|confermo)$/i.test(normalizedAnswer);
  const noAnswer = /^(no|no grazie|annulla|non ora)$/i.test(normalizedAnswer);
  const variantsRequest = /^(mostra( tutte)?( le)? varianti|varianti|altre varianti)$/i.test(text);
  const numericSelection = text.match(/^\s*(\d{1,2})\s*$/);
  const previousOptions = Array.isArray(previousIntakeState.slots?.proposed_glass_options)
    ? previousIntakeState.slots.proposed_glass_options
    : [];
  if (previousIntakeState.pendingSlot === 'quote_pdf_confirmation') {
    if (variantsRequest && previousOptions.length) {
      const parsed = {
        originalText: text,
        plate: s(previousIntakeState.slots?.plate) || s(previousContext.plate) || '',
        vin: s(previousIntakeState.slots?.vin) || s(previousContext.vin) || '',
        oeCode: s(previousIntakeState.slots?.oe_code) || s(previousContext.oe_code) || '',
        requestedPartText: s(previousIntakeState.slots?.part_name) || s(previousContext.normalized_part_name) || 'Ricambio cristalli',
        confidence: 1
      };
      const normalizedPart = {
        name: s(previousIntakeState.slots?.part_name) || 'Ricambio cristalli',
        category: 'cristalli'
      };
      return {
        status: 'OK',
        parsed,
        vehicle: null,
        normalizedPart,
        dbrtResult: {},
        glassCatalog: { status: 'READY', message: 'Varianti cristalli riproposte al cliente durante conferma preventivo', items: previousOptions },
        oeCatalog: {},
        oeResults: previousOptions,
        equivalents: {},
        missingData: ['quote_pdf_confirmation'],
        whatsappText: `${buildGlassOptionsReplyText(previousOptions, previousOptions.length)}\n\nVuoi che ti prepari subito un preventivo PDF? Rispondi SI oppure NO.`,
        aiRequest: {
          intent: 'glass_options_recap_during_quote_confirmation',
          request_is_valid: true,
          suggested_service: 'WAITING_DATA',
          instruction: 'Riproposta varianti RTWS mentre si attende la conferma del preventivo PDF.',
          availableSources: ['CONVERSATION_CONTEXT', 'RTWS_LISTINI'],
          parsed,
          normalizedPart,
          openai: { skipped: true, error: null, model: process.env.OPENAI_MODEL || 'gpt-4o-mini', statusCode: null, raw: null, parsed: null }
        },
        aiSummary: null,
        resolvedStatus: 'oe_trovato',
        intakeState: previousIntakeState
      };
    }
    if (numericSelection && previousOptions.length) {
      const selectedIndex = Number(numericSelection[1]) - 1;
      const selectedItem = previousOptions[selectedIndex];
      if (selectedItem) {
        const parsed = {
          originalText: text,
          plate: s(previousIntakeState.slots?.plate) || s(previousContext.plate) || '',
          vin: s(previousIntakeState.slots?.vin) || s(previousContext.vin) || '',
          oeCode: s(selectedItem.oe_code) || '',
          requestedPartText: s(previousIntakeState.slots?.part_name) || s(previousContext.normalized_part_name) || 'Ricambio cristalli',
          confidence: 1
        };
        const normalizedPart = {
          name: s(previousIntakeState.slots?.part_name) || 'Ricambio cristalli',
          category: 'cristalli'
        };
        return {
          status: 'OK',
          parsed,
          vehicle: null,
          normalizedPart,
          dbrtResult: {},
          glassCatalog: { status: 'READY', message: 'Variante cristalli aggiornata durante conferma preventivo', items: previousOptions },
          oeCatalog: {},
          oeResults: [selectedItem],
          equivalents: {},
          missingData: ['quote_pdf_confirmation'],
          whatsappText: buildQuotePdfQuestionText(selectedItem),
          aiRequest: {
            intent: 'glass_option_reselection',
            request_is_valid: true,
            suggested_service: 'WAITING_DATA',
            instruction: 'Il cliente ha cambiato la variante selezionata prima della conferma preventivo PDF.',
            availableSources: ['CONVERSATION_CONTEXT', 'RTWS_LISTINI'],
            parsed,
            normalizedPart,
            selectedOptionIndex: selectedIndex + 1,
            openai: { skipped: true, error: null, model: process.env.OPENAI_MODEL || 'gpt-4o-mini', statusCode: null, raw: null, parsed: null }
          },
          aiSummary: null,
          resolvedStatus: 'oe_trovato',
          intakeState: {
            stage: 'waiting_quote_pdf_confirmation',
            pendingSlot: 'quote_pdf_confirmation',
            pendingQuestion: 'Vuoi che ti prepari subito un preventivo PDF? Rispondi SI oppure NO.',
            slots: {
              ...previousIntakeState.slots,
              oe_code: s(selectedItem.oe_code) || s(previousIntakeState.slots?.oe_code) || '',
              selected_glass_option: selectedItem,
              proposed_glass_options: previousOptions
            }
          }
        };
      }
    }
    const selectedItem = previousIntakeState.slots?.selected_glass_option || null;
    const parsed = {
      originalText: text,
      plate: s(previousIntakeState.slots?.plate) || s(previousContext.plate) || '',
      vin: s(previousIntakeState.slots?.vin) || s(previousContext.vin) || '',
      oeCode: s(selectedItem?.oe_code) || s(previousIntakeState.slots?.oe_code) || '',
      requestedPartText: s(previousIntakeState.slots?.part_name) || s(previousContext.normalized_part_name) || 'Ricambio cristalli',
      confidence: 1
    };
    const normalizedPart = {
      name: s(previousIntakeState.slots?.part_name) || 'Ricambio cristalli',
      category: 'cristalli'
    };
    if (yesAnswer) {
      return {
        status: 'OK',
        parsed,
        vehicle: null,
        normalizedPart,
        dbrtResult: {},
        glassCatalog: { status: 'READY', message: 'Conferma creazione preventivo PDF ricevuta', items: previousOptions },
        oeCatalog: {},
        oeResults: selectedItem ? [selectedItem] : [],
        equivalents: {},
        missingData: [],
        whatsappText: 'Perfetto, preparo subito il preventivo PDF e te lo invio qui su WhatsApp.',
        quoteDecision: 'create_pdf',
        aiRequest: {
          intent: 'quote_pdf_confirmation_yes',
          request_is_valid: true,
          suggested_service: 'CREATE_PREVENTIVO_PDF',
          instruction: 'Conferma positiva del cliente alla generazione preventivo PDF.',
          availableSources: ['CONVERSATION_CONTEXT', 'CRM_PREVENTIVI'],
          parsed,
          normalizedPart,
          openai: { skipped: true, error: null, model: process.env.OPENAI_MODEL || 'gpt-4o-mini', statusCode: null, raw: null, parsed: null }
        },
        aiSummary: null,
        resolvedStatus: 'preventivo_pronto',
        intakeState: {
          stage: 'quote_pdf_confirmed',
          pendingSlot: null,
          pendingQuestion: null,
          slots: {
            ...previousIntakeState.slots,
            quote_pdf_requested: true
          }
        }
      };
    }
    if (noAnswer) {
      return {
        status: 'OK',
        parsed,
        vehicle: null,
        normalizedPart,
        dbrtResult: {},
        glassCatalog: { status: 'READY', message: 'Preventivo PDF rifiutato dal cliente', items: previousOptions },
        oeCatalog: {},
        oeResults: selectedItem ? [selectedItem] : [],
        equivalents: {},
        missingData: [],
        whatsappText: 'Va bene, non genero il PDF per ora. La richiesta resta salvata e possiamo procedere quando vuoi.',
        aiRequest: {
          intent: 'quote_pdf_confirmation_no',
          request_is_valid: true,
          suggested_service: 'WAITING_DATA',
          instruction: 'Il cliente non desidera il preventivo PDF in questo momento.',
          availableSources: ['CONVERSATION_CONTEXT'],
          parsed,
          normalizedPart,
          openai: { skipped: true, error: null, model: process.env.OPENAI_MODEL || 'gpt-4o-mini', statusCode: null, raw: null, parsed: null }
        },
        aiSummary: null,
        resolvedStatus: 'oe_trovato',
        intakeState: {
          stage: 'selection_completed',
          pendingSlot: null,
          pendingQuestion: null,
          slots: {
            ...previousIntakeState.slots,
            quote_pdf_requested: false
          }
        }
      };
    }
    return {
      status: 'OK',
      parsed,
      vehicle: null,
      normalizedPart,
      dbrtResult: {},
      glassCatalog: { status: 'READY', message: 'In attesa di conferma preventivo PDF', items: previousOptions },
      oeCatalog: {},
      oeResults: selectedItem ? [selectedItem] : [],
      equivalents: {},
      missingData: ['quote_pdf_confirmation'],
      whatsappText: 'Dimmi solo SI oppure NO se vuoi che ti prepari subito il preventivo PDF.',
      aiRequest: {
        intent: 'quote_pdf_confirmation_repeat',
        request_is_valid: true,
        suggested_service: 'WAITING_DATA',
        instruction: 'Ripetizione richiesta SI/NO per generazione preventivo PDF.',
        availableSources: ['CONVERSATION_CONTEXT'],
        parsed,
        normalizedPart,
        openai: { skipped: true, error: null, model: process.env.OPENAI_MODEL || 'gpt-4o-mini', statusCode: null, raw: null, parsed: null }
      },
      aiSummary: null,
      resolvedStatus: 'oe_trovato',
      intakeState: previousIntakeState
    };
  }
  if (variantsRequest && previousOptions.length) {
    const parsed = {
      originalText: text,
      plate: s(previousIntakeState.slots?.plate) || s(previousContext.plate) || '',
      vin: s(previousIntakeState.slots?.vin) || s(previousContext.vin) || '',
      oeCode: s(previousIntakeState.slots?.oe_code) || s(previousContext.oe_code) || '',
      requestedPartText: s(previousIntakeState.slots?.part_name) || s(previousContext.normalized_part_name) || 'Ricambio cristalli',
      confidence: 1
    };
    const normalizedPart = {
      name: s(previousIntakeState.slots?.part_name) || 'Ricambio cristalli',
      category: 'cristalli'
    };
    return {
      status: 'OK',
      parsed,
      vehicle: null,
      normalizedPart,
      dbrtResult: {},
      glassCatalog: { status: 'READY', message: 'Varianti cristalli riproposte al cliente', items: previousOptions },
      oeCatalog: {},
      oeResults: previousOptions,
      equivalents: {},
      missingData: [],
      whatsappText: buildGlassOptionsReplyText(previousOptions, previousOptions.length),
      aiRequest: {
        intent: 'glass_options_recap',
        request_is_valid: true,
        suggested_service: 'RTWS_LISTINI_CHECK_EUROCODE_TARGA_OE2',
        instruction: 'Riproposta delle varianti RTWS gia trovate in precedenza.',
        availableSources: ['CONVERSATION_CONTEXT', 'RTWS_LISTINI'],
        parsed,
        normalizedPart,
        openai: {
          skipped: true,
          error: null,
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          statusCode: null,
          raw: null,
          parsed: null
        }
      },
      aiSummary: null,
      resolvedStatus: 'in_attesa_verifica_tecnica',
      intakeState: {
        stage: 'ready_for_service',
        pendingSlot: null,
        pendingQuestion: null,
        slots: previousIntakeState.slots
      }
    };
  }
  if (numericSelection && previousOptions.length) {
    const selectedIndex = Number(numericSelection[1]) - 1;
    const selectedItem = previousOptions[selectedIndex];
    if (selectedItem) {
      const parsed = {
        originalText: text,
        plate: s(previousIntakeState.slots?.plate) || s(previousContext.plate) || '',
        vin: s(previousIntakeState.slots?.vin) || s(previousContext.vin) || '',
        oeCode: s(selectedItem.oe_code) || '',
        requestedPartText: s(previousIntakeState.slots?.part_name) || s(previousContext.normalized_part_name) || 'Ricambio cristalli',
        confidence: 1
      };
      const normalizedPart = {
        name: s(previousIntakeState.slots?.part_name) || 'Ricambio cristalli',
        category: 'cristalli'
      };
      return {
        status: 'OK',
        parsed,
        vehicle: null,
        normalizedPart,
        dbrtResult: {},
        glassCatalog: { status: 'READY', message: 'Variante cristalli selezionata da cliente', items: previousOptions },
        oeCatalog: {},
        oeResults: [selectedItem],
        equivalents: {},
        missingData: [],
        whatsappText: buildQuotePdfQuestionText(selectedItem),
        aiRequest: {
          intent: 'glass_option_selection',
          request_is_valid: true,
          suggested_service: 'RTWS_LISTINI_CHECK_EUROCODE_TARGA_OE2',
          instruction: 'Selezione diretta di una variante RTWS proposta in precedenza.',
          availableSources: ['CONVERSATION_CONTEXT', 'RTWS_LISTINI'],
          parsed,
          normalizedPart,
          selectedOptionIndex: selectedIndex + 1,
          openai: {
            skipped: true,
            error: null,
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            statusCode: null,
            raw: null,
            parsed: null
          }
        },
        aiSummary: null,
        resolvedStatus: 'oe_trovato',
        intakeState: {
          stage: 'waiting_quote_pdf_confirmation',
          pendingSlot: 'quote_pdf_confirmation',
          pendingQuestion: 'Vuoi che ti prepari subito un preventivo PDF? Rispondi SI oppure NO.',
          slots: {
            ...previousIntakeState.slots,
            oe_code: s(selectedItem.oe_code) || s(previousIntakeState.slots?.oe_code) || '',
            selected_glass_option: selectedItem,
            proposed_glass_options: previousOptions
          }
        }
      };
    }
  }

  const fallbackPlate = extractPlateFromText(text);
  const fallbackVin = extractVinFromText(text);
  const fallbackOeCode = extractOeCodeFromText(text);
  const basePlate = normalizePlate(fallbackPlate || previousContext.plate || previousIntakeState.slots?.plate || '');
  const baseVin = fallbackVin || s(previousContext.vin) || s(previousIntakeState.slots?.vin) || '';
  const baseOeCode = fallbackOeCode || s(previousContext.oe_code) || s(previousIntakeState.slots?.oe_code) || '';
  const baseRequestedPartText = deriveRequestedPartText(text, basePlate, baseVin, baseOeCode)
    || s(previousContext.requested_part_text)
    || s(previousContext.normalized_part_name)
    || text;

  const preliminaryParsed = {
    originalText: text,
    plate: basePlate,
    vin: baseVin,
    oeCode: baseOeCode,
    requestedPartText: baseRequestedPartText,
    confidence: 0
  };
  const preliminaryNormalizedPart = {
    name: s(previousContext.normalized_part_name) || preliminaryParsed.requestedPartText,
    category: s(previousContext.normalized_part_category) || guessPartCategory(preliminaryParsed.requestedPartText)
  };

  const intakeSlots = mergeIntakeSlots({
    parsed: preliminaryParsed,
    normalizedPart: preliminaryNormalizedPart,
    context: previousContext,
    intakeState: previousIntakeState
  });
  const intakeDecision = buildIntakeDecision(intakeSlots);

  if (!intakeDecision.ready) {
    const parsed = {
      originalText: text,
      plate: intakeSlots.plate || '',
      vin: intakeSlots.vin || '',
      oeCode: intakeSlots.oe_code || '',
      requestedPartText: intakeSlots.part_name || preliminaryParsed.requestedPartText,
      confidence: 0
    };
    const normalizedPart = {
      name: intakeSlots.part_name || parsed.requestedPartText,
      category: intakeSlots.part_category || preliminaryNormalizedPart.category
    };
    return {
      status: 'OK',
      parsed,
      vehicle: null,
      normalizedPart,
      dbrtResult: {},
      glassCatalog: { status: 'SKIPPED', message: 'In attesa di dati cliente', items: [] },
      oeCatalog: {},
      oeResults: [],
      equivalents: {},
      missingData: intakeDecision.pendingSlot ? [intakeDecision.pendingSlot] : [],
      whatsappText: intakeDecision.question,
      aiRequest: {
        intent: 'intake_collection',
        request_is_valid: true,
        suggested_service: 'WAITING_DATA',
        instruction: 'Raccolta dati progressiva senza chiamata AI finche la richiesta non e completa.',
        availableSources: ['RULES', 'CONVERSATION_CONTEXT'],
        parsed,
        normalizedPart,
        intakeSlots,
        intakeDecision,
        openai: {
          skipped: true,
          error: null,
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          statusCode: null,
          raw: null,
          parsed: null
        }
      },
      aiSummary: null,
      resolvedStatus: 'in_attesa_dati_cliente',
      intakeState: {
        stage: intakeDecision.stage,
        pendingSlot: intakeDecision.pendingSlot,
        pendingQuestion: intakeDecision.question,
        slots: intakeSlots
      }
    };
  }

  if (intakeDecision.stage === 'ready_for_service' && intakeSlots.part_category === 'cristalli') {
    const parsed = {
      originalText: text,
      plate: intakeSlots.plate || '',
      vin: intakeSlots.vin || '',
      oeCode: intakeSlots.oe_code || '',
      requestedPartText: intakeSlots.part_name || preliminaryParsed.requestedPartText,
      confidence: 1
    };
    const normalizedPart = {
      name: intakeSlots.part_name || parsed.requestedPartText,
      category: 'cristalli'
    };
    const glassCatalog = await rtwsCheckEurocodeDaTargaOE2({ plate: parsed.plate, oeCode: parsed.oeCode });
    const selectedItem = chooseBestGlassItem(glassCatalog.items, parsed.requestedPartText);
    const options = buildGlassOptions(glassCatalog.items, parsed.requestedPartText);
    const confidentSelection = isConfidentGlassSelection(selectedItem, parsed.requestedPartText, options);
    let whatsappText = '';
    let status = 'in_attesa_verifica_tecnica';

    if (selectedItem && options.length <= 1 && confidentSelection) {
      parsed.oeCode = selectedItem.oe_code || parsed.oeCode;
      whatsappText = buildQuotePdfQuestionText(selectedItem);
      status = 'oe_trovato';
    } else if (options.length > 1) {
      whatsappText = buildGlassOptionsReplyText(options, glassCatalog.items.length);
      status = 'in_attesa_verifica_tecnica';
    } else if (glassCatalog.status === 'ERROR') {
      whatsappText = 'Ho ricevuto la richiesta del cristallo e sto verificando i dati tecnici. Ti aggiorno appena completo il controllo.';
      status = 'errore_integrazione';
    } else {
      whatsappText = 'Ho identificato una richiesta cristalli, ma dalla sola targa non emerge un risultato univoco. Indicami meglio quale vetro o allega una foto del ricambio.';
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
      missingData: [],
      whatsappText,
      aiRequest: {
        intent: 'deterministic_glass_resolution',
        request_is_valid: true,
        suggested_service: 'RTWS_LISTINI_CHECK_EUROCODE_TARGA_OE2',
        instruction: 'Risoluzione cristalli deterministica con dati minimi completi, senza passare prima da AI.',
        availableSources: ['RULES', 'RTWS_LISTINI'],
        parsed,
        normalizedPart,
        intakeSlots,
        intakeDecision,
        openai: {
          skipped: true,
          error: null,
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          statusCode: null,
          raw: null,
          parsed: null
        }
      },
      aiSummary: null,
      resolvedStatus: status,
      intakeState: {
        stage: selectedItem && options.length <= 1 && confidentSelection ? 'waiting_quote_pdf_confirmation' : 'ready_for_service',
        pendingSlot: selectedItem && options.length <= 1 && confidentSelection ? 'quote_pdf_confirmation' : null,
        pendingQuestion: selectedItem && options.length <= 1 && confidentSelection ? 'Vuoi che ti prepari subito un preventivo PDF? Rispondi SI oppure NO.' : null,
        slots: {
          ...intakeSlots,
          oe_code: selectedItem && confidentSelection ? (selectedItem.oe_code || intakeSlots.oe_code || '') : (intakeSlots.oe_code || ''),
          selected_glass_option: selectedItem && options.length <= 1 && confidentSelection ? selectedItem : null,
          proposed_glass_options: options
        }
      }
    };
  }

  const aiPrompt = [
    `Messaggio cliente: ${text}`,
    `Contesto raccolto: ${JSON.stringify(intakeSlots)}`
  ].join('\n');
  const aiResult = await triangulateWithOpenAI(aiPrompt);
  const ai = aiResult.data || {};
  const parsed = {
    originalText: text,
    plate: normalizePlate(ai.plate || intakeSlots.plate || ''),
    vin: s(ai.vin) || intakeSlots.vin || '',
    oeCode: s(ai.oe_code) || intakeSlots.oe_code || '',
    requestedPartText: s(ai.requested_part_text) || intakeSlots.part_name || preliminaryParsed.requestedPartText,
    confidence: ai.confidence ?? 0
  };
  const normalizedPart = {
    name: s(ai.normalized_part_name) || intakeSlots.part_name || parsed.requestedPartText,
    category: s(ai.normalized_part_category) || intakeSlots.part_category || preliminaryNormalizedPart.category
  };
  const finalSlots = mergeIntakeSlots({
    parsed,
    normalizedPart,
    context: previousContext,
    intakeState: { slots: intakeSlots }
  });
  const glassEligible = ai.request_is_valid !== false
    && parsed.plate
    && finalSlots.part_category === 'cristalli'
    && (String(ai.suggested_service || '') === 'RTWS_LISTINI_CHECK_EUROCODE_TARGA_OE2' || normalizedPart.category === 'cristalli');

  let glassCatalog = { status: 'SKIPPED', message: 'Nessun servizio tecnico eseguito', items: [] };
  let whatsappText = s(ai.operator_reply_text) || '';
  let status = s(ai.status) || 'nuova';

  if (glassEligible) {
    glassCatalog = await rtwsCheckEurocodeDaTargaOE2({ plate: parsed.plate, oeCode: parsed.oeCode });
    const selectedItem = chooseBestGlassItem(glassCatalog.items, parsed.requestedPartText);
    const options = buildGlassOptions(glassCatalog.items, parsed.requestedPartText);
    if (selectedItem && options.length <= 1) {
      parsed.oeCode = selectedItem.oe_code || parsed.oeCode;
      whatsappText = buildGlassReplyText(selectedItem, glassCatalog.items.length);
      status = 'oe_trovato';
    } else if (options.length > 1) {
      whatsappText = buildGlassOptionsReplyText(options, glassCatalog.items.length);
      status = 'in_attesa_verifica_tecnica';
    } else {
      whatsappText = whatsappText || 'Ho identificato una richiesta cristalli, ma dalla sola targa non emerge un risultato univoco. Indicami meglio quale vetro o allega una foto del ricambio.';
      status = 'in_attesa_verifica_tecnica';
    }
  } else if (!parsed.plate) {
    whatsappText = whatsappText || 'Per usare i servizi attivi oggi ho bisogno almeno della targa. Inviami targa e tipo di cristallo/ricambio richiesto.';
    status = 'in_attesa_dati_cliente';
  } else if (normalizedPart.category !== 'cristalli') {
    whatsappText = whatsappText || 'Ho raccolto i dati essenziali della richiesta. La inoltro per verifica tecnica e preparazione ricambio.';
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
      instruction: 'Triage AI e scelta del servizio RTWS piu utile con minimizzazione dei falsi positivi.',
      availableSources: ['OPENAI', 'RTWS_LISTINI', 'RTWS_BDRT'],
      parsed,
      normalizedPart,
      intakeSlots: finalSlots,
      intakeDecision: { ready: true, stage: glassEligible ? 'ready_for_service' : 'ready_for_ai' },
      extraction: {
        plate_source: ai.plate ? 'openai' : (fallbackPlate ? 'regex' : (previousContext.plate || previousIntakeState.slots?.plate ? 'context' : 'missing')),
        vin_source: ai.vin ? 'openai' : (fallbackVin ? 'regex' : (previousContext.vin || previousIntakeState.slots?.vin ? 'context' : 'missing')),
        oe_source: ai.oe_code ? 'openai' : (fallbackOeCode ? 'regex' : (previousContext.oe_code || previousIntakeState.slots?.oe_code ? 'context' : 'missing'))
      },
      conversationContext: previousContext ? {
        plate: s(previousContext.plate) || null,
        vin: s(previousContext.vin) || null,
        oe_code: s(previousContext.oe_code) || null,
        requested_part_text: s(previousContext.requested_part_text) || null,
        normalized_part_name: s(previousContext.normalized_part_name) || null,
        normalized_part_category: s(previousContext.normalized_part_category) || null
      } : null,
      openai: {
        skipped: !!aiResult.skipped,
        error: aiResult.error || null,
        model: aiResult.meta?.model || null,
        statusCode: aiResult.meta?.statusCode || null,
        raw: aiResult.meta?.content || aiResult.meta?.raw || aiResult.raw || null,
        parsed: aiResult.data || aiResult.meta?.parsed || null
      }
    },
    aiSummary: s(ai.ai_summary) || null,
    resolvedStatus: status,
    intakeState: {
      stage: glassEligible && selectedItem && options.length <= 1 && confidentSelection ? 'waiting_quote_pdf_confirmation' : (glassEligible ? 'ready_for_service' : 'ready_for_ai'),
      pendingSlot: glassEligible && selectedItem && options.length <= 1 && confidentSelection ? 'quote_pdf_confirmation' : null,
      pendingQuestion: glassEligible && selectedItem && options.length <= 1 && confidentSelection ? 'Vuoi che ti prepari subito un preventivo PDF? Rispondi SI oppure NO.' : null,
      slots: {
        ...finalSlots,
        oe_code: glassEligible && selectedItem && confidentSelection ? (selectedItem.oe_code || finalSlots.oe_code || '') : (finalSlots.oe_code || ''),
        selected_glass_option: glassEligible && selectedItem && options.length <= 1 && confidentSelection ? selectedItem : null,
        proposed_glass_options: options || []
      }
    }
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

  if (resolved?.intakeState) {
    saveIntakeState(partsRequestId, resolved.intakeState);
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
    intake_state: getIntakeState(id),
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

function buildConversationUserKey(channel, rawUserId) {
  if (channel === 'telegram') return `telegram:${rawUserId}`;
  return String(rawUserId || 'sconosciuto');
}

function extractOutboundMessageId(channel, sendResult) {
  if (channel === 'telegram') return s(sendResult?.body?.result?.message_id);
  return s(sendResult?.body?.messages?.[0]?.id);
}

function extractDocumentMediaRef(channel, sendResult) {
  if (channel === 'telegram') return s(sendResult?.body?.result?.document?.file_id);
  return s(sendResult?.mediaId);
}

function buildPublicPdfLinkMessage(quote, publicPdfUrl) {
  return [
    `Preventivo ${quote?.codicePreventivo || ''}`.trim(),
    publicPdfUrl ? `Link PDF: ${publicPdfUrl}` : null
  ].filter(Boolean).join('\n');
}

function enqueueInboundPartsMessage(payload) {
  const run = async () => processInboundPartsMessage(payload);
  const next = partsInboundProcessingQueue.then(run, run);
  partsInboundProcessingQueue = next.catch((error) => {
    console.error('parts inbound queue error', error);
  });
  return next;
}

async function processInboundPartsMessage({
  channel,
  userKey,
  outboundTarget,
  bodyText,
  externalMessageId,
  messageType = 'text',
  mediaUrl = null,
  mediaMimeType = null,
  mediaMetadata = null,
  rawPayload = null,
  sendText,
  sendDocument
}) {
  let partsRequestId = null;
  try {
    closeStalePartsRequestsForPhone(userKey);
    const activeRequest = getActivePartsRequestForPhone(userKey);
    if (activeRequest) {
      partsRequestId = activeRequest.id;
      db.prepare(`
        UPDATE parts_requests
        SET external_message_id = COALESCE(?, external_message_id),
            updated_at = datetime('now'),
            last_message_at = datetime('now')
        WHERE id = ?
      `).run(externalMessageId, partsRequestId);
    } else {
      const requestInsert = db.prepare(`
        INSERT INTO parts_requests (
          request_uuid, channel, external_message_id, user_phone, original_message,
          requested_part_text, status, source_system, last_message_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'nuova', ?, datetime('now'))
      `).run(
        makeUuid(),
        channel,
        externalMessageId,
        userKey,
        bodyText || '[messaggio senza testo]',
        bodyText || null,
        `${channel}_webhook`
      );
      partsRequestId = Number(requestInsert.lastInsertRowid);
    }

    const conversation = ensureConversationByPhone(userKey, partsRequestId, null);

    db.prepare(`
      INSERT INTO whatsapp_messages (
        conversation_id, direction, channel, external_message_id, message_type,
        body_text, media_url, media_mime_type, media_metadata_json, delivery_status,
        source_system, raw_payload_json
      )
      VALUES (?, 'inbound', ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
    `).run(
      conversation.id,
      channel,
      externalMessageId,
      messageType,
      bodyText,
      mediaUrl,
      mediaMimeType,
      mediaMetadata ? JSON.stringify(mediaMetadata) : null,
      `${channel}_webhook`,
      rawPayload ? JSON.stringify(rawPayload) : null
    );

    db.prepare(`
      UPDATE parts_requests
      SET updated_at = datetime('now'), last_message_at = datetime('now')
      WHERE id = ?
    `).run(partsRequestId);

    upsertConversationState(conversation.id);
    logPartEvent(partsRequestId, 'richiesta_ricevuta', `Richiesta ricevuta da webhook ${channel}`, `${channel}_webhook`, { userKey, externalMessageId });
    const conversationContext = getLatestConversationContext(userKey, partsRequestId);
    const intakeState = getIntakeState(partsRequestId);

    const resolved = await resolvePartsMessageV2({
      message: bodyText,
      channel,
      context: conversationContext,
      intakeState
    });

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
      } else if (resolved.glassCatalog?.status === 'EMPTY') {
        logPartEvent(partsRequestId, 'rtws_listini_empty', resolved.glassCatalog.message || 'RTWS_LISTINI senza risultati', 'rtws_listini', {
          items: resolved.glassCatalog.items?.slice(0, 20) || [],
          stateCode: resolved.glassCatalog.stateCode || '',
          rawXml: resolved.glassCatalog.rawXml || ''
        });
      } else if (resolved.glassCatalog?.status === 'ERROR') {
        logPartEvent(partsRequestId, 'errore_integrazione', resolved.glassCatalog.message || 'Errore RTWS_LISTINI', 'rtws_listini', resolved.glassCatalog);
      }

      if (resolved.whatsappText) {
        const outboundResult = await sendText(outboundTarget, resolved.whatsappText);
        db.prepare(`
          INSERT INTO whatsapp_messages (
            conversation_id, direction, channel, external_message_id, message_type,
            body_text, delivery_status, error_message, source_system, raw_payload_json
          )
          VALUES (?, 'outbound', ?, ?, 'text', ?, ?, ?, 'openai_auto_reply', ?)
        `).run(
          conversation.id,
          channel,
          extractOutboundMessageId(channel, outboundResult),
          resolved.whatsappText,
          outboundResult.error ? 'error' : (outboundResult.statusCode >= 200 && outboundResult.statusCode < 300 ? 'sent' : 'error'),
          outboundResult.error || s(outboundResult.body?.error?.message) || s(outboundResult.body?.description),
          JSON.stringify(outboundResult)
        );
        upsertConversationState(conversation.id);
        logPartEvent(
          partsRequestId,
          outboundResult.error ? 'errore_integrazione' : `messaggio_${channel}_inviato`,
          outboundResult.error ? `Invio ${channel} fallito: ${outboundResult.error}` : `Risposta automatica ${channel} inviata`,
          channel,
          outboundResult
        );
      }

      if (resolved.quoteDecision === 'create_pdf') {
        try {
          const artifacts = await createQuoteArtifactsFromRequestId(partsRequestId);
          const documentSend = await sendDocument(
            outboundTarget,
            artifacts.pdf.buffer,
            artifacts.pdf.filename,
            buildQuotePdfCaption(artifacts.quote)
          );
          db.prepare(`
            INSERT INTO whatsapp_messages (
              conversation_id, direction, channel, external_message_id, message_type,
              body_text, media_url, media_mime_type, media_metadata_json, delivery_status,
              error_message, source_system, raw_payload_json
            )
            VALUES (?, 'outbound', ?, ?, 'document', ?, ?, ?, ?, ?, ?, 'openai_auto_reply', ?)
          `).run(
            conversation.id,
            channel,
            extractOutboundMessageId(channel, documentSend),
            `Preventivo ${artifacts.quote.codicePreventivo}`,
            extractDocumentMediaRef(channel, documentSend),
            'application/pdf',
            JSON.stringify({
              filename: artifacts.pdf.filename,
              preventivoId: artifacts.quote.preventivoId,
              codicePreventivo: artifacts.quote.codicePreventivo
            }),
            documentSend.error ? 'error' : (documentSend.statusCode >= 200 && documentSend.statusCode < 300 ? 'sent' : 'error'),
            documentSend.error || s(documentSend.body?.error?.message) || s(documentSend.body?.description),
            JSON.stringify(documentSend)
          );
          upsertConversationState(conversation.id);
          logPartEvent(
            partsRequestId,
            documentSend.error ? 'errore_integrazione' : 'preventivo_pdf_inviato',
            documentSend.error ? `Invio PDF ${channel} fallito: ${documentSend.error}` : `Preventivo PDF inviato automaticamente su ${channel}`,
            channel,
            {
              ...documentSend,
              preventivoId: artifacts.quote.preventivoId,
              codicePreventivo: artifacts.quote.codicePreventivo,
              productId: artifacts.quotedProduct.product.id
            }
          );

          const publicLinkText = buildPublicPdfLinkMessage(artifacts.quote, artifacts.publicPdfUrl);
          const linkSend = await sendText(outboundTarget, publicLinkText);
          db.prepare(`
            INSERT INTO whatsapp_messages (
              conversation_id, direction, channel, external_message_id, message_type,
              body_text, delivery_status, error_message, source_system, raw_payload_json
            )
            VALUES (?, 'outbound', ?, ?, 'text', ?, ?, ?, 'openai_auto_reply', ?)
          `).run(
            conversation.id,
            channel,
            extractOutboundMessageId(channel, linkSend),
            publicLinkText,
            linkSend.error ? 'error' : (linkSend.statusCode >= 200 && linkSend.statusCode < 300 ? 'sent' : 'error'),
            linkSend.error || s(linkSend.body?.error?.message) || s(linkSend.body?.description),
            JSON.stringify(linkSend)
          );
          upsertConversationState(conversation.id);
          logPartEvent(
            partsRequestId,
            linkSend.error ? 'errore_integrazione' : 'link_preventivo_inviato',
            linkSend.error ? `Invio link preventivo ${channel} fallito: ${linkSend.error}` : `Link pubblico preventivo inviato su ${channel}`,
            channel,
            {
              ...linkSend,
              publicPdfUrl: artifacts.publicPdfUrl,
              preventivoId: artifacts.quote.preventivoId,
              codicePreventivo: artifacts.quote.codicePreventivo
            }
          );
        } catch (error) {
          logPartEvent(partsRequestId, 'errore_integrazione', `Creazione/invio preventivo PDF fallito: ${error.message}`, 'crm', {
            quoteDecision: resolved.quoteDecision,
            channel
          });
        }
      }
    }

    const backendResult = await forwardToPartsBackend({
      originalMessage: bodyText,
      phone: userKey,
      externalMessageId,
      channel,
      requestUuid: db.prepare('SELECT request_uuid FROM parts_requests WHERE id = ?').get(partsRequestId)?.request_uuid || null,
      parsed: resolved?.parsed || null,
      normalizedPart: resolved?.normalizedPart || null,
      missingData: resolved?.missingData || [],
      aiSummary: resolved?.aiSummary || null,
      resolvedStatus: resolved?.resolvedStatus || null,
      whatsappReplyText: resolved?.whatsappText || null,
      suggestedService: resolved?.aiRequest?.suggested_service || null,
      rtws: {
        status: resolved?.glassCatalog?.status || null,
        message: resolved?.glassCatalog?.message || null,
        stateCode: resolved?.glassCatalog?.stateCode || null,
        results: Array.isArray(resolved?.oeResults) ? resolved.oeResults.slice(0, 20) : []
      }
    });
    if (!backendResult.skipped && !backendResult.error && backendResult.statusCode >= 200 && backendResult.statusCode < 300) {
      logPartEvent(partsRequestId, 'backend_sync', 'Richiesta inoltrata al backend ricambi', 'parts_backend', backendResult.body || { statusCode: backendResult.statusCode });
    } else if (backendResult.error) {
      logPartEvent(partsRequestId, 'errore_integrazione', backendResult.error, 'parts_backend', backendResult);
    }

  } catch (error) {
    if (partsRequestId) {
      try {
        db.prepare(`
          UPDATE parts_requests
          SET status = 'errore_integrazione',
              updated_at = datetime('now')
          WHERE id = ?
        `).run(partsRequestId);
        logPartEvent(
          partsRequestId,
          'errore_integrazione',
          `Eccezione processing webhook ${channel}: ${error.message}`,
          'parts_webhook',
          {
            channel,
            userKey,
            externalMessageId,
            stack: error.stack || null
          }
        );
      } catch (loggingError) {
        console.error('parts inbound webhook logging error', loggingError);
      }
    }
    console.error('parts inbound webhook error', error);
    throw error;
  }
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
  res.json({ ok: true });

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value || {};
      const messages = Array.isArray(value?.messages) ? value.messages : [];
      for (const message of messages) {
        const phone = s(message?.from) || s(value?.contacts?.[0]?.wa_id) || 'sconosciuto';
        const bodyText = s(message?.text?.body) || s(message?.button?.text) || s(message?.interactive?.button_reply?.title) || '';
        const externalMessageId = s(message?.id);
        enqueueInboundPartsMessage({
          channel: 'whatsapp',
          userKey: buildConversationUserKey('whatsapp', phone),
          outboundTarget: phone,
          bodyText,
          externalMessageId,
          messageType: s(message?.type) || 'text',
          mediaUrl: s(message?.image?.id) || s(message?.document?.id) || s(message?.audio?.id) || null,
          mediaMimeType: s(message?.image?.mime_type) || s(message?.document?.mime_type) || s(message?.audio?.mime_type) || null,
          mediaMetadata: message,
          rawPayload: { entry, change, value, message },
          sendText: sendWhatsAppText,
          sendDocument: sendWhatsAppDocumentBuffer
        }).catch((error) => {
          console.error('parts whatsapp async processing error', error);
        });
      }
    }
  }
});

router.post('/webhook/telegram', async (req, res) => {
  const secretHeader = s(req.headers['x-telegram-bot-api-secret-token']);
  const expectedSecret = s(process.env.TELEGRAM_WEBHOOK_SECRET);
  if (expectedSecret && secretHeader !== expectedSecret) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const update = req.body || {};
  const message = update.message || update.edited_message || update.callback_query?.message || null;
  const callbackData = s(update.callback_query?.data);
  const chatId = s(message?.chat?.id);
  const bodyText = s(message?.text) || s(message?.caption) || callbackData || '';
  const externalMessageId = s(message?.message_id) || s(update.update_id) || s(update.callback_query?.id);

  if (!chatId) return res.json({ ok: true, skipped: 'chat_missing' });
  res.json({ ok: true });

  enqueueInboundPartsMessage({
    channel: 'telegram',
    userKey: buildConversationUserKey('telegram', chatId),
    outboundTarget: chatId,
    bodyText,
    externalMessageId,
    messageType: callbackData ? 'callback' : (message?.photo ? 'photo' : (message?.document ? 'document' : (message?.text ? 'text' : 'telegram_message'))),
    mediaUrl: s(message?.document?.file_id) || s(message?.photo?.[message.photo.length - 1]?.file_id) || null,
    mediaMimeType: s(message?.document?.mime_type) || (message?.photo ? 'image/jpeg' : null),
    mediaMetadata: message || update.callback_query || update,
    rawPayload: update,
    sendText: sendTelegramText,
    sendDocument: sendTelegramDocumentBuffer
  }).catch((error) => {
    console.error('parts telegram async processing error', error);
  });
});

router.use(authMiddleware);

router.post('/parts/resolve', requirePermesso('ricambi', 'read'), async (req, res) => {
  const resolved = await resolvePartsMessageV2({
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

router.post('/parts/requests/:id/create-quote', requirePermesso('ricambi', 'edit'), async (req, res) => {
  const requestId = Number(req.params.id);
  db.exec('BEGIN');
  try {
    const { quotedProduct, quote } = await createQuoteArtifactsFromRequestId(requestId);
    db.exec('COMMIT');
    res.json({
      ok: true,
      product_id: quotedProduct.product.id,
      preventivo_id: quote.preventivoId,
      codice_preventivo: quote.codicePreventivo,
      pdf_url: `/api/preventivi/${quote.preventivoId}/pdf`
    });
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    res.status(400).json({ error: error.message });
  }
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
