const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');
const { writeAudit } = require('./audit');
const { parseFatturaPAXml } = require('./fattura-import');
const {
  classifyDocument,
  countInvoiceBodies,
  determineDirection,
  unwrapDocument,
  xmlBufferToString
} = require('./sdi-document-classifier');

const ROOT = path.resolve(__dirname, '../../');
const ARCHIVE_DIR = path.join(ROOT, 'uploads', 'sdi-storico');

// Pipeline unica di import documentale SdI.
//
// Vale per gli archivi dei Servizi Massivi e per l'export manuale dal cassetto
// fiscale: cambia solo la provenienza. Tre principi non negoziabili:
//   - il file originale non viene mai modificato ne sostituito;
//   - una fattura importata dallo storico non e' piu' trasmissibile al SdI;
//   - la stessa sincronizzazione ripetuta non crea duplicati.

const SOURCES = new Set(['CRM', 'SDI_REALTIME', 'SDI_HISTORICAL_SYNC', 'SDI_MANUAL_IMPORT']);

// Ordine di ricerca del duplicato: dal criterio piu' forte al piu' debole.
// Il nome file da solo non e' mai una chiave.
const DEDUP_LEVELS = [
  'IDENTIFICATIVO_SDI',
  'ORIGINAL_SHA256',
  'DOCUMENT_IDENTITY',
  'ORIGINAL_FILENAME',
  'PROGRESSIVO_INVIO'
];

function importDocument({
  tenantId,
  buffer,
  filename,
  source = 'SDI_HISTORICAL_SYNC',
  jobId = null,
  utenteId = null,
  dryRun = false,
  tenantIdentifiers,
  // Negli archivi dei Servizi Massivi ogni file-fattura viaggia con un file di
  // metadati che riporta l'identificativo SdI (Formato File SMTS v1.5 par.
  // 1.3.2). Dal solo nome del file-fattura quell'identificativo non si ricava:
  // quando c'e' va passato, perche' e' la chiave di deduplicazione piu' forte.
  identificativoSdi: identificativoSdiOverride = null
}) {
  if (!SOURCES.has(source)) throw new Error(`Source non ammessa: ${source}`);
  const unwrapped = unwrapDocument(buffer, filename);
  const originalSha256 = sha256(unwrapped.original);

  if (!unwrapped.xml) {
    return finish({
      outcome: 'STORED_NON_XML',
      documentType: unwrapped.contentType === 'zip' ? 'ARCHIVIO' : 'UNKNOWN',
      filename,
      originalSha256,
      note: unwrapped.error || `contenuto non XML (${unwrapped.contentType})`
    });
  }

  // Rispetta la codifica dichiarata: windows-1252 letto come UTF-8 rovina le
  // lettere accentate nelle denominazioni.
  const xmlText = xmlBufferToString(unwrapped.xml);
  const classification = classifyDocument(unwrapped.xml);
  if (!classification.isInvoice) {
    // Notifiche, metadati e sconosciuti si archiviano senza interrompere il job.
    return finish({
      outcome: classification.type === 'UNKNOWN' ? 'UNKNOWN' : 'NOTIFICATION',
      documentType: classification.type,
      rootElement: classification.rootElement,
      filename,
      originalSha256,
      xmlSha256: sha256(unwrapped.xml)
    });
  }

  const bodies = countInvoiceBodies(xmlText);
  if (bodies > 1) {
    return finish({
      outcome: 'LOTTO',
      documentType: classification.type,
      filename,
      originalSha256,
      xmlSha256: sha256(unwrapped.xml),
      bodies,
      note: `lotto con ${bodies} corpi fattura: da scomporre prima dell'import`
    });
  }

  const parsed = parseFatturaPAXml(xmlText);
  const directionInfo = determineDirection(xmlText, tenantIdentifiers || {});
  const xmlSha256 = sha256(unwrapped.xml);
  const identificativoSdi = normalizeIdentificativoSdi(identificativoSdiOverride) || extractIdentificativoSdi(filename);

  const duplicate = findExisting({
    tenantId,
    identificativoSdi,
    originalSha256,
    xmlSha256,
    parsed,
    direction: directionInfo.direction,
    filename
  });

  if (duplicate) {
    // Una fattura gia' presente non si duplica: si arricchisce con cio' che
    // lo storico aggiunge (identificativo SdI, file originali, hash).
    const enriched = dryRun ? false : enrichExisting({ existing: duplicate.row, identificativoSdi, originalSha256, xmlSha256, filename, unwrapped, source });
    return finish({
      outcome: 'DUPLICATE',
      documentType: classification.type,
      direction: directionInfo.direction,
      filename,
      originalSha256,
      xmlSha256,
      identificativoSdi,
      fatturaId: duplicate.row.id,
      dedupLevel: duplicate.level,
      enriched,
      numero: parsed.numero
    });
  }

  if (dryRun) {
    return finish({
      outcome: 'WOULD_IMPORT',
      documentType: classification.type,
      direction: directionInfo.direction,
      directionReason: directionInfo.reason,
      filename,
      originalSha256,
      xmlSha256,
      identificativoSdi,
      numero: parsed.numero,
      totale: parsed.totale,
      // La simulazione serve a controllare cosa finirebbe in archivio, e la
      // controparte e' il campo che si sbaglia piu' facilmente: su una attiva
      // e' il cessionario, su una passiva il cedente. Senza mostrarla, il
      // dry-run non permette di verificare proprio la cosa che conta.
      controparte: resolveCounterparty(directionInfo)
    });
  }

  const stored = persistOriginals({ tenantId, filename, unwrapped, originalSha256 });
  // Ogni documento e' atomico: un errore qui non travolge il resto dell'archivio.
  db.exec('BEGIN');
  let fatturaId;
  try {
    fatturaId = insertInvoice({
      tenantId, parsed, direction: directionInfo.direction, source,
      identificativoSdi, originalSha256, xmlSha256, filename, stored,
      counterparty: resolveCounterparty(directionInfo)
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    return finish({
      outcome: 'FAILED',
      documentType: classification.type,
      direction: directionInfo.direction,
      filename,
      originalSha256,
      xmlSha256,
      error: error.message
    });
  }

  audit('SDI_HISTORICAL_DOCUMENT_IMPORTED', { tenantId, jobId, utenteId, fatturaId, filename, originalSha256, identificativoSdi });
  return finish({
    outcome: 'IMPORTED',
    documentType: classification.type,
    direction: directionInfo.direction,
    directionReason: directionInfo.reason,
    filename,
    originalSha256,
    xmlSha256,
    identificativoSdi,
    fatturaId,
    numero: parsed.numero
  });

  function finish(result) {
    if (result.outcome === 'DUPLICATE') {
      audit('SDI_HISTORICAL_DUPLICATE_FOUND', { tenantId, jobId, utenteId, filename, dedupLevel: result.dedupLevel, fatturaId: result.fatturaId });
    }
    if (result.outcome === 'FAILED') {
      audit('SDI_HISTORICAL_IMPORT_FAILED', { tenantId, jobId, utenteId, filename, error: result.error });
    }
    return { ...result, source, dryRun, jobId: jobId || null };
  }
}

// --- deduplicazione a piu' livelli ---------------------------------------

function findExisting({ tenantId, identificativoSdi, originalSha256, xmlSha256, parsed, direction, filename }) {
  const lookups = [
    ['IDENTIFICATIVO_SDI', () => identificativoSdi
      && db.prepare('SELECT * FROM fatture WHERE tenant_id = ? AND sdi_id = ? LIMIT 1').get(tenantId, identificativoSdi)],
    ['ORIGINAL_SHA256', () => db.prepare(
      'SELECT * FROM fatture WHERE tenant_id = ? AND (original_sha256 = ? OR original_sha256 = ? OR hash_file = ?) LIMIT 1'
    ).get(tenantId, originalSha256, xmlSha256, parsed.hash_file || '')],
    ['DOCUMENT_IDENTITY', () => {
      const key = documentIdentity({ tenantId, direction, parsed });
      return key && db.prepare('SELECT * FROM fatture WHERE tenant_id = ? AND hash_documento = ? LIMIT 1').get(tenantId, key);
    }],
    ['ORIGINAL_FILENAME', () => filename
      && db.prepare('SELECT * FROM fatture WHERE tenant_id = ? AND original_filename = ? LIMIT 1').get(tenantId, filename)],
    ['PROGRESSIVO_INVIO', () => {
      const progressivo = parsed?.documento_meta?.progressivo_invio;
      if (!progressivo || !parsed.numero) return null;
      return db.prepare(
        'SELECT * FROM fatture WHERE tenant_id = ? AND numero_documento = ? AND data = ? LIMIT 1'
      ).get(tenantId, parsed.numero, parsed.data || '');
    }]
  ];

  for (const [level, lookup] of lookups) {
    let row = null;
    try { row = lookup(); } catch { row = null; }
    if (row) return { level, row };
  }
  return null;
}

function documentIdentity({ tenantId, direction, parsed }) {
  if (!parsed?.numero) return null;
  const raw = [
    tenantId,
    direction || 'UNKNOWN',
    parsed.fornitore_piva || parsed.fornitore_codice_fiscale || '',
    parsed.tipo_esteso || '',
    parsed.numero,
    parsed.data || ''
  ].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex');
}

// Arricchisce senza sovrascrivere: COALESCE tiene i valori gia' presenti.
function enrichExisting({ existing, identificativoSdi, originalSha256, xmlSha256, filename, unwrapped, source }) {
  const meta = parseJson(existing.documento_meta);
  db.prepare(`
    UPDATE fatture
    SET sdi_id = COALESCE(sdi_id, ?),
        original_sha256 = COALESCE(original_sha256, ?),
        original_filename = COALESCE(original_filename, ?),
        formato_trasmissione = COALESCE(formato_trasmissione, ?),
        documento_meta = ?
    WHERE id = ?
  `).run(
    identificativoSdi || null,
    originalSha256 || null,
    filename || null,
    unwrapped.signed ? 'firmato' : null,
    JSON.stringify({ ...meta, arricchito_da: source, xml_sha256: xmlSha256, arricchito_il: new Date().toISOString() }),
    existing.id
  );
  return true;
}

// --- persistenza ----------------------------------------------------------

function persistOriginals({ tenantId, filename, unwrapped, originalSha256 }) {
  const dayDir = path.join(ARCHIVE_DIR, String(tenantId), new Date().toISOString().slice(0, 10).replace(/-/g, '/'));
  fs.mkdirSync(dayDir, { recursive: true });
  const safeName = String(filename || 'documento').replace(/[^A-Za-z0-9._-]+/g, '-');
  const originalPath = path.join(dayDir, `${originalSha256}_${safeName}`);
  if (!fs.existsSync(originalPath)) fs.writeFileSync(originalPath, unwrapped.original);

  let xmlPath = originalPath;
  if (unwrapped.signed && unwrapped.xml) {
    // Il p7m resta l'originale fiscale: l'XML estratto e' una copia di lavoro.
    xmlPath = path.join(dayDir, `${sha256(unwrapped.xml)}_${safeName.replace(/\.p7m$/i, '')}`);
    if (!fs.existsSync(xmlPath)) fs.writeFileSync(xmlPath, unwrapped.xml);
  }
  return { originalPath: relative(originalPath), xmlPath: relative(xmlPath) };
}

// La controparte di una fattura non e' sempre il cedente.
//
// Su una passiva il cedente e' il fornitore, e va bene. Su una attiva il
// cedente siamo noi: prendere sempre quello significherebbe registrare tutte
// le fatture emesse come se il cliente fossimo noi stessi, e agganciarle alla
// nostra stessa anagrafica. Con direzione sconosciuta si resta sul cedente,
// che e' il comportamento storico e l'unica scelta difendibile.
function resolveCounterparty(directionInfo) {
  const parties = directionInfo?.parties || {};
  const party = directionInfo?.direction === 'OUTGOING' ? parties.cessionario : parties.cedente;
  if (!party || (!party.vat && !party.fiscalCode && !party.denomination)) return null;
  return {
    piva: joinVatNumber(party.country, party.vat),
    codiceFiscale: party.fiscalCode ? String(party.fiscalCode).toUpperCase() : null,
    denominazione: party.denomination || null
  };
}

function joinVatNumber(country, code) {
  const cleanCountry = String(country || '').replace(/[^A-Za-z0-9]/g, '');
  const cleanCode = String(code || '').replace(/[^A-Za-z0-9]/g, '');
  if (!cleanCode) return null;
  return cleanCountry ? `${cleanCountry}${cleanCode}` : cleanCode;
}

function insertInvoice({ tenantId, parsed, direction, source, identificativoSdi, originalSha256, xmlSha256, filename, stored, counterparty = null }) {
  const isOutgoing = direction === 'OUTGOING';
  const controparte = counterparty || {
    piva: parsed.fornitore_piva,
    codiceFiscale: parsed.fornitore_codice_fiscale,
    denominazione: parsed.fornitore_nome
  };
  const anagraficaId = findAnagrafica(controparte.piva);
  const result = db.prepare(`
    INSERT INTO fatture (
      tenant_id, numero, numero_documento, tipo, direzione, tipo_documento, anagrafica_id, data, scadenza,
      imponibile, iva, totale, sdi_id, xml_path, stato, partita_iva, codice_fiscale,
      cliente_fornitore_label, tipo_esteso, documento_meta, hash_file, hash_documento,
      origine_importazione, source, sdi_send_allowed, original_filename, original_file_path, original_sha256
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    tenantId,
    parsed.numero, parsed.numero,
    isOutgoing ? 'emessa' : 'ricevuta',
    direction === 'OUTGOING' ? 'attiva' : (direction === 'INCOMING' ? 'passiva' : 'sconosciuta'),
    parsed.tipo_documento || 'fattura',
    anagraficaId,
    parsed.data,
    parsed.scadenza || null,
    parsed.imponibile, parsed.iva, parsed.totale,
    identificativoSdi || null,
    stored.xmlPath,
    'ricevuta',
    controparte.piva || null,
    controparte.codiceFiscale || null,
    controparte.denominazione || null,
    parsed.tipo_esteso || null,
    JSON.stringify({ ...(parsed.documento_meta || {}), xml_sha256: xmlSha256, direction }),
    parsed.hash_file || xmlSha256,
    documentIdentity({ tenantId, direction, parsed }),
    source === 'SDI_MANUAL_IMPORT' ? 'manuale' : 'sdi_storico',
    source,
    // Protezione assoluta: una fattura storica non e' piu' trasmissibile.
    0,
    filename || null,
    stored.originalPath,
    originalSha256
  );

  const fatturaId = Number(result.lastInsertRowid);
  const insertRow = db.prepare(`
    INSERT INTO fatture_righe (tenant_id, fattura_id, descrizione, quantita, prezzo_unitario, imponibile, aliquota_iva, natura_iva, importo_iva, totale_riga)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  (parsed.righe || []).forEach((riga) => insertRow.run(
    tenantId, fatturaId, riga.descrizione, riga.quantita, riga.prezzo_unitario,
    riga.imponibile || null, riga.aliquota_iva || null, riga.natura_iva || null,
    riga.importo_iva || null, riga.totale_riga
  ));
  const insertVat = db.prepare(`
    INSERT INTO fatture_iva_riepilogo (tenant_id, fattura_id, aliquota_iva, natura_iva, imponibile, imposta, riferimento_normativo)
    VALUES (?,?,?,?,?,?,?)
  `);
  (parsed.riepilogo_iva || []).forEach((row) => insertVat.run(
    tenantId, fatturaId, row.aliquota_iva ?? null, row.natura_iva || null,
    row.imponibile ?? null, row.imposta ?? null, row.riferimento_normativo || null
  ));
  return fatturaId;
}

function findAnagrafica(piva) {
  if (!piva) return null;
  const candidates = [piva, String(piva).replace(/^[A-Z]{2}/i, '')];
  const row = db.prepare(
    `SELECT id FROM anagrafiche WHERE piva IN (${candidates.map(() => '?').join(',')}) LIMIT 1`
  ).get(...candidates);
  return row ? row.id : null;
}

// Il nome file SdI porta l'identificativo solo nelle notifiche; sulla fattura
// il progressivo non e' l'IdentificativoSdI, quindi non lo si inventa.
function extractIdentificativoSdi(filename) {
  const match = String(filename || '').match(/_(\d{6,12})_(?:RC|NS|MC|NE|DT|AT|MT|EC)_/i);
  return match ? match[1] : null;
}

// L'identificativo SdI e' numerico: un valore non conforme che arrivasse dai
// metadati non deve finire in fatture.sdi_id, dove e' chiave di deduplicazione.
function normalizeIdentificativoSdi(value) {
  const clean = String(value || '').trim();
  return /^\d{1,20}$/.test(clean) ? clean : null;
}

function relative(absolutePath) {
  return `/${path.relative(ROOT, absolutePath).replace(/\\/g, '/')}`;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8')).digest('hex');
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function audit(azione, dettagli) {
  try {
    writeAudit({
      utente_id: dettagli.utenteId || null,
      azione,
      entita_tipo: 'fattura',
      entita_id: dettagli.fatturaId || null,
      dettagli
    });
  } catch {}
}

module.exports = {
  DEDUP_LEVELS,
  SOURCES,
  documentIdentity,
  importDocument
};
