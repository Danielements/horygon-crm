const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const { createPreventivoPdfBuffer } = require('../services/document-pdf');
const { createNotificationsForUserIds } = require('../services/google');

const router = express.Router();

const PARTS_OPEN_STATUSES = ['nuova', 'in_lavorazione', 'in_attesa_dati_cliente', 'in_attesa_verifica_tecnica', 'oe_trovato', 'preventivo_pronto'];
const rtwsSessions = new Map();
let partsInboundProcessingQueue = Promise.resolve();
let partsAttentionWatchdogStarted = false;

function s(value) {
  return value === undefined || value === null || value === '' ? null : String(value).trim();
}

function buildInboundMessagePlaceholder(messageType = 'text', mediaUrl = null) {
  const normalizedType = String(messageType || '').toLowerCase();
  if (normalizedType === 'image' || normalizedType === 'photo') return '[foto ricevuta]';
  if (normalizedType === 'document') return '[documento ricevuto]';
  if (normalizedType === 'audio' || normalizedType === 'voice') return '[audio ricevuto]';
  if (mediaUrl) return '[allegato ricevuto]';
  return '[messaggio senza testo]';
}

function isSyntheticInboundPlaceholder(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return [
    '[foto ricevuta]',
    '[documento ricevuto]',
    '[audio ricevuto]',
    '[allegato ricevuto]',
    '[messaggio senza testo]',
    'foto ricevuta',
    'documento ricevuto',
    'audio ricevuto',
    'allegato ricevuto',
    'messaggio senza testo'
  ].includes(normalized);
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
  const parsed = parseInt(process.env.PARTS_ACTIVE_REQUEST_WINDOW_MINUTES || '30', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
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

function sanitizeOeCode(value, plate = '') {
  const normalized = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const normalizedPlate = normalizePlate(plate);
  if (!normalized) return '';
  if (normalized === normalizedPlate) return '';
  if (/^[A-Z]{2}\d{3}[A-Z]{2}$/.test(normalized)) return '';
  if (/^[A-Z]{2}\d{4}[A-Z]$/.test(normalized)) return '';
  if (/^[A-Z]\d{5}[A-Z]$/.test(normalized)) return '';
  return normalized;
}

function enrichMediaAnalysisData(data = {}) {
  if (!data || typeof data !== 'object') return data;
  const visibleText = s(data.visible_text) || '';
  const summary = s(data.summary) || '';
  const requestedPartText = s(data.requested_part_text) || '';
  const normalizedPartName = s(data.normalized_part_name) || '';
  const extractionText = [visibleText, summary, requestedPartText, normalizedPartName].filter(Boolean).join(' ');
  const derivedPartText = deriveExplicitPartRequest(extractionText, s(data.plate), s(data.vin), s(data.oe_code));
  const safeDerivedPartText = shouldOverridePartSelection(derivedPartText)
    && normalizePartCategory('', derivedPartText) !== 'ricambio_generico'
    ? derivedPartText
    : '';

  const plate = normalizePlate(s(data.plate) || extractPlateFromText(extractionText) || '');
  const vin = s(data.vin) || extractVinFromText(extractionText) || '';
  const oeCode = sanitizeOeCode(s(data.oe_code) || extractOeCodeFromText(extractionText) || '', plate);
  const normalizedPartCategory = normalizePartCategory(
    s(data.normalized_part_category),
    `${requestedPartText} ${normalizedPartName} ${visibleText}`.trim()
  );

  return {
    ...data,
    plate,
    vin,
    oe_code: oeCode,
    normalized_part_category: normalizedPartCategory,
    requested_part_text: deriveExplicitPartRequest(requestedPartText, plate, vin, oeCode) || safeDerivedPartText,
    normalized_part_name: shouldOverridePartSelection(normalizedPartName)
      ? normalizedPartName
      : (deriveExplicitPartRequest(requestedPartText, plate, vin, oeCode) || safeDerivedPartText)
  };
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

function hasExplicitPlateLabel(value = '') {
  return /\b(targa|plate|license plate)\b/i.test(String(value || ''));
}

function hasExplicitOeLabel(value = '') {
  return /\b(codice\s*oe|oe\b|oem\b|originale)\b/i.test(String(value || ''));
}

function extractStandaloneMixedCodeCandidate(value = '') {
  const compact = String(value || '').toUpperCase();
  const tokens = [...compact.matchAll(/\b([A-Z0-9]{6,18})\b/g)]
    .map((match) => match[1])
    .filter((token) => /\d/.test(token) && /[A-Z]/.test(token));
  if (tokens.length !== 1) return '';
  return tokens[0];
}

function detectAmbiguousCodeTypeAnswer(value = '') {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (/\b(targa|plate)\b/.test(text)) return 'plate';
  if (/\b(codice\s*oe|oe\b|oem\b|originale)\b/.test(text)) return 'oe_code';
  return '';
}

function detectAmbiguousIdentifierCandidate({
  text = '',
  plate = '',
  vin = '',
  oeCode = '',
  partName = ''
} = {}) {
  if (plate || vin || oeCode) return '';
  if (hasExplicitPlateLabel(text) || hasExplicitOeLabel(text)) return '';
  if (partName) return '';
  const candidate = extractStandaloneMixedCodeCandidate(text);
  if (!candidate) return '';
  if (/^[A-HJ-NPR-Z0-9]{17}$/.test(candidate)) return '';
  return candidate;
}

function shouldConfirmUnlabeledPlateCandidate({
  text = '',
  plate = '',
  vin = '',
  oeCode = '',
  partName = ''
} = {}) {
  if (!plate || vin || oeCode) return false;
  if (!shouldOverridePartSelection(partName)) return false;
  if (hasExplicitPlateLabel(text) || hasExplicitOeLabel(text)) return false;
  const candidate = extractStandaloneMixedCodeCandidate(text);
  if (!candidate) return false;
  return normalizePlate(candidate) === normalizePlate(plate);
}

function deriveRequestedPartText(value, plate = '', vin = '', oeCode = '') {
  if (isSyntheticInboundPlaceholder(value)) return '';
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

function deriveExplicitPartRequest(value, plate = '', vin = '', oeCode = '') {
  const derived = s(deriveRequestedPartText(value, plate, vin, oeCode)) || '';
  if (!shouldOverridePartSelection(derived)) return '';
  if (isGenericVehicleDocumentLabel(derived)) return '';
  if (normalizePartCategory('', derived) === 'ricambio_generico' && derived.split(/\s+/).length > 6) return '';
  return derived;
}

function tokenizePartSpecificity(value = '') {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9Ã Ã¨Ã©Ã¬Ã²Ã¹]+/i)
    .filter((token) => token.length >= 3);
}

function scorePartCandidate(name = '', category = '', { preferDeterministic = false } = {}) {
  if (!shouldOverridePartSelection(name)) return -1;
  const normalizedName = s(name) || '';
  const normalizedCategory = normalizePartCategory(category, normalizedName);
  const tokens = tokenizePartSpecificity(normalizedName);
  let score = Math.min(normalizedName.length, 40) + (tokens.length * 6);

  if (normalizedCategory && normalizedCategory !== 'ricambio_generico') score += 30;
  if (detectGlassPosition(normalizedName)) score += 10;
  if (detectBrakeComponent(normalizedName)) score += 8;
  if (detectFilterType(normalizedName)) score += 8;
  if (detectSide(normalizedName)) score += 4;
  if (detectAxle(normalizedName)) score += 4;
  if (preferDeterministic) score += 15;

  return score;
}

function choosePreferredPartCandidate(candidates = []) {
  const ranked = candidates
    .map((candidate) => {
      const name = s(candidate?.name) || '';
      if (!name) return null;
      const category = normalizePartCategory(candidate?.category, name);
      const score = scorePartCandidate(name, category, {
        preferDeterministic: !!candidate?.preferDeterministic
      });
      if (score < 0) return null;
      return {
        ...candidate,
        name,
        category,
        score
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.name.length - a.name.length);

  return ranked[0] || {
    name: '',
    category: '',
    score: -1,
    source: ''
  };
}

function isGenericVehicleDocumentLabel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return true;
  return [
    '[evidenza immagine]',
    'foto ricevuta',
    'documento ricevuto',
    'audio ricevuto',
    'allegato ricevuto',
    'messaggio senza testo',
    'evidenza immagine',
    'libretto',
    'carta di circolazione',
    'documento',
    'documento di registrazione',
    'documento veicolo',
    'veicolo',
    'auto',
    'automobile',
    'ricambio',
    'pezzo'
  ].includes(normalized);
}

function isOperationalFeedbackMessage(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  return [
    'non ci siamo',
    'non sta funzionando',
    'non funziona',
    'non va',
    'non va bene',
    'aiuto',
    'help',
    'ok',
    'va bene',
    'grazie',
    'no',
    'si',
    'sì'
  ].includes(normalized);
}

function hasVehicleDocumentTextHints(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  if (/(libretto|carta di circolazione|documento di circolazione|vehicle registration|registration document|numero di telaio|telaio|immatricolazione|targa|plate|vin|circulation)/.test(normalized)) return true;
  if (/\b(cognome|nome|residenza|indirizzo|massa|cilindrata|potenza|kw|cv|uso proprio|alimentazione|fabbrica|tipo|variante|versione)\b/.test(normalized)) return true;
  if (/\b[a-e]\b/.test(normalized) && /(targa|telaio|vin|immatricolazione|plate)/.test(normalized)) return true;
  const fieldMatches = normalized.match(/\b(immatricolazione|cilindrata|potenza|massa|alimentazione|telaio|vin|targa)\b/g) || [];
  return fieldMatches.length >= 2;
}

function isVehicleDocumentMediaKind(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return /(libretto|carta di circolazione|documento|document|registration|vehicle registration|registration document|circulation)/.test(normalized)
    || hasVehicleDocumentTextHints(normalized);
}

function isLikelyVehicleDocumentAnalysis(mediaAi = null) {
  if (!mediaAi) return false;
  const signals = [
    mediaAi?.media_kind,
    mediaAi?.detected_subject,
    mediaAi?.summary,
    mediaAi?.visible_text
  ].filter(Boolean).join(' ').toLowerCase();
  const plate = s(mediaAi?.plate) || '';
  const vin = s(mediaAi?.vin) || '';
  const hasVehicleIds = !!(plate || vin);
  const hasBothVehicleIds = !!plate && !!vin;
  const hasDocumentKeywords = hasVehicleDocumentTextHints(signals);
  return hasDocumentKeywords
    || isVehicleDocumentMediaKind(signals)
    || hasBothVehicleIds
    || (hasVehicleIds && !s(mediaAi?.requested_part_text) && !s(mediaAi?.normalized_part_name));
}

function shouldRetryVehicleDocumentOcr(mediaAi = null) {
  if (!mediaAi) return false;
  if (s(mediaAi?.plate) || s(mediaAi?.vin)) return false;
  if (s(mediaAi?.oe_code)) return false;
  const signals = [
    mediaAi?.media_kind,
    mediaAi?.summary,
    mediaAi?.visible_text
  ].filter(Boolean).join(' ').toLowerCase();
  const visibleText = String(mediaAi?.visible_text || '').replace(/\s+/g, ' ').trim();
  const hasDocumentKeywords = hasVehicleDocumentTextHints(signals);
  const textHeavyImage = visibleText.length >= 20;
  return hasDocumentKeywords || textHeavyImage;
}

function classifyInboundCase({ text = '', mediaAi = null }) {
  const hasExplicitText = !!(String(text || '').trim() && !isSyntheticInboundPlaceholder(text));
  const mediaKind = String(mediaAi?.media_kind || mediaAi?.detected_subject || '').trim().toLowerCase();
  const hasMedia = !!mediaAi;
  const isVehicleDocument = hasMedia && (isVehicleDocumentMediaKind(mediaKind) || isLikelyVehicleDocumentAnalysis(mediaAi));
  const hasMediaPartGuess = !!(s(mediaAi?.normalized_part_name) || s(mediaAi?.requested_part_text));
  const hasMediaOe = !!s(mediaAi?.oe_code);

  if (isVehicleDocument && hasExplicitText) return 'document_image_plus_text';
  if (isVehicleDocument) return 'document_image_only';
  if (hasMedia && hasExplicitText) return 'image_plus_text';
  if (hasMedia && (hasMediaPartGuess || hasMediaOe)) return 'part_image_only';
  if (hasMedia) return 'generic_image_only';
  if (hasExplicitText) return 'text_only';
  return 'empty';
}

function detectSessionKeywordIntent(text = '') {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) return '';
  if (/^(info|informazioni|aiuto|help)$/.test(normalized)) return 'info';
  if (/^(chiudi richiesta|chiudi sessione|fine|annulla|termina)$/.test(normalized)) return 'close';
  if (/^(nuova richiesta|nuovo ricambio|nuovo pezzo)$/.test(normalized)) return 'new_request';
  if (/^(aggiungi pezzo|aggiungi ricambio|altro pezzo|altro ricambio|aggiungi)$/.test(normalized)) return 'add_part';
  if (/^(sostituisci|cambia pezzo|cambia ricambio)$/.test(normalized)) return 'replace_part';
  if (/^(continua richiesta|continua|riprendi)$/.test(normalized)) return 'continue';
  return '';
}

function detectAssistantWakeIntent(text = '') {
  const normalized = String(text || '').trim().toLowerCase().replace(/[!?.,:;]+$/g, '');
  if (!normalized) return '';
  if (/^(vera|ciao vera|hey vera|ehi vera|ok vera|pronto vera)$/.test(normalized)) return 'wake';
  return '';
}

function buildAssistantWakeReplyText() {
  return [
    'Ciao, sono Vera, l assistente ricambi di Horygon.',
    'Per iniziare puoi inviarmi:',
    '1. Targa o VIN',
    '2. Foto libretto',
    '3. Foto pezzo o etichetta',
    '4. Codice OE',
    '5. Testo libero con il ricambio',
    'Esempio: FP781GE parabrezza anteriore.'
  ].join('\n');
}

function buildInfoKeywordReplyText() {
  return [
    'Per trovare il ricambio piu in fretta, usa uno di questi 6 formati:',
    '1. Targa o VIN + codice OE',
    '2. Targa o VIN + nome ricambio',
    '3. Foto etichetta/codice + targa o VIN',
    '4. Foto libretto + testo ricambio',
    '5. Foto pezzo + testo descrittivo',
    '6. Solo foto del pezzo o solo testo libero',
    'Esempio: FP781GE filtro olio oppure foto libretto + "parabrezza anteriore".'
  ].join('\n');
}

function detectGuidedIntakeChoice(text = '') {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) return '';
  if (/^\/start(?:@\w+)?$/.test(normalized) || /^\/help(?:@\w+)?$/.test(normalized) || detectAssistantWakeIntent(normalized)) return 'root_menu';
  if (/^(targa o vin|targa\/vin|targa vin|vin o targa)$/.test(normalized)) return 'vehicle_key';
  if (/^(foto libretto|libretto|foto documento|documento veicolo)$/.test(normalized)) return 'vehicle_document_photo';
  if (/^(foto pezzo|foto ricambio|foto etichetta|foto codice)$/.test(normalized)) return 'part_photo';
  if (/^(codice oe|oe|codice oem|codice ricambio)$/.test(normalized)) return 'oe_code';
  if (/^(testo libero|scrivo io|testo|messaggio libero)$/.test(normalized)) return 'free_text_request';
  return '';
}

function buildTelegramReplyKeyboard(rows = [], inputPlaceholder = '', options = {}) {
  const includeCloseSession = options?.includeCloseSession !== false;
  const normalizedRows = rows
    .map((row) => Array.isArray(row) ? row.map((label) => String(label || '').trim()).filter(Boolean) : [])
    .filter((row) => row.length);
  const hasCloseSessionButton = normalizedRows.some((row) => row.some((label) => /^chiudi sessione$/i.test(label)));
  if (includeCloseSession && !hasCloseSessionButton) {
    normalizedRows.push(['Chiudi sessione']);
  }
  const keyboard = normalizedRows
    .map((row) => row.map((label) => ({ text: label })))
    .filter((row) => row.length);
  if (!keyboard.length) return null;
  const replyMarkup = {
    keyboard,
    resize_keyboard: true,
    one_time_keyboard: false
  };
  if (inputPlaceholder) replyMarkup.input_field_placeholder = String(inputPlaceholder).slice(0, 64);
  return { reply_markup: replyMarkup };
}

function truncateMetaText(value, maxLength) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > maxLength ? text.slice(0, Math.max(0, maxLength - 1)).trimEnd() : text;
}

function normalizeWhatsAppInteractiveRow(row, fallbackIndex = 0) {
  if (!row) return null;
  if (typeof row === 'string') {
    const title = truncateMetaText(row, 24);
    if (!title) return null;
    return {
      id: `row_${slugToken(title || fallbackIndex, 'ROW').toLowerCase()}`,
      title
    };
  }
  const title = truncateMetaText(row.title || row.label || row.text || '', 24);
  if (!title) return null;
  return {
    id: truncateMetaText(String(row.id || `row_${slugToken(title || fallbackIndex, 'ROW').toLowerCase()}`), 200),
    title,
    ...(s(row.description) ? { description: truncateMetaText(row.description, 72) } : {})
  };
}

function buildWhatsAppReplyButtonsOptions(buttons = [], extra = {}) {
  const includeCloseSession = extra?.includeCloseSession !== false;
  const normalizedButtons = buttons
    .map((button, index) => {
      if (!button) return null;
      if (typeof button === 'string') {
        const title = truncateMetaText(button, 20);
        if (!title) return null;
        return {
          type: 'reply',
          reply: {
            id: `btn_${slugToken(title || index, 'BTN').toLowerCase()}`,
            title
          }
        };
      }
      const title = truncateMetaText(button.title || button.label || button.text || '', 20);
      if (!title) return null;
      return {
        type: 'reply',
        reply: {
          id: truncateMetaText(String(button.id || `btn_${slugToken(title || index, 'BTN').toLowerCase()}`), 256),
          title
        }
      };
    })
    .filter(Boolean);
  const hasCloseButton = normalizedButtons.some((button) => /^chiudi sessione$/i.test(s(button?.reply?.title) || ''));
  if (includeCloseSession && !hasCloseButton && normalizedButtons.length < 3) {
    normalizedButtons.push({
      type: 'reply',
      reply: {
        id: 'btn_chiudi_sessione',
        title: 'Chiudi sessione'
      }
    });
  }
  if (!normalizedButtons.length) return null;
  return {
    whatsappInteractive: {
      type: 'button',
      headerText: truncateMetaText(extra.headerText || '', 60),
      footerText: truncateMetaText(extra.footerText || '', 60),
      buttons: normalizedButtons.slice(0, 3)
    }
  };
}

function buildWhatsAppListOptions(rows = [], extra = {}) {
  const includeCloseSession = extra?.includeCloseSession !== false;
  const normalizedRows = rows
    .map((row, index) => normalizeWhatsAppInteractiveRow(row, index + 1))
    .filter(Boolean);
  const hasCloseRow = normalizedRows.some((row) => /^chiudi sessione$/i.test(s(row?.title) || ''));
  if (includeCloseSession && !hasCloseRow) {
    normalizedRows.push({
      id: 'row_chiudi_sessione',
      title: 'Chiudi sessione'
    });
  }
  if (!normalizedRows.length) return null;
  return {
    whatsappInteractive: {
      type: 'list',
      headerText: truncateMetaText(extra.headerText || '', 60),
      footerText: truncateMetaText(extra.footerText || '', 60),
      buttonText: truncateMetaText(extra.buttonText || 'Apri menu', 20) || 'Apri menu',
      sections: [
        {
          title: truncateMetaText(extra.sectionTitle || 'Scelte', 24) || 'Scelte',
          rows: normalizedRows.slice(0, 10)
        }
      ]
    }
  };
}

function buildWhatsAppRootMenuOptions(extra = {}) {
  return buildWhatsAppListOptions([
    { id: 'vehicle_key', title: 'Targa o VIN', description: 'Scrivi targa o VIN del veicolo' },
    { id: 'vehicle_document_photo', title: 'Foto libretto', description: 'Invia il documento del veicolo' },
    { id: 'part_photo', title: 'Foto pezzo', description: 'Invia foto pezzo o etichetta' },
    { id: 'oe_code', title: 'Codice OE', description: 'Invia il codice ricambio' },
    { id: 'free_text_request', title: 'Testo libero', description: 'Scrivi la richiesta completa' },
    { id: 'info', title: 'Info', description: 'Vedi come cercare meglio il ricambio' }
  ], {
    headerText: extra.headerText || 'Vera',
    footerText: extra.footerText || 'Horygon Parts',
    buttonText: extra.buttonText || 'Apri menu',
    sectionTitle: extra.sectionTitle || 'Come vuoi iniziare',
    includeCloseSession: extra.includeCloseSession !== false
  });
}

function buildWhatsAppCategoryMenuOptions(extra = {}) {
  return buildWhatsAppListOptions([
    { id: 'categoria_cristalli', title: 'Cristalli', description: 'Parabrezza, lunotto, vetri laterali' },
    { id: 'categoria_filtri', title: 'Filtri', description: 'Olio, aria, abitacolo, carburante' },
    { id: 'categoria_freni', title: 'Freni', description: 'Pastiglie, dischi, pinze' },
    { id: 'categoria_retrovisori', title: 'Retrovisori', description: 'Specchi e calotte' },
    { id: 'categoria_illuminazione', title: 'Illuminazione', description: 'Fari, stop, lampade' },
    { id: 'categoria_altro', title: 'Altro', description: 'Ricambio non ancora classificato' },
    { id: 'info', title: 'Info', description: 'Suggerimenti per cercare il ricambio' }
  ], {
    headerText: extra.headerText || 'Ricambi',
    footerText: extra.footerText || 'Horygon Parts',
    buttonText: extra.buttonText || 'Categorie',
    sectionTitle: extra.sectionTitle || 'Scegli la categoria',
    includeCloseSession: extra.includeCloseSession !== false
  });
}

function buildWhatsAppReplyOptionsForResolved(resolved = {}) {
  const stage = String(resolved?.intakeState?.stage || '').toLowerCase();
  const pendingSlot = String(resolved?.intakeState?.pendingSlot || '').toLowerCase();
  const intent = String(resolved?.aiRequest?.intent || '').toLowerCase();

  if (intent.includes('assistant_wake') || intent.includes('root_menu') || intent.includes('info_keyword') || stage === 'guided_root_menu') {
    return buildWhatsAppRootMenuOptions({
      headerText: 'Vera',
      sectionTitle: 'Come vuoi iniziare',
      buttonText: 'Apri menu',
      includeCloseSession: stage !== 'session_closed'
    });
  }

  if (pendingSlot === 'session_action' || stage.includes('session_action')) {
    return buildWhatsAppReplyButtonsOptions(['SOSTITUISCI', 'AGGIUNGI', 'NO'], {
      headerText: 'Sessione aperta',
      includeCloseSession: false
    });
  }

  if (pendingSlot === 'quote_pdf_confirmation' || stage.includes('quote')) {
    return buildWhatsAppReplyButtonsOptions(['SI', 'NO'], {
      headerText: 'Preventivo PDF',
      footerText: 'Puoi anche chiudere la sessione'
    });
  }

  if (pendingSlot === 'ambiguous_code_type' || stage.includes('ambiguous_code')) {
    return buildWhatsAppListOptions([
      { id: 'ambiguous_plate', title: 'Targa', description: 'Conferma che il codice e la targa' },
      { id: 'ambiguous_oe', title: 'Codice OE', description: 'Conferma che il codice e OE' },
      { id: 'ambiguous_no', title: 'No', description: 'Nessuna delle due opzioni' }
    ], {
      headerText: 'Conferma codice',
      buttonText: 'Scegli',
      sectionTitle: 'Che tipo di codice e?'
    });
  }

  if (pendingSlot === 'glass_position' || stage.includes('glass_position')) {
    return buildWhatsAppListOptions([
      { id: 'glass_parabrezza', title: 'Parabrezza', description: 'Vetro anteriore' },
      { id: 'glass_lunotto', title: 'Lunotto', description: 'Vetro posteriore' },
      { id: 'glass_laterale', title: 'Vetro laterale', description: 'Laterale destro o sinistro' },
      { id: 'glass_raschiavetro', title: 'Raschiavetro', description: 'Guarnizione o raschiavetro' }
    ], {
      headerText: 'Cristalli',
      buttonText: 'Apri elenco',
      sectionTitle: 'Quale cristallo ti serve?'
    });
  }

  if (pendingSlot === 'filter_type' || stage.includes('filter_type')) {
    return buildWhatsAppListOptions([
      { id: 'filter_olio', title: 'Olio', description: 'Filtro olio motore' },
      { id: 'filter_aria', title: 'Aria', description: 'Filtro aria motore' },
      { id: 'filter_abitacolo', title: 'Abitacolo', description: 'Filtro aria abitacolo' },
      { id: 'filter_carburante', title: 'Carburante', description: 'Filtro carburante' }
    ], {
      headerText: 'Filtri',
      buttonText: 'Apri elenco',
      sectionTitle: 'Quale filtro ti serve?'
    });
  }

  if (pendingSlot === 'brake_component' || stage.includes('brake_component')) {
    return buildWhatsAppListOptions([
      { id: 'brake_pastiglie', title: 'Pastiglie', description: 'Pastiglie freno' },
      { id: 'brake_dischi', title: 'Dischi', description: 'Dischi freno' },
      { id: 'brake_pinza', title: 'Pinza', description: 'Pinza freno' },
      { id: 'brake_altro', title: 'Altro', description: 'Altro componente freni' }
    ], {
      headerText: 'Freni',
      buttonText: 'Apri elenco',
      sectionTitle: 'Quale componente ti serve?'
    });
  }

  if (pendingSlot === 'axle' || stage.includes('waiting_axle')) {
    return buildWhatsAppReplyButtonsOptions(['Anteriori', 'Posteriori'], {
      headerText: 'Asse'
    });
  }

  if (pendingSlot === 'side' || stage.includes('waiting_side')) {
    return buildWhatsAppReplyButtonsOptions(['Destro', 'Sinistro'], {
      headerText: 'Lato'
    });
  }

  if (
    pendingSlot === 'vehicle_key'
    || pendingSlot === 'plate'
    || stage.includes('waiting_vehicle_key')
    || stage.includes('waiting_service_key')
    || stage === 'guided_waiting_document_photo'
    || stage === 'guided_waiting_part_photo'
    || stage === 'guided_waiting_oe_code'
    || stage === 'guided_waiting_free_text'
  ) {
    return buildWhatsAppRootMenuOptions({
      headerText: 'Vera',
      sectionTitle: 'Dati utili',
      buttonText: 'Apri menu'
    });
  }

  if (pendingSlot === 'part_name' || stage.includes('waiting_part_name') || stage.includes('document_vehicle_data_completed')) {
    return buildWhatsAppCategoryMenuOptions({
      headerText: 'Ricambi',
      buttonText: 'Apri categorie',
      sectionTitle: 'Che ricambio ti serve?'
    });
  }

  if (stage === 'session_closed') {
    return buildWhatsAppRootMenuOptions({
      headerText: 'Vera',
      sectionTitle: 'Nuova richiesta',
      buttonText: 'Apri menu',
      includeCloseSession: false
    });
  }

  return null;
}

function buildTelegramReplyOptionsForResolved(resolved = {}) {
  const stage = String(resolved?.intakeState?.stage || '').toLowerCase();
  const pendingSlot = String(resolved?.intakeState?.pendingSlot || '').toLowerCase();
  const intent = String(resolved?.aiRequest?.intent || '').toLowerCase();
  const slots = resolved?.intakeState?.slots || {};
  const hasVehicleKey = !!(s(slots.plate) || s(slots.vin) || s(slots.oe_code));

  if (intent.includes('root_menu') || stage === 'guided_root_menu' || intent.includes('info_keyword')) {
    return buildTelegramReplyKeyboard([
      ['Targa o VIN', 'Foto libretto'],
      ['Foto pezzo', 'Codice OE'],
      ['Testo libero', 'Info']
    ], 'Scegli come vuoi iniziare');
  }

  if (pendingSlot === 'session_action' || stage.includes('session_action')) {
    return buildTelegramReplyKeyboard([
      ['SOSTITUISCI', 'AGGIUNGI'],
      ['NO']
    ], 'Scegli come gestire il nuovo ricambio');
  }

  if (pendingSlot === 'quote_pdf_confirmation' || stage.includes('quote')) {
    return buildTelegramReplyKeyboard([
      ['SI', 'NO']
    ], 'Vuoi il preventivo PDF?');
  }

  if (pendingSlot === 'ambiguous_code_type' || stage.includes('ambiguous_code')) {
    return buildTelegramReplyKeyboard([
      ['Targa', 'Codice OE'],
      ['No']
    ], 'Conferma il tipo di codice');
  }

  if (pendingSlot === 'glass_position' || stage.includes('glass_position')) {
    return buildTelegramReplyKeyboard([
      ['Parabrezza', 'Lunotto'],
      ['Vetro laterale', 'Raschiavetro']
    ], 'Scegli il cristallo');
  }

  if (pendingSlot === 'filter_type' || stage.includes('filter_type')) {
    return buildTelegramReplyKeyboard([
      ['Olio', 'Aria'],
      ['Abitacolo', 'Carburante']
    ], 'Scegli il filtro');
  }

  if (pendingSlot === 'brake_component' || stage.includes('brake_component')) {
    return buildTelegramReplyKeyboard([
      ['Pastiglie', 'Dischi'],
      ['Pinza', 'Altro']
    ], 'Scegli il componente freni');
  }

  if (pendingSlot === 'axle' || stage.includes('waiting_axle')) {
    return buildTelegramReplyKeyboard([
      ['Anteriori', 'Posteriori']
    ], 'Scegli l asse');
  }

  if (pendingSlot === 'side' || stage.includes('waiting_side')) {
    return buildTelegramReplyKeyboard([
      ['Destro', 'Sinistro']
    ], 'Scegli il lato');
  }

  if (pendingSlot === 'vehicle_key' || pendingSlot === 'plate' || stage.includes('waiting_vehicle_key') || stage.includes('waiting_service_key')) {
    return buildTelegramReplyKeyboard([
      ['Targa o VIN', 'Foto libretto'],
      ['Foto pezzo', 'Codice OE'],
      ['Testo libero', 'Info']
    ], 'Invia targa, VIN, foto o codice OE');
  }

  if (pendingSlot === 'part_name' || stage.includes('waiting_part_name') || stage.includes('document_vehicle_data_completed') || (hasVehicleKey && !s(slots.part_name))) {
    return buildTelegramReplyKeyboard([
      ['Cristalli', 'Filtri', 'Freni'],
      ['Retrovisori', 'Illuminazione', 'Altro'],
      ['Chiudi sessione', 'Info']
    ], 'Scegli la categoria del ricambio');
  }

  if (stage === 'guided_waiting_document_photo') {
    return buildTelegramReplyKeyboard([
      ['Foto libretto', 'Targa o VIN'],
      ['Info']
    ], 'Invia la foto del libretto');
  }

  if (stage === 'guided_waiting_part_photo') {
    return buildTelegramReplyKeyboard([
      ['Foto pezzo', 'Targa o VIN'],
      ['Codice OE', 'Info']
    ], 'Invia la foto del pezzo');
  }

  if (stage === 'guided_waiting_oe_code') {
    return buildTelegramReplyKeyboard([
      ['Codice OE', 'Targa o VIN'],
      ['Info']
    ], 'Invia il codice OE');
  }

  if (stage === 'guided_waiting_free_text') {
    return buildTelegramReplyKeyboard([
      ['Testo libero', 'Info']
    ], 'Scrivi la richiesta completa');
  }

  if (stage === 'session_closed') {
    return buildTelegramReplyKeyboard([
      ['Targa o VIN', 'Foto libretto'],
      ['Foto pezzo', 'Codice OE'],
      ['Testo libero', 'Info']
    ], 'Inizia una nuova richiesta', { includeCloseSession: false });
  }

  return null;
}

function buildGuidedChoiceResponse({ choice = '', text = '', previousContext = {}, previousIntakeState = { slots: {} }, channel = 'telegram' }) {
  const currentPart = buildCurrentPartSummary(previousIntakeState.slots || {}, previousContext);
  const currentCategory = normalizePartCategory(
    s(previousIntakeState.slots?.part_category) || s(previousContext.normalized_part_category),
    currentPart
  );
  const baseParsed = {
    originalText: text,
    plate: s(previousIntakeState.slots?.plate) || s(previousContext.plate) || '',
    vin: s(previousIntakeState.slots?.vin) || s(previousContext.vin) || '',
    oeCode: s(previousIntakeState.slots?.oe_code) || s(previousContext.oe_code) || '',
    requestedPartText: currentPart,
    confidence: 1
  };
  const baseNormalizedPart = {
    name: currentPart,
    category: currentCategory
  };
  const stageMap = {
    root_menu: { stage: 'guided_root_menu', pendingSlot: null, question: 'Scegli come vuoi iniziare la richiesta: targa o VIN, foto libretto, foto pezzo, codice OE oppure testo libero.' },
    vehicle_key: { stage: 'guided_waiting_vehicle_key', pendingSlot: 'vehicle_key', question: 'Perfetto. Inviami targa o VIN e, se vuoi, anche il ricambio in un solo messaggio.' },
    vehicle_document_photo: { stage: 'guided_waiting_document_photo', pendingSlot: 'vehicle_document_photo', question: 'Perfetto. Inviami la foto del libretto: se riesco a leggerlo salvo subito targa e VIN.' },
    part_photo: { stage: 'guided_waiting_part_photo', pendingSlot: 'part_photo', question: 'Perfetto. Inviami la foto del pezzo o dell etichetta. Se puoi aggiungi anche targa o VIN.' },
    oe_code: { stage: 'guided_waiting_oe_code', pendingSlot: 'oe_code', question: 'Perfetto. Inviami il codice OE. Se puoi, aggiungi anche targa o VIN per ridurre gli errori.' },
    free_text_request: { stage: 'guided_waiting_free_text', pendingSlot: 'free_text_request', question: 'Scrivimi pure tutto in una riga. Esempio: FP781GE parabrezza anteriore.' }
  };
  const selected = stageMap[choice] || stageMap.root_menu;

  return {
    status: 'OK',
    parsed: baseParsed,
    vehicle: null,
    normalizedPart: baseNormalizedPart,
    dbrtResult: {},
    glassCatalog: { status: 'SKIPPED', message: `Scelta guidata ${channel} acquisita`, items: [] },
    oeCatalog: {},
    oeResults: [],
    equivalents: {},
    missingData: selected.pendingSlot ? [selected.pendingSlot] : [],
    whatsappText: selected.question,
    aiRequest: {
      intent: `${channel}_guided_${choice || 'root_menu'}`,
      request_is_valid: true,
      suggested_service: 'WAITING_DATA',
      instruction: 'Scelta guidata acquisita tramite interazione chat prima del triage completo della richiesta.',
      availableSources: [channel === 'telegram' ? 'TELEGRAM_KEYBOARD' : 'WHATSAPP_INTERACTIVE', 'CONVERSATION_CONTEXT'],
      openai: { skipped: true, error: null, model: null, statusCode: null, raw: null, parsed: null }
    },
    aiSummary: `Scelta guidata ${channel} acquisita.`,
    resolvedStatus: selected.pendingSlot ? 'in_attesa_dati_cliente' : null,
    intakeState: {
      stage: selected.stage,
      pendingSlot: selected.pendingSlot,
      pendingQuestion: selected.question,
      slots: {
        ...previousIntakeState.slots
      }
    }
  };
}

function buildCurrentPartSummary(slots = {}, context = {}) {
  return s(slots.part_name) || s(context.normalized_part_name) || s(context.requested_part_text) || '';
}

function getLinkedQuoteMeta(slots = {}, context = {}) {
  return {
    id: i(slots.linked_preventivo_id) || i(context.linked_preventivo_id) || null,
    code: s(slots.linked_preventivo_code) || s(context.linked_preventivo_code) || '',
    appendRequested: !!(slots.quote_append_requested)
  };
}

function buildSessionActionQuestion(currentPartSummary = '', proposedPartName = '', quoteMeta = {}) {
  if (quoteMeta?.id || quoteMeta?.code) {
    const quoteLabel = quoteMeta.code || `preventivo #${quoteMeta.id}`;
    return `Hai una richiesta aperta per ${currentPartSummary || 'questo ricambio'} con ${quoteLabel} gia creato. Vuoi sostituirlo con ${proposedPartName || 'il nuovo pezzo'} oppure aggiungerlo allo stesso preventivo? Rispondi SOSTITUISCI oppure AGGIUNGI.`;
  }
  return `Hai una richiesta aperta per ${currentPartSummary || 'questo ricambio'}. Vuoi sostituirlo con ${proposedPartName || 'il nuovo pezzo'} oppure aggiungerlo alla stessa richiesta? Rispondi SOSTITUISCI oppure AGGIUNGI.`;
}

function hasMeaningfulIntakeSlots(slots = {}) {
  if (!slots || typeof slots !== 'object') return false;
  return !!(
    s(slots.plate)
    || s(slots.vin)
    || s(slots.oe_code)
    || s(slots.part_name)
    || s(slots.part_category)
    || s(slots.glass_position)
    || s(slots.side)
    || s(slots.axle)
    || s(slots.brake_component)
    || s(slots.filter_type)
  );
}

function appendSessionPart(slots = {}, item = {}) {
  const current = Array.isArray(slots.session_parts) ? slots.session_parts : [];
  const name = s(item.part_name);
  if (!name) return current;
  return [
    ...current,
    {
      part_name: name,
      part_category: s(item.part_category) || '',
      plate: s(item.plate) || '',
      vin: s(item.vin) || '',
      oe_code: s(item.oe_code) || '',
      added_at: new Date().toISOString()
    }
  ];
}

async function buildVehicleDocumentWaitingResponse({
  text = '',
  channel = 'whatsapp',
  previousContext = {},
  previousIntakeState = { slots: {} },
  mediaAi = null
}) {
  const existingSlots = previousIntakeState.slots || {};
  const plate = normalizePlate(s(mediaAi?.plate) || s(existingSlots.plate) || s(previousContext.plate) || '');
  const vin = s(mediaAi?.vin) || s(existingSlots.vin) || s(previousContext.vin) || '';
  const oeCode = sanitizeOeCode(s(mediaAi?.oe_code) || s(existingSlots.oe_code) || s(previousContext.oe_code) || '', plate);
  const carriedPartName = shouldOverridePartSelection(existingSlots.part_name)
    ? s(existingSlots.part_name)
    : (shouldOverridePartSelection(previousContext.normalized_part_name) ? s(previousContext.normalized_part_name) : '');
  const carriedPartCategory = normalizePartCategory(s(existingSlots.part_category) || s(previousContext.normalized_part_category), carriedPartName || '');
  const carriedText = carriedPartName || '';

  if (carriedPartName) {
    return resolvePartsMessageV2({
      message: carriedPartName,
      channel,
      context: {
        ...previousContext,
        plate: plate || s(previousContext.plate) || '',
        vin: vin || s(previousContext.vin) || '',
        oe_code: oeCode || s(previousContext.oe_code) || '',
        requested_part_text: carriedPartName,
        normalized_part_name: carriedPartName,
        normalized_part_category: carriedPartCategory
      },
      intakeState: {
        ...previousIntakeState,
        stage: 'document_vehicle_data_completed',
        pendingSlot: null,
        pendingQuestion: null,
        slots: {
          ...existingSlots,
          plate,
          vin,
          oe_code: oeCode,
          part_name: carriedPartName,
          part_category: carriedPartCategory,
          glass_position: detectGlassPosition(carriedText) || s(existingSlots.glass_position) || '',
          side: detectSide(carriedText) || s(existingSlots.side) || '',
          axle: detectAxle(carriedText) || s(existingSlots.axle) || '',
          brake_component: detectBrakeComponent(carriedText) || s(existingSlots.brake_component) || '',
          filter_type: detectFilterType(carriedText) || s(existingSlots.filter_type) || ''
        }
      },
      mediaAnalysis: null
    });
  }

  const waitingQuestion = (!plate && !vin)
    ? 'Ho ricevuto il documento del veicolo, ma non riesco ancora a leggere bene targa o VIN. Inviami una foto piu nitida del libretto oppure scrivimi la targa.'
    : 'Ho raccolto i dati del veicolo. Dimmi ora quale ricambio ti serve.';
  const parsed = {
    originalText: text || '[foto ricevuta]',
    plate,
    vin,
    oeCode,
    requestedPartText: '',
    confidence: Number(mediaAi?.confidence || 0)
  };
  const normalizedPart = {
    name: '',
    category: 'ricambio_generico'
  };

  return {
    status: 'OK',
    parsed,
    vehicle: null,
    normalizedPart,
    dbrtResult: {},
    glassCatalog: { status: 'SKIPPED', message: 'Documento veicolo acquisito, in attesa del ricambio richiesto', items: [] },
    oeCatalog: {},
    oeResults: [],
    equivalents: {},
    missingData: (!plate && !vin) ? ['vehicle_key'] : ['part_name'],
    whatsappText: waitingQuestion,
    aiRequest: {
      intent: 'vehicle_document_intake',
      request_is_valid: true,
      suggested_service: 'WAITING_DATA',
      instruction: (!plate && !vin)
        ? 'Documento veicolo riconosciuto ma identificativi non leggibili. Richiedere una foto piu nitida o la targa scritta.'
        : 'Documento veicolo acquisito nel ramo dedicato. Raccolti i dati tecnici del veicolo, in attesa del ricambio richiesto prima di qualsiasi dispatch ai servizi.',
      availableSources: ['OPENAI_VISION', 'RULES', 'CONVERSATION_CONTEXT'],
      parsed,
      normalizedPart,
      masterCase: 'document_image_only',
      mediaAnalysis: mediaAi,
      openai: {
        skipped: false,
        error: null,
        model: process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
        statusCode: null,
        raw: null,
        parsed: mediaAi
      }
    },
    aiSummary: s(mediaAi?.summary) || 'Documento veicolo acquisito e dati tecnici estratti.',
    resolvedStatus: 'in_attesa_dati_cliente',
    intakeState: {
      stage: (!plate && !vin) ? 'waiting_vehicle_key' : 'waiting_part_name',
      pendingSlot: (!plate && !vin) ? 'vehicle_key' : 'part_name',
      pendingQuestion: waitingQuestion,
      slots: {
        ...previousIntakeState.slots,
        plate,
        vin,
        oe_code: oeCode,
        part_category: '',
        part_name: ''
      }
    }
  };
}

function shouldTrustMediaPartExtraction(mediaData = null, bodyText = '') {
  if (!mediaData) return false;
  if (isVehicleDocumentMediaKind(mediaData?.media_kind)) return false;
  if (s(mediaData?.oe_code)) return true;
  const partName = s(mediaData?.normalized_part_name) || s(mediaData?.requested_part_text) || '';
  const category = normalizePartCategory(mediaData?.normalized_part_category, partName);
  return shouldOverridePartSelection(partName) && !!category && category !== 'ricambio_generico';
}

function shouldTrustEvidencePartExtraction(evidence = null, bodyText = '') {
  if (!evidence) return false;
  if (isVehicleDocumentMediaKind(evidence?.detected_subject) || isVehicleDocumentMediaKind(evidence?.media_kind)) return false;
  if (s(evidence?.oe_code)) return true;
  const partName = s(evidence?.normalized_part_name) || s(evidence?.requested_part_text) || '';
  const category = normalizePartCategory(evidence?.normalized_part_category, partName);
  return shouldOverridePartSelection(partName) && !!category && category !== 'ricambio_generico';
}

function shouldOverridePartSelection(value) {
  const normalized = s(value);
  if (!normalized || normalized.length < 3) return false;
  if (isGenericVehicleDocumentLabel(normalized)) return false;
  if (isOperationalFeedbackMessage(normalized)) return false;
  if (normalizePartCategory('', normalized) === 'ricambio_generico' && normalized.split(/\s+/).length > 4) return false;
  return true;
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

function normalizePartCategory(value, fallbackText = '') {
  const raw = s(value);
  if (!raw) return guessPartCategory(fallbackText);
  const lower = raw.toLowerCase();
  if (/(cristall|vetr|glass|windshield|windscreen|parabrezza|lunotto|scendente|raschiavetro|alzacristall)/.test(lower)) return 'cristalli';
  if (/(fren|brake|pastigli|disch|pinz|tambur|ganasc|ceppi|cilindrett)/.test(lower)) return 'freni';
  if (/(filtr|filter|olio|aria|abitacolo|carburante)/.test(lower)) return 'filtri';
  if (/(retrovisor|specchiett|mirror)/.test(lower)) return 'retrovisori';
  if (/(illuminaz|fanal|faro|stop|light|lamp)/.test(lower)) return 'illuminazione';
  if (/(generic|generico|ricambio)/.test(lower)) return 'ricambio_generico';
  return guessPartCategory(`${raw} ${fallbackText}`.trim());
}

function logPartEvent(partsRequestId, eventType, eventMessage, eventSource = 'crm', payload = null) {
  db.prepare(`
    INSERT INTO parts_request_events (parts_request_id, event_type, event_message, event_source, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(partsRequestId, eventType, s(eventMessage), s(eventSource), payload ? JSON.stringify(payload) : null);
}

function pickDefaultPartsAssigneeUserId() {
  const row = db.prepare(`
    SELECT u.id
    FROM utenti u
    LEFT JOIN ruoli r ON r.id = u.ruolo_id
    WHERE u.attivo = 1
      AND COALESCE(r.nome, '') IN ('commerciale', 'admin', 'superadmin', 'amministrazione', 'logistica')
    ORDER BY
      CASE COALESCE(r.nome, '')
        WHEN 'commerciale' THEN 1
        WHEN 'admin' THEN 2
        WHEN 'superadmin' THEN 3
        WHEN 'amministrazione' THEN 4
        WHEN 'logistica' THEN 5
        ELSE 99
      END,
      u.id ASC
    LIMIT 1
  `).get();
  return i(row?.id);
}

function getPartsAttentionUserIds() {
  return db.prepare(`
    SELECT u.id
    FROM utenti u
    LEFT JOIN ruoli r ON r.id = u.ruolo_id
    WHERE u.attivo = 1
      AND COALESCE(r.nome, '') IN ('commerciale', 'admin', 'superadmin', 'amministrazione', 'logistica')
    ORDER BY u.id ASC
  `).all().map((row) => i(row.id)).filter(Boolean);
}

function getPartsEscalationWindowSeconds() {
  const parsed = parseInt(process.env.PARTS_ESCALATION_WINDOW_SECONDS || '60', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}

function notifyAndEscalatePartsRequest(partsRequestId, reason = 'manual_review_required', extra = {}) {
  if (!partsRequestId) return false;
  const alreadyEscalated = db.prepare(`
    SELECT id
    FROM parts_request_events
    WHERE parts_request_id = ?
      AND event_type = 'richiesta_escalata_operatore'
    LIMIT 1
  `).get(partsRequestId);
  if (alreadyEscalated) return false;

  const request = db.prepare(`
    SELECT id, request_uuid, user_phone, plate, vin, oe_code, requested_part_text, normalized_part_name, normalized_part_category, assigned_to_user_id
    FROM parts_requests
    WHERE id = ?
  `).get(partsRequestId);
  if (!request) return false;

  const assigneeId = i(request.assigned_to_user_id) || pickDefaultPartsAssigneeUserId();
  if (assigneeId) {
    db.prepare(`
      UPDATE parts_requests
      SET assigned_to_user_id = COALESCE(assigned_to_user_id, ?),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(assigneeId, partsRequestId);
  }

  logPartEvent(partsRequestId, 'richiesta_escalata_operatore', 'Richiesta girata a operatore per evitare stallo del flusso', 'crm', {
    reason,
    assigned_to_user_id: assigneeId,
    ...extra
  });

  const title = `Richiesta ricambi da presidiare #${request.id}`;
  const body = [
    request.normalized_part_name || request.requested_part_text || 'Richiesta ricambi',
    request.plate ? `targa ${request.plate}` : null,
    request.vin ? `VIN ${request.vin}` : null,
    reason === 'service_not_available' ? 'servizio automatico non ancora disponibile' : 'nessun esito automatico entro la soglia prevista'
  ].filter(Boolean).join(' • ');

  const userIds = getPartsAttentionUserIds();
  if (userIds.length) {
    createNotificationsForUserIds(userIds, {
      tipo: 'ricambi_attention',
      titolo: title,
      messaggio: body,
      livello_urgenza: 'alta',
      entita_tipo: 'parts_request',
      entita_id: partsRequestId,
      uniqueSuffix: `parts-escalation:${reason}`
    });
  }

  return true;
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
  const baseDescription = s(item?.description) || s(request?.normalized_part_name) || s(request?.requested_part_text) || 'Ricambio ricambi';
  const price = item?.price !== undefined && item?.price !== null
    ? Number(String(item.price).replace(',', '.'))
    : (request?.oe_results?.[0]?.list_price || null);
  const description = [
    baseDescription,
    oeCode ? `OE ${oeCode}` : null,
    price !== null && Number.isFinite(price) ? `EUR ${Number(price).toFixed(2)}` : null
  ].filter(Boolean).join(' - ');
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
    totale,
    reusedExisting: false
  };
}

function buildQuotePdfQuestionText(selectedItem, existingQuoteCode = '') {
  const lines = [
    'Perfetto, ho identificato il ricambio selezionato.',
    selectedItem?.description ? `Descrizione: ${selectedItem.description}` : null,
    selectedItem?.oe_code ? `Codice OE: ${selectedItem.oe_code}` : null,
    selectedItem?.eurocode ? `Eurocode: ${selectedItem.eurocode}` : null,
    selectedItem?.price ? `Prezzo indicativo: EUR ${selectedItem.price}` : null,
    '',
    existingQuoteCode
      ? `Vuoi che aggiorni subito il preventivo ${existingQuoteCode} in PDF? Rispondi SI oppure NO.`
      : 'Vuoi che ti prepari subito un preventivo PDF? Rispondi SI oppure NO.'
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
  const linkedQuoteId = i(current?.linked_preventivo_id);
  const appendToExistingQuote = !!current?.intake_state?.slots?.quote_append_requested;
  const reusableQuote = appendToExistingQuote && linkedQuoteId
    ? db.prepare(`
      SELECT id, codice_preventivo, stato
      FROM preventivi
      WHERE id = ?
      LIMIT 1
    `).get(linkedQuoteId)
    : null;
  let quote = null;

  if (reusableQuote && String(reusableQuote.stato || '').toLowerCase() === 'bozza') {
    const qty = 1;
    const imponibile = Number(quotedProduct.price || 0) * qty;
    const aliquotaIva = 22;
    const importoIva = Number((imponibile * aliquotaIva / 100).toFixed(2));
    const totale = Number((imponibile + importoIva).toFixed(2));

    db.prepare(`
      INSERT INTO preventivi_righe (
        preventivo_id, prodotto_id, descrizione, quantita, prezzo_unitario, sconto,
        imponibile, aliquota_iva, importo_iva, totale_riga
      )
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      reusableQuote.id,
      quotedProduct.product.id,
      quotedProduct.description,
      qty,
      quotedProduct.price,
      imponibile,
      aliquotaIva,
      importoIva,
      totale
    );

    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(imponibile), 0) AS imponibile,
        COALESCE(SUM(importo_iva), 0) AS iva,
        COALESCE(SUM(totale_riga), 0) AS totale
      FROM preventivi_righe
      WHERE preventivo_id = ?
    `).get(reusableQuote.id);

    db.prepare(`
      UPDATE preventivi
      SET imponibile = ?, iva = ?, totale = ?
      WHERE id = ?
    `).run(
      Number(totals?.imponibile || 0),
      Number(totals?.iva || 0),
      Number(totals?.totale || 0),
      reusableQuote.id
    );

    quote = {
      preventivoId: reusableQuote.id,
      codicePreventivo: reusableQuote.codice_preventivo,
      qty,
      imponibile: Number(totals?.imponibile || 0),
      importoIva: Number(totals?.iva || 0),
      totale: Number(totals?.totale || 0),
      reusedExisting: true
    };
  } else {
    quote = createDraftQuoteFromRequest(current, quotedProduct);
  }

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
  logPartEvent(
    requestId,
    quote.reusedExisting ? 'preventivo_aggiornato' : 'preventivo_creato',
    quote.reusedExisting
      ? 'Preventivo bozza aggiornato automaticamente con un nuovo ricambio'
      : 'Preventivo bozza creato automaticamente dalla richiesta ricambi',
    'crm',
    {
      preventivoId: quote.preventivoId,
      codice_preventivo: quote.codicePreventivo,
      total: quote.totale,
      qty: quote.qty,
      reusedExisting: !!quote.reusedExisting
    }
  );

  const publicToken = ensurePublicPreventivoToken(quote.preventivoId);
  const pdf = await createPreventivoPdfBuffer(quote.preventivoId);
  return {
    quotedProduct,
    quote,
    pdf,
    publicPdfUrl: buildPublicPreventivoPdfUrl(quote.preventivoId, publicToken)
  };
}

function persistQuoteSessionState(partsRequestId, quote = null) {
  if (!partsRequestId || !quote?.preventivoId) return;
  const currentState = getIntakeState(partsRequestId) || { slots: {} };
  saveIntakeState(partsRequestId, {
    stage: 'quote_pdf_confirmed',
    pendingSlot: null,
    pendingQuestion: null,
    slots: {
      ...(currentState.slots || {}),
      linked_preventivo_id: quote.preventivoId,
      linked_preventivo_code: quote.codicePreventivo || '',
      quote_pdf_requested: true,
      quote_append_requested: false
    }
  });
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
      pr.id,
      pr.plate,
      pr.vin,
      pr.oe_code,
      pr.requested_part_text,
      pr.normalized_part_name,
      pr.normalized_part_category,
      pr.ai_summary,
      pr.whatsapp_reply_text,
      pr.status,
      pr.created_at,
      pr.updated_at,
      pr.linked_preventivo_id,
      p.codice_preventivo AS linked_preventivo_code
    FROM parts_requests pr
    LEFT JOIN preventivi p ON p.id = pr.linked_preventivo_id
    WHERE pr.user_phone = ?
      AND (? IS NULL OR pr.id <> ?)
      AND pr.status IN (${PARTS_OPEN_STATUSES.map(() => '?').join(', ')})
      AND (
        COALESCE(pr.plate, '') <> ''
        OR COALESCE(pr.vin, '') <> ''
        OR COALESCE(pr.oe_code, '') <> ''
        OR COALESCE(pr.requested_part_text, '') <> ''
        OR COALESCE(pr.normalized_part_category, '') <> ''
      )
    ORDER BY pr.id DESC
    LIMIT 1
  `).get(phone, currentPartsRequestId, currentPartsRequestId, ...PARTS_OPEN_STATUSES);
}

function getActivePartsRequestForPhone(phone) {
  if (!phone) return null;
  const windowMinutes = getActiveRequestWindowMinutes();
  return db.prepare(`
    SELECT *
    FROM parts_requests
    WHERE user_phone = ?
      AND status IN (${PARTS_OPEN_STATUSES.map(() => '?').join(', ')})
      AND COALESCE(last_message_at, updated_at, created_at) >= datetime('now', ?)
    ORDER BY last_message_at DESC, id DESC
    LIMIT 1
  `).get(phone, ...PARTS_OPEN_STATUSES, `-${windowMinutes} minutes`);
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
  const incomingPartName = shouldOverridePartSelection(normalizedPart?.name)
    ? s(normalizedPart?.name)
    : (shouldOverridePartSelection(parsed?.requestedPartText) ? s(parsed?.requestedPartText) : null);
  const previousPartName = s(existing.part_name) || s(context?.normalized_part_name) || '';
  const partChanged = !!incomingPartName && incomingPartName.toLowerCase() !== previousPartName.toLowerCase();
  const normalizedIncomingCategory = normalizePartCategory(normalizedPart?.category, incomingPartName || sourceText);
  const normalizedExistingCategory = normalizePartCategory(existing.part_category, `${existing.part_name || ''} ${sourceText}`.trim());
  const normalizedContextCategory = normalizePartCategory(context?.normalized_part_category, `${context?.normalized_part_name || ''} ${sourceText}`.trim());
  const category = partChanged
    ? (normalizedIncomingCategory || guessPartCategory(incomingPartName || sourceText))
    : (normalizedIncomingCategory || normalizedExistingCategory || normalizedContextCategory || guessPartCategory(sourceText));
  const partName = incomingPartName || previousPartName || s(parsed?.requestedPartText);
  const keepExistingCategoryDetails = !partChanged;

  return {
    plate: s(parsed?.plate) || s(existing.plate) || s(context?.plate) || '',
    vin: s(parsed?.vin) || s(existing.vin) || s(context?.vin) || '',
    oe_code: s(parsed?.oeCode) || s(existing.oe_code) || s(context?.oe_code) || '',
    part_category: category || '',
    part_name: partName || '',
    glass_position: detectGlassPosition(sourceText) || (keepExistingCategoryDetails ? s(existing.glass_position) : '') || '',
    side: detectSide(sourceText) || (keepExistingCategoryDetails ? s(existing.side) : '') || '',
    axle: detectAxle(sourceText) || (keepExistingCategoryDetails ? s(existing.axle) : '') || '',
    brake_component: detectBrakeComponent(sourceText) || (keepExistingCategoryDetails ? s(existing.brake_component) : '') || '',
    filter_type: detectFilterType(sourceText) || (keepExistingCategoryDetails ? s(existing.filter_type) : '') || ''
  };
}

function buildIntakeDecision(slots = {}) {
  const hasLookupKey = !!s(slots.plate) || !!s(slots.vin) || !!s(slots.oe_code);

  if (!hasLookupKey) {
    return {
      ready: false,
      stage: 'waiting_vehicle_key',
      pendingSlot: 'vehicle_key',
      question: 'Per proseguire ho bisogno di almeno uno tra targa, VIN o codice OE del ricambio.'
    };
  }

  switch (slots.part_category) {
    case 'cristalli':
      if (!slots.glass_position) {
        return {
          ready: false,
          stage: 'waiting_glass_position',
          pendingSlot: 'glass_position',
          question: 'Ho preso i dati tecnici del veicolo. Dimmi quale cristallo ti serve: parabrezza, lunotto oppure vetro laterale.'
        };
      }
      return { ready: true, stage: 'ready_for_service', pendingSlot: null, question: null };
    case 'freni':
      if (!slots.brake_component) {
        return {
          ready: false,
          stage: 'waiting_brake_component',
          pendingSlot: 'brake_component',
          question: 'Ho preso i dati tecnici del veicolo. Per i freni dimmi se ti servono pastiglie, dischi, pinza o altro.'
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
          question: 'Ho preso i dati tecnici del veicolo. Dimmi quale filtro ti serve: aria, olio, abitacolo o carburante.'
        };
      }
      return { ready: true, stage: 'ready_for_ai', pendingSlot: null, question: null };
    case 'retrovisori':
      if (!slots.side) {
        return {
          ready: false,
          stage: 'waiting_side',
          pendingSlot: 'side',
          question: 'Ho preso i dati tecnici del veicolo. Mi serve sapere se il ricambio e destro o sinistro.'
        };
      }
      return { ready: true, stage: 'ready_for_ai', pendingSlot: null, question: null };
    case 'illuminazione':
      if (!slots.side) {
        return {
          ready: false,
          stage: 'waiting_side',
          pendingSlot: 'side',
          question: 'Ho preso i dati tecnici del veicolo. Mi confermi se ti serve lato destro o sinistro?'
        };
      }
      return { ready: true, stage: 'ready_for_ai', pendingSlot: null, question: null };
    default:
      if (!slots.part_name || slots.part_name.length < 4 || isGenericVehicleDocumentLabel(slots.part_name)) {
        return {
          ready: false,
          stage: 'waiting_part_name',
          pendingSlot: 'part_name',
          question: 'Dimmi meglio quale ricambio ti serve.'
        };
      }
      return { ready: true, stage: 'ready_for_ai', pendingSlot: null, question: null };
  }
}

function buildFallbackMissingDataQuestion(slots = {}, evidence = null) {
  if (!slots.plate && !slots.vin && !slots.oe_code) {
    return 'Per procedere ho bisogno di almeno uno tra targa, VIN o codice OE del ricambio.';
  }
  if (!slots.part_name) {
    return 'Dimmi ora quale ricambio ti serve esattamente.';
  }
  return 'Ho raccolto parte dei dati, ma mi serve ancora un dettaglio in piu per procedere correttamente.';
}

function joinHumanList(items = []) {
  const normalized = items.map((item) => s(item)).filter(Boolean);
  if (!normalized.length) return '';
  if (normalized.length === 1) return normalized[0];
  if (normalized.length === 2) return `${normalized[0]} e ${normalized[1]}`;
  return `${normalized.slice(0, -1).join(', ')} e ${normalized[normalized.length - 1]}`;
}

function getPendingCategoryService(category = '', slots = {}) {
  const normalizedCategory = normalizePartCategory(category, slots.part_name || '');
  const hasOe = !!s(slots.oe_code);

  if (hasOe && normalizedCategory === 'ricambio_generico') return 'RTWS_EQUIVALENTI_BY_OE_PENDING';

  switch (normalizedCategory) {
    case 'filtri':
      return hasOe ? 'RTWS_BDRT_FILTRI_BY_OE_PENDING' : 'RTWS_BDRT_FILTRI_PENDING';
    case 'freni':
      return hasOe ? 'RTWS_BDRT_FRENI_BY_OE_PENDING' : 'RTWS_BDRT_FRENI_PENDING';
    case 'retrovisori':
      return hasOe ? 'RTWS_BDRT_RETROVISORI_BY_OE_PENDING' : 'RTWS_BDRT_RETROVISORI_PENDING';
    case 'illuminazione':
      return hasOe ? 'RTWS_BDRT_ILLUMINAZIONE_BY_OE_PENDING' : 'RTWS_BDRT_ILLUMINAZIONE_PENDING';
    case 'ricambio_generico':
      return hasOe ? 'RTWS_EQUIVALENTI_BY_OE_PENDING' : 'RTWS_IDENTIFICATION_GENERIC_PENDING';
    default:
      return `CATEGORY_${String(normalizedCategory || 'GENERIC').toUpperCase()}_PENDING`;
  }
}

function resolvePlannedService(category = '', suggestedService = '', slots = {}) {
  const normalizedCategory = normalizePartCategory(category, slots.part_name || '');
  const normalizedSuggested = String(s(suggestedService) || '').toUpperCase();
  const fallbackService = getPendingCategoryService(normalizedCategory, slots);

  if (!normalizedSuggested || normalizedSuggested === 'MANUAL_REVIEW' || normalizedSuggested === 'WAITING_DATA') {
    return fallbackService;
  }
  if (normalizedSuggested === 'RTWS_LISTINI_CHECK_EUROCODE_TARGA_OE2' && normalizedCategory !== 'cristalli') {
    return fallbackService;
  }

  return normalizedSuggested;
}

function buildPendingCategoryMessage(category = '', partName = '', slots = {}) {
  const normalizedCategory = normalizePartCategory(category, partName);
  const partLabel = s(partName) || 'il ricambio richiesto';
  const lookupBits = [
    s(slots.plate) ? `targa ${s(slots.plate)}` : '',
    s(slots.vin) ? `VIN ${s(slots.vin)}` : '',
    s(slots.oe_code) ? `codice OE ${s(slots.oe_code)}` : ''
  ].filter(Boolean);
  const lookupText = lookupBits.length
    ? ` Ho gia raccolto ${joinHumanList(lookupBits)}.`
    : '';

  switch (normalizedCategory) {
    case 'filtri':
      return `Ho riconosciuto una richiesta filtri per ${partLabel}.${lookupText} La instrado sul ramo filtri: con i servizi attivi oggi non posso ancora chiuderla in automatico, quindi passa al reparto tecnico senza usare il flusso cristalli.`;
    case 'freni':
      return `Ho riconosciuto una richiesta freni per ${partLabel}.${lookupText} La instrado sul ramo freni: con i servizi attivi oggi non posso ancora chiuderla in automatico, quindi passa al reparto tecnico senza usare il flusso cristalli.`;
    case 'retrovisori':
      return `Ho riconosciuto una richiesta retrovisori per ${partLabel}.${lookupText} La instrado sul ramo retrovisori: con i servizi attivi oggi non posso ancora chiuderla in automatico, quindi passa al reparto tecnico senza usare il flusso cristalli.`;
    case 'illuminazione':
      return `Ho riconosciuto una richiesta illuminazione per ${partLabel}.${lookupText} La instrado sul ramo illuminazione: con i servizi attivi oggi non posso ancora chiuderla in automatico, quindi passa al reparto tecnico senza usare il flusso cristalli.`;
    default:
      if (s(slots.oe_code)) {
        return `Ho riconosciuto la richiesta per ${partLabel}.${lookupText} La instrado sul ramo OE/equivalenti: il catalogo automatico dedicato non e ancora attivo, quindi passa al reparto tecnico.`;
      }
      return `Ho raccolto i dati per ${partLabel}.${lookupText} La richiesta passa al reparto tecnico per usare il ramo piu adatto appena disponibile.`;
  }
}

function buildVehicleAwarePendingCategoryMessage(category = '', partName = '', slots = {}, vehicle = null) {
  const normalizedCategory = normalizePartCategory(category, partName);
  const baseVehicleLabel = buildVehicleSummaryLabel(vehicle);
  const vehicleLabel = baseVehicleLabel || 'il veicolo associato alla targa';
  const plateText = s(slots.plate) ? ` dalla targa ${s(slots.plate)}` : '';

  switch (normalizedCategory) {
    case 'filtri':
      return `Ho riconosciuto una richiesta filtri per ${s(partName) || 'il ricambio richiesto'}. Ho identificato ${vehicleLabel}${plateText}. Il ramo filtri e pronto per la lavorazione tecnica senza usare il flusso cristalli.`;
    case 'freni':
      return `Ho riconosciuto una richiesta freni per ${s(partName) || 'il ricambio richiesto'}. Ho identificato ${vehicleLabel}${plateText}. Il ramo freni e pronto per la lavorazione tecnica senza usare il flusso cristalli.`;
    case 'retrovisori':
      return `Ho riconosciuto una richiesta retrovisori per ${s(partName) || 'il ricambio richiesto'}. Ho identificato ${vehicleLabel}${plateText}. Il ramo retrovisori e pronto per la lavorazione tecnica senza usare il flusso cristalli.`;
    case 'illuminazione':
      return `Ho riconosciuto una richiesta illuminazione per ${s(partName) || 'il ricambio richiesto'}. Ho identificato ${vehicleLabel}${plateText}. Il ramo illuminazione e pronto per la lavorazione tecnica senza usare il flusso cristalli.`;
    default:
      return `Ho identificato ${vehicleLabel}${plateText} e ho raccolto i dati della richiesta per ${s(partName) || 'il ricambio richiesto'}. La richiesta passa al reparto tecnico sul ramo corretto.`;
  }
}

function buildServiceExecutionPlan(slots = {}, suggestedService = '', evidence = null, normalizedPart = null) {
  const category = normalizePartCategory(s(slots.part_category) || s(normalizedPart?.category), slots.part_name || normalizedPart?.name || '');
  const partName = s(slots.part_name) || s(normalizedPart?.name) || '';
  const hasPlate = !!s(slots.plate);
  const hasVin = !!s(slots.vin);
  const hasOe = !!s(slots.oe_code);
  const hasVehicleKey = hasPlate || hasVin;
  const hasLookupKey = hasVehicleKey || hasOe;

  if (!hasLookupKey) {
    return {
      mode: 'waiting_data',
      missing: ['plate_or_vin_or_oe'],
      question: buildFallbackMissingDataQuestion(slots, evidence)
    };
  }

  if (!partName && !hasOe) {
    return {
      mode: 'waiting_data',
      missing: ['part_name'],
      question: buildFallbackMissingDataQuestion(slots, evidence)
    };
  }

  if (category === 'ricambio_generico' && !hasOe) {
    return {
      mode: 'waiting_data',
      missing: ['part_name_clarification'],
      question: 'Per aiutarti meglio, dimmi il nome del ricambio oppure mandami una foto piu chiara del pezzo o del codice OE.'
    };
  }

  if (category === 'cristalli' && !hasPlate && !hasOe) {
    return {
      mode: 'waiting_data',
      missing: ['plate'],
      question: 'Per cercare i cristalli con i servizi attivi oggi mi serve la targa del veicolo. Inviamela e procedo subito.'
    };
  }

  if (category === 'cristalli' && hasPlate && partName) {
    return {
      mode: 'execute_service',
      service: 'RTWS_LISTINI_CHECK_EUROCODE_TARGA_OE2'
    };
  }

  if (hasOe) {
    return {
      mode: 'execute_service',
      service: 'RTWS_LISTINI_LOOKUP_BY_OE',
      category
    };
  }

  if (category !== 'cristalli' && hasPlate && partName && isRtwsNonGlassPlateLookupEnabled()) {
    return {
      mode: 'execute_service',
      service: 'RTWS_IDENTIFICATION_GET_RT_TARGA_MIN',
      category
    };
  }

  return {
    mode: 'escalate_service_pending',
    service: resolvePlannedService(category, suggestedService, slots),
    category,
    message: buildPendingCategoryMessage(category, partName, slots)
  };
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
    process.env.RTWS_CLIENT_NAME &&
    process.env.RTWS_PASSWORD &&
    process.env.RTWS_PRODUCT_LISTINI
  );
}

function isRtwsBdrtConfigured() {
  return !!(
    getRtwsServiceUrl() &&
    process.env.RTWS_AZIENDA_NAME &&
    process.env.RTWS_CLIENT_NAME &&
    process.env.RTWS_PASSWORD &&
    process.env.RTWS_PRODUCT_BDRT
  );
}

function isRtwsIdentificationConfigured() {
  return !!(
    getRtwsServiceUrl() &&
    process.env.RTWS_AZIENDA_NAME &&
    process.env.RTWS_CLIENT_NAME &&
    process.env.RTWS_PASSWORD &&
    process.env.RTWS_PRODUCT_IDENTIFICATION
  );
}

function isRtwsTargatelaioConfigured() {
  return !!(
    getRtwsServiceUrl() &&
    process.env.RTWS_AZIENDA_NAME &&
    process.env.RTWS_CLIENT_NAME &&
    process.env.RTWS_PASSWORD &&
    process.env.RTWS_PRODUCT_TARGATELAIO
  );
}

function isRtwsNonGlassPlateLookupEnabled() {
  const flag = String(process.env.PARTS_ENABLE_NON_GLASS_PLATE_LOOKUP || '').trim().toLowerCase();
  if (!['1', 'true', 'yes', 'on'].includes(flag)) return false;
  return isRtwsTargatelaioConfigured() || isRtwsIdentificationConfigured();
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

function parseRtwsVehicleAllestimenti(rawXml) {
  return collectXmlBlocks(getXmlTagBlock(rawXml, 'Allestimenti'), 'AllestimentoEsteso').map((block) => ({
    category: getXmlTagValue(block, 'Category') || '',
    id_marca: getXmlTagValue(block, 'IdMar') || '',
    id_modello: getXmlTagValue(block, 'IdMod') || '',
    id_versione: getXmlTagValue(block, 'IdVer') || '',
    make: getXmlTagValue(block, 'DsMar') || '',
    model: getXmlTagValue(block, 'DsMod') || '',
    version: getXmlTagValue(block, 'DsVer') || '',
    infocar_code: getXmlTagValue(block, 'CodiceInfocarAM') || '',
    link_type: getXmlTagValue(block, 'TipologiaLink') || '',
    id_par: getXmlTagValue(block, 'IdPar') || '',
    start_commercialization: getXmlTagValue(block, 'InizioCommercializzazione') || '',
    end_commercialization: getXmlTagValue(block, 'FineCommercializzazione') || ''
  })).filter((item) => item.make || item.model || item.version || item.id_marca || item.infocar_code);
}

function parseRtwsListinoItems(rawXml, itemTag = 'RicambioRes') {
  return collectXmlBlocks(getXmlTagBlock(rawXml, 'Ricambi') || rawXml, itemTag).map((block) => ({
    id_marca: getXmlTagValue(block, 'IdMar') || '',
    id_par: getXmlTagValue(block, 'IdPar') || getXmlTagValue(block, 'Idpar') || '',
    id_riga: getXmlTagValue(block, 'IdRiga') || '',
    oe_code: getXmlTagValue(block, 'OE') || getXmlTagValue(block, 'Oe') || '',
    part_number: getXmlTagValue(block, 'PartNumber') || getXmlTagValue(block, 'Parno') || '',
    price: getXmlTagValue(block, 'Prezzo') || getXmlTagValue(block, 'Przli') || '',
    description: getXmlTagValue(block, 'Descrizione') || getXmlTagValue(block, 'Dspar') || '',
    state: getXmlTagValue(block, 'Stato') || '',
    flag_manuale: getXmlTagValue(block, 'FlagManuale') || '',
    data_validita: getXmlTagValue(block, 'DataValiditaListino') || '',
    data_aggiornamento: getXmlTagValue(block, 'DataAggiornamentoListino') || '',
    raw_xml: block
  })).filter((item) => item.oe_code || item.part_number || item.description || item.price);
}

function parseRtwsEquivalentItems(rawXml) {
  return collectXmlBlocks(getXmlTagBlock(rawXml, 'Ricambi') || rawXml, 'RicambioEquiRes').map((block) => ({
    id_marca: getXmlTagValue(block, 'IdMar') || '',
    oe_code: getXmlTagValue(block, 'OE') || getXmlTagValue(block, 'Oe') || '',
    part_number: getXmlTagValue(block, 'PartNumber') || '',
    description: getXmlTagValue(block, 'Descrizione') || '',
    price: getXmlTagValue(block, 'Prezzo') || '',
    raw_xml: block
  })).filter((item) => item.part_number || item.oe_code || item.description || item.price);
}

function parseRtwsSearchVehiclesByOeItems(rawXml) {
  return collectXmlBlocks(getXmlTagBlock(rawXml, 'Allestimenti') || rawXml, 'AllestimentoRes').map((block) => ({
    id_marca: getXmlTagValue(block, 'IdMar') || '',
    id_modello: getXmlTagValue(block, 'IdMod') || '',
    id_versione: getXmlTagValue(block, 'IdVer') || '',
    make: getXmlTagValue(block, 'DsMar') || '',
    model: getXmlTagValue(block, 'DsMod') || '',
    version: getXmlTagValue(block, 'DsVer') || '',
    oe_code: getXmlTagValue(block, 'OE') || '',
    start_commercialization: getXmlTagValue(block, 'InizioCommercializzazione') || '',
    end_commercialization: getXmlTagValue(block, 'FineCommercializzazione') || ''
  })).filter((item) => item.id_marca || item.make || item.oe_code);
}

function parseRtwsRicambiByOeEntries(rawXml) {
  return collectXmlBlocks(getXmlTagBlock(rawXml, 'SparePart_OEList') || rawXml, 'SparePart_OE').map((block) => ({
    oe_code: getXmlTagValue(block, 'OE') || '',
    matches: collectXmlBlocks(getXmlTagBlock(block, 'SparePartInfos') || block, 'SparePartInfo').map((infoBlock) => ({
      id_par: getXmlTagValue(infoBlock, 'Idpar') || '',
      description: getXmlTagValue(infoBlock, 'Dspar') || '',
      id_sim: getXmlTagValue(infoBlock, 'Idsim') || '',
      variants: collectXmlBlocks(getXmlTagBlock(infoBlock, 'OEList') || infoBlock, 'OEDetail').map((detailBlock) => ({
        part_number: getXmlTagValue(detailBlock, 'Parno') || '',
        extra_description: getXmlTagValue(detailBlock, 'Ultds') || '',
        pecos: getXmlTagValue(detailBlock, 'Pecos') || '',
        color: getXmlTagValue(detailBlock, 'Color') || '',
        raw_xml: detailBlock
      })).filter((item) => item.part_number || item.extra_description || item.pecos || item.color)
    })).filter((item) => item.id_par || item.description || item.variants.length)
  })).filter((item) => item.oe_code || item.matches.length);
}

function flattenRtwsRicambiByOeEntries(entries = []) {
  return entries.flatMap((entry) => {
    const entryOeCode = s(entry.oe_code);
    return (Array.isArray(entry.matches) ? entry.matches : []).flatMap((match) => {
      const baseItem = {
        oe_code: entryOeCode,
        id_par: s(match.id_par),
        id_sim: s(match.id_sim),
        description: s(match.description),
        part_number: '',
        extra_description: '',
        pecos: '',
        color: '',
        price: '',
        raw_xml: ''
      };
      const variants = Array.isArray(match.variants) ? match.variants : [];
      if (!variants.length) return [baseItem];
      return variants.map((variant) => ({
        ...baseItem,
        part_number: s(variant.part_number),
        extra_description: s(variant.extra_description),
        pecos: s(variant.pecos),
        color: s(variant.color),
        raw_xml: s(variant.raw_xml)
      }));
    });
  }).filter((item) => item.oe_code || item.part_number || item.description || item.id_par);
}

function dedupeOeLookupItems(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = [
      sanitizeOeCode(s(item.oe_code)),
      sanitizeOeCode(s(item.part_number)),
      s(item.description).toLowerCase(),
      s(item.id_par)
    ].join('|');
    if (!key.replace(/\|/g, '')) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildVehicleSummaryLabel(vehicle = {}) {
  return [
    s(vehicle.make),
    s(vehicle.model),
    s(vehicle.version)
  ].filter(Boolean).join(' ').trim();
}

function buildBdrtVehicleFromOeMatch(matchedAllestimento = null, vehicleMatches = [], oeCode = '') {
  const primary = matchedAllestimento || (Array.isArray(vehicleMatches) ? vehicleMatches[0] : null) || null;
  if (!primary) return null;

  const relatedMatches = Array.isArray(vehicleMatches)
    ? vehicleMatches.filter((item) => (
      s(item.id_marca) === s(primary.id_marca)
      && s(item.id_modello) === s(primary.id_modello)
      && s(item.id_versione) === s(primary.id_versione)
    ))
    : [];

  return {
    make: s(primary.make),
    model: s(primary.model),
    version: s(primary.version),
    engine_code: '',
    ktype: '',
    infocar_code: s(primary.infocar_code),
    vehicle_source: 'rtws_bdrt_oe_search',
    raw_payload_json: {
      oe_code: s(oeCode),
      matched_allestimento: matchedAllestimento || null,
      vehicle_matches: relatedMatches.length ? relatedMatches : (Array.isArray(vehicleMatches) ? vehicleMatches : [])
    }
  };
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
  const normalizedStateCode = String(stateCode || '').trim();
  const warningCodes = new Set(['-100']);
  const isWarning = warningCodes.has(normalizedStateCode);
  const status = normalizedStateCode === '0'
    ? (items.length ? 'READY' : 'EMPTY')
    : (isWarning ? (items.length ? 'READY' : 'EMPTY') : 'ERROR');
  return {
    status,
    message: stateDescription || (items.length ? 'Risultati cristalli recuperati da RTWS_LISTINI tramite targa.' : 'Nessun cristallo trovato per la targa indicata.'),
    items,
    rawXml: result.rawXml,
    stateCode: stateCode || '',
    warning: isWarning
  };
}

async function rtwsGetUpdateListiniByOe({ oeCode, idMar = 0, idPar = 0, idRiga = 1 }) {
  if (!isRtwsConfigured()) {
    return { status: 'NOT_CONFIGURED', message: 'RTWS non configurato', items: [] };
  }
  const normalizedOe = sanitizeOeCode(oeCode);
  if (!normalizedOe) {
    return { status: 'EMPTY', message: 'Codice OE non valido', items: [] };
  }
  try {
    const sessionId = await getRtwsSession(process.env.RTWS_PRODUCT_LISTINI);
    const body = `
      <sessionId>${xmlEscape(sessionId)}</sessionId>
      <context>
        <Ricambi>
          <RicambioReq>
            <IdMar>${Number(idMar) || 0}</IdMar>
            <IdPar>${Number(idPar) || 0}</IdPar>
            <OE>${xmlEscape(normalizedOe)}</OE>
            <IdRiga>${Number(idRiga) || 1}</IdRiga>
          </RicambioReq>
        </Ricambi>
      </context>
    `;
    const result = await callRtwsSoap('GetUpdateListini', body);
    if (!result.ok) {
      return { status: 'ERROR', message: result.error || 'Chiamata GetUpdateListini fallita', items: [], rawXml: result.rawXml || '' };
    }
    const stateCode = getXmlTagValue(result.rawXml, 'Code');
    const items = parseRtwsListinoItems(result.rawXml, 'RicambioRes');
    return {
      status: String(stateCode || '').trim() === '0' ? (items.length ? 'READY' : 'EMPTY') : 'ERROR',
      message: items.length ? 'Dettaglio OE recuperato da RTWS_LISTINI.' : 'Nessun dettaglio OE trovato in RTWS_LISTINI.',
      items,
      rawXml: result.rawXml,
      stateCode: stateCode || ''
    };
  } catch (error) {
    return { status: 'ERROR', message: error.message || 'Eccezione GetUpdateListini', items: [], rawXml: '' };
  }
}

async function rtwsSearchListiniByOe({ oeCode, idMar = '', top = 10 }) {
  if (!isRtwsConfigured()) {
    return { status: 'NOT_CONFIGURED', message: 'RTWS non configurato', items: [] };
  }
  const normalizedOe = sanitizeOeCode(oeCode);
  if (!normalizedOe || normalizedOe.length < 3) {
    return { status: 'EMPTY', message: 'Servono almeno 3 caratteri di OE per la ricerca', items: [] };
  }
  try {
    const sessionId = await getRtwsSession(process.env.RTWS_PRODUCT_LISTINI);
    const body = `
      <sessionId>${xmlEscape(sessionId)}</sessionId>
      <context>
        <Oe>${xmlEscape(normalizedOe)}</Oe>
        <idMar>${xmlEscape(String(idMar || ''))}</idMar>
        <Top>${Math.max(1, Math.min(Number(top) || 10, 20))}</Top>
      </context>
    `;
    const result = await callRtwsSoap('SearchListiniByOe', body);
    if (!result.ok) {
      return { status: 'ERROR', message: result.error || 'Chiamata SearchListiniByOe fallita', items: [], rawXml: result.rawXml || '' };
    }
    const stateCode = getXmlTagValue(result.rawXml, 'Code');
    const items = parseRtwsListinoItems(result.rawXml, 'SearchRicambioRes');
    return {
      status: String(stateCode || '').trim() === '0' ? (items.length ? 'READY' : 'EMPTY') : 'ERROR',
      message: items.length ? 'Ricerca OE completata su RTWS_LISTINI.' : 'Nessuna corrispondenza trovata su RTWS_LISTINI.',
      items,
      rawXml: result.rawXml,
      stateCode: stateCode || ''
    };
  } catch (error) {
    return { status: 'ERROR', message: error.message || 'Eccezione SearchListiniByOe', items: [], rawXml: '' };
  }
}

async function rtwsGetListiniEquivalenti({ partNumber }) {
  if (!isRtwsConfigured()) {
    return { status: 'NOT_CONFIGURED', message: 'RTWS non configurato', items: [] };
  }
  const normalizedPartNumber = sanitizeOeCode(partNumber);
  if (!normalizedPartNumber) {
    return { status: 'EMPTY', message: 'Part number non valido', items: [] };
  }
  try {
    const sessionId = await getRtwsSession(process.env.RTWS_PRODUCT_LISTINI);
    const body = `
      <sessionId>${xmlEscape(sessionId)}</sessionId>
      <context>
        <PartNumber>${xmlEscape(normalizedPartNumber)}</PartNumber>
      </context>
    `;
    const result = await callRtwsSoap('GetListiniEquivalenti', body);
    if (!result.ok) {
      return { status: 'ERROR', message: result.error || 'Chiamata GetListiniEquivalenti fallita', items: [], rawXml: result.rawXml || '' };
    }
    const stateCode = getXmlTagValue(result.rawXml, 'Code');
    const items = parseRtwsEquivalentItems(result.rawXml);
    return {
      status: String(stateCode || '').trim() === '0' ? (items.length ? 'READY' : 'EMPTY') : 'ERROR',
      message: items.length ? 'Equivalenti recuperati da RTWS_LISTINI.' : 'Nessun equivalente trovato in RTWS_LISTINI.',
      items,
      rawXml: result.rawXml,
      stateCode: stateCode || ''
    };
  } catch (error) {
    return { status: 'ERROR', message: error.message || 'Eccezione GetListiniEquivalenti', items: [], rawXml: '' };
  }
}

async function rtwsSearchVehiclesByOe({ oeCode, top = 10 }) {
  if (!isRtwsBdrtConfigured()) {
    return { status: 'NOT_CONFIGURED', message: 'RTWS_BDRT non configurato', items: [] };
  }
  const normalizedOe = sanitizeOeCode(oeCode);
  if (!normalizedOe || normalizedOe.length < 3) {
    return { status: 'EMPTY', message: 'Servono almeno 3 caratteri di OE per cercare i veicoli compatibili', items: [] };
  }
  try {
    const sessionId = await getRtwsSession(process.env.RTWS_PRODUCT_BDRT);
    const body = `
      <sessionId>${xmlEscape(sessionId)}</sessionId>
      <context>
        <Oe>${xmlEscape(normalizedOe)}</Oe>
        <Top>${Math.max(1, Math.min(Number(top) || 10, 20))}</Top>
      </context>
    `;
    const result = await callRtwsSoap('SearchRTByOe', body);
    if (!result.ok) {
      return { status: 'ERROR', message: result.error || 'Chiamata SearchRTByOe fallita', items: [], rawXml: result.rawXml || '' };
    }
    const stateCode = getXmlTagValue(result.rawXml, 'Code');
    const stateDescription = getXmlTagValue(result.rawXml, 'Description');
    const items = parseRtwsSearchVehiclesByOeItems(result.rawXml);
    return {
      status: String(stateCode || '').trim() === '0' ? (items.length ? 'READY' : 'EMPTY') : 'ERROR',
      message: stateDescription || (items.length ? 'Veicoli compatibili recuperati da RTWS_BDRT.' : 'Nessun veicolo compatibile trovato in RTWS_BDRT.'),
      items,
      rawXml: result.rawXml,
      stateCode: stateCode || ''
    };
  } catch (error) {
    return { status: 'ERROR', message: error.message || 'Eccezione SearchRTByOe', items: [], rawXml: '' };
  }
}

async function rtwsGetRicambiByOe({ idMar, idMod, idVer, oeCodes = [] }) {
  if (!isRtwsBdrtConfigured()) {
    return { status: 'NOT_CONFIGURED', message: 'RTWS_BDRT non configurato', items: [], entries: [] };
  }
  const normalizedCodes = [...new Set((Array.isArray(oeCodes) ? oeCodes : [oeCodes])
    .map((code) => sanitizeOeCode(code))
    .filter(Boolean))];
  if (!normalizedCodes.length) {
    return { status: 'EMPTY', message: 'Nessun codice OE valido per la verifica BDRT', items: [], entries: [] };
  }
  try {
    const sessionId = await getRtwsSession(process.env.RTWS_PRODUCT_BDRT);
    const oeListXml = normalizedCodes.map((code) => `<OE>${xmlEscape(code)}</OE>`).join('');
    const body = `
      <sessionId>${xmlEscape(sessionId)}</sessionId>
      <context>
        <Marca>${Number(idMar) || 0}</Marca>
        <Modello>${Number(idMod) || 0}</Modello>
        <Versione>${Number(idVer) || 0}</Versione>
        <Oelist>${oeListXml}</Oelist>
      </context>
    `;
    const result = await callRtwsSoap('GetRicambiByOE', body);
    if (!result.ok) {
      return { status: 'ERROR', message: result.error || 'Chiamata GetRicambiByOE fallita', items: [], entries: [], rawXml: result.rawXml || '' };
    }
    const stateCode = getXmlTagValue(result.rawXml, 'Code');
    const stateDescription = getXmlTagValue(result.rawXml, 'Description');
    const entries = parseRtwsRicambiByOeEntries(result.rawXml);
    const items = flattenRtwsRicambiByOeEntries(entries);
    const normalizedStateCode = String(stateCode || '').trim();
    const isPartial = normalizedStateCode === '1';
    return {
      status: ['0', '1'].includes(normalizedStateCode) ? (items.length ? 'READY' : 'EMPTY') : 'ERROR',
      message: stateDescription || (items.length ? 'Ricambi OE recuperati da RTWS_BDRT.' : 'Nessun ricambio OE trovato in RTWS_BDRT.'),
      items,
      entries,
      rawXml: result.rawXml,
      stateCode: stateCode || '',
      warning: isPartial
    };
  } catch (error) {
    return { status: 'ERROR', message: error.message || 'Eccezione GetRicambiByOE', items: [], entries: [], rawXml: '' };
  }
}

async function rtwsGetVehicleByPlate({ plate, ricercaAvanzata = true }) {
  if (!isRtwsTargatelaioConfigured() && !isRtwsIdentificationConfigured()) {
    return { status: 'NOT_CONFIGURED', message: 'RTWS targa/telaio e identificazione non configurati', vehicle: null, allestimenti: [] };
  }
  try {
    const useTargatelaio = isRtwsTargatelaioConfigured();
    const sessionId = await getRtwsSession(useTargatelaio ? process.env.RTWS_PRODUCT_TARGATELAIO : process.env.RTWS_PRODUCT_IDENTIFICATION);
    const body = useTargatelaio
      ? `
        <sessionId>${xmlEscape(sessionId)}</sessionId>
        <context>
          <Targa>${xmlEscape(normalizePlate(plate))}</Targa>
          <RicercaAvanzata>${ricercaAvanzata ? 'true' : 'false'}</RicercaAvanzata>
        </context>
      `
      : `
        <sessionId>${xmlEscape(sessionId)}</sessionId>
        <context>
          <Targa>${xmlEscape(normalizePlate(plate))}</Targa>
        </context>
      `;
    const result = await callRtwsSoap(useTargatelaio ? 'GetRTDaTargaMin' : 'GetRTEstesoDaTarga', body);
    if (!result.ok) {
      return {
        status: 'ERROR',
        message: result.error || `Chiamata RTWS ${useTargatelaio ? 'targa/telaio' : 'identificazione'} fallita`,
        vehicle: null,
        allestimenti: [],
        rawXml: result.rawXml || ''
      };
    }

    const allestimenti = parseRtwsVehicleAllestimenti(result.rawXml);
    const selected = allestimenti[0] || {};
    const plateValue = getXmlTagValue(result.rawXml, 'targa') || getXmlTagValue(result.rawXml, 'Targa') || normalizePlate(plate);
    const vin = getXmlTagValue(result.rawXml, 'telaio') || getXmlTagValue(result.rawXml, 'Telaio') || '';
    const engineCode = getXmlTagValue(result.rawXml, 'codiceMotore') || getXmlTagValue(result.rawXml, 'CodiceMotore') || '';
    const errCode = getXmlTagValue(result.rawXml, 'AllestimentiErrCode') || '';
    const errMessage = getXmlTagValue(result.rawXml, 'AllestimentiErrMessage') || '';
    const vehicle = (selected.make || selected.model || selected.version || vin || plateValue)
      ? {
          make: selected.make || '',
          model: selected.model || '',
          version: selected.version || '',
          engine_code: engineCode || '',
          ktype: '',
          infocar_code: selected.infocar_code || '',
          vehicle_source: useTargatelaio ? 'rtws_targatelaio_targa' : 'rtws_identification_targa',
          raw_payload_json: {
            plate: plateValue,
            vin,
            engine_code: engineCode,
            err_code: errCode,
            err_message: errMessage,
            selected_allestimento: selected,
            allestimenti
          }
        }
      : null;

    const status = vehicle ? 'READY' : 'EMPTY';
    return {
      status,
      message: vehicle
        ? `Veicolo identificato da targa tramite ${useTargatelaio ? 'RTWS_TARGATELAIO' : 'RTWS_IDENTIFICAZIONE'}.`
        : (errMessage || `Nessun veicolo identificato da targa tramite ${useTargatelaio ? 'RTWS_TARGATELAIO' : 'RTWS_IDENTIFICAZIONE'}.`),
      vehicle,
      allestimenti,
      rawXml: result.rawXml,
      errorCode: errCode,
      errorMessage: errMessage,
      plate: plateValue,
      vin
    };
  } catch (error) {
    return {
      status: 'ERROR',
      message: error?.message || 'Eccezione RTWS identificazione',
      vehicle: null,
      allestimenti: [],
      rawXml: '',
      errorCode: 'EXCEPTION',
      errorMessage: error?.message || 'Eccezione RTWS identificazione',
      plate: normalizePlate(plate),
      vin: ''
    };
  }
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

function postWhatsAppJsonPayload(payload) {
  return new Promise((resolve) => {
    if (!isWhatsappConfigured()) return resolve({ skipped: true, reason: 'whatsapp_non_configurato' });
    const version = process.env.WHATSAPP_API_VERSION || 'v20.0';
    const endpoint = new URL(`https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`);
    const rawPayload = JSON.stringify(payload || {});
    const req = https.request({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: 443,
      path: endpoint.pathname,
      method: 'POST',
      timeout: Number(process.env.RTWS_TIMEOUT_MS || 12000),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(rawPayload),
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
    req.write(rawPayload);
    req.end();
  });
}

function buildWhatsAppTextPayload(to, bodyText) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(to || ''),
    type: 'text',
    text: {
      preview_url: false,
      body: String(bodyText || '')
    }
  };
}

function buildWhatsAppInteractivePayload(to, bodyText, options = {}) {
  const interactive = options?.whatsappInteractive || null;
  if (!interactive) return buildWhatsAppTextPayload(to, bodyText);
  const basePayload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(to || ''),
    type: 'interactive'
  };
  const body = {
    text: truncateMetaText(bodyText || '', 1024)
  };
  const headerText = truncateMetaText(interactive.headerText || '', 60);
  const footerText = truncateMetaText(interactive.footerText || '', 60);

  if (interactive.type === 'button') {
    const buttons = Array.isArray(interactive.buttons) ? interactive.buttons.slice(0, 3) : [];
    if (!buttons.length) return buildWhatsAppTextPayload(to, bodyText);
    return {
      ...basePayload,
      interactive: {
        type: 'button',
        ...(headerText ? { header: { type: 'text', text: headerText } } : {}),
        body,
        ...(footerText ? { footer: { text: footerText } } : {}),
        action: {
          buttons
        }
      }
    };
  }

  if (interactive.type === 'list') {
    const sections = Array.isArray(interactive.sections)
      ? interactive.sections
        .slice(0, 10)
        .map((section, sectionIndex) => ({
          title: truncateMetaText(section?.title || `Scelte ${sectionIndex + 1}`, 24) || `Scelte ${sectionIndex + 1}`,
          rows: Array.isArray(section?.rows)
            ? section.rows.map((row, rowIndex) => normalizeWhatsAppInteractiveRow(row, rowIndex + 1)).filter(Boolean).slice(0, 10)
            : []
        }))
        .filter((section) => section.rows.length)
      : [];
    if (!sections.length) return buildWhatsAppTextPayload(to, bodyText);
    return {
      ...basePayload,
      interactive: {
        type: 'list',
        ...(headerText ? { header: { type: 'text', text: headerText } } : {}),
        body,
        ...(footerText ? { footer: { text: footerText } } : {}),
        action: {
          button: truncateMetaText(interactive.buttonText || 'Apri menu', 20) || 'Apri menu',
          sections
        }
      }
    };
  }

  return buildWhatsAppTextPayload(to, bodyText);
}

async function sendWhatsAppText(to, bodyText, options = {}) {
  if (!isWhatsappConfigured()) return { skipped: true, reason: 'whatsapp_non_configurato' };
  const wantsInteractive = !!options?.whatsappInteractive;
  const primaryPayload = wantsInteractive
    ? buildWhatsAppInteractivePayload(to, bodyText, options)
    : buildWhatsAppTextPayload(to, bodyText);
  const primaryResult = await postWhatsAppJsonPayload(primaryPayload);
  const failedPrimary = primaryResult.error || !primaryResult.statusCode || primaryResult.statusCode < 200 || primaryResult.statusCode >= 300;
  if (!wantsInteractive || !failedPrimary) return primaryResult;

  const fallbackResult = await postWhatsAppJsonPayload(buildWhatsAppTextPayload(to, bodyText));
  return {
    ...fallbackResult,
    fallbackFromInteractive: true,
    interactiveAttempt: primaryResult
  };
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

async function sendTelegramText(chatId, bodyText, options = {}) {
  return callTelegramApi('sendMessage', {
    chat_id: String(chatId || ''),
    text: String(bodyText || ''),
    ...(options?.reply_markup ? { reply_markup: options.reply_markup } : {})
  });
}

async function sendTelegramDocumentBuffer(chatId, buffer, filename, caption = '') {
  const form = new FormData();
  form.append('chat_id', String(chatId || ''));
  form.append('document', new Blob([buffer], { type: 'application/pdf' }), filename || 'preventivo.pdf');
  if (caption) form.append('caption', String(caption));
  return callTelegramApi('sendDocument', form, true);
}

function looksLikeImageMimeType(mimeType) {
  return /^image\//i.test(String(mimeType || '').trim());
}

function looksLikeImageFilename(filename) {
  return /\.(jpg|jpeg|png|webp|gif|bmp|heic|heif)$/i.test(String(filename || '').trim());
}

function choosePreferredImageMimeType(downloadedMimeType, declaredMimeType = null) {
  const downloaded = s(downloadedMimeType);
  const declared = s(declaredMimeType);
  if (looksLikeImageMimeType(downloaded)) return downloaded;
  if (looksLikeImageMimeType(declared)) return declared;
  return downloaded || declared || null;
}

function guessFilenameFromMimeType(mimeType, fallbackBase = 'media') {
  const lower = String(mimeType || '').toLowerCase();
  const extMap = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/heic': 'heic',
    'image/heif': 'heif'
  };
  const ext = extMap[lower] || 'bin';
  return `${fallbackBase}.${ext}`;
}

function buildMediaDerivedMessageText(bodyText, mediaData) {
  const includeMediaPart = shouldTrustMediaPartExtraction(mediaData, bodyText);
  const bits = [
    isSyntheticInboundPlaceholder(bodyText) ? null : s(bodyText),
    includeMediaPart ? s(mediaData?.requested_part_text) : null,
    includeMediaPart ? s(mediaData?.normalized_part_name) : null,
    s(mediaData?.plate) ? `targa ${normalizePlate(mediaData.plate)}` : null,
    s(mediaData?.vin) ? `vin ${s(mediaData.vin)}` : null,
    s(mediaData?.oe_code) ? `oe ${s(mediaData.oe_code)}` : null,
    s(mediaData?.glass_position) ? s(mediaData.glass_position).replace(/_/g, ' ') : null,
    s(mediaData?.side),
    s(mediaData?.axle),
    s(mediaData?.brake_component),
    s(mediaData?.filter_type),
    s(mediaData?.visible_text)
  ].filter(Boolean);

  const deduped = [];
  const seen = new Set();
  bits.forEach((bit) => {
    const key = String(bit).trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    deduped.push(String(bit).trim());
  });
  return deduped.join(' ').trim();
}

async function downloadWhatsAppInboundMedia(mediaId) {
  if (!isWhatsappConfigured()) return { ok: false, error: 'whatsapp_non_configurato' };
  const version = process.env.WHATSAPP_API_VERSION || 'v20.0';
  const metadataEndpoint = `https://graph.facebook.com/${version}/${encodeURIComponent(String(mediaId || ''))}`;
  const metadataResponse = await fetch(metadataEndpoint, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` }
  });
  const metadataRaw = await metadataResponse.text();
  const metadataBody = parseWhatsappResponseBody(metadataRaw);
  if (!metadataResponse.ok || !metadataBody?.url) {
    return {
      ok: false,
      stage: 'metadata',
      statusCode: metadataResponse.status,
      raw: metadataRaw,
      body: metadataBody,
      error: metadataBody?.error?.message || metadataRaw || `WhatsApp media metadata HTTP ${metadataResponse.status}`
    };
  }

  const binaryResponse = await fetch(metadataBody.url, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` }
  });
  const binaryBuffer = Buffer.from(await binaryResponse.arrayBuffer());
  if (!binaryResponse.ok) {
    const raw = binaryBuffer.toString('utf8');
    return {
      ok: false,
      stage: 'download',
      statusCode: binaryResponse.status,
      raw,
      error: raw || `WhatsApp media download HTTP ${binaryResponse.status}`
    };
  }

  return {
    ok: true,
    buffer: binaryBuffer,
    mimeType: s(metadataBody.mime_type) || s(binaryResponse.headers.get('content-type')) || null,
    filename: guessFilenameFromMimeType(metadataBody.mime_type, `whatsapp-${metadataBody.id || mediaId}`),
    metadata: metadataBody
  };
}

async function downloadTelegramInboundMedia(fileId, mediaMetadata = null) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return { ok: false, error: 'telegram_non_configurato' };
  const fileInfoResponse = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(String(fileId || ''))}`);
  const fileInfoRaw = await fileInfoResponse.text();
  const fileInfoBody = parseWhatsappResponseBody(fileInfoRaw);
  const filePath = s(fileInfoBody?.result?.file_path);
  if (!fileInfoResponse.ok || !filePath) {
    return {
      ok: false,
      stage: 'metadata',
      statusCode: fileInfoResponse.status,
      raw: fileInfoRaw,
      body: fileInfoBody,
      error: fileInfoBody?.description || fileInfoRaw || `Telegram getFile HTTP ${fileInfoResponse.status}`
    };
  }

  const binaryResponse = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  const binaryBuffer = Buffer.from(await binaryResponse.arrayBuffer());
  if (!binaryResponse.ok) {
    const raw = binaryBuffer.toString('utf8');
    return {
      ok: false,
      stage: 'download',
      statusCode: binaryResponse.status,
      raw,
      error: raw || `Telegram file download HTTP ${binaryResponse.status}`
    };
  }

  const explicitFilename = s(mediaMetadata?.document?.file_name);
  const mimeType = s(mediaMetadata?.document?.mime_type) || s(binaryResponse.headers.get('content-type')) || null;
  return {
    ok: true,
    buffer: binaryBuffer,
    mimeType,
    filename: explicitFilename || filePath.split('/').pop() || guessFilenameFromMimeType(mimeType, `telegram-${fileId}`),
    metadata: fileInfoBody?.result || null
  };
}

async function downloadStoredConversationMedia(message = null) {
  if (!message?.media_url) return { ok: false, error: 'media_non_disponibile' };
  const metadata = json(message.media_metadata_json, null) || null;
  if (message.channel === 'whatsapp') return downloadWhatsAppInboundMedia(message.media_url);
  if (message.channel === 'telegram') return downloadTelegramInboundMedia(message.media_url, metadata);
  return { ok: false, error: 'canale_media_non_supportato' };
}

async function downloadInboundMediaForAi({ channel, mediaUrl, mediaMimeType, mediaMetadata, messageType }) {
  const effectiveMimeType = s(mediaMimeType) || s(mediaMetadata?.document?.mime_type) || s(mediaMetadata?.image?.mime_type);
  const effectiveFilename = s(mediaMetadata?.document?.file_name);
  const imageCandidate = looksLikeImageMimeType(effectiveMimeType)
    || looksLikeImageFilename(effectiveFilename)
    || String(messageType || '').toLowerCase() === 'image'
    || String(messageType || '').toLowerCase() === 'photo';

  if (!mediaUrl || !imageCandidate) {
    return {
      skipped: true,
      reason: mediaUrl ? 'media_non_supportato_per_vision' : 'media_mancante'
    };
  }

  if (channel === 'whatsapp') return downloadWhatsAppInboundMedia(mediaUrl);
  if (channel === 'telegram') return downloadTelegramInboundMedia(mediaUrl, mediaMetadata);
  return { skipped: true, reason: 'canale_media_non_supportato' };
}

async function analyzeInboundMediaWithOpenAI({ channel, bodyText, mediaUrl, mediaMimeType, mediaMetadata, messageType }) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  if (!apiKey) {
    return { skipped: true, reason: 'openai_non_configurato', meta: { model } };
  }

  const mediaDownload = await downloadInboundMediaForAi({ channel, mediaUrl, mediaMimeType, mediaMetadata, messageType });
  if (mediaDownload?.skipped) {
    return { skipped: true, reason: mediaDownload.reason, meta: { model } };
  }
  if (!mediaDownload?.ok || !mediaDownload?.buffer?.length) {
    return {
      skipped: false,
      error: mediaDownload?.error || 'Download media fallito',
      meta: {
        model,
        stage: mediaDownload?.stage || 'download',
        statusCode: mediaDownload?.statusCode || null,
        raw: mediaDownload?.raw || null,
        parsed: mediaDownload?.body || null
      }
    };
  }

  const mimeType = choosePreferredImageMimeType(mediaDownload.mimeType, mediaMimeType) || 'image/jpeg';
  if (!looksLikeImageMimeType(mimeType)) {
    return { skipped: true, reason: 'mime_non_immagine', meta: { model, mimeType } };
  }

  const imageDataUrl = `data:${mimeType};base64,${mediaDownload.buffer.toString('base64')}`;
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'parts_media_analysis',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              media_kind: { type: 'string' },
              summary: { type: 'string' },
              visible_text: { type: 'string' },
              plate: { type: 'string' },
              vin: { type: 'string' },
              oe_code: { type: 'string' },
              requested_part_text: { type: 'string' },
              normalized_part_name: { type: 'string' },
              normalized_part_category: { type: 'string' },
              glass_position: { type: 'string' },
              side: { type: 'string' },
              axle: { type: 'string' },
              brake_component: { type: 'string' },
              filter_type: { type: 'string' },
              confidence: { type: 'number' },
              needs_followup: { type: 'boolean' },
              followup_question: { type: 'string' }
            },
            required: ['media_kind', 'summary', 'visible_text', 'plate', 'vin', 'oe_code', 'requested_part_text', 'normalized_part_name', 'normalized_part_category', 'glass_position', 'side', 'axle', 'brake_component', 'filter_type', 'confidence', 'needs_followup', 'followup_question']
          }
        }
      },
      messages: [
        {
          role: 'system',
          content: 'Analizza immagini ricevute per richieste ricambi auto. L immagine puo mostrare targa, libretto, carta di circolazione, etichetta OE oppure il pezzo stesso. Se vedi un libretto o una carta di circolazione italiana, priorita assoluta: trascrivi quanto piu testo utile possibile in visible_text ed estrai separatamente sia targa sia VIN quando leggibili. Cerca in modo attivo i campi tipici del libretto come targa, numero di telaio, immatricolazione, cilindrata, potenza, alimentazione, variante e versione. Non fermarti al primo identificativo trovato: raccogli tutti i dati tecnici utili presenti nell immagine. Se la targa o il VIN sono presenti ma poco nitidi, prova comunque a dedurli solo se altamente probabili; altrimenti lascia stringa vuota. Estrai con prudenza solo dati leggibili o altamente probabili. Se l immagine non basta per completare la richiesta, imposta needs_followup=true e scrivi una domanda breve e utile per il riparatore. Usa normalized_part_category tra cristalli, freni, filtri, retrovisori, illuminazione, ricambio_generico.'
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Messaggio/caption del cliente: ${String(bodyText || '').trim() || '[vuoto]'}`
            },
            {
              type: 'image_url',
              image_url: {
                url: imageDataUrl,
                detail: 'high'
              }
            }
          ]
        }
      ]
    })
  });

  const raw = await response.text();
  const parsed = parseWhatsappResponseBody(raw);
  if (!response.ok) {
    return {
      skipped: false,
      error: parsed?.error?.message || raw || `OpenAI vision HTTP ${response.status}`,
      meta: { model, statusCode: response.status, raw, parsed, mimeType }
    };
  }
  const content = parsed?.choices?.[0]?.message?.content;
  if (!content) {
    return {
      skipped: false,
      error: 'Risposta OpenAI vision vuota',
      meta: { model, statusCode: response.status, raw, parsed, mimeType }
    };
  }
  try {
    let parsedData = enrichMediaAnalysisData(JSON.parse(content));
    let documentRetryMeta = null;

    if (shouldRetryVehicleDocumentOcr(parsedData)) {
      const retryResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'vehicle_document_ocr_retry',
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  media_kind: { type: 'string' },
                  summary: { type: 'string' },
                  visible_text: { type: 'string' },
                  plate: { type: 'string' },
                  vin: { type: 'string' },
                  confidence: { type: 'number' },
                  followup_question: { type: 'string' }
                },
                required: ['media_kind', 'summary', 'visible_text', 'plate', 'vin', 'confidence', 'followup_question']
              }
            }
          },
          messages: [
            {
              role: 'system',
              content: 'Sei un OCR specialist per documenti veicolo. Controlla se l immagine mostra un libretto o una carta di circolazione, in particolare italiana. Devi trascrivere il testo visibile piu utile e cercare in modo specifico targa e VIN. Cerca anche segnali tipici del libretto: immatricolazione, numero di telaio, cilindrata, potenza, alimentazione, variante, versione, massa, cognome e nome intestatario. Se trovi targa o VIN scrivili nei campi dedicati. Se non sono leggibili, lascia stringa vuota e spiega in followup_question cosa manca. Non inventare.'
            },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Contesto: prima analisi immagine senza targa/VIN certi. Caption del cliente: ${String(bodyText || '').trim() || '[vuoto]'}. Prima trascrizione disponibile: ${String(parsedData.visible_text || '').trim() || '[vuota]'}.`
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: imageDataUrl,
                    detail: 'high'
                  }
                }
              ]
            }
          ]
        })
      });
      const retryRaw = await retryResponse.text();
      const retryParsed = parseWhatsappResponseBody(retryRaw);
      const retryContent = retryParsed?.choices?.[0]?.message?.content;
      if (retryResponse.ok && retryContent) {
        try {
          const retryData = JSON.parse(retryContent);
          const retrySignals = [
            retryData?.media_kind,
            retryData?.summary,
            retryData?.visible_text,
            retryData?.followup_question
          ].filter(Boolean).join(' ');
          const retryLooksDocument = hasVehicleDocumentTextHints(retrySignals)
            || isVehicleDocumentMediaKind(retryData?.media_kind)
            || !!(s(retryData?.plate) || s(retryData?.vin));
          parsedData = enrichMediaAnalysisData({
            ...parsedData,
            media_kind: retryLooksDocument
              ? (s(retryData.media_kind) || s(parsedData.media_kind) || '')
              : (s(parsedData.media_kind) || s(retryData.media_kind) || ''),
            summary: retryLooksDocument
              ? (s(retryData.summary) || s(parsedData.summary) || '')
              : (s(parsedData.summary) || s(retryData.summary) || ''),
            visible_text: (String(retryData.visible_text || '').trim().length > String(parsedData.visible_text || '').trim().length)
              ? retryData.visible_text
              : parsedData.visible_text,
            plate: s(parsedData.plate) || s(retryData.plate) || '',
            vin: s(parsedData.vin) || s(retryData.vin) || ''
          });
          documentRetryMeta = {
            statusCode: retryResponse.status,
            raw: retryRaw,
            parsed: retryParsed,
            content: retryContent
          };
        } catch {
          documentRetryMeta = {
            statusCode: retryResponse.status,
            raw: retryRaw,
            parsed: retryParsed,
            content: retryContent,
            error: 'JSON OCR retry non valido'
          };
        }
      } else {
        documentRetryMeta = {
          statusCode: retryResponse.status,
          raw: retryRaw,
          parsed: retryParsed,
          error: retryParsed?.error?.message || retryRaw || `OpenAI OCR retry HTTP ${retryResponse.status}`
        };
      }
    }

    return {
      skipped: false,
      data: parsedData,
      meta: {
        model,
        statusCode: response.status,
        raw,
        parsed,
        content,
        mimeType,
        filename: mediaDownload.filename || null,
        documentRetry: documentRetryMeta
      }
    };
  } catch {
    return {
      skipped: false,
      error: 'JSON OpenAI vision non valido',
      raw: content,
      meta: { model, statusCode: response.status, raw, parsed, content, mimeType }
    };
  }
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

async function analyzeInboundEvidenceWithOpenAI({
  messageText,
  mediaAnalysis = null,
  context = null,
  intakeState = null
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const cleanMessageText = isSyntheticInboundPlaceholder(messageText) ? '' : String(messageText || '').trim();
  const mediaData = mediaAnalysis?.data || mediaAnalysis || null;
  if (!apiKey) {
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
      temperature: 0.1,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'parts_inbound_evidence',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              intent: { type: 'string' },
              request_is_valid: { type: 'boolean' },
              detected_subject: { type: 'string' },
              confidence: { type: 'number' },
              ai_summary: { type: 'string' },
              suggested_service: { type: 'string' },
              requested_part_text: { type: 'string' },
              normalized_part_name: { type: 'string' },
              normalized_part_category: { type: 'string' },
              plate: { type: 'string' },
              vin: { type: 'string' },
              oe_code: { type: 'string' },
              glass_position: { type: 'string' },
              side: { type: 'string' },
              axle: { type: 'string' },
              brake_component: { type: 'string' },
              filter_type: { type: 'string' },
              missing_fields: {
                type: 'array',
                items: { type: 'string' }
              },
              ready_for_service: { type: 'boolean' },
              next_best_question: { type: 'string' },
              operator_reply_text: { type: 'string' },
              status: { type: 'string' }
            },
            required: ['intent', 'request_is_valid', 'detected_subject', 'confidence', 'ai_summary', 'suggested_service', 'requested_part_text', 'normalized_part_name', 'normalized_part_category', 'plate', 'vin', 'oe_code', 'glass_position', 'side', 'axle', 'brake_component', 'filter_type', 'missing_fields', 'ready_for_service', 'next_best_question', 'operator_reply_text', 'status']
          }
        }
      },
      messages: [
        {
          role: 'system',
          content: 'Sei il motore di raccolta evidenze di Horygon Parts Systems. Devi raccogliere il prima possibile le informazioni minime per interrogare i webservice ricambi con il minor numero di domande. In input puoi ricevere solo testo, solo foto, o foto con testo. Non inventare dati. Se la foto mostra una targa o un libretto, priorita assoluta a estrarre targa e VIN. Se la foto mostra un pezzo o un etichetta, estrai codice OE, descrizione probabile e categoria. next_best_question deve essere una sola domanda breve e ad alto valore informativo. operator_reply_text deve essere la risposta pronta da inviare al cliente, dinamica e concreta. Se hai gia dati sufficienti per partire con i servizi, ready_for_service=true. normalized_part_category deve essere uno tra cristalli, freni, filtri, retrovisori, illuminazione, ricambio_generico.'
        },
        {
          role: 'user',
          content: JSON.stringify({
            message_text: cleanMessageText,
            media_analysis: mediaData,
            current_context: context || {},
            intake_state: intakeState?.slots || {}
          })
        }
      ]
    })
  });

  const raw = await response.text();
  const parsed = parseWhatsappResponseBody(raw);
  if (!response.ok) {
    return {
      skipped: false,
      error: parsed?.error?.message || raw || `OpenAI evidence HTTP ${response.status}`,
      meta: { model, statusCode: response.status, raw, parsed }
    };
  }
  const content = parsed?.choices?.[0]?.message?.content;
  if (!content) {
    return {
      skipped: false,
      error: 'Risposta OpenAI evidence vuota',
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
      error: 'JSON OpenAI evidence non valido',
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

  if (!options.length && items.length) {
    const fallbackRanked = items
      .map((item) => {
        const haystack = `${item.description} ${item.oe_code} ${item.eurocode}`.toLowerCase();
        const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
        return { item, score };
      })
      .sort((a, b) => b.score - a.score);

    for (const entry of fallbackRanked) {
      const label = (entry.item.description || entry.item.oe_code || entry.item.eurocode || 'Ricambio cristalli').trim();
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      options.push(entry.item);
    }
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

function buildOeLookupReplyText({
  oeCode = '',
  exactItem = null,
  searchItems = [],
  equivalentItems = [],
  needsPlateForGlass = false,
  identifiedVehicle = null,
  vehicleMatches = [],
  dbrtItems = []
}) {
  const exactLabel = exactItem?.description || exactItem?.part_number || oeCode || 'Ricambio OE';
  if (exactItem) {
    const lines = [
      `Ho verificato il codice OE ${oeCode || exactItem.oe_code || exactItem.part_number || ''} sui servizi RTWS attivi.`,
      '',
      identifiedVehicle ? `Veicolo verificato: ${buildVehicleSummaryLabel(identifiedVehicle) || 'veicolo da targa acquisito'}` : null,
      `Descrizione: ${exactLabel}`,
      exactItem.oe_code ? `Codice OE: ${exactItem.oe_code}` : null,
      exactItem.part_number && exactItem.part_number !== exactItem.oe_code ? `Part number: ${exactItem.part_number}` : null,
      exactItem.price ? `Prezzo listino indicativo: EUR ${exactItem.price}` : null,
      dbrtItems.length > 1 ? `Varianti tecniche BDRT sul veicolo: ${dbrtItems.length}.` : null,
      (!identifiedVehicle && vehicleMatches.length) ? `Veicoli compatibili trovati in BDRT: ${vehicleMatches.length}.` : null,
      equivalentItems.length ? `Equivalenti trovati: ${equivalentItems.length}.` : null,
      needsPlateForGlass
        ? 'Il codice sembra appartenere ai cristalli. Inviami la targa e verifico subito la compatibilita veicolo e le varianti corrette.'
        : null
    ].filter(Boolean);
    return lines.join('\n');
  }

  const candidateItems = dedupeOeLookupItems([...searchItems, ...dbrtItems]);
  if (candidateItems.length) {
    const lines = [
      `Ho trovato alcune corrispondenze RTWS per il codice OE ${oeCode}.`,
      identifiedVehicle ? `Veicolo verificato: ${buildVehicleSummaryLabel(identifiedVehicle) || 'veicolo da targa acquisito'}` : null,
      (!identifiedVehicle && vehicleMatches.length) ? `Veicoli compatibili trovati in BDRT: ${vehicleMatches.length}.` : null,
      'Ti elenco le piu vicine:'
    ].filter(Boolean);
    candidateItems.slice(0, 5).forEach((item, index) => {
      const parts = [
        `${index + 1}. ${item.description || item.part_number || item.oe_code || 'Ricambio OE'}`,
        item.oe_code ? `OE ${item.oe_code}` : null,
        item.part_number && item.part_number !== item.oe_code ? `PN ${item.part_number}` : null,
        item.price ? `EUR ${item.price}` : null
      ].filter(Boolean);
      lines.push(parts.join(' - '));
    });
    if (candidateItems.length > 5) {
      lines.push(`Ci sono anche altre ${candidateItems.length - 5} corrispondenze possibili.`);
    }
    lines.push(
      identifiedVehicle
        ? 'Rispondi con il numero corretto se riconosci il ricambio giusto, oppure mandami altri dettagli per la verifica finale.'
        : 'Rispondi con il numero corretto, oppure inviami la targa o altri dettagli del ricambio per restringere la verifica.'
    );
    return lines.join('\n');
  }

  if (vehicleMatches.length) {
    return `Ho trovato ${vehicleMatches.length} veicoli compatibili per il codice OE ${oeCode}, ma per chiudere la ricerca in automatico mi serve la targa oppure un dettaglio in piu sul ricambio.`;
  }

  return `Ho verificato il codice OE ${oeCode}, ma sui servizi attivi oggi non ho trovato un riscontro automatico utilizzabile. Se mi mandi la targa oppure una foto del ricambio provo la verifica migliore disponibile.`;
}

// Legacy resolver kept only as historical reference. Runtime webhook flow uses resolvePartsMessageV2.
async function legacyResolvePartsMessageUnused({ message, channel = 'whatsapp', context = null }) {
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
  } else if (!parsed.plate && !parsed.vin && !parsed.oeCode) {
    whatsappText = whatsappText || 'Per usare i servizi attivi oggi ho bisogno di almeno uno tra targa, VIN o codice OE, oltre al tipo di cristallo/ricambio richiesto.';
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

async function resolvePartsMessageV2({ message, channel = 'whatsapp', context = null, intakeState = null, mediaAnalysis = null }) {
  const text = String(message || '').trim();
  const mediaAi = mediaAnalysis?.data || null;
  const trustMediaPartExtraction = shouldTrustMediaPartExtraction(mediaAi, text);
  const effectiveText = buildMediaDerivedMessageText(text, mediaAi) || text || (mediaAi ? '[evidenza immagine]' : '');
  if (!effectiveText && !mediaAi) return { status: 'ERROR', error: 'message obbligatorio' };

  const previousContext = context || {};
  const previousIntakeState = intakeState || { slots: {} };
  const mediaVehicleKeyDetected = !!(s(mediaAi?.plate) || s(mediaAi?.vin));
  const mediaDocumentDetected = !!(mediaAi && (
    isLikelyVehicleDocumentAnalysis(mediaAi)
    || hasVehicleDocumentTextHints([
      mediaAi?.summary,
      mediaAi?.visible_text,
      mediaAi?.followup_question
    ].filter(Boolean).join(' '))
  ));
  const earlyPlate = normalizePlate(extractPlateFromText(text));
  const earlyVin = extractVinFromText(text);
  const earlyOeCode = sanitizeOeCode(extractOeCodeFromText(text), earlyPlate);
  const earlyExplicitPart = deriveExplicitPartRequest(text, earlyPlate, earlyVin, earlyOeCode);
  const selfContainedFreshRequest = !!earlyExplicitPart && !!(earlyPlate || earlyVin || earlyOeCode);
  const masterCase = classifyInboundCase({ text, mediaAi });
  const assistantWakeIntent = detectAssistantWakeIntent(text);
  const guidedChoice = (channel === 'telegram' || (channel === 'whatsapp' && !assistantWakeIntent))
    ? detectGuidedIntakeChoice(text)
    : '';
  const sessionIntent = detectSessionKeywordIntent(text);
  const currentPartSummary = buildCurrentPartSummary(previousIntakeState.slots || {}, previousContext);
  const normalizedAnswer = text.toLowerCase();
  const yesAnswer = /^(si|sì|yes|ok|va bene|procedi|confermo)$/i.test(normalizedAnswer);
  const noAnswer = /^(no|no grazie|annulla|non ora)$/i.test(normalizedAnswer);
  const variantsRequest = /^(mostra( tutte)?( le)? varianti|varianti|altre varianti)$/i.test(text);
  const numericSelection = text.match(/^\s*(\d{1,2})\s*$/);
  const bypassPendingForFreshRequest = selfContainedFreshRequest
    && ['ambiguous_code_type', 'session_action', 'quote_pdf_confirmation'].includes(String(previousIntakeState.pendingSlot || ''));
  const currentRequestAwaitingClarification = ['part_name', 'glass_position', 'vehicle_key', 'plate', 'part_name_clarification'].includes(String(previousIntakeState.pendingSlot || ''))
    || ['waiting_part_name', 'waiting_glass_position', 'waiting_vehicle_key', 'waiting_service_key', 'document_vehicle_data_completed', 'waiting_oe_option_selection'].includes(String(previousIntakeState.stage || ''));
  const previousOptions = Array.isArray(previousIntakeState.slots?.proposed_glass_options)
    ? previousIntakeState.slots.proposed_glass_options
    : [];
  const previousOeOptions = Array.isArray(previousIntakeState.slots?.proposed_oe_options)
    ? previousIntakeState.slots.proposed_oe_options
    : [];
  const guidedDocumentRequested = String(previousIntakeState.pendingSlot || '') === 'vehicle_document_photo';

  if (guidedChoice) {
    return buildGuidedChoiceResponse({
      choice: guidedChoice,
      text,
      previousContext,
      previousIntakeState,
      channel
    });
  }

  if (assistantWakeIntent && channel !== 'telegram') {
    const quoteMeta = getLinkedQuoteMeta(previousIntakeState.slots || {}, previousContext);
    const activeSessionText = currentPartSummary
      ? (quoteMeta.id || quoteMeta.code
        ? `Ciao, sono Vera. Hai gia una richiesta aperta per ${currentPartSummary} collegata al preventivo ${quoteMeta.code || `#${quoteMeta.id}`}. Puoi inviarmi subito un nuovo ricambio, scrivere INFO oppure CHIUDI SESSIONE.`
        : `Ciao, sono Vera. Hai gia una richiesta aperta per ${currentPartSummary}. Puoi inviarmi subito un nuovo ricambio, scrivere INFO oppure CHIUDI SESSIONE.`)
      : buildAssistantWakeReplyText();
    return {
      status: 'OK',
      parsed: {
        originalText: text,
        plate: s(previousIntakeState.slots?.plate) || s(previousContext.plate) || '',
        vin: s(previousIntakeState.slots?.vin) || s(previousContext.vin) || '',
        oeCode: s(previousIntakeState.slots?.oe_code) || s(previousContext.oe_code) || '',
        requestedPartText: currentPartSummary,
        confidence: 1
      },
      vehicle: null,
      normalizedPart: {
        name: currentPartSummary,
        category: normalizePartCategory(s(previousIntakeState.slots?.part_category) || s(previousContext.normalized_part_category), currentPartSummary)
      },
      dbrtResult: {},
      glassCatalog: { status: 'SKIPPED', message: 'Keyword di avvio Vera riconosciuta', items: [] },
      oeCatalog: {},
      oeResults: [],
      equivalents: {},
      missingData: currentPartSummary ? [] : ['vehicle_key', 'part_name'],
      whatsappText: activeSessionText,
      aiRequest: {
        intent: currentPartSummary ? 'assistant_wake_active_session' : 'assistant_wake',
        request_is_valid: true,
        suggested_service: 'WAITING_DATA',
        instruction: 'Keyword Vera riconosciuta come ingresso esplicito nel flusso assistente.',
        availableSources: ['KEYWORDS', 'CONVERSATION_CONTEXT'],
        masterCase,
        openai: { skipped: true, error: null, model: null, statusCode: null, raw: null, parsed: null }
      },
      aiSummary: currentPartSummary
        ? 'Keyword Vera ricevuta con sessione aperta.'
        : 'Keyword Vera ricevuta come avvio del flusso guidato.',
      resolvedStatus: currentPartSummary ? (s(previousContext.status) || 'in_lavorazione') : null,
      intakeState: currentPartSummary
        ? {
          ...previousIntakeState,
          pendingQuestion: activeSessionText
        }
        : {
          stage: 'guided_root_menu',
          pendingSlot: null,
          pendingQuestion: activeSessionText,
          slots: {
            ...(previousIntakeState.slots || {})
          }
        }
    };
  }

  if (!text && (mediaVehicleKeyDetected || mediaDocumentDetected || guidedDocumentRequested)) {
    return buildVehicleDocumentWaitingResponse({
      text,
      channel,
      previousContext,
      previousIntakeState,
      mediaAi
    });
  }

  if (sessionIntent === 'info') {
    return {
      status: 'OK',
      parsed: {
        originalText: text,
        plate: s(previousIntakeState.slots?.plate) || s(previousContext.plate) || '',
        vin: s(previousIntakeState.slots?.vin) || s(previousContext.vin) || '',
        oeCode: s(previousIntakeState.slots?.oe_code) || s(previousContext.oe_code) || '',
        requestedPartText: currentPartSummary,
        confidence: 1
      },
      vehicle: null,
      normalizedPart: {
        name: currentPartSummary,
        category: normalizePartCategory(s(previousIntakeState.slots?.part_category) || s(previousContext.normalized_part_category), currentPartSummary)
      },
      dbrtResult: {},
      glassCatalog: { status: 'SKIPPED', message: 'Messaggio informativo richiesto da keyword utente', items: [] },
      oeCatalog: {},
      oeResults: [],
      equivalents: {},
      missingData: [],
      whatsappText: buildInfoKeywordReplyText(),
      aiRequest: {
        intent: 'info_keyword',
        request_is_valid: true,
        suggested_service: 'WAITING_DATA',
        instruction: 'Messaggio informativo richiesto da keyword utente senza modificare la sessione corrente.',
        availableSources: ['KEYWORDS'],
        masterCase,
        sessionIntent,
        openai: { skipped: true, error: null, model: null, statusCode: null, raw: null, parsed: null }
      },
      aiSummary: 'Messaggio informativo richiesto da keyword utente.',
      resolvedStatus: null
    };
  }

  if (sessionIntent === 'close') {
    return {
      status: 'OK',
      parsed: {
        originalText: text,
        plate: s(previousIntakeState.slots?.plate) || s(previousContext.plate) || '',
        vin: s(previousIntakeState.slots?.vin) || s(previousContext.vin) || '',
        oeCode: s(previousIntakeState.slots?.oe_code) || s(previousContext.oe_code) || '',
        requestedPartText: currentPartSummary,
        confidence: 1
      },
      vehicle: null,
      normalizedPart: {
        name: currentPartSummary,
        category: normalizePartCategory(s(previousIntakeState.slots?.part_category) || s(previousContext.normalized_part_category), currentPartSummary)
      },
      dbrtResult: {},
      glassCatalog: { status: 'SKIPPED', message: 'Sessione chiusa da keyword utente', items: [] },
      oeCatalog: {},
      oeResults: [],
      equivalents: {},
      missingData: [],
      whatsappText: currentPartSummary
        ? `Chiudo la sessione aperta per ${currentPartSummary}. Se ti serve altro puoi inviarmi una nuova richiesta.`
        : 'Chiudo la sessione aperta. Se ti serve altro puoi inviarmi una nuova richiesta.',
      aiRequest: {
        intent: 'session_close',
        request_is_valid: true,
        suggested_service: 'WAITING_DATA',
        instruction: 'Chiusura esplicita della sessione tramite keyword utente.',
        availableSources: ['KEYWORDS', 'CONVERSATION_CONTEXT'],
        masterCase,
        sessionIntent,
        openai: { skipped: true, error: null, model: null, statusCode: null, raw: null, parsed: null }
      },
      aiSummary: 'Sessione chiusa da keyword utente.',
      resolvedStatus: 'completata',
      intakeState: {
        stage: 'session_closed',
        pendingSlot: null,
        pendingQuestion: null,
        slots: {
          ...previousIntakeState.slots,
          session_closed_at: new Date().toISOString()
        }
      }
    };
  }

  if (previousIntakeState.pendingSlot === 'ambiguous_code_type' && !bypassPendingForFreshRequest) {
    const pendingValue = String(previousIntakeState.slots?.pending_ambiguous_code || '').toUpperCase();
    const resolvedCodeType = detectAmbiguousCodeTypeAnswer(text);
    if (pendingValue && noAnswer) {
      const clarificationQuestion = `Va bene. Allora ${pendingValue} non lo confermo come targa. Dimmi se e un codice OE oppure inviami la targa corretta.`;
      return {
        status: 'OK',
        parsed: {
          originalText: text,
          plate: '',
          vin: s(previousIntakeState.slots?.vin) || s(previousContext.vin) || '',
          oeCode: '',
          requestedPartText: s(previousIntakeState.slots?.pending_ambiguous_part_name) || s(previousIntakeState.slots?.part_name) || '',
          confidence: 0
        },
        vehicle: null,
        normalizedPart: {
          name: s(previousIntakeState.slots?.pending_ambiguous_part_name) || s(previousIntakeState.slots?.part_name) || '',
          category: normalizePartCategory(
            s(previousIntakeState.slots?.part_category) || s(previousContext.normalized_part_category),
            s(previousIntakeState.slots?.pending_ambiguous_part_name) || s(previousIntakeState.slots?.part_name) || ''
          )
        },
        dbrtResult: {},
        glassCatalog: { status: 'SKIPPED', message: 'In attesa di chiarimento aggiuntivo sul codice ambiguo', items: [] },
        oeCatalog: {},
        oeResults: [],
        equivalents: {},
        missingData: ['ambiguous_code_type'],
        whatsappText: clarificationQuestion,
        aiRequest: {
          intent: 'ambiguous_code_type_negative_confirmation',
          request_is_valid: true,
          suggested_service: 'WAITING_DATA',
          instruction: 'Il cliente ha negato che il valore ambiguo sia una targa. Richiedere se si tratta di codice OE oppure la targa corretta.',
          availableSources: ['RULES', 'CONVERSATION_CONTEXT'],
          masterCase,
          openai: { skipped: true, error: null, model: null, statusCode: null, raw: null, parsed: null }
        },
        aiSummary: 'Il cliente non conferma il valore ambiguo come targa.',
        resolvedStatus: 'in_attesa_dati_cliente',
        intakeState: {
          ...previousIntakeState,
          pendingSlot: 'ambiguous_code_type',
          pendingQuestion: clarificationQuestion,
          slots: {
            ...previousIntakeState.slots,
            plate: '',
            oe_code: ''
          }
        }
      };
    }
    if (pendingValue && resolvedCodeType) {
      const nextSlots = {
        ...previousIntakeState.slots,
        pending_ambiguous_code: '',
        plate: resolvedCodeType === 'plate'
          ? normalizePlate(pendingValue)
          : (s(previousIntakeState.slots?.plate) || ''),
        oe_code: resolvedCodeType === 'oe_code'
          ? sanitizeOeCode(pendingValue, s(previousIntakeState.slots?.plate) || '')
          : (s(previousIntakeState.slots?.oe_code) || '')
      };
      const nextText = s(previousIntakeState.slots?.pending_ambiguous_part_name)
        || s(previousIntakeState.slots?.part_name)
        || text;
      return resolvePartsMessageV2({
        message: nextText,
        channel,
        context: {
          ...previousContext,
          plate: nextSlots.plate || s(previousContext.plate) || '',
          oe_code: nextSlots.oe_code || s(previousContext.oe_code) || ''
        },
        intakeState: {
          ...previousIntakeState,
          pendingSlot: null,
          pendingQuestion: null,
          slots: {
            ...nextSlots,
            pending_ambiguous_part_name: ''
          }
        },
        mediaAnalysis
      });
    }
    return {
      status: 'OK',
      parsed: {
        originalText: text,
        plate: s(previousIntakeState.slots?.plate) || s(previousContext.plate) || '',
        vin: s(previousIntakeState.slots?.vin) || s(previousContext.vin) || '',
        oeCode: s(previousIntakeState.slots?.oe_code) || s(previousContext.oe_code) || '',
        requestedPartText: s(previousIntakeState.slots?.part_name) || s(previousContext.normalized_part_name) || '',
        confidence: 0
      },
      vehicle: null,
      normalizedPart: {
        name: s(previousIntakeState.slots?.part_name) || s(previousContext.normalized_part_name) || '',
        category: normalizePartCategory(
          s(previousIntakeState.slots?.part_category) || s(previousContext.normalized_part_category),
          s(previousIntakeState.slots?.part_name) || s(previousContext.normalized_part_name) || ''
        )
      },
      dbrtResult: {},
      glassCatalog: { status: 'SKIPPED', message: 'In attesa di chiarimento sul codice ambiguo', items: [] },
      oeCatalog: {},
      oeResults: [],
      equivalents: {},
      missingData: ['ambiguous_code_type'],
      whatsappText: `Ho il valore ${pendingValue || 'indicato'} in sospeso. Mi confermi se e una targa oppure un codice OE?`,
      aiRequest: {
        intent: 'ambiguous_code_type_repeat',
        request_is_valid: true,
        suggested_service: 'WAITING_DATA',
        instruction: 'Richiesta di chiarimento per distinguere tra targa e codice OE.',
        availableSources: ['RULES', 'CONVERSATION_CONTEXT'],
        masterCase,
        openai: { skipped: true, error: null, model: null, statusCode: null, raw: null, parsed: null }
      },
      aiSummary: 'In attesa di conferma se il codice inserito e una targa o un codice OE.',
      resolvedStatus: 'in_attesa_dati_cliente',
      intakeState: previousIntakeState
    };
  }

  if (previousIntakeState.pendingSlot === 'session_action' && !bypassPendingForFreshRequest) {
    const proposedPartName = s(previousIntakeState.slots?.proposed_next_part_name) || '';
    const proposedCategory = s(previousIntakeState.slots?.proposed_next_part_category) || '';
    const baseSlots = previousIntakeState.slots || {};
    const quoteMeta = getLinkedQuoteMeta(baseSlots, previousContext);

    if (noAnswer) {
      return {
        status: 'OK',
        parsed: {
          originalText: text,
          plate: s(baseSlots.plate) || s(previousContext.plate) || '',
          vin: s(baseSlots.vin) || s(previousContext.vin) || '',
          oeCode: s(baseSlots.oe_code) || s(previousContext.oe_code) || '',
          requestedPartText: currentPartSummary || proposedPartName,
          confidence: 1
        },
        vehicle: null,
        normalizedPart: {
          name: currentPartSummary || proposedPartName,
          category: normalizePartCategory(
            s(baseSlots.part_category) || proposedCategory || s(previousContext.normalized_part_category),
            currentPartSummary || proposedPartName
          )
        },
        dbrtResult: {},
        glassCatalog: { status: 'SKIPPED', message: 'Nuovo ricambio non confermato, sessione corrente mantenuta', items: [] },
        oeCatalog: {},
        oeResults: [],
        equivalents: {},
        missingData: [],
        whatsappText: currentPartSummary
          ? (quoteMeta.id || quoteMeta.code
            ? `Va bene, continuo con la richiesta aperta per ${currentPartSummary} e tengo valido il preventivo ${quoteMeta.code || `#${quoteMeta.id}`}.`
            : `Va bene, continuo con la richiesta aperta per ${currentPartSummary}.`)
          : 'Va bene, continuo con la richiesta aperta.',
        aiRequest: {
          intent: 'session_action_cancelled',
          request_is_valid: true,
          suggested_service: 'WAITING_DATA',
          instruction: 'Il cliente non vuole sostituire o aggiungere il nuovo testo rilevato. Mantieni la richiesta corrente.',
          availableSources: ['KEYWORDS', 'CONVERSATION_CONTEXT'],
          masterCase,
          sessionIntent,
          openai: { skipped: true, error: null, model: null, statusCode: null, raw: null, parsed: null }
        },
        aiSummary: 'Richiesta corrente mantenuta, proposta di nuovo ricambio annullata.',
        resolvedStatus: s(previousContext.status) || 'in_lavorazione',
        intakeState: {
          stage: previousIntakeState.stage || 'in_lavorazione',
          pendingSlot: null,
          pendingQuestion: null,
          slots: {
            ...baseSlots,
            proposed_next_part_name: '',
            proposed_next_part_category: '',
            proposed_next_part_source: ''
          }
        }
      };
    }

    if (sessionIntent === 'replace_part') {
      return {
        status: 'OK',
        parsed: {
          originalText: text,
          plate: s(baseSlots.plate) || s(previousContext.plate) || '',
          vin: s(baseSlots.vin) || s(previousContext.vin) || '',
          oeCode: s(baseSlots.oe_code) || s(previousContext.oe_code) || '',
          requestedPartText: proposedPartName,
          confidence: 1
        },
        vehicle: null,
        normalizedPart: {
          name: proposedPartName,
          category: normalizePartCategory(proposedCategory, proposedPartName)
        },
        dbrtResult: {},
        glassCatalog: { status: 'SKIPPED', message: 'Sostituzione ricambio confermata', items: [] },
        oeCatalog: {},
        oeResults: [],
        equivalents: {},
        missingData: [],
        whatsappText: `Perfetto, sostituisco il ricambio corrente con ${proposedPartName}. Procedo con questa nuova ricerca.`,
        aiRequest: {
          intent: 'session_replace_part',
          request_is_valid: true,
          suggested_service: 'WAITING_DATA',
          instruction: 'L utente ha scelto di sostituire il ricambio della sessione aperta.',
          availableSources: ['KEYWORDS', 'CONVERSATION_CONTEXT'],
          masterCase,
          sessionIntent,
          openai: { skipped: true, error: null, model: null, statusCode: null, raw: null, parsed: null }
        },
        aiSummary: 'Ricambio corrente sostituito nella sessione aperta.',
        resolvedStatus: 'in_lavorazione',
        intakeState: {
          stage: 'part_replaced',
          pendingSlot: null,
          pendingQuestion: null,
          slots: {
            ...baseSlots,
            part_name: proposedPartName,
            part_category: normalizePartCategory(proposedCategory, proposedPartName),
            quote_append_requested: false,
            proposed_next_part_name: '',
            proposed_next_part_category: '',
            proposed_next_part_source: ''
          }
        }
      };
    }

    if (sessionIntent === 'add_part') {
      const sessionParts = appendSessionPart(baseSlots, {
        part_name: currentPartSummary,
        part_category: s(baseSlots.part_category) || s(previousContext.normalized_part_category) || '',
        plate: s(baseSlots.plate) || s(previousContext.plate) || '',
        vin: s(baseSlots.vin) || s(previousContext.vin) || '',
        oe_code: s(baseSlots.oe_code) || s(previousContext.oe_code) || ''
      });
      return {
        status: 'OK',
        parsed: {
          originalText: text,
          plate: s(baseSlots.plate) || s(previousContext.plate) || '',
          vin: s(baseSlots.vin) || s(previousContext.vin) || '',
          oeCode: s(baseSlots.oe_code) || s(previousContext.oe_code) || '',
          requestedPartText: proposedPartName,
          confidence: 1
        },
        vehicle: null,
        normalizedPart: {
          name: proposedPartName,
          category: normalizePartCategory(proposedCategory, proposedPartName)
        },
        dbrtResult: {},
        glassCatalog: { status: 'SKIPPED', message: 'Aggiunta nuovo ricambio alla stessa sessione', items: [] },
        oeCatalog: {},
        oeResults: [],
        equivalents: {},
        missingData: [],
        whatsappText: quoteMeta.id || quoteMeta.code
          ? `Perfetto, tengo aperta la richiesta precedente e aggiungo anche ${proposedPartName} allo stesso preventivo ${quoteMeta.code || `#${quoteMeta.id}`}. Procedo con il nuovo ricambio.`
          : `Perfetto, tengo aperta la richiesta precedente e aggiungo anche ${proposedPartName}. Procedo con il nuovo ricambio.`,
        aiRequest: {
          intent: 'session_add_part',
          request_is_valid: true,
          suggested_service: 'WAITING_DATA',
          instruction: 'L utente ha scelto di aggiungere un nuovo ricambio nella stessa sessione.',
          availableSources: ['KEYWORDS', 'CONVERSATION_CONTEXT'],
          masterCase,
          sessionIntent,
          openai: { skipped: true, error: null, model: null, statusCode: null, raw: null, parsed: null }
        },
        aiSummary: 'Nuovo ricambio aggiunto nella stessa sessione.',
        resolvedStatus: 'in_lavorazione',
        intakeState: {
          stage: 'part_added',
          pendingSlot: null,
          pendingQuestion: null,
          slots: {
            ...baseSlots,
            session_parts: sessionParts,
            part_name: proposedPartName,
            part_category: normalizePartCategory(proposedCategory, proposedPartName),
            quote_append_requested: !!(quoteMeta.id || quoteMeta.code),
            proposed_next_part_name: '',
            proposed_next_part_category: '',
            proposed_next_part_source: ''
          }
        }
      };
    }

    return {
      status: 'OK',
      parsed: {
        originalText: text,
        plate: s(baseSlots.plate) || s(previousContext.plate) || '',
        vin: s(baseSlots.vin) || s(previousContext.vin) || '',
        oeCode: s(baseSlots.oe_code) || s(previousContext.oe_code) || '',
        requestedPartText: proposedPartName || currentPartSummary,
        confidence: 0
      },
      vehicle: null,
      normalizedPart: {
        name: proposedPartName || currentPartSummary,
        category: normalizePartCategory(proposedCategory || s(baseSlots.part_category), proposedPartName || currentPartSummary)
      },
      dbrtResult: {},
      glassCatalog: { status: 'SKIPPED', message: 'In attesa della scelta aggiungi/sostituisci', items: [] },
      oeCatalog: {},
      oeResults: [],
      equivalents: {},
      missingData: ['session_action'],
      whatsappText: buildSessionActionQuestion(currentPartSummary || 'questo ricambio', proposedPartName || 'il nuovo pezzo', quoteMeta),
      aiRequest: {
        intent: 'session_action_repeat',
        request_is_valid: true,
        suggested_service: 'WAITING_DATA',
        instruction: 'Ripetizione della scelta di sessione tra sostituzione o aggiunta del nuovo ricambio.',
        availableSources: ['KEYWORDS', 'CONVERSATION_CONTEXT'],
        masterCase,
        sessionIntent,
        openai: { skipped: true, error: null, model: null, statusCode: null, raw: null, parsed: null }
      },
      aiSummary: 'In attesa della scelta utente per gestire il nuovo ricambio nella stessa sessione.',
      resolvedStatus: 'in_attesa_dati_cliente',
      intakeState: previousIntakeState
    };
  }
  if (previousIntakeState.pendingSlot === 'quote_pdf_confirmation' && !bypassPendingForFreshRequest) {
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
          whatsappText: buildQuotePdfQuestionText(
            selectedItem,
            previousIntakeState.slots?.quote_append_requested ? (s(previousIntakeState.slots?.linked_preventivo_code) || '') : ''
          ),
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
    const existingQuoteCode = previousIntakeState.slots?.quote_append_requested
      ? (s(previousIntakeState.slots?.linked_preventivo_code) || '')
      : '';
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
        whatsappText: existingQuoteCode
          ? `Perfetto, aggiorno subito il preventivo ${existingQuoteCode} in PDF e te lo invio qui su WhatsApp.`
          : 'Perfetto, preparo subito il preventivo PDF e te lo invio qui su WhatsApp.',
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
        resolvedStatus: 'completata',
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
        whatsappText: existingQuoteCode
          ? `Va bene, non aggiorno il PDF del preventivo ${existingQuoteCode} per ora. La richiesta resta aperta e possiamo procedere quando vuoi.`
          : 'Va bene, non genero il PDF per ora. La richiesta resta salvata e possiamo procedere quando vuoi.',
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
        resolvedStatus: existingQuoteCode ? 'preventivo_pronto' : 'completata',
        intakeState: {
          stage: 'selection_completed',
          pendingSlot: null,
          pendingQuestion: null,
          slots: {
            ...previousIntakeState.slots,
            quote_pdf_requested: false,
            quote_append_requested: false
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
        whatsappText: buildQuotePdfQuestionText(
          selectedItem,
          previousIntakeState.slots?.quote_append_requested ? (s(previousIntakeState.slots?.linked_preventivo_code) || '') : ''
        ),
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

  if (variantsRequest && previousOeOptions.length) {
    const parsed = {
      originalText: text,
      plate: s(previousIntakeState.slots?.plate) || s(previousContext.plate) || '',
      vin: s(previousIntakeState.slots?.vin) || s(previousContext.vin) || '',
      oeCode: s(previousIntakeState.slots?.oe_code) || s(previousContext.oe_code) || '',
      requestedPartText: s(previousIntakeState.slots?.part_name) || s(previousContext.normalized_part_name) || 'Ricambio OE',
      confidence: 1
    };
    const normalizedPart = {
      name: s(previousIntakeState.slots?.part_name) || 'Ricambio OE',
      category: s(previousIntakeState.slots?.part_category) || normalizePartCategory('', s(previousIntakeState.slots?.part_name) || '')
    };
    return {
      status: 'OK',
      parsed,
      vehicle: null,
      normalizedPart,
      dbrtResult: {},
      glassCatalog: { status: 'SKIPPED', message: 'Varianti OE riproposte al cliente', items: [] },
      oeCatalog: { status: 'READY', message: 'Varianti OE riproposte al cliente', items: previousOeOptions },
      oeResults: previousOeOptions,
      equivalents: {},
      missingData: [],
      whatsappText: buildOeLookupReplyText({
        oeCode: parsed.oeCode,
        searchItems: previousOeOptions
      }),
      aiRequest: {
        intent: 'oe_options_recap',
        request_is_valid: true,
        suggested_service: 'RTWS_LISTINI_LOOKUP_BY_OE',
        instruction: 'Riproposta delle varianti OE gia trovate in precedenza.',
        availableSources: ['CONVERSATION_CONTEXT', 'RTWS_LISTINI', 'RTWS_BDRT'],
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
      intakeState: previousIntakeState
    };
  }

  if (numericSelection && previousOeOptions.length) {
    const selectedIndex = Number(numericSelection[1]) - 1;
    const selectedItem = previousOeOptions[selectedIndex];
    if (selectedItem) {
      const parsed = {
        originalText: text,
        plate: s(previousIntakeState.slots?.plate) || s(previousContext.plate) || '',
        vin: s(previousIntakeState.slots?.vin) || s(previousContext.vin) || '',
        oeCode: s(selectedItem.oe_code) || s(previousIntakeState.slots?.oe_code) || '',
        requestedPartText: s(previousIntakeState.slots?.part_name) || s(previousContext.normalized_part_name) || 'Ricambio OE',
        confidence: 1
      };
      const normalizedPart = {
        name: s(previousIntakeState.slots?.part_name) || s(selectedItem.description) || 'Ricambio OE',
        category: s(previousIntakeState.slots?.part_category) || normalizePartCategory('', `${s(previousIntakeState.slots?.part_name)} ${s(selectedItem.description)}`.trim())
      };
      return {
        status: 'OK',
        parsed,
        vehicle: null,
        normalizedPart,
        dbrtResult: {},
        glassCatalog: { status: 'SKIPPED', message: 'Variante OE selezionata da cliente', items: [] },
        oeCatalog: { status: 'READY', message: 'Variante OE selezionata da cliente', items: previousOeOptions },
        oeResults: [selectedItem],
        equivalents: {},
        missingData: ['quote_pdf_confirmation'],
        whatsappText: buildQuotePdfQuestionText(
          selectedItem,
          previousIntakeState.slots?.quote_append_requested ? (s(previousIntakeState.slots?.linked_preventivo_code) || '') : ''
        ),
        aiRequest: {
          intent: 'oe_option_selection',
          request_is_valid: true,
          suggested_service: 'RTWS_LISTINI_LOOKUP_BY_OE',
          instruction: 'Selezione diretta di una variante OE proposta in precedenza.',
          availableSources: ['CONVERSATION_CONTEXT', 'RTWS_LISTINI', 'RTWS_BDRT'],
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
            proposed_oe_options: previousOeOptions
          }
        }
      };
    }
  }

  if (masterCase === 'document_image_only') {
    return buildVehicleDocumentWaitingResponse({
      text,
      channel,
      previousContext,
      previousIntakeState,
      mediaAi
    });
  }

  const evidenceResult = await analyzeInboundEvidenceWithOpenAI({
    messageText: text,
    mediaAnalysis,
    context: previousContext,
    intakeState: previousIntakeState
  });
  const evidence = evidenceResult.data || {};
  const useEvidencePartExtraction = shouldTrustEvidencePartExtraction(evidence, text);

  const fallbackPlate = extractPlateFromText(effectiveText);
  const fallbackVin = extractVinFromText(effectiveText);
  const fallbackOeCode = sanitizeOeCode(extractOeCodeFromText(effectiveText), fallbackPlate);
  const basePlate = normalizePlate(fallbackPlate || s(evidence.plate) || mediaAi?.plate || previousContext.plate || previousIntakeState.slots?.plate || '');
  const baseVin = fallbackVin || s(evidence.vin) || s(mediaAi?.vin) || s(previousContext.vin) || s(previousIntakeState.slots?.vin) || '';
  const baseOeCode = sanitizeOeCode(
    fallbackOeCode || s(evidence.oe_code) || s(mediaAi?.oe_code) || s(previousContext.oe_code) || s(previousIntakeState.slots?.oe_code) || '',
    basePlate
  );
  const explicitBodyPartText = deriveExplicitPartRequest(text, basePlate, baseVin, baseOeCode);
  const explicitEffectivePartText = (!isSyntheticInboundPlaceholder(text) && text)
    ? deriveExplicitPartRequest(effectiveText, basePlate, baseVin, baseOeCode)
    : '';
  const currentMessageGlassPosition = detectGlassPosition(`${explicitBodyPartText || ''} ${explicitEffectivePartText || ''} ${text}`.trim());
  const currentMessageSide = detectSide(`${explicitBodyPartText || ''} ${explicitEffectivePartText || ''} ${text}`.trim());
  const currentMessageAxle = detectAxle(`${explicitBodyPartText || ''} ${explicitEffectivePartText || ''} ${text}`.trim());
  const currentMessageBrakeComponent = detectBrakeComponent(`${explicitBodyPartText || ''} ${explicitEffectivePartText || ''} ${text}`.trim());
  const currentMessageFilterType = detectFilterType(`${explicitBodyPartText || ''} ${explicitEffectivePartText || ''} ${text}`.trim());
  const preferredPartCandidate = choosePreferredPartCandidate([
    {
      name: explicitBodyPartText,
      category: normalizePartCategory('', explicitBodyPartText),
      source: 'explicit_body_text',
      preferDeterministic: true
    },
    {
      name: explicitEffectivePartText,
      category: normalizePartCategory('', explicitEffectivePartText),
      source: 'explicit_effective_text',
      preferDeterministic: true
    },
    useEvidencePartExtraction ? {
      name: s(evidence.normalized_part_name) || s(evidence.requested_part_text) || '',
      category: s(evidence.normalized_part_category) || '',
      source: 'openai_evidence'
    } : null,
    trustMediaPartExtraction ? {
      name: s(mediaAi?.normalized_part_name) || s(mediaAi?.requested_part_text) || '',
      category: s(mediaAi?.normalized_part_category) || '',
      source: 'media_analysis'
    } : null,
    {
      name: s(previousContext.normalized_part_name) || s(previousContext.requested_part_text) || '',
      category: s(previousContext.normalized_part_category) || '',
      source: 'previous_context'
    }
  ].filter(Boolean));
  const baseRequestedPartText = preferredPartCandidate.name
    || s(previousContext.requested_part_text)
    || s(previousContext.normalized_part_name)
    || '';
  const baseRequestedPartCategory = preferredPartCandidate.category
    || normalizePartCategory(
      s(evidence.normalized_part_category) || s(mediaAi?.normalized_part_category) || s(previousContext.normalized_part_category),
      baseRequestedPartText
    );

  const previousOpenPart = buildCurrentPartSummary(previousIntakeState.slots || {}, previousContext);
  const incomingExplicitPart = explicitBodyPartText || explicitEffectivePartText || '';
  if (
    !selfContainedFreshRequest
    &&
    !currentRequestAwaitingClarification
    &&
    previousOpenPart
    && incomingExplicitPart
    && !isOperationalFeedbackMessage(incomingExplicitPart)
    && previousOpenPart.toLowerCase() !== incomingExplicitPart.toLowerCase()
    && normalizePartCategory('', incomingExplicitPart) !== 'ricambio_generico'
    && previousIntakeState.pendingSlot !== 'quote_pdf_confirmation'
  ) {
    const quoteMeta = getLinkedQuoteMeta(previousIntakeState.slots || {}, previousContext);
    const sessionActionQuestion = buildSessionActionQuestion(previousOpenPart, incomingExplicitPart, quoteMeta);
    return {
      status: 'OK',
      parsed: {
        originalText: text,
        plate: s(previousIntakeState.slots?.plate) || s(previousContext.plate) || '',
        vin: s(previousIntakeState.slots?.vin) || s(previousContext.vin) || '',
        oeCode: s(previousIntakeState.slots?.oe_code) || s(previousContext.oe_code) || '',
        requestedPartText: incomingExplicitPart,
        confidence: 1
      },
      vehicle: null,
      normalizedPart: {
        name: incomingExplicitPart,
        category: normalizePartCategory('', incomingExplicitPart)
      },
      dbrtResult: {},
      glassCatalog: { status: 'SKIPPED', message: 'Nuovo ricambio rilevato durante una sessione aperta', items: [] },
      oeCatalog: {},
      oeResults: [],
      equivalents: {},
      missingData: ['session_action'],
      whatsappText: sessionActionQuestion,
      aiRequest: {
        intent: 'session_action_needed',
        request_is_valid: true,
        suggested_service: 'WAITING_DATA',
        instruction: 'Rilevato un nuovo ricambio esplicito in una sessione ancora aperta. Chiedere se sostituire o aggiungere.',
        availableSources: ['RULES', 'CONVERSATION_CONTEXT'],
        masterCase,
        openai: { skipped: true, error: null, model: null, statusCode: null, raw: null, parsed: null }
      },
      aiSummary: 'Nuovo ricambio rilevato durante una sessione aperta: in attesa della scelta sostituisci/aggiungi.',
      resolvedStatus: 'in_attesa_dati_cliente',
      intakeState: {
        stage: 'waiting_session_action',
        pendingSlot: 'session_action',
        pendingQuestion: sessionActionQuestion,
        slots: {
          ...previousIntakeState.slots,
          proposed_next_part_name: incomingExplicitPart,
          proposed_next_part_category: normalizePartCategory('', incomingExplicitPart),
          proposed_next_part_source: masterCase
        }
      }
    };
  }

  const preliminaryParsed = {
    originalText: effectiveText,
    plate: basePlate,
    vin: baseVin,
    oeCode: baseOeCode,
    requestedPartText: baseRequestedPartText,
    confidence: 0
  };
  const preliminaryNormalizedPart = {
    name: preferredPartCandidate.name || s(previousContext.normalized_part_name) || preliminaryParsed.requestedPartText,
    category: baseRequestedPartCategory
  };

  const ambiguousCandidate = detectAmbiguousIdentifierCandidate({
    text,
    plate: preliminaryParsed.plate,
    vin: preliminaryParsed.vin,
    oeCode: preliminaryParsed.oeCode,
    partName: preliminaryParsed.requestedPartText
  });
  if (ambiguousCandidate) {
    return {
      status: 'OK',
      parsed: {
        originalText: text,
        plate: '',
        vin: '',
        oeCode: '',
        requestedPartText: '',
        confidence: 0
      },
      vehicle: null,
      normalizedPart: {
        name: '',
        category: ''
      },
      dbrtResult: {},
      glassCatalog: { status: 'SKIPPED', message: 'Codice ambiguo rilevato, chiarimento richiesto al cliente', items: [] },
      oeCatalog: {},
      oeResults: [],
      equivalents: {},
      missingData: ['ambiguous_code_type'],
      whatsappText: `Ho trovato il valore ${ambiguousCandidate}. Mi confermi se e una targa oppure un codice OE?`,
      aiRequest: {
        intent: 'ambiguous_code_type',
        request_is_valid: true,
        suggested_service: 'WAITING_DATA',
        instruction: 'Richiedere al cliente se il valore inserito rappresenta una targa oppure un codice OE.',
        availableSources: ['RULES', 'CONVERSATION_CONTEXT'],
        masterCase,
        openai: { skipped: true, error: null, model: null, statusCode: null, raw: null, parsed: null }
      },
      aiSummary: 'Rilevato valore ambiguo da classificare come targa o codice OE.',
      resolvedStatus: 'in_attesa_dati_cliente',
      intakeState: {
        stage: 'waiting_ambiguous_code_type',
        pendingSlot: 'ambiguous_code_type',
        pendingQuestion: `Ho trovato il valore ${ambiguousCandidate}. Mi confermi se e una targa oppure un codice OE?`,
        slots: {
          ...previousIntakeState.slots,
          pending_ambiguous_code: ambiguousCandidate,
          pending_ambiguous_part_name: ''
        }
      }
    };
  }

  const mergedIntakeSlots = mergeIntakeSlots({
    parsed: preliminaryParsed,
    normalizedPart: preliminaryNormalizedPart,
    context: selfContainedFreshRequest ? {} : previousContext,
    intakeState: selfContainedFreshRequest ? { slots: {} } : previousIntakeState
  });
  const intakeSlots = {
    linked_preventivo_id: i(previousIntakeState.slots?.linked_preventivo_id) || i(previousContext.linked_preventivo_id) || null,
    linked_preventivo_code: s(previousIntakeState.slots?.linked_preventivo_code) || s(previousContext.linked_preventivo_code) || '',
    quote_pdf_requested: !!previousIntakeState.slots?.quote_pdf_requested,
    quote_append_requested: !!previousIntakeState.slots?.quote_append_requested,
    session_parts: Array.isArray(previousIntakeState.slots?.session_parts) ? previousIntakeState.slots.session_parts : [],
    ...mergedIntakeSlots,
    plate: normalizePlate(s(evidence.plate) || mergedIntakeSlots.plate || ''),
    vin: s(evidence.vin) || mergedIntakeSlots.vin || '',
    oe_code: sanitizeOeCode(s(evidence.oe_code) || mergedIntakeSlots.oe_code || '', normalizePlate(s(evidence.plate) || mergedIntakeSlots.plate || '')),
    part_category: normalizePartCategory(
      preferredPartCandidate.category || mergedIntakeSlots.part_category,
      preferredPartCandidate.name || mergedIntakeSlots.part_name || ''
    ),
    part_name: preferredPartCandidate.name || mergedIntakeSlots.part_name || '',
    glass_position: currentMessageGlassPosition || s(evidence.glass_position) || mergedIntakeSlots.glass_position || '',
    side: currentMessageSide || s(evidence.side) || mergedIntakeSlots.side || '',
    axle: currentMessageAxle || s(evidence.axle) || mergedIntakeSlots.axle || '',
    brake_component: currentMessageBrakeComponent || s(evidence.brake_component) || mergedIntakeSlots.brake_component || '',
    filter_type: currentMessageFilterType || s(evidence.filter_type) || mergedIntakeSlots.filter_type || ''
  };
  const intakeDecision = buildIntakeDecision(intakeSlots);
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
    category: normalizePartCategory(intakeSlots.part_category || preliminaryNormalizedPart.category, intakeSlots.part_name || parsed.requestedPartText)
  };

  if (!intakeDecision.ready) {
    const waitingQuestion = intakeDecision.question || s(evidence.next_best_question) || s(mediaAi?.followup_question);
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
      missingData: Array.isArray(evidence.missing_fields) && evidence.missing_fields.length
        ? evidence.missing_fields
        : (intakeDecision.pendingSlot ? [intakeDecision.pendingSlot] : []),
      whatsappText: waitingQuestion,
      aiRequest: {
        intent: evidence.intent || 'intake_collection',
        request_is_valid: evidence.request_is_valid !== false,
        suggested_service: evidence.suggested_service || 'WAITING_DATA',
        instruction: 'Raccolta dati progressiva senza chiamata AI finche la richiesta non e completa.',
        availableSources: ['OPENAI', 'RULES', 'CONVERSATION_CONTEXT'],
        parsed,
        normalizedPart,
        intakeSlots,
        intakeDecision,
        evidenceAnalysis: evidence,
        mediaAnalysis: mediaAi,
        openai: {
          skipped: !!evidenceResult.skipped,
          error: evidenceResult.error || null,
          model: evidenceResult.meta?.model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
          statusCode: evidenceResult.meta?.statusCode || null,
          raw: evidenceResult.meta?.content || evidenceResult.meta?.raw || evidenceResult.raw || null,
          parsed: evidenceResult.data || evidenceResult.meta?.parsed || null
        }
      },
      aiSummary: s(evidence.ai_summary) || null,
      resolvedStatus: 'in_attesa_dati_cliente',
      intakeState: {
        stage: intakeDecision.stage,
        pendingSlot: intakeDecision.pendingSlot,
        pendingQuestion: waitingQuestion,
        slots: intakeSlots
      }
    };
  }

  const servicePlan = buildServiceExecutionPlan(intakeSlots, evidence.suggested_service || '', evidence, normalizedPart);
  if (servicePlan.mode === 'waiting_data') {
    const waitingQuestion = servicePlan.question || buildFallbackMissingDataQuestion(intakeSlots, evidence);
    return {
      status: 'OK',
      parsed,
      vehicle: null,
      normalizedPart,
      dbrtResult: {},
      glassCatalog: { status: 'SKIPPED', message: 'In attesa del dato necessario per il servizio', items: [] },
      oeCatalog: {},
      oeResults: [],
      equivalents: {},
      missingData: servicePlan.missing || [],
      whatsappText: waitingQuestion,
      aiRequest: {
        intent: 'service_waiting_data',
        request_is_valid: true,
        suggested_service: 'WAITING_DATA',
        instruction: 'Dati generali presenti, ma manca ancora il dato minimo richiesto dal servizio tecnico selezionato.',
        availableSources: ['RULES', 'CONVERSATION_CONTEXT', 'OPENAI'],
        parsed,
        normalizedPart,
        intakeSlots,
        intakeDecision,
        servicePlan,
        evidenceAnalysis: evidence,
        mediaAnalysis: mediaAi,
        openai: {
          skipped: !!evidenceResult.skipped,
          error: evidenceResult.error || null,
          model: evidenceResult.meta?.model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
          statusCode: evidenceResult.meta?.statusCode || null,
          raw: evidenceResult.meta?.content || evidenceResult.meta?.raw || evidenceResult.raw || null,
          parsed: evidenceResult.data || evidenceResult.meta?.parsed || null
        }
      },
      aiSummary: s(evidence.ai_summary) || null,
      resolvedStatus: 'in_attesa_dati_cliente',
      intakeState: {
        stage: 'waiting_service_key',
        pendingSlot: (servicePlan.missing || [])[0] || intakeDecision.pendingSlot || null,
        pendingQuestion: waitingQuestion,
        slots: intakeSlots
      }
    };
  }

  if (servicePlan.mode === 'execute_service' && servicePlan.service === 'RTWS_LISTINI_CHECK_EUROCODE_TARGA_OE2' && intakeSlots.part_category === 'cristalli') {
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
      whatsappText = buildQuotePdfQuestionText(
        selectedItem,
        intakeSlots.quote_append_requested ? (s(intakeSlots.linked_preventivo_code) || '') : ''
      );
      status = 'oe_trovato';
    } else if (options.length > 1) {
      whatsappText = buildGlassOptionsReplyText(options, glassCatalog.items.length);
      status = 'in_attesa_verifica_tecnica';
    } else if (glassCatalog.status === 'ERROR') {
      whatsappText = 'Ho ricevuto la richiesta del cristallo e sto verificando i dati tecnici. Ti aggiorno appena completo il controllo.';
      status = 'errore_integrazione';
    } else if (shouldConfirmUnlabeledPlateCandidate({
      text,
      plate: parsed.plate,
      vin: parsed.vin,
      oeCode: parsed.oeCode,
      partName: parsed.requestedPartText
    })) {
      const ambiguousQuestion = `Ho letto ${parsed.plate} come targa, ma non ho trovato un risultato univoco. Confermi che e la targa? Se no, dimmi se e un codice OE.`;
      return {
        status: 'OK',
        parsed: {
          ...parsed,
          plate: '',
          oeCode: ''
        },
        vehicle: null,
        normalizedPart,
        dbrtResult: {},
        glassCatalog,
        oeCatalog: {},
        oeResults: glassCatalog.items || [],
        equivalents: {},
        missingData: ['ambiguous_code_type'],
        whatsappText: ambiguousQuestion,
        aiRequest: {
          intent: 'ambiguous_plate_or_oe_after_empty_rtws',
          request_is_valid: true,
          suggested_service: 'WAITING_DATA',
          instruction: 'La ricerca RTWS non ha dato esito e il codice alfanumerico senza etichetta potrebbe essere una targa oppure un codice OE. Chiedere conferma al cliente.',
          availableSources: ['RULES', 'RTWS_LISTINI', 'CONVERSATION_CONTEXT'],
          parsed,
          normalizedPart,
          intakeSlots,
          intakeDecision,
          servicePlan,
          openai: {
            skipped: true,
            error: null,
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            statusCode: null,
            raw: null,
            parsed: null
          }
        },
        aiSummary: 'Codice alfanumerico da confermare come targa o come codice OE dopo esito vuoto RTWS.',
        resolvedStatus: 'in_attesa_dati_cliente',
        intakeState: {
          stage: 'waiting_ambiguous_code_type',
          pendingSlot: 'ambiguous_code_type',
          pendingQuestion: ambiguousQuestion,
          slots: {
            ...intakeSlots,
            plate: '',
            oe_code: '',
            pending_ambiguous_code: parsed.plate,
            pending_ambiguous_part_name: parsed.requestedPartText
          }
        }
      };
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
        servicePlan,
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

  if (servicePlan.mode === 'execute_service' && servicePlan.service === 'RTWS_LISTINI_LOOKUP_BY_OE') {
    const parsed = {
      originalText: text,
      plate: intakeSlots.plate || '',
      vin: intakeSlots.vin || '',
      oeCode: intakeSlots.oe_code || '',
      requestedPartText: intakeSlots.part_name || preliminaryParsed.requestedPartText,
      confidence: 1
    };
    const exactCatalog = await rtwsGetUpdateListiniByOe({ oeCode: parsed.oeCode });
    const searchCatalog = exactCatalog.status === 'READY'
      ? { status: 'SKIPPED', message: 'Ricerca OE estesa non necessaria', items: [] }
      : await rtwsSearchListiniByOe({ oeCode: parsed.oeCode, top: 8 });
    const equivalents = await rtwsGetListiniEquivalenti({ partNumber: parsed.oeCode });
    const vehicleSearch = await rtwsSearchVehiclesByOe({ oeCode: parsed.oeCode, top: 8 });
    const identificationCatalog = parsed.plate
      ? await rtwsGetVehicleByPlate({ plate: parsed.plate })
      : { status: 'SKIPPED', message: 'Nessuna targa disponibile per il match MMV', vehicle: null, allestimenti: [] };
    const exactItems = Array.isArray(exactCatalog.items) ? exactCatalog.items : [];
    const searchItems = Array.isArray(searchCatalog.items) ? searchCatalog.items : [];
    const vehicleMatches = Array.isArray(vehicleSearch.items) ? vehicleSearch.items : [];
    const identifiedAllestimenti = Array.isArray(identificationCatalog.allestimenti) ? identificationCatalog.allestimenti : [];
    const matchedAllestimento = identifiedAllestimenti.find((candidate) => vehicleMatches.some((match) => (
      s(match.id_marca) === s(candidate.id_marca)
      && s(match.id_modello) === s(candidate.id_modello)
      && s(match.id_versione) === s(candidate.id_versione)
    ))) || identifiedAllestimenti[0] || null;
    const dbrtCatalog = matchedAllestimento
      ? await rtwsGetRicambiByOe({
        idMar: matchedAllestimento.id_marca,
        idMod: matchedAllestimento.id_modello,
        idVer: matchedAllestimento.id_versione,
        oeCodes: [parsed.oeCode]
      })
      : { status: 'SKIPPED', message: 'Match MMV BDRT non eseguito', items: [], entries: [] };
    const dbrtItems = Array.isArray(dbrtCatalog.items) ? dbrtCatalog.items : [];
    const labeledExactItems = exactItems.map((item) => ({ ...item, source: s(item.source) || 'RTWS_LISTINI' }));
    const labeledSearchItems = searchItems.map((item) => ({ ...item, source: s(item.source) || 'RTWS_LISTINI_SEARCH' }));
    const labeledDbrtItems = dbrtItems.map((item) => ({ ...item, source: s(item.source) || 'RTWS_BDRT' }));
    const exactCatalogItem = labeledExactItems.find((item) => sanitizeOeCode(item.oe_code || item.part_number || '') === parsed.oeCode)
      || labeledExactItems[0]
      || null;
    const exactSearchItem = labeledSearchItems.find((item) => sanitizeOeCode(item.oe_code || item.part_number || '') === parsed.oeCode)
      || null;
    const exactBdrtItem = labeledDbrtItems.length === 1 ? labeledDbrtItems[0] : null;
    const confirmedItem = exactCatalogItem || exactSearchItem || null;
    const informativeItem = confirmedItem || exactBdrtItem || null;
    const selectedItem = informativeItem
      ? {
        ...informativeItem,
        description: s(exactBdrtItem?.description) || s(informativeItem.description) || parsed.requestedPartText || parsed.oeCode,
        oe_code: s(informativeItem.oe_code) || s(exactBdrtItem?.oe_code) || parsed.oeCode,
        part_number: s(exactBdrtItem?.part_number) || s(informativeItem.part_number) || '',
        id_par: s(exactBdrtItem?.id_par) || s(informativeItem.id_par) || '',
        extra_description: s(exactBdrtItem?.extra_description) || s(informativeItem.extra_description) || '',
        pecos: s(exactBdrtItem?.pecos) || s(informativeItem.pecos) || '',
        color: s(exactBdrtItem?.color) || s(informativeItem.color) || '',
        raw_xml: s(informativeItem.raw_xml) || s(exactBdrtItem?.raw_xml) || '',
        source: s(exactBdrtItem?.source) || s(informativeItem.source) || (confirmedItem ? 'RTWS_LISTINI' : 'RTWS_BDRT')
      }
      : null;
    const candidateItems = dedupeOeLookupItems([
      ...labeledSearchItems,
      ...labeledDbrtItems
    ]).filter((item) => !selectedItem || [
      sanitizeOeCode(s(item.oe_code)),
      sanitizeOeCode(s(item.part_number)),
      s(item.description).toLowerCase(),
      s(item.id_par)
    ].join('|') !== [
      sanitizeOeCode(s(selectedItem.oe_code)),
      sanitizeOeCode(s(selectedItem.part_number)),
      s(selectedItem.description).toLowerCase(),
      s(selectedItem.id_par)
    ].join('|'));
    const inferredPartName = s(selectedItem?.description) || s(normalizedPart.name) || parsed.requestedPartText || parsed.oeCode;
    const inferredCategory = normalizePartCategory(normalizedPart.category, inferredPartName);
    const resolvedPart = {
      name: inferredPartName,
      category: inferredCategory
    };
    const resolvedVehicle = identificationCatalog.vehicle || buildBdrtVehicleFromOeMatch(matchedAllestimento, vehicleMatches, parsed.oeCode);
    const needsPlateForGlass = inferredCategory === 'cristalli' && !parsed.plate;
    const needsPlateForFollowup = !parsed.plate && !selectedItem && vehicleMatches.length > 0;
    const oeResults = selectedItem
      ? [selectedItem, ...candidateItems].slice(0, 8)
      : candidateItems;
    const canOfferQuote = !!(confirmedItem && selectedItem && !needsPlateForGlass);
    const existingQuoteCode = intakeSlots.quote_append_requested ? (s(intakeSlots.linked_preventivo_code) || '') : '';
    const whatsappText = canOfferQuote
      ? (resolvedVehicle
        ? `Ho verificato il codice OE sul veicolo ${buildVehicleSummaryLabel(resolvedVehicle) || 'compatibile con il veicolo indicato'}.\n\n${buildQuotePdfQuestionText(selectedItem, existingQuoteCode)}`
        : buildQuotePdfQuestionText(selectedItem, existingQuoteCode))
      : buildOeLookupReplyText({
        oeCode: parsed.oeCode,
        exactItem: selectedItem,
        searchItems: candidateItems,
        equivalentItems: Array.isArray(equivalents.items) ? equivalents.items : [],
        needsPlateForGlass,
        identifiedVehicle: resolvedVehicle,
        vehicleMatches,
        dbrtItems
      });

    return {
      status: (
        exactCatalog.status === 'ERROR'
        && searchCatalog.status === 'ERROR'
        && equivalents.status === 'ERROR'
        && vehicleSearch.status === 'ERROR'
        && dbrtCatalog.status === 'ERROR'
      ) ? 'ERROR' : 'OK',
      parsed: {
        ...parsed,
        requestedPartText: inferredPartName
      },
      vehicle: resolvedVehicle,
      normalizedPart: resolvedPart,
      dbrtResult: {
        vehicleSearch,
        oeLookup: dbrtCatalog,
        matchedAllestimento
      },
      glassCatalog: { status: 'SKIPPED', message: 'Lookup OE eseguito senza compatibilita targa', items: [] },
      oeCatalog: exactCatalog.status === 'READY' ? exactCatalog : searchCatalog,
      oeResults,
      equivalents,
      identificationCatalog,
      missingData: needsPlateForGlass || needsPlateForFollowup ? ['plate'] : [],
      whatsappText,
      aiRequest: {
        intent: 'oe_lookup_resolution',
        request_is_valid: true,
        suggested_service: 'RTWS_LISTINI_LOOKUP_BY_OE',
        instruction: 'Lookup diretto del codice OE usando RTWS_LISTINI e RTWS_BDRT prima del passaggio manuale.',
        availableSources: ['RTWS_LISTINI', 'RTWS_BDRT', 'RULES', 'CONVERSATION_CONTEXT'],
        parsed,
        normalizedPart: resolvedPart,
        intakeSlots,
        intakeDecision,
        servicePlan,
        exactCatalog,
        searchCatalog,
        equivalents,
        vehicleSearch,
        identificationCatalog,
        dbrtCatalog,
        resolvedVehicle,
        openai: {
          skipped: true,
          error: null,
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          statusCode: null,
          raw: null,
          parsed: null
        }
      },
      aiSummary: selectedItem
        ? `Codice OE verificato sui servizi RTWS: ${inferredPartName}.`
        : (candidateItems.length
          ? `Trovate ${candidateItems.length} corrispondenze OE sui servizi RTWS.`
          : `Nessun risultato automatico utile per il codice OE ${parsed.oeCode}.`),
      resolvedStatus: canOfferQuote
        ? 'oe_trovato'
        : (needsPlateForGlass || needsPlateForFollowup
        ? 'in_attesa_dati_cliente'
        : 'in_attesa_verifica_tecnica'),
      escalationRequired: !canOfferQuote && !needsPlateForGlass && !needsPlateForFollowup && !selectedItem && !candidateItems.length && !vehicleMatches.length,
      intakeState: {
        stage: canOfferQuote
          ? 'waiting_quote_pdf_confirmation'
          : (needsPlateForGlass || needsPlateForFollowup ? 'waiting_service_key' : (selectedItem ? 'oe_lookup_completed' : 'manual_review')),
        pendingSlot: canOfferQuote
          ? 'quote_pdf_confirmation'
          : ((needsPlateForGlass || needsPlateForFollowup) ? 'plate' : null),
        pendingQuestion: canOfferQuote
          ? 'Vuoi che ti prepari subito un preventivo PDF? Rispondi SI oppure NO.'
          : ((needsPlateForGlass || needsPlateForFollowup)
            ? (needsPlateForGlass
              ? 'Il codice sembra appartenere ai cristalli. Inviami la targa e verifico subito la compatibilita veicolo e le varianti corrette.'
              : 'Inviami la targa del veicolo cosi posso restringere la verifica OE sul mezzo corretto.')
            : null),
        slots: {
          ...intakeSlots,
          part_name: inferredPartName,
          part_category: inferredCategory,
          oe_code: s(selectedItem?.oe_code) || s(intakeSlots.oe_code) || '',
          matched_mmv: matchedAllestimento
            ? {
              id_marca: s(matchedAllestimento.id_marca),
              id_modello: s(matchedAllestimento.id_modello),
              id_versione: s(matchedAllestimento.id_versione),
              make: s(matchedAllestimento.make),
              model: s(matchedAllestimento.model),
              version: s(matchedAllestimento.version)
            }
            : (intakeSlots.matched_mmv || null),
          selected_id_par: s(selectedItem?.id_par) || s(intakeSlots.selected_id_par) || '',
          selected_glass_option: canOfferQuote ? selectedItem : (intakeSlots.selected_glass_option || null),
          proposed_oe_options: !canOfferQuote && candidateItems.length ? candidateItems.slice(0, 8) : (intakeSlots.proposed_oe_options || [])
        }
      }
    };
  }

  if (servicePlan.mode === 'execute_service' && servicePlan.service === 'RTWS_IDENTIFICATION_GET_RT_TARGA_MIN' && intakeSlots.part_category !== 'cristalli') {
    const identification = await rtwsGetVehicleByPlate({ plate: intakeSlots.plate });
    const vehicle = identification.vehicle || null;
    const identifiedMessage = vehicle
      ? buildVehicleAwarePendingCategoryMessage(normalizedPart.category, normalizedPart.name, intakeSlots, vehicle)
      : null;
    const fallbackMessage = servicePlan.message
      || buildPendingCategoryMessage(normalizedPart.category, normalizedPart.name, intakeSlots);
    const whatsappText = identifiedMessage
      || (identification.status === 'ERROR'
        ? `${fallbackMessage} La verifica automatica del veicolo da targa non si e completata, quindi la richiesta passa comunque al reparto tecnico.`
        : fallbackMessage);

    return {
      status: 'OK',
      parsed,
      vehicle,
      normalizedPart,
      dbrtResult: {},
      glassCatalog: { status: 'SKIPPED', message: 'Servizio cristalli non applicabile a questa categoria', items: [] },
      identificationCatalog: identification,
      oeCatalog: {},
      oeResults: [],
      equivalents: {},
      missingData: [],
      whatsappText,
      escalationRequired: true,
      aiRequest: {
        intent: 'service_pending_manual_review',
        request_is_valid: evidence.request_is_valid !== false,
        suggested_service: servicePlan.service,
        instruction: 'Flusso server categoria non cristalli: identificazione veicolo da targa eseguita prima del passaggio al reparto tecnico.',
        availableSources: ['RTWS_IDENTIFICATION', 'RULES', 'CONVERSATION_CONTEXT'],
        parsed,
        normalizedPart,
        intakeSlots,
        intakeDecision,
        servicePlan,
        identification,
        evidenceAnalysis: evidence,
        mediaAnalysis: mediaAi,
        openai: {
          skipped: !!evidenceResult.skipped,
          error: evidenceResult.error || null,
          model: evidenceResult.meta?.model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
          statusCode: evidenceResult.meta?.statusCode || null,
          raw: evidenceResult.meta?.content || evidenceResult.meta?.raw || evidenceResult.raw || null,
          parsed: evidenceResult.data || evidenceResult.meta?.parsed || null
        }
      },
      aiSummary: vehicle
        ? `Veicolo identificato da targa per richiesta ${normalizedPart.category || 'ricambi'}: ${buildVehicleSummaryLabel(vehicle) || intakeSlots.plate || 'veicolo acquisito'}.`
        : (s(evidence.ai_summary) || null),
      resolvedStatus: 'in_attesa_verifica_tecnica',
      intakeState: {
        stage: 'manual_review',
        pendingSlot: null,
        pendingQuestion: null,
        slots: intakeSlots
      }
    };
  }

  const manualReviewMessage = servicePlan.message
    || `Ho raccolto i dati per ${normalizedPart.name || 'il ricambio richiesto'}, ma al momento il servizio automatico per la categoria ${normalizedPart.category || 'ricambio_generico'} non e ancora disponibile. La richiesta passa in verifica manuale al reparto tecnico.`;

  return {
    status: 'OK',
    parsed,
    vehicle: null,
    normalizedPart,
    dbrtResult: {},
    glassCatalog: { status: 'SKIPPED', message: 'Servizio automatico non disponibile per questa categoria', items: [] },
    oeCatalog: {},
    oeResults: [],
    equivalents: {},
    missingData: [],
    whatsappText: manualReviewMessage,
    escalationRequired: true,
    aiRequest: {
      intent: evidence.intent || 'service_pending_manual_review',
      request_is_valid: evidence.request_is_valid !== false,
      suggested_service: servicePlan.service || evidence.suggested_service || 'MANUAL_REVIEW',
      instruction: 'Flusso unico lato server: dati raccolti correttamente, ma servizio dedicato non disponibile. Escalation manuale senza secondo triage AI.',
      availableSources: ['OPENAI', 'RULES', 'CONVERSATION_CONTEXT'],
      parsed,
      normalizedPart,
      intakeSlots,
      intakeDecision,
      servicePlan,
      evidenceAnalysis: evidence,
      mediaAnalysis: mediaAi,
      openai: {
        skipped: !!evidenceResult.skipped,
        error: evidenceResult.error || null,
        model: evidenceResult.meta?.model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
        statusCode: evidenceResult.meta?.statusCode || null,
        raw: evidenceResult.meta?.content || evidenceResult.meta?.raw || evidenceResult.raw || null,
        parsed: evidenceResult.data || evidenceResult.meta?.parsed || null
      }
    },
    aiSummary: s(evidence.ai_summary) || null,
    resolvedStatus: 'in_attesa_verifica_tecnica',
    intakeState: {
      stage: 'manual_review',
      pendingSlot: null,
      pendingQuestion: null,
      slots: intakeSlots
    }
  };
}

function persistResolvedPayload(partsRequestId, resolved) {
  const parsed = resolved?.parsed || {};
  const normalizedPart = resolved?.normalizedPart || {};
  const items = Array.isArray(resolved?.oeResults) ? resolved.oeResults : [];
  const equivalents = Array.isArray(resolved?.equivalents?.items) ? resolved.equivalents.items : [];
  const vehicle = resolved?.vehicle || null;

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
      s(item.description || item.eurocode || normalizedPart.name || 'Ricambio'),
      item.price ? Number(String(item.price).replace(',', '.')) : null,
      s(item.source) || 'RTWS_LISTINI',
      JSON.stringify(item)
    );
  });

  db.prepare('DELETE FROM parts_request_equivalents WHERE parts_request_id = ?').run(partsRequestId);
  const insertEquivalent = db.prepare(`
    INSERT INTO parts_request_equivalents (parts_request_id, oe_result_id, brand, code, description, source)
    VALUES (?, NULL, ?, ?, ?, ?)
  `);
  equivalents.forEach((item) => {
    insertEquivalent.run(
      partsRequestId,
      s(item.id_marca) || 'RTWS',
      s(item.part_number) || s(item.oe_code),
      s(item.description),
      'RTWS_LISTINI_EQUIVALENTI'
    );
  });

  if (vehicle && (vehicle.make || vehicle.model || vehicle.version || vehicle.engine_code || vehicle.ktype || vehicle.infocar_code || vehicle.raw_payload_json)) {
    db.prepare(`
      INSERT INTO parts_request_vehicle_data (
        parts_request_id, make, model, version, engine_code, ktype, infocar_code, vehicle_source, raw_payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(parts_request_id) DO UPDATE SET
        make = COALESCE(excluded.make, parts_request_vehicle_data.make),
        model = COALESCE(excluded.model, parts_request_vehicle_data.model),
        version = COALESCE(excluded.version, parts_request_vehicle_data.version),
        engine_code = COALESCE(excluded.engine_code, parts_request_vehicle_data.engine_code),
        ktype = COALESCE(excluded.ktype, parts_request_vehicle_data.ktype),
        infocar_code = COALESCE(excluded.infocar_code, parts_request_vehicle_data.infocar_code),
        vehicle_source = COALESCE(excluded.vehicle_source, parts_request_vehicle_data.vehicle_source),
        raw_payload_json = COALESCE(excluded.raw_payload_json, parts_request_vehicle_data.raw_payload_json),
        updated_at = datetime('now')
    `).run(
      partsRequestId,
      s(vehicle.make),
      s(vehicle.model),
      s(vehicle.version),
      s(vehicle.engine_code),
      s(vehicle.ktype),
      s(vehicle.infocar_code),
      s(vehicle.vehicle_source),
      vehicle.raw_payload_json ? JSON.stringify(vehicle.raw_payload_json) : null
    );
  }

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
      SUM(CASE WHEN status IN ('nuova','in_lavorazione','in_attesa_dati_cliente','in_attesa_verifica_tecnica','oe_trovato') THEN 1 ELSE 0 END) AS requests_open,
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

function buildFlowMessageCode(resolved = {}) {
  const intent = String(resolved?.aiRequest?.intent || '').toLowerCase();
  const stage = String(resolved?.intakeState?.stage || '').toLowerCase();
  const suggestedService = String(resolved?.aiRequest?.suggested_service || '').toUpperCase();

  if (intent.includes('assistant_wake') || intent.includes('root_menu') || stage === 'guided_root_menu') return 'HPS2-START';
  if (intent.includes('info_keyword')) return 'HPS2-INFO';
  if (intent.includes('vehicle_document')) return 'HPS2-DOC';
  if (intent.includes('ambiguous_code')) return 'HPS2-CODE';
  if (intent.includes('session_') || stage.includes('session')) return 'HPS2-SESSION';
  if (intent.includes('quote_pdf') || stage.includes('quote')) return 'HPS2-PDF';
  if (intent.includes('glass_option') || intent.includes('deterministic_glass') || intent.includes('oe_lookup') || suggestedService.startsWith('RTWS_LISTINI')) return 'HPS2-RTWS';
  if (suggestedService.includes('BDRT') || suggestedService.includes('IDENTIFICATION') || suggestedService.includes('EQUIVALENTI')) return 'HPS2-BDRT';
  if (resolved?.escalationRequired || stage === 'manual_review') return 'HPS2-MANUAL';
  return 'HPS2-ASK';
}

function detectOutboundAutoReplyMessageType(channel = '', replyOptions = null) {
  if (channel === 'whatsapp' && replyOptions?.whatsappInteractive) return 'interactive';
  if (channel === 'telegram' && replyOptions?.reply_markup) return 'interactive';
  return 'text';
}

function getSendResultError(sendResult = null) {
  return s(sendResult?.error)
    || s(sendResult?.body?.error?.message)
    || s(sendResult?.body?.error?.error_data?.details)
    || s(sendResult?.body?.description)
    || null;
}

function isSendResultSuccessful(sendResult = null) {
  if (!sendResult || sendResult.skipped) return false;
  if (getSendResultError(sendResult)) return false;
  return Number(sendResult.statusCode || 0) >= 200 && Number(sendResult.statusCode || 0) < 300;
}

function detectConversationChannelFromUserKey(userKey = '') {
  return String(userKey || '').startsWith('telegram:') ? 'telegram' : 'whatsapp';
}

function extractOutboundTargetFromUserKey(userKey = '') {
  const value = String(userKey || '');
  if (value.startsWith('telegram:')) return value.slice('telegram:'.length);
  return value;
}

function decorateFlowReplyText(bodyText, resolved = {}) {
  const text = s(bodyText);
  if (!text) return '';
  if (/^\[HPS2-[A-Z]+\]\s/.test(text)) return text;
  return `[${buildFlowMessageCode(resolved)}] ${text}`;
}

function enqueueInboundPartsMessage(payload) {
  const run = async () => processInboundPartsMessage(payload);
  const next = partsInboundProcessingQueue.then(run, run);
  partsInboundProcessingQueue = next.catch((error) => {
    console.error('parts inbound queue error', error);
  });
  return next;
}

function scanAndEscalateAgedPartsRequests() {
  const windowSeconds = getPartsEscalationWindowSeconds();
  const rows = db.prepare(`
    SELECT id, request_uuid, status, updated_at, last_message_at
    FROM parts_requests
    WHERE status IN (${PARTS_OPEN_STATUSES.map(() => '?').join(', ')})
      AND COALESCE(last_message_at, updated_at, created_at) < datetime('now', ?)
    ORDER BY updated_at ASC, id ASC
    LIMIT 50
  `).all(...PARTS_OPEN_STATUSES, `-${windowSeconds} seconds`);

  rows.forEach((row) => {
    notifyAndEscalatePartsRequest(row.id, 'timeout_1m', {
      inactivity_window_seconds: windowSeconds,
      request_uuid: row.request_uuid,
      status: row.status
    });
  });
}

function startPartsAttentionWatchdog() {
  if (partsAttentionWatchdogStarted) return;
  partsAttentionWatchdogStarted = true;
  setInterval(() => {
    try {
      scanAndEscalateAgedPartsRequests();
    } catch (error) {
      console.error('parts attention watchdog error', error);
    }
  }, 60000);
}

startPartsAttentionWatchdog();

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
  const inboundPreviewText = s(bodyText) || buildInboundMessagePlaceholder(messageType, mediaUrl);
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
        inboundPreviewText,
        inboundPreviewText,
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
      inboundPreviewText,
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
    const intakeState = getIntakeState(partsRequestId);
    const conversationContext = hasMeaningfulIntakeSlots(intakeState?.slots)
      ? null
      : getLatestConversationContext(userKey, partsRequestId);
    const mediaAnalysis = mediaUrl
      ? await analyzeInboundMediaWithOpenAI({
        channel,
        bodyText,
        mediaUrl,
        mediaMimeType,
        mediaMetadata,
        messageType
      })
      : { skipped: true, reason: 'media_assente' };

    if (mediaAnalysis?.skipped) {
      logPartEvent(
        partsRequestId,
        'media_ai_skipped',
        `Analisi immagine non eseguita: ${mediaAnalysis.reason || 'motivo_non_specificato'}`,
        'openai_vision',
        mediaAnalysis
      );
    } else {
      logPartEvent(
        partsRequestId,
        mediaAnalysis.error ? 'errore_integrazione' : 'media_ai_analysis',
        mediaAnalysis.error ? `Analisi immagine fallita: ${mediaAnalysis.error}` : 'Analisi immagine completata',
        'openai_vision',
        mediaAnalysis
      );
    }

    const resolved = await resolvePartsMessageV2({
      message: bodyText || '',
      channel,
      context: conversationContext,
      intakeState,
      mediaAnalysis
    });
    if (resolved?.whatsappText) {
      resolved.whatsappText = decorateFlowReplyText(resolved.whatsappText, resolved);
    }
    const channelReplyOptions = channel === 'telegram'
      ? buildTelegramReplyOptionsForResolved(resolved)
      : (channel === 'whatsapp' ? buildWhatsAppReplyOptionsForResolved(resolved) : null);

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

      if (resolved.identificationCatalog?.status === 'READY') {
        logPartEvent(partsRequestId, 'rtws_identification', resolved.identificationCatalog.message || 'RTWS_IDENTIFICATION eseguito', 'rtws_identification', {
          vehicle: resolved.vehicle || null,
          allestimenti: resolved.identificationCatalog.allestimenti?.slice(0, 10) || [],
          errorCode: resolved.identificationCatalog.errorCode || ''
        });
      } else if (resolved.identificationCatalog?.status === 'EMPTY') {
        logPartEvent(partsRequestId, 'rtws_identification_empty', resolved.identificationCatalog.message || 'RTWS_IDENTIFICATION senza risultati', 'rtws_identification', {
          plate: resolved.identificationCatalog.plate || null,
          errorCode: resolved.identificationCatalog.errorCode || '',
          errorMessage: resolved.identificationCatalog.errorMessage || ''
        });
      } else if (resolved.identificationCatalog?.status === 'ERROR') {
        logPartEvent(partsRequestId, 'rtws_identification_error', resolved.identificationCatalog.message || 'Errore RTWS_IDENTIFICATION', 'rtws_identification', resolved.identificationCatalog);
      }

      if (resolved.oeCatalog?.status === 'READY') {
        logPartEvent(partsRequestId, 'rtws_oe_lookup', resolved.oeCatalog.message || 'Lookup OE eseguito', 'rtws_listini', {
          items: resolved.oeCatalog.items?.slice(0, 10) || [],
          stateCode: resolved.oeCatalog.stateCode || ''
        });
      } else if (resolved.oeCatalog?.status === 'EMPTY') {
        logPartEvent(partsRequestId, 'rtws_oe_lookup_empty', resolved.oeCatalog.message || 'Lookup OE senza risultati', 'rtws_listini', {
          stateCode: resolved.oeCatalog.stateCode || '',
          rawXml: resolved.oeCatalog.rawXml || ''
        });
      } else if (resolved.oeCatalog?.status === 'ERROR') {
        logPartEvent(partsRequestId, 'errore_integrazione', resolved.oeCatalog.message || 'Errore lookup OE RTWS', 'rtws_listini', resolved.oeCatalog);
      }

      if (resolved.equivalents?.status === 'READY') {
        logPartEvent(partsRequestId, 'rtws_equivalenti', resolved.equivalents.message || 'Equivalenti RTWS recuperati', 'rtws_listini', {
          items: resolved.equivalents.items?.slice(0, 10) || [],
          stateCode: resolved.equivalents.stateCode || ''
        });
      }

      if (resolved.dbrtResult?.vehicleSearch?.status === 'READY') {
        logPartEvent(partsRequestId, 'rtws_bdrt_searchrt', resolved.dbrtResult.vehicleSearch.message || 'Veicoli compatibili recuperati da RTWS_BDRT', 'rtws_bdrt', {
          items: resolved.dbrtResult.vehicleSearch.items?.slice(0, 10) || [],
          stateCode: resolved.dbrtResult.vehicleSearch.stateCode || ''
        });
      } else if (resolved.dbrtResult?.vehicleSearch?.status === 'ERROR') {
        logPartEvent(partsRequestId, 'rtws_bdrt_searchrt_error', resolved.dbrtResult.vehicleSearch.message || 'Errore SearchRTByOe', 'rtws_bdrt', resolved.dbrtResult.vehicleSearch);
      }

      if (resolved.dbrtResult?.oeLookup?.status === 'READY') {
        logPartEvent(partsRequestId, 'rtws_bdrt_oe', resolved.dbrtResult.oeLookup.message || 'Ricambi OE recuperati da RTWS_BDRT', 'rtws_bdrt', {
          items: resolved.dbrtResult.oeLookup.items?.slice(0, 10) || [],
          stateCode: resolved.dbrtResult.oeLookup.stateCode || '',
          matchedAllestimento: resolved.dbrtResult.matchedAllestimento || null
        });
      } else if (resolved.dbrtResult?.oeLookup?.status === 'ERROR') {
        logPartEvent(partsRequestId, 'rtws_bdrt_oe_error', resolved.dbrtResult.oeLookup.message || 'Errore GetRicambiByOE', 'rtws_bdrt', resolved.dbrtResult.oeLookup);
      }

      if (resolved.whatsappText) {
        const outboundResult = await sendText(outboundTarget, resolved.whatsappText, channelReplyOptions || undefined);
        const outboundMessageType = outboundResult?.fallbackFromInteractive
          ? 'text'
          : detectOutboundAutoReplyMessageType(channel, channelReplyOptions);
        const outboundError = getSendResultError(outboundResult);
        const outboundSuccess = isSendResultSuccessful(outboundResult);
        db.prepare(`
          INSERT INTO whatsapp_messages (
            conversation_id, direction, channel, external_message_id, message_type,
            body_text, delivery_status, error_message, source_system, raw_payload_json
          )
          VALUES (?, 'outbound', ?, ?, ?, ?, ?, ?, 'openai_auto_reply', ?)
        `).run(
          conversation.id,
          channel,
          extractOutboundMessageId(channel, outboundResult),
          outboundMessageType,
          resolved.whatsappText,
          outboundSuccess ? 'sent' : 'error',
          outboundError,
          JSON.stringify(outboundResult)
        );
        upsertConversationState(conversation.id);
        logPartEvent(
          partsRequestId,
          outboundSuccess ? `messaggio_${channel}_inviato` : 'errore_integrazione',
          outboundSuccess ? `Risposta automatica ${channel} inviata` : `Invio ${channel} fallito: ${outboundError || 'errore non specificato'}`,
          channel,
          outboundResult
        );
      }

      if (resolved.quoteDecision === 'create_pdf') {
        try {
          const artifacts = await createQuoteArtifactsFromRequestId(partsRequestId);
          persistQuoteSessionState(partsRequestId, artifacts.quote);
          const documentSend = await sendDocument(
            outboundTarget,
            artifacts.pdf.buffer,
            artifacts.pdf.filename,
            buildQuotePdfCaption(artifacts.quote)
          );
          const documentError = getSendResultError(documentSend);
          const documentSuccess = isSendResultSuccessful(documentSend);
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
            documentSuccess ? 'sent' : 'error',
            documentError,
            JSON.stringify(documentSend)
          );
          upsertConversationState(conversation.id);
          logPartEvent(
            partsRequestId,
            documentSuccess ? 'preventivo_pdf_inviato' : 'errore_integrazione',
            documentSuccess ? `Preventivo PDF inviato automaticamente su ${channel}` : `Invio PDF ${channel} fallito: ${documentError || 'errore non specificato'}`,
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
          const linkError = getSendResultError(linkSend);
          const linkSuccess = isSendResultSuccessful(linkSend);
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
            linkSuccess ? 'sent' : 'error',
            linkError,
            JSON.stringify(linkSend)
          );
          upsertConversationState(conversation.id);
          logPartEvent(
            partsRequestId,
            linkSuccess ? 'link_preventivo_inviato' : 'errore_integrazione',
            linkSuccess ? `Link pubblico preventivo inviato su ${channel}` : `Invio link preventivo ${channel} fallito: ${linkError || 'errore non specificato'}`,
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

      if (resolved.escalationRequired) {
        notifyAndEscalatePartsRequest(partsRequestId, 'service_not_available', {
          suggested_service: resolved.aiRequest?.suggested_service || null,
          normalized_part_category: resolved.normalizedPart?.category || null
        });
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
        const bodyText = s(message?.text?.body)
          || s(message?.image?.caption)
          || s(message?.document?.caption)
          || s(message?.button?.text)
          || s(message?.interactive?.button_reply?.title)
          || s(message?.interactive?.list_reply?.title)
          || s(message?.interactive?.button_reply?.id)
          || s(message?.interactive?.list_reply?.id)
          || '';
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

router.get('/parts/messages/:id/media', requirePermesso('ricambi', 'read'), async (req, res) => {
  const message = db.prepare('SELECT * FROM whatsapp_messages WHERE id = ?').get(Number(req.params.id));
  if (!message) return res.status(404).json({ error: 'Messaggio non trovato' });
  if (!message.media_url) return res.status(404).json({ error: 'Nessun allegato disponibile per questo messaggio' });

  const downloaded = await downloadStoredConversationMedia(message);
  if (!downloaded?.ok || !downloaded?.buffer?.length) {
    return res.status(502).json({ error: downloaded?.error || 'Download allegato fallito' });
  }

  const mimeType = choosePreferredImageMimeType(downloaded.mimeType, message.media_mime_type) || downloaded.mimeType || message.media_mime_type || 'application/octet-stream';
  const filename = downloaded.filename || guessFilenameFromMimeType(mimeType, `parts-message-${message.id}`);
  const safeFilename = String(filename || `parts-message-${message.id}`).replace(/[^A-Za-z0-9._-]/g, '_');
  const disposition = looksLikeImageMimeType(mimeType) ? 'inline' : 'attachment';
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `${disposition}; filename="${safeFilename}"`);
  return res.end(downloaded.buffer);
});

router.post('/parts/conversations/:id/messages', requirePermesso('ricambi', 'edit'), async (req, res) => {
  const conversation = db.prepare('SELECT * FROM whatsapp_conversations WHERE id = ?').get(Number(req.params.id));
  if (!conversation) return res.status(404).json({ error: 'Conversazione non trovata' });

  const bodyText = s(req.body?.body_text);
  const internalNote = req.body?.internal_note ? 1 : 0;
  if (!bodyText) return res.status(400).json({ error: 'Testo messaggio obbligatorio' });

  const conversationChannel = detectConversationChannelFromUserKey(conversation.user_phone);
  const outboundTarget = extractOutboundTargetFromUserKey(conversation.user_phone);
  const sendText = conversationChannel === 'telegram' ? sendTelegramText : sendWhatsAppText;
  const outboundResult = internalNote ? { skipped: true } : await sendText(outboundTarget, bodyText);
  const outboundError = internalNote ? null : getSendResultError(outboundResult);
  const outboundSuccess = internalNote ? false : isSendResultSuccessful(outboundResult);
  const result = db.prepare(`
    INSERT INTO whatsapp_messages (
      conversation_id, direction, channel, external_message_id, message_type, body_text,
      delivery_status, error_message, source_system, raw_payload_json, internal_note
    )
    VALUES (?, ?, ?, ?, 'text', ?, ?, ?, 'crm_operator', ?, ?)
  `).run(
    conversation.id,
    internalNote ? 'internal' : 'outbound',
    conversationChannel,
    internalNote ? null : extractOutboundMessageId(conversationChannel, outboundResult),
    bodyText,
    internalNote ? 'saved' : (outboundSuccess ? 'sent' : 'error'),
    internalNote ? null : outboundError,
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
      internalNote ? 'nota_chat_interna' : `messaggio_${conversationChannel}_inviato`,
      internalNote ? 'Nota interna salvata in conversazione' : (outboundSuccess ? `Messaggio outbound inviato via ${conversationChannel}` : `Invio ${conversationChannel} fallito: ${outboundError || 'errore non specificato'}`),
      'crm',
      { userId: req.user.id, conversationId: conversation.id }
    );
  }

  res.json({ id: Number(result.lastInsertRowid), sent: outboundSuccess, error: outboundError || null, channel: conversationChannel });
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
