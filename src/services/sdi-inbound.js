const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');
const { parseSdiNotificationXml } = require('./sdi-notification-parser');
const { updateInteroperabilityCallback } = require('./sdi-interoperability');

const ROOT = path.resolve(__dirname, '../../');
const INBOUND_DIR = path.join(ROOT, 'uploads', 'sdi-inbound');

function receiveSdiNotificationXml(xml, options = {}) {
  const parsed = parseSdiNotificationXml(xml, options);
  const matchedFlow = findMatchingFlow(parsed);
  if (!matchedFlow) {
    throw new Error(`Nessun flusso SDI trovato per il file ${parsed.nomeFileFattura || 'sconosciuto'}`);
  }

  const storage = persistInboundXml(xml, parsed);
  const statoNormalizzato = parsed.statoNormalizzato || 'ricevuta';

  const result = db.prepare(`
    INSERT INTO fatture_sdi_notifiche (
      flusso_id, tipo_notifica, original_filename, identificativo_sdi, hash_sha256, ricevuto_il, fattura_id,
      stato_normalizzato, nome_file_fattura, codice, descrizione, xml_path, payload_meta
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    matchedFlow.id,
    parsed.tipoNotifica,
    parsed.originalFilename || null,
    parsed.identificativoSdi || null,
    parsed.xmlSha256,
    new Date().toISOString(),
    matchedFlow.fattura_id || null,
    statoNormalizzato,
    parsed.nomeFileFattura || null,
    parsed.codiceErrore || null,
    parsed.descrizioneErrore || null,
    storage.relativePath,
    JSON.stringify(parsed)
  );

  db.prepare(`
    UPDATE fatture_sdi_flussi
    SET identificativo_sdi = COALESCE(?, identificativo_sdi),
        stato = ?,
        esito_codice = ?,
        esito_descrizione = ?,
        response_path = ?,
        ricevuto_il = datetime('now'),
        ultimo_evento_il = datetime('now')
    WHERE id = ?
  `).run(
    parsed.identificativoSdi || null,
    statoNormalizzato,
    parsed.codiceErrore || null,
    parsed.descrizioneErrore || null,
    storage.relativePath,
    matchedFlow.id
  );

  if (matchedFlow.fattura_id) {
    db.prepare(`
      UPDATE fatture
      SET stato_sdi = ?
      WHERE id = ?
    `).run(statoNormalizzato, matchedFlow.fattura_id);
  }

  updateInteroperabilityCallback({
    flow: matchedFlow,
    parsed,
    soapAction: options.soapAction || null,
    contentType: options.contentType || null,
    isMtom: options.isMtom || false,
    httpStatus: options.httpStatus || 200,
    responseLength: options.responseLength ?? null,
    contractName: options.contractName || null,
    flowSide: options.flowSide || null,
    operationName: options.operationName || null,
    operationNamespace: options.operationNamespace || null,
    dispatcherKey: options.dispatcherKey || null
  });

  return {
    notificationId: result.lastInsertRowid,
    flowId: matchedFlow.id,
    fatturaId: matchedFlow.fattura_id || null,
    statoNormalizzato,
    storage,
    parsed
  };
}

function findMatchingFlow(parsed) {
  const byFile = String(parsed.nomeFileFattura || '').trim();
  if (byFile) {
    const candidates = buildFilenameCandidates(byFile);
    if (candidates.length) {
      const placeholders = candidates.map(() => '?').join(',');
      const flow = db.prepare(`
        SELECT *
        FROM fatture_sdi_flussi
        WHERE nome_file IN (${placeholders})
        ORDER BY id DESC
        LIMIT 1
      `).get(...candidates);
      if (flow) return flow;
    }
    const flow = db.prepare(`
      SELECT *
      FROM fatture_sdi_flussi
      WHERE nome_file = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(byFile);
    if (flow) return flow;
  }
  const bySdi = String(parsed.identificativoSdi || '').trim();
  if (bySdi) {
    const flow = db.prepare(`
      SELECT *
      FROM fatture_sdi_flussi
      WHERE identificativo_sdi = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(bySdi);
    if (flow) return flow;
  }
  const progressivo = extractFilenameProgressivo(byFile);
  if (progressivo) {
    const flow = db.prepare(`
      SELECT *
      FROM fatture_sdi_flussi
      WHERE nome_file LIKE ?
         OR payload_meta LIKE ?
      ORDER BY id DESC
      LIMIT 1
    `).get(`%_${progressivo}.%`, `%${progressivo}%`);
    if (flow) return flow;
  }
  return null;
}

function buildFilenameCandidates(filename) {
  const value = String(filename || '').trim();
  if (!value) return [];
  const candidates = new Set([value]);
  if (/\.xml\.p7m$/i.test(value)) {
    candidates.add(value.replace(/\.p7m$/i, ''));
  } else if (/\.xml$/i.test(value)) {
    candidates.add(`${value}.p7m`);
    candidates.add(value.replace(/\.xml$/i, '.p7m'));
  } else if (/\.p7m$/i.test(value)) {
    candidates.add(value.replace(/\.p7m$/i, '.xml'));
    candidates.add(value.replace(/\.p7m$/i, '.xml.p7m'));
  }
  return [...candidates];
}

function extractFilenameProgressivo(filename) {
  const base = String(filename || '').trim().split(/[\\/]/).pop() || '';
  const normalized = base.replace(/\.xml\.p7m$/i, '').replace(/\.xml$/i, '').replace(/\.p7m$/i, '');
  const match = normalized.match(/_([A-Za-z0-9]{5})$/);
  return match?.[1] || null;
}

function persistInboundXml(xml, parsed) {
  const now = new Date();
  const dayDir = path.join(
    INBOUND_DIR,
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0')
  );
  ensureDir(dayDir);
  const filenameBase = sanitizeFilePart(parsed.originalFilename || parsed.nomeFileFattura || parsed.tipoNotifica || 'notifica');
  const sha = parsed.xmlSha256 || crypto.createHash('sha256').update(xml).digest('hex');
  const absolutePath = path.join(dayDir, `${sha}_${filenameBase}.xml`);
  if (!fs.existsSync(absolutePath)) fs.writeFileSync(absolutePath, xml, 'utf8');
  return {
    absolutePath,
    relativePath: `/${toPosix(path.relative(ROOT, absolutePath))}`,
    sha256: sha
  };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sanitizeFilePart(value) {
  return String(value || '')
    .trim()
    .replace(/\.xml$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'file';
}

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

module.exports = {
  buildFilenameCandidates,
  receiveSdiNotificationXml
};
