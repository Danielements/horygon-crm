const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');

const NOTIFICATION_MAP = {
  NotificaScarto: 'scarto',
  RicevutaScarto: 'scarto',
  RicevutaConsegna: 'consegnata',
  NotificaMancataConsegna: 'mancata_consegna',
  RicevutaImpossibilitaRecapito: 'mancata_consegna',
  NotificaEsito: 'esito',
  NotificaDecorrenzaTermini: 'decorrenza_termini',
  AttestazioneTrasmissioneFattura: 'attestazione_trasmissione',
  MetadatiInvioFile: 'metadati_invio'
};

function parseSdiNotificationXml(xml, options = {}) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true
  });
  const parsed = parser.parse(xml);
  const rootName = Object.keys(parsed || {}).find((key) => key !== '?xml') || '';
  const root = rootName ? parsed[rootName] : {};
  const errors = collectErrorEntries(root);
  return {
    rootElement: rootName,
    namespace: root?.['@_xmlns'] || root?.['@_xmlns:ns2'] || root?.['@_xmlns:p'] || '',
    tipoNotifica: rootName,
    statoNormalizzato: NOTIFICATION_MAP[rootName] || 'sconosciuto',
    identificativoSdi: firstValue(root, ['IdentificativoSdI', 'IdentificativoSdi']),
    nomeFileFattura: firstValue(root, ['NomeFile', 'NomeFileSdI', 'NomeFileFattura']),
    dataOraRiferimento: firstValue(root, ['DataOraRicezione', 'DataOraConsegna', 'DataOraMessaggio', 'DataOra', 'Data']),
    codiceErrore: errors[0]?.codice || null,
    descrizioneErrore: errors[0]?.descrizione || null,
    errori: errors,
    originalFilename: options.originalFilename || null,
    xmlSha256: sha256(xml)
  };
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
  parseSdiNotificationXml
};
