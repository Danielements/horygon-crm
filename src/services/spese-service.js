// Contabilita Fase D (core): spese documentate e manuali.
// Nessuna estrazione AI in questa fase: i campi si inseriscono a mano; il
// documento (foto/PDF) e' un allegato opzionale, il cui originale non viene mai
// distrutto. Le spese confermate entrano in prima nota.

const crypto = require('crypto');
const fs = require('fs');
const db = require('../db/database');

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// --- helper puri (testabili senza DB) -------------------------------------

// Tipo file dai magic bytes (Buffer). Ammessi: JPG, PNG, PDF, WEBP, HEIC.
function sniffFileType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf'; // %PDF
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.slice(4, 8).toString('ascii') === 'ftyp' && /hei[cf]|mif1|heic|heix/.test(buf.slice(8, 12).toString('ascii'))) return 'image/heic';
  return null;
}

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'application/pdf', 'image/webp', 'image/heic']);

// Valida i campi di una spesa. Puro. Ritorna { ok, error?, normalized }.
function validateSpesa(input) {
  const totale = round2(input.totale);
  if (!(totale > 0)) return { ok: false, error: 'Totale non valido' };
  const imponibile = input.imponibile != null && input.imponibile !== '' ? round2(input.imponibile) : null;
  const iva = input.iva != null && input.iva !== '' ? round2(input.iva) : null;
  // Se imponibile e iva sono entrambi valorizzati, la loro somma non puo
  // scostarsi dal totale (tolleranza centesimo).
  if (imponibile != null && iva != null && Math.abs(round2(imponibile + iva) - totale) > 0.02) {
    return { ok: false, error: `Imponibile + IVA (${round2(imponibile + iva)}) diverso dal totale (${totale})` };
  }
  return {
    ok: true,
    normalized: {
      data: input.data || null,
      fornitore_nome: input.fornitore_nome || null,
      fornitore_piva: input.fornitore_piva || null,
      numero_documento: input.numero_documento || null,
      imponibile, iva, totale,
      valuta: input.valuta || 'EUR',
      metodo_pagamento: input.metodo_pagamento || null,
      categoria_id: input.categoria_id ? Number(input.categoria_id) : null,
      centro_costo_id: input.centro_costo_id ? Number(input.centro_costo_id) : null,
      commessa_id: input.commessa_id ? Number(input.commessa_id) : null,
      pagata_con: input.pagata_con === 'anticipo_personale' ? 'anticipo_personale' : 'azienda',
      stato: ['bozza', 'confermata', 'archiviata'].includes(input.stato) ? input.stato : 'confermata',
      note: input.note || null
    }
  };
}

// --- documenti -------------------------------------------------------------

// Archivia i metadati di un file gia salvato su disco da multer. Valida MIME e
// magic bytes; se non ammesso, lancia (e il chiamante rimuove il file).
function saveDocumento(file, userId) {
  const buf = fs.readFileSync(file.path);
  const sniffed = sniffFileType(buf);
  if (!sniffed || !ALLOWED_MIME.has(sniffed)) {
    throw new Error('Tipo file non ammesso (solo JPG, PNG, PDF, WEBP, HEIC)');
  }
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const info = db.prepare(`INSERT INTO cont_documenti (path, sha256, mime, dimensione, original_filename, caricato_da)
    VALUES (?, ?, ?, ?, ?, ?)`).run(file.path, sha256, sniffed, buf.length, file.originalname || null, userId != null ? Number(userId) : null);
  return { id: Number(info.lastInsertRowid), sha256, mime: sniffed, dimensione: buf.length };
}

function getDocumento(id) {
  return db.prepare('SELECT * FROM cont_documenti WHERE id = ?').get(Number(id));
}

// --- spese -----------------------------------------------------------------

function createSpesa(input, documentoId, userId) {
  const v = validateSpesa(input);
  if (!v.ok) throw new Error(v.error);
  const s = v.normalized;
  const info = db.prepare(`INSERT INTO cont_spese
    (documento_id, data, fornitore_nome, fornitore_piva, numero_documento, imponibile, iva, totale, valuta, metodo_pagamento, categoria_id, centro_costo_id, commessa_id, pagata_con, stato, fonte, note, creato_da)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manuale', ?, ?)`).run(
    documentoId || null, s.data, s.fornitore_nome, s.fornitore_piva, s.numero_documento,
    s.imponibile, s.iva, s.totale, s.valuta, s.metodo_pagamento,
    s.categoria_id, s.centro_costo_id, s.commessa_id, s.pagata_con, s.stato, s.note,
    userId != null ? Number(userId) : null);
  return { id: Number(info.lastInsertRowid) };
}

function updateSpesa(id, input) {
  const v = validateSpesa(input);
  if (!v.ok) throw new Error(v.error);
  const s = v.normalized;
  db.prepare(`UPDATE cont_spese SET data=?, fornitore_nome=?, fornitore_piva=?, numero_documento=?,
    imponibile=?, iva=?, totale=?, valuta=?, metodo_pagamento=?, categoria_id=?, centro_costo_id=?,
    commessa_id=?, pagata_con=?, stato=?, note=? WHERE id=?`).run(
    s.data, s.fornitore_nome, s.fornitore_piva, s.numero_documento, s.imponibile, s.iva, s.totale,
    s.valuta, s.metodo_pagamento, s.categoria_id, s.centro_costo_id, s.commessa_id, s.pagata_con, s.stato, s.note, Number(id));
  return { ok: true };
}

// Elimina la riga spesa. Il documento allegato NON viene distrutto (originale
// intoccabile): resta in cont_documenti, scollegato.
function deleteSpesa(id) {
  const info = db.prepare('DELETE FROM cont_spese WHERE id = ?').run(Number(id));
  return { deleted: info.changes > 0 };
}

function listSpese(filters = {}) {
  const where = ['1=1'];
  const params = [];
  if (filters.stato) { where.push('s.stato = ?'); params.push(filters.stato); }
  if (filters.dal) { where.push('s.data >= ?'); params.push(filters.dal); }
  if (filters.al) { where.push('s.data <= ?'); params.push(filters.al); }
  if (filters.categoria_id) { where.push('s.categoria_id = ?'); params.push(Number(filters.categoria_id)); }
  return db.prepare(`
    SELECT s.*, cat.nome AS categoria_nome, cc.nome AS centro_nome, co.nome AS commessa_nome,
           d.original_filename AS documento_nome, d.mime AS documento_mime
    FROM cont_spese s
    LEFT JOIN cont_categorie cat ON cat.id = s.categoria_id
    LEFT JOIN cont_centri_costo cc ON cc.id = s.centro_costo_id
    LEFT JOIN cont_commesse co ON co.id = s.commessa_id
    LEFT JOIN cont_documenti d ON d.id = s.documento_id
    WHERE ${where.join(' AND ')}
    ORDER BY s.data DESC, s.id DESC LIMIT ?
  `).all(...params, Number(filters.limit) || 500);
}

module.exports = {
  round2,
  sniffFileType,
  validateSpesa,
  saveDocumento,
  getDocumento,
  createSpesa,
  updateSpesa,
  deleteSpesa,
  listSpese,
  ALLOWED_MIME
};
