const { extractCmsContent } = require('./sdi-cades');

// Riconoscimento del contenuto di un file proveniente dagli archivi SdI.
//
// Regola generale: non ci si fida mai dell'estensione. Il formato reale viene
// dedotto dai byte, e il file firmato originale non viene mai sostituito da
// quello estratto.

const DOCUMENT_TYPES = {
  FatturaElettronica: 'FATTURA',
  FatturaElettronicaSemplificata: 'FATTURA_SEMPLIFICATA',
  RicevutaConsegna: 'RICEVUTA_CONSEGNA',
  RicevutaScarto: 'RICEVUTA_SCARTO',
  NotificaScarto: 'NOTIFICA_SCARTO',
  NotificaMancataConsegna: 'NOTIFICA_MANCATA_CONSEGNA',
  RicevutaImpossibilitaRecapito: 'RICEVUTA_IMPOSSIBILITA_RECAPITO',
  NotificaEsito: 'NOTIFICA_ESITO',
  NotificaEsitoCommittente: 'NOTIFICA_ESITO_COMMITTENTE',
  ScartoEsitoCommittente: 'SCARTO_ESITO_COMMITTENTE',
  NotificaDecorrenzaTermini: 'NOTIFICA_DECORRENZA_TERMINI',
  AttestazioneTrasmissioneFattura: 'ATTESTAZIONE_TRASMISSIONE',
  // Stesso documento con due nomi: MetadatiInvioFile sul flusso PA,
  // FileMetadati sul flusso B2B/B2C.
  MetadatiInvioFile: 'METADATI_INVIO_FILE',
  FileMetadati: 'METADATI_INVIO_FILE'
};

const INVOICE_TYPES = new Set(['FATTURA', 'FATTURA_SEMPLIFICATA']);

function detectContentType(buffer, filename = '') {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return 'empty';
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return 'zip';
  // SEQUENCE DER con lunghezza in forma lunga: e' come si presenta un CMS
  // reale, e un XML valido non puo' iniziare cosi'. Resta un candidato:
  // la conferma arriva solo se il contenuto si estrae davvero.
  if (buffer.length >= 4 && buffer[0] === 0x30 && (buffer[1] & 0x80) !== 0) return 'p7m';
  const head = buffer.toString('utf8', 0, Math.min(buffer.length, 200)).replace(/^﻿/, '').trimStart();
  if (head.startsWith('<?xml') || head.startsWith('<')) return 'xml';
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.p7m')) return 'p7m';
  if (lower.endsWith('.xml')) return 'xml';
  return 'binary';
}

// Restituisce sempre l'originale accanto all'eventuale XML estratto.
// Un .p7m puo' arrivare in DER binario oppure in base-64, e negli archivi dei
// Servizi Massivi convivono entrambe le forme: nello stesso ZIP alcuni file
// cominciano con 0x30 0x82, altri con "MII", che e' quel DER codificato.
// Trattare i secondi come binario li faceva archiviare senza importarli.
function decodeIfBase64(buffer) {
  const testa = buffer.toString('latin1', 0, Math.min(buffer.length, 64)).trim();
  if (!/^[A-Za-z0-9+/\r\n]+={0,2}$/.test(testa) || !testa.startsWith('MI')) return null;
  try {
    const der = Buffer.from(buffer.toString('latin1').replace(/\s+/g, ''), 'base64');
    // Deve risultare una SEQUENCE DER in forma lunga, come un CMS vero.
    return der.length > 4 && der[0] === 0x30 && (der[1] & 0x80) !== 0 ? der : null;
  } catch {
    return null;
  }
}

function unwrapDocument(buffer, filename = '') {
  const contentType = detectContentType(buffer, filename);
  if (contentType === 'p7m') {
    try {
      return { contentType: 'p7m', signed: true, original: buffer, xml: extractCmsContent(buffer), filename };
    } catch (error) {
      // Prima di arrendersi: puo' essere lo stesso DER in base-64. Il nome .p7m
      // porta qui entrambe le forme, e distinguerle guardando i primi byte non
      // basta perche' il ramo e' scelto sull'estensione.
      const der = decodeIfBase64(buffer);
      if (der) {
        try {
          // L'originale fiscale resta il file come e' arrivato, base-64
          // compreso: e' quello su cui SdI ha calcolato l'hash dei metadati.
          return { contentType: 'p7m', signed: true, original: buffer, xml: extractCmsContent(der), filename, base64: true };
        } catch (secondo) {
          return { contentType: 'binary', signed: false, original: buffer, xml: null, filename, error: secondo.message };
        }
      }
      // Un DER che non e' un CMS leggibile resta archiviato come binario.
      return { contentType: 'binary', signed: false, original: buffer, xml: null, filename, error: error.message };
    }
  }
  const derNudo = decodeIfBase64(buffer);
  if (derNudo) {
    try {
      return { contentType: 'p7m', signed: true, original: buffer, xml: extractCmsContent(derNudo), filename, base64: true };
    } catch (error) {
      return { contentType: 'binary', signed: false, original: buffer, xml: null, filename, error: error.message };
    }
  }
  if (contentType === 'xml') {
    return { contentType: 'xml', signed: false, original: buffer, xml: buffer, filename };
  }
  return { contentType, signed: false, original: buffer, xml: null, filename };
}

function detectRootElement(xml) {
  const text = String(xml || '').replace(/^﻿/, '').trimStart();
  const match = text.match(/^<\?xml[^>]*\?>\s*<([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)/)
    || text.match(/^<([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)/);
  return match ? (match[2] || '') : '';
}

// Un tipo sconosciuto non e' un errore: si archivia e si prosegue.
function classifyDocument(xmlBuffer) {
  const xml = Buffer.isBuffer(xmlBuffer) ? xmlBuffer.toString('utf8') : String(xmlBuffer || '');
  const root = detectRootElement(xml);
  const type = DOCUMENT_TYPES[root] || 'UNKNOWN';
  return { type, rootElement: root, isInvoice: INVOICE_TYPES.has(type) };
}

// --- direzione ------------------------------------------------------------

function firstBlock(xml, tagName) {
  const pattern = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${tagName}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z_][\\w.-]*:)?${tagName}>`, 'i');
  return String(xml || '').match(pattern)?.[1] || '';
}

function firstTag(xml, tagName) {
  const pattern = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${tagName}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z_][\\w.-]*:)?${tagName}>`, 'i');
  const value = String(xml || '').match(pattern)?.[1] || '';
  return value.replace(/<[^>]+>/g, '').trim();
}

function extractParty(block) {
  const vatBlock = firstBlock(block, 'IdFiscaleIVA');
  return {
    vat: normalizeId(firstTag(vatBlock, 'IdCodice')),
    country: (firstTag(vatBlock, 'IdPaese') || '').toUpperCase(),
    fiscalCode: normalizeId(firstTag(block, 'CodiceFiscale')),
    denomination: firstTag(block, 'Denominazione')
      || [firstTag(block, 'Nome'), firstTag(block, 'Cognome')].filter(Boolean).join(' ').trim()
  };
}

function extractParties(xml) {
  const text = String(xml || '');
  return {
    cedente: extractParty(firstBlock(text, 'CedentePrestatore')),
    cessionario: extractParty(firstBlock(text, 'CessionarioCommittente'))
  };
}

// OUTGOING se il tenant e' il cedente, INCOMING se e' il cessionario.
// Se non corrisponde nessuno dei due, UNKNOWN e riconciliazione manuale:
// meglio un documento da esaminare che uno classificato a caso.
function determineDirection(xml, tenantIdentifiers = {}) {
  const parties = extractParties(xml);
  const own = new Set(
    [tenantIdentifiers.vatNumber, tenantIdentifiers.taxCode]
      .map(normalizeId)
      .filter(Boolean)
  );
  if (!own.size) return { direction: 'UNKNOWN', reason: 'identificativi del tenant non configurati', parties };

  const matches = (party) => Boolean((party.vat && own.has(party.vat)) || (party.fiscalCode && own.has(party.fiscalCode)));
  const isCedente = matches(parties.cedente);
  const isCessionario = matches(parties.cessionario);

  if (isCedente && isCessionario) return { direction: 'OUTGOING', reason: 'autofattura: cedente e cessionario coincidono', parties };
  if (isCedente) return { direction: 'OUTGOING', reason: null, parties };
  if (isCessionario) return { direction: 'INCOMING', reason: null, parties };
  return { direction: 'UNKNOWN', reason: 'il tenant non compare ne come cedente ne come cessionario', parties };
}

function normalizeId(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase().replace(/^IT(?=\d)/, '');
}

// Un file puo' contenere piu' FatturaElettronicaBody (lotto): ogni corpo e'
// una fattura distinta e va importato come tale.
function countInvoiceBodies(xml) {
  const matches = String(xml || '').match(/<(?:[A-Za-z_][\w.-]*:)?FatturaElettronicaBody\b/gi);
  return matches ? matches.length : 0;
}

module.exports = {
  DOCUMENT_TYPES,
  INVOICE_TYPES,
  classifyDocument,
  countInvoiceBodies,
  detectContentType,
  detectRootElement,
  determineDirection,
  extractParties,
  normalizeId,
  unwrapDocument
};
