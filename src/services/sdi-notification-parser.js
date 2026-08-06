const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');

const NOTIFICATION_MAP = {
  NotificaScarto: 'scarto',
  RicevutaScarto: 'scarto',
  RicevutaConsegna: 'consegnata',
  NotificaMancataConsegna: 'UNDELIVERABLE',
  RicevutaImpossibilitaRecapito: 'UNDELIVERABLE',
  NotificaEsito: 'esito',
  NotificaDecorrenzaTermini: 'decorrenza_termini',
  AttestazioneTrasmissioneFattura: 'attestazione_trasmissione',
  MetadatiInvioFile: 'metadati_invio'
};

const DELIVERY_FAILURE_ROOTS = {
  NotificaMancataConsegna: {
    subtype: 'B2G_MANCATA_CONSEGNA',
    normalizedStatus: 'UNDELIVERABLE'
  },
  RicevutaImpossibilitaRecapito: {
    subtype: 'B2X_IMPOSSIBILITA_RECAPITO',
    normalizedStatus: 'UNDELIVERABLE'
  }
};

function parseSdiNotificationXml(xml, options = {}) {
  const rootInfo = detectXmlRootInfo(xml);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true
  });
  const parsed = parser.parse(xml);
  const rootName = rootInfo.localName || Object.keys(parsed || {}).find((key) => key !== '?xml') || '';
  const root = rootName ? parsed[rootName] : {};
  const errors = collectErrorEntries(root);
  const deliveryFailure = DELIVERY_FAILURE_ROOTS[rootName] || null;
  const normalizedStatus = deliveryFailure?.normalizedStatus || NOTIFICATION_MAP[rootName] || 'sconosciuto';
  const esitoCommittente = firstObject(root, ['EsitoCommittente']) || {};
  const destinatario = firstObject(root, ['Destinatario']) || {};
  return {
    rootElement: rootName,
    namespace: rootInfo.namespace || root?.['@_xmlns'] || root?.['@_xmlns:ns2'] || root?.['@_xmlns:p'] || '',
    tipoNotifica: rootName,
    subtype: deliveryFailure?.subtype || null,
    status: normalizedStatus,
    statoNormalizzato: normalizedStatus,
    identificativoSdi: firstValue(root, ['IdentificativoSdI', 'IdentificativoSdi']),
    outerNomeFile: options.originalFilename || null,
    innerNomeFile: firstValue(root, ['NomeFile', 'NomeFileSdI', 'NomeFileFattura']),
    nomeFileFattura: firstValue(root, ['NomeFile', 'NomeFileSdI', 'NomeFileFattura']),
    hash: firstValue(root, ['Hash']),
    dataOraRiferimento: firstValue(root, ['DataOraRicezione', 'DataOraConsegna', 'DataOraMessaggio', 'DataOra', 'Data']),
    dataMessaADisposizione: firstValue(root, ['DataMessaADisposizione']),
    descrizione: firstValue(root, ['Descrizione']),
    esitoCommittente: firstValue(esitoCommittente, ['Esito']),
    messageIdCommittente: firstValue(esitoCommittente, ['MessageIdCommittente']),
    messageId: firstValue(root, ['MessageId', 'MessageID']),
    note: firstValue(root, ['Note']),
    destinatarioCodice: firstValue(destinatario, ['Codice']),
    destinatarioDescrizione: firstValue(destinatario, ['Descrizione']),
    hashFileOriginale: firstValue(root, ['HashFileOriginale', 'Hash']),
    codiceErrore: errors[0]?.codice || null,
    descrizioneErrore: errors[0]?.descrizione || null,
    errori: errors,
    originalFilename: options.originalFilename || null,
    xmlSha256: sha256(xml)
  };
}

function firstObject(node, candidates) {
  if (node == null) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const nested = firstObject(item, candidates);
      if (nested) return nested;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  for (const [key, value] of Object.entries(node)) {
    if (candidates.includes(key) && value && typeof value === 'object') return value;
    const nested = firstObject(value, candidates);
    if (nested) return nested;
  }
  return null;
}

function detectXmlRootInfo(xml) {
  const text = String(xml || '').replace(/^\uFEFF/, '').trim();
  const rootMatch = text.match(/^<\?xml[^>]*>\s*<([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)([^>]*)>|^<([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)([^>]*)>/);
  if (!rootMatch) return { localName: '', prefix: '', namespace: '' };
  const prefix = String(rootMatch[1] || rootMatch[4] || '').replace(/:$/, '');
  const localName = rootMatch[2] || rootMatch[5] || '';
  const attributes = rootMatch[3] || rootMatch[6] || '';
  const namespace = findNamespace(attributes, prefix);
  return { localName, prefix, namespace };
}

function findNamespace(attributes, prefix) {
  const pattern = prefix
    ? new RegExp(`\\sxmlns:${escapeRegex(prefix)}=["']([^"']+)["']`)
    : /\sxmlns=["']([^"']+)["']/;
  const match = String(attributes || '').match(pattern);
  return match?.[1] || '';
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectErrorEntries(node) {
  const entries = [];
  walk(node, (candidate) => {
    if (!candidate || typeof candidate !== 'object') return;
    const codice = firstValue(candidate, ['Codice', 'CodiceErrore']);
    const descrizione = firstValue(candidate, ['Descrizione', 'DescrizioneErrore']);
    if (codice || descrizione) entries.push({ codice: codice || null, descrizione: descrizione || null });
  });
  return uniqueErrorEntries(entries);
}

function walk(node, visitor) {
  if (node == null) return;
  if (Array.isArray(node)) return node.forEach((item) => walk(item, visitor));
  if (typeof node !== 'object') return;
  visitor(node);
  Object.values(node).forEach((value) => walk(value, visitor));
}

function firstValue(node, candidates) {
  if (node == null) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const nested = firstValue(item, candidates);
      if (nested != null) return nested;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  for (const [key, value] of Object.entries(node)) {
    if (candidates.includes(key) && typeof value !== 'object') return String(value).trim();
    const nested = firstValue(value, candidates);
    if (nested != null) return nested;
  }
  return null;
}

function uniqueErrorEntries(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.codice || ''}|${entry.descrizione || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sha256(content) {
  return crypto.createHash('sha256').update(Buffer.from(String(content), 'utf8')).digest('hex');
}

module.exports = {
  DELIVERY_FAILURE_ROOTS,
  parseSdiNotificationXml
};
