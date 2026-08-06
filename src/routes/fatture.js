const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const db = require('../db/database');
const XLSX = require('xlsx');
const crypto = require('crypto');
const { importInvoiceXml } = require('../services/fattura-import');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads/fatture';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

router.use(authMiddleware);

function sqlNullable(value) {
  return value === undefined ? null : value;
}

// Lista fatture
router.get('/', requirePermesso('fatture', 'read'), (req, res) => {
  const { tipo, stato, direzione } = req.query;
  let sql = `SELECT f.*, a.ragione_sociale FROM fatture f LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id WHERE 1=1`;
  const params = [];
  if (tipo) { sql += ' AND f.tipo = ?'; params.push(tipo); }
  if (direzione) { sql += ' AND COALESCE(f.direzione, CASE WHEN f.tipo = "emessa" THEN "attiva" ELSE "passiva" END) = ?'; params.push(direzione); }
  if (stato) { sql += ' AND f.stato = ?'; params.push(stato); }
  sql += ' ORDER BY f.data DESC';
  res.json(db.prepare(sql).all(...params));
});

// Singola fattura con righe
router.get('/:id', requirePermesso('fatture', 'read'), (req, res) => {
  const f = db.prepare(`SELECT f.*, a.ragione_sociale FROM fatture f LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id WHERE f.id = ?`).get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Non trovata' });
  f.righe = db.prepare(`SELECT r.*, p.nome, p.codice_interno FROM fatture_righe r LEFT JOIN prodotti p ON p.id = r.prodotto_id WHERE r.fattura_id = ?`).all(req.params.id);
  f.riepilogo_iva = db.prepare(`SELECT * FROM fatture_iva_riepilogo WHERE fattura_id = ? ORDER BY id`).all(req.params.id);
  res.json(f);
});

router.get('/:id/xml', requirePermesso('fatture', 'read'), (req, res) => {
  const f = db.prepare('SELECT id, xml_path FROM fatture WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Non trovata' });
  if (!f.xml_path) return res.status(404).json({ error: 'XML non disponibile' });
  const root = path.resolve(__dirname, '../../');
  const cleanRelativePath = String(f.xml_path).replace(/^[/\\]+/, '');
  const absolutePath = path.resolve(root, cleanRelativePath);
  const uploadsRoot = path.resolve(root, 'uploads');
  if (!absolutePath.startsWith(uploadsRoot + path.sep) || !fs.existsSync(absolutePath)) {
    return res.status(404).json({ error: 'XML non trovato' });
  }
  res.type('application/xml').send(fs.readFileSync(absolutePath, 'utf8'));
});

// Crea fattura manuale
router.post('/', requirePermesso('fatture', 'edit'), (req, res) => {
  const { numero, tipo, direzione, tipo_documento, anagrafica_id, ordine_id, data, scadenza, data_ricezione, imponibile, iva, totale, sdi_id, stato, stato_pagamento, valuta, partita_iva, codice_fiscale, note, righe, riepilogo_iva } = req.body;
  try {
    const hashDocumento = buildDocumentHash({ numero, data, partita_iva, totale });
    const duplicate = db.prepare(`
      SELECT id, numero, data, partita_iva, totale
      FROM fatture
      WHERE hash_documento = ?
         OR (numero = ? AND COALESCE(data,'') = COALESCE(?, '') AND COALESCE(partita_iva,'') = COALESCE(?, '') AND COALESCE(totale,0) = COALESCE(?,0))
      LIMIT 1
    `).get(hashDocumento, numero, data, partita_iva, totale);
    if (duplicate) return res.status(400).json({ error: 'Fattura duplicata o gia importata' });
    const r = db.prepare(`INSERT INTO fatture (
      numero, numero_documento, tipo, direzione, tipo_documento, anagrafica_id, ordine_id, data, scadenza, data_ricezione,
      imponibile, iva, totale, sdi_id, stato, stato_pagamento, valuta, partita_iva, codice_fiscale, note, hash_documento, origine_importazione
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      sqlNullable(numero), sqlNullable(numero), sqlNullable(tipo), direzione || (tipo === 'emessa' ? 'attiva' : 'passiva'), tipo_documento || 'fattura',
      sqlNullable(anagrafica_id), sqlNullable(ordine_id), sqlNullable(data), sqlNullable(scadenza), data_ricezione || null,
      sqlNullable(imponibile), sqlNullable(iva), sqlNullable(totale), sqlNullable(sdi_id), stato || 'ricevuta', stato_pagamento || 'da_pagare', valuta || 'EUR',
      partita_iva || null, codice_fiscale || null, sqlNullable(note), hashDocumento, 'manuale'
    );
    const id = r.lastInsertRowid;
    if (righe?.length) {
      const ins = db.prepare(`INSERT INTO fatture_righe (
        fattura_id,prodotto_id,descrizione,quantita,prezzo_unitario,sconto,imponibile,aliquota_iva,natura_iva,importo_iva,totale_riga
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      righe.forEach(riga => ins.run(
        id,
        riga.prodotto_id||null,
        sqlNullable(riga.descrizione),
        sqlNullable(riga.quantita),
        sqlNullable(riga.prezzo_unitario),
        riga.sconto || 0,
        riga.imponibile ?? null,
        riga.aliquota_iva ?? null,
        riga.natura_iva || null,
        riga.importo_iva ?? null,
        sqlNullable(riga.totale_riga)
      ));
    }
    saveVatSummary(id, riepilogo_iva);
    res.json({ id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/:id', requirePermesso('fatture', 'edit'), (req, res) => {
  const { numero, tipo, direzione, tipo_documento, anagrafica_id, ordine_id, data, scadenza, data_ricezione, imponibile, iva, totale, sdi_id, stato, stato_pagamento, valuta, partita_iva, codice_fiscale, note, righe, riepilogo_iva } = req.body;
  try {
    const hashDocumento = buildDocumentHash({ numero, data, partita_iva, totale });
    const duplicate = db.prepare(`
      SELECT id FROM fatture
      WHERE id <> ?
        AND (hash_documento = ?
          OR (numero = ? AND COALESCE(data,'') = COALESCE(?, '') AND COALESCE(partita_iva,'') = COALESCE(?, '') AND COALESCE(totale,0) = COALESCE(?,0)))
      LIMIT 1
    `).get(req.params.id, hashDocumento, numero, data, partita_iva, totale);
    if (duplicate) return res.status(400).json({ error: 'Esiste gia una fattura con gli stessi riferimenti' });
    db.prepare(`UPDATE fatture SET
      numero=?, numero_documento=?, tipo=?, direzione=?, tipo_documento=?, anagrafica_id=?, ordine_id=?, data=?, scadenza=?, data_ricezione=?,
      imponibile=?, iva=?, totale=?, sdi_id=?, stato=?, stato_pagamento=?, valuta=?, partita_iva=?, codice_fiscale=?, note=?, hash_documento=?
      WHERE id=?
    `).run(
      sqlNullable(numero), sqlNullable(numero), sqlNullable(tipo), direzione || (tipo === 'emessa' ? 'attiva' : 'passiva'), tipo_documento || 'fattura',
      sqlNullable(anagrafica_id), sqlNullable(ordine_id), sqlNullable(data), sqlNullable(scadenza), data_ricezione || null,
      sqlNullable(imponibile), sqlNullable(iva), sqlNullable(totale), sqlNullable(sdi_id), stato || 'ricevuta', stato_pagamento || 'da_pagare', valuta || 'EUR',
      partita_iva || null, codice_fiscale || null, sqlNullable(note), hashDocumento, req.params.id
    );
    db.prepare('DELETE FROM fatture_righe WHERE fattura_id = ?').run(req.params.id);
    db.prepare('DELETE FROM fatture_iva_riepilogo WHERE fattura_id = ?').run(req.params.id);
    if (righe?.length) {
      const ins = db.prepare(`INSERT INTO fatture_righe (
        fattura_id,prodotto_id,descrizione,quantita,prezzo_unitario,sconto,imponibile,aliquota_iva,natura_iva,importo_iva,totale_riga
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      righe.forEach(riga => ins.run(
        req.params.id,
        riga.prodotto_id||null,
        sqlNullable(riga.descrizione),
        sqlNullable(riga.quantita),
        sqlNullable(riga.prezzo_unitario),
        riga.sconto || 0,
        riga.imponibile ?? null,
        riga.aliquota_iva ?? null,
        riga.natura_iva || null,
        riga.importo_iva ?? null,
        sqlNullable(riga.totale_riga)
      ));
    }
    saveVatSummary(req.params.id, riepilogo_iva);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Upload PDF fattura
router.post('/:id/pdf', requirePermesso('fatture', 'edit'), upload.single('file'), (req, res) => {
  const path = `/uploads/fatture/${req.file.filename}`;
  db.prepare('UPDATE fatture SET pdf_path = ? WHERE id = ?').run(path, req.params.id);
  res.json({ path });
});

// Upload e parsing XML FatturaPA
router.post('/import/xml', requirePermesso('fatture', 'edit'), upload.single('file'), (req, res) => {
  try {
    const xml = fs.readFileSync(req.file.path, 'utf8');
    const result = importInvoiceXml(xml, {
      xmlPath: `/uploads/fatture/${req.file.filename}`,
      source: 'xml'
    });
    if (result.duplicate) return res.status(400).json({ error: 'Fattura duplicata o gia importata' });
    res.json({ id: result.id, parsed: result.parsed });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/import/spreadsheet', requirePermesso('fatture', 'edit'), upload.single('file'), (req, res) => {
  try {
    const workbook = XLSX.readFile(req.file.path, { cellDates: true });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
    const imported = [];
    const skipped = [];
    rows.forEach((row, index) => {
      const numero = String(getRowValue(row, ['numero', 'Numero documento', 'Numero', 'numero_documento']) || '').trim();
      if (!numero) { skipped.push({ row: index + 2, reason: 'Numero mancante' }); return; }
      const totale = parseDecimal(getRowValue(row, ['totale', 'Totale documento', 'Totale', 'importo_totale'])) || 0;
      const data = normalizeDate(getRowValue(row, ['data', 'Data documento', 'Data', 'data_documento']));
      const partitaIva = sanitizeVatNumber(getRowValue(row, ['piva', 'Partita IVA', 'partita_iva', 'P.IVA'])) || null;
      const hashDocumento = buildDocumentHash({ numero, data, partita_iva: partitaIva, totale });
      const duplicate = db.prepare('SELECT id FROM fatture WHERE hash_documento = ? LIMIT 1').get(hashDocumento);
      if (duplicate) { skipped.push({ row: index + 2, reason: 'Duplicato' }); return; }
      const tipo = inferInvoiceType(row);
      const label = String(getRowValue(row, ['cliente', 'fornitore', 'Cliente/Fornitore', 'Ragione sociale', 'ragione_sociale']) || '').trim();
      const anagrafica = partitaIva
        ? db.prepare('SELECT id FROM anagrafiche WHERE piva = ?').get(partitaIva)
        : (label ? db.prepare('SELECT id FROM anagrafiche WHERE lower(ragione_sociale) = lower(?)').get(label) : null);
      const result = db.prepare(`INSERT INTO fatture (
        numero,numero_documento,tipo,direzione,tipo_documento,anagrafica_id,data,data_ricezione,imponibile,iva,totale,valuta,stato,stato_pagamento,partita_iva,codice_fiscale,cliente_fornitore_label,hash_documento,origine_importazione
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        numero, numero, tipo.tipo, tipo.direzione, tipo.tipo_documento,
        anagrafica?.id || null, data, normalizeDate(getRowValue(row, ['data_ricezione', 'Data ricezione'])) || null,
        parseDecimal(getRowValue(row, ['imponibile', 'Imponibile'])) || 0,
        parseDecimal(getRowValue(row, ['iva', 'IVA', 'imposta'])) || 0,
        totale,
        String(getRowValue(row, ['valuta', 'Valuta']) || 'EUR').trim() || 'EUR',
        String(getRowValue(row, ['stato', 'Stato']) || 'ricevuta').trim() || 'ricevuta',
        String(getRowValue(row, ['stato_pagamento', 'Stato pagamento']) || 'da_pagare').trim() || 'da_pagare',
        partitaIva,
        sanitizeFiscalCode(getRowValue(row, ['cf', 'Codice fiscale', 'codice_fiscale'])) || null,
        label || null,
        hashDocumento,
        'spreadsheet'
      );
      imported.push({ id: result.lastInsertRowid, numero });
    });
    res.json({ imported, skipped, totale: rows.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Aggiorna stato fattura
router.patch('/:id/stato', requirePermesso('fatture', 'edit'), (req, res) => {
  db.prepare('UPDATE fatture SET stato = ? WHERE id = ?').run(req.body.stato, req.params.id);
  res.json({ ok: true });
});

// Parser XML FatturaPA semplificato
function parseFatturaPA(xml) {
  const normalizedXml = stripXmlNamespaces(xml);
  const tag = (name, source = normalizedXml) => {
    const m = source.match(new RegExp(`<${name}[^>]*>([^<]*)<\/${name}>`, 'i'));
    return m ? m[1].trim() : null;
  };
  const supplierBlock = firstBlock(normalizedXml, 'CedentePrestatore');
  const supplierVatBlock = firstBlock(supplierBlock, 'IdFiscaleIVA');
  const fornitorePaese = tag('IdPaese', supplierVatBlock);
  const fornitoreCodice = tag('IdCodice', supplierVatBlock);
  const fornitorePiva = joinVatNumber(fornitorePaese, fornitoreCodice);
  const supplierName = firstNonEmpty([
    tag('Denominazione', supplierBlock),
    [tag('Nome', supplierBlock), tag('Cognome', supplierBlock)].filter(Boolean).join(' ').trim()
  ]);
  const righe = [];
  const righeMatch = normalizedXml.matchAll(/<DettaglioLinee>([\s\S]*?)<\/DettaglioLinee>/gi);
  for (const m of righeMatch) {
    const r = m[1];
    const qtag = (n) => { const x = r.match(new RegExp(`<${n}>([^<]*)<\/${n}>`, 'i')); return x ? x[1].trim() : null; };
    const quantita = parseDecimal(qtag('Quantita')) || 1;
    const prezzoUnitario = parseDecimal(qtag('PrezzoUnitario')) || 0;
    const totaleRiga = parseDecimal(qtag('PrezzoTotale')) || 0;
    const aliquotaIva = parseDecimal(qtag('AliquotaIVA')) || 0;
    righe.push({
      descrizione: qtag('Descrizione'),
      quantita,
      prezzo_unitario: prezzoUnitario,
      imponibile: totaleRiga,
      aliquota_iva: aliquotaIva,
      natura_iva: qtag('Natura'),
      importo_iva: null,
      totale_riga: totaleRiga,
    });
  }
  const riepilogo_iva = [];
  const riepiloghi = normalizedXml.matchAll(/<DatiRiepilogo>([\s\S]*?)<\/DatiRiepilogo>/gi);
  for (const m of riepiloghi) {
    const r = m[1];
    const qtag = (n) => { const x = r.match(new RegExp(`<${n}>([^<]*)<\/${n}>`, 'i')); return x ? x[1].trim() : null; };
    riepilogo_iva.push({
      aliquota_iva: parseDecimal(qtag('AliquotaIVA')) || 0,
      natura_iva: qtag('Natura'),
      imponibile: parseDecimal(qtag('ImponibileImporto')) || 0,
      imposta: parseDecimal(qtag('Imposta')) || 0,
      riferimento_normativo: qtag('RiferimentoNormativo')
    });
  }
  const imponibile = riepilogo_iva.length
    ? riepilogo_iva.reduce((sum, row) => sum + Number(row.imponibile || 0), 0)
    : righe.reduce((sum, row) => sum + Number(row.imponibile || 0), 0);
  const iva = riepilogo_iva.reduce((sum, row) => sum + Number(row.imposta || 0), 0);
  const totaleDocumento = parseDecimal(tag('ImportoTotaleDocumento')) || (imponibile + iva);
  const rawTipoDocumento = tag('TipoDocumento');
  return {
    numero: tag('Numero'),
    data: tag('Data'),
    totale: totaleDocumento,
    imponibile, iva,
    sdi_id: tag('ProgressivoInvio'),
    tipo_documento: mapFatturaPaDocumentType(rawTipoDocumento),
    tipo_esteso: rawTipoDocumento,
    fornitore_piva: fornitorePiva,
    fornitore_paese: fornitorePaese,
    fornitore_codice_fiscale: sanitizeFiscalCode(tag('CodiceFiscale', supplierBlock)),
    fornitore_nome: supplierName,
    righe,
    riepilogo_iva,
    documento_meta: {
      progressivo_invio: tag('ProgressivoInvio'),
      formato_trasmissione: tag('FormatoTrasmissione'),
      pec_destinatario: tag('PECDestinatario'),
      codice_destinatario: tag('CodiceDestinatario')
    }
  };
}

function buildDocumentHash({ numero, data, partita_iva, totale }) {
  const raw = [numero || '', data || '', partita_iva || '', Number(totale || 0).toFixed(2)].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex');
}

function fileHash(filePath) {
  return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
}

function saveVatSummary(fatturaId, rows) {
  if (!fatturaId || !Array.isArray(rows) || !rows.length) return;
  const ins = db.prepare(`
    INSERT INTO fatture_iva_riepilogo (fattura_id, aliquota_iva, natura_iva, imponibile, imposta, riferimento_normativo)
    VALUES (?,?,?,?,?,?)
  `);
  rows.forEach(row => ins.run(
    fatturaId,
    row.aliquota_iva ?? null,
    row.natura_iva || null,
    row.imponibile ?? null,
    row.imposta ?? row.importo_iva ?? null,
    row.riferimento_normativo || null
  ));
}

function normalizeDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const str = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const dmy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  const dt = new Date(str);
  if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  return null;
}

function inferInvoiceType(row) {
  const label = String(getRowValue(row, ['tipo_documento', 'Tipo documento', 'tipo', 'Tipo', 'TD']) || '').toLowerCase();
  if (label.includes('td04') || label.includes('credito')) return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'nota_credito' };
  if (label.includes('td05') || label.includes('debito')) return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'nota_debito' };
  if (label.includes('td16') || label.includes('auto')) return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'autofattura' };
  if (label.includes('td17') || label.includes('td18') || label.includes('td19') || label.includes('integraz')) return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'integrazione_estero' };
  if (label.includes('credito')) return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'nota_credito' };
  if (label.includes('debito')) return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'nota_debito' };
  if (label.includes('auto')) return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'autofattura' };
  if (label.includes('integraz')) return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'integrazione_estero' };
  const direction = String(getRowValue(row, ['direzione', 'Attiva/Passiva', 'attiva_passiva']) || '').toLowerCase();
  if (direction.includes('att')) return { tipo: 'emessa', direzione: 'attiva', tipo_documento: 'fattura' };
  return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'fattura' };
}

function getRowValue(row, keys = []) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') return row[key];
  }
  return null;
}

function parseDecimal(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let str = String(value).trim();
  if (!str) return null;
  str = str.replace(/[€\s]/g, '');
  if (str.includes(',') && str.includes('.')) {
    str = str.replace(/\./g, '').replace(',', '.');
  } else if (str.includes(',')) {
    str = str.replace(',', '.');
  }
  const parsed = Number(str);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeVatNumber(value) {
  if (!value) return null;
  return String(value).trim().replace(/\s+/g, '').toUpperCase() || null;
}

function sanitizeFiscalCode(value) {
  if (!value) return null;
  return String(value).trim().replace(/\s+/g, '').toUpperCase() || null;
}

function stripXmlNamespaces(xml) {
  return String(xml || '').replace(/<(\/?)(?:\w+:)/g, '<$1');
}

function firstBlock(source, tagName) {
  if (!source) return '';
  const match = source.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match ? match[1] : '';
}

function firstNonEmpty(values = []) {
  return values.find(value => value && String(value).trim()) || null;
}

function joinVatNumber(country, code) {
  const cleanCountry = sanitizeVatNumber(country);
  const cleanCode = sanitizeVatNumber(code);
  if (!cleanCode) return null;
  return cleanCountry ? `${cleanCountry}${cleanCode}` : cleanCode;
}

function mapFatturaPaDocumentType(value) {
  const code = String(value || '').trim().toUpperCase();
  if (code === 'TD04') return 'nota_credito';
  if (code === 'TD05') return 'nota_debito';
  if (code === 'TD16') return 'autofattura';
  if (['TD17', 'TD18', 'TD19'].includes(code)) return 'integrazione_estero';
  return 'fattura';
}

function stripVatCountryPrefix(value) {
  const normalized = sanitizeVatNumber(value);
  if (!normalized) return null;
  return /^[A-Z]{2}\d+$/.test(normalized) ? normalized.slice(2) : normalized;
}

module.exports = router;
