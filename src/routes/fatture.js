const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const db = require('../db/database');
const XLSX = require('xlsx');
const crypto = require('crypto');

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
      numero, numero, tipo, direzione || (tipo === 'emessa' ? 'attiva' : 'passiva'), tipo_documento || 'fattura',
      anagrafica_id, ordine_id, data, scadenza, data_ricezione || null,
      imponibile, iva, totale, sdi_id, stato || 'ricevuta', stato_pagamento || 'da_pagare', valuta || 'EUR',
      partita_iva || null, codice_fiscale || null, note, hashDocumento, 'manuale'
    );
    const id = r.lastInsertRowid;
    if (righe?.length) {
      const ins = db.prepare(`INSERT INTO fatture_righe (
        fattura_id,prodotto_id,descrizione,quantita,prezzo_unitario,sconto,imponibile,aliquota_iva,natura_iva,importo_iva,totale_riga
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      righe.forEach(riga => ins.run(
        id,
        riga.prodotto_id||null,
        riga.descrizione,
        riga.quantita,
        riga.prezzo_unitario,
        riga.sconto || 0,
        riga.imponibile ?? null,
        riga.aliquota_iva ?? null,
        riga.natura_iva || null,
        riga.importo_iva ?? null,
        riga.totale_riga
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
      numero, numero, tipo, direzione || (tipo === 'emessa' ? 'attiva' : 'passiva'), tipo_documento || 'fattura',
      anagrafica_id, ordine_id, data, scadenza, data_ricezione || null,
      imponibile, iva, totale, sdi_id, stato || 'ricevuta', stato_pagamento || 'da_pagare', valuta || 'EUR',
      partita_iva || null, codice_fiscale || null, note, hashDocumento, req.params.id
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
        riga.descrizione,
        riga.quantita,
        riga.prezzo_unitario,
        riga.sconto || 0,
        riga.imponibile ?? null,
        riga.aliquota_iva ?? null,
        riga.natura_iva || null,
        riga.importo_iva ?? null,
        riga.totale_riga
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
    const parsed = parseFatturaPA(xml);
    parsed.hash_file = fileHash(req.file.path);
    parsed.xml_path = `/uploads/fatture/${req.file.filename}`;
    // Cerca anagrafica fornitore per P.IVA
    if (parsed.fornitore_piva) {
      const anag = db.prepare('SELECT id FROM anagrafiche WHERE piva = ?').get(parsed.fornitore_piva);
      if (anag) parsed.anagrafica_id = anag.id;
    }
    const hashDocumento = buildDocumentHash({ numero: parsed.numero, data: parsed.data, partita_iva: parsed.fornitore_piva, totale: parsed.totale });
    const duplicate = db.prepare('SELECT id FROM fatture WHERE hash_file = ? OR hash_documento = ? LIMIT 1').get(parsed.hash_file, hashDocumento);
    if (duplicate) return res.status(400).json({ error: 'Fattura duplicata o gia importata' });
    // Salva fattura
    const r = db.prepare(`INSERT INTO fatture (
      numero,numero_documento,tipo,direzione,tipo_documento,anagrafica_id,data,data_ricezione,imponibile,iva,totale,sdi_id,xml_path,stato,partita_iva,hash_file,hash_documento,origine_importazione
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      parsed.numero, parsed.numero, 'ricevuta', 'passiva', parsed.tipo_documento || 'fattura',
      parsed.anagrafica_id||null, parsed.data, new Date().toISOString().slice(0,10),
      parsed.imponibile, parsed.iva, parsed.totale, parsed.sdi_id, parsed.xml_path, 'ricevuta',
      parsed.fornitore_piva || null, parsed.hash_file, hashDocumento, 'xml'
    );
    if (r.lastInsertRowid && parsed.righe?.length) {
      const ins = db.prepare('INSERT INTO fatture_righe (fattura_id,descrizione,quantita,prezzo_unitario,imponibile,aliquota_iva,natura_iva,importo_iva,totale_riga) VALUES (?,?,?,?,?,?,?,?,?)');
      parsed.righe.forEach(riga => ins.run(r.lastInsertRowid, riga.descrizione, riga.quantita, riga.prezzo_unitario, riga.imponibile || null, riga.aliquota_iva || null, riga.natura_iva || null, riga.importo_iva || null, riga.totale_riga));
    }
    saveVatSummary(r.lastInsertRowid, parsed.riepilogo_iva);
    res.json({ id: r.lastInsertRowid, parsed });
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
      const numero = String(row.numero || row['Numero documento'] || row['Numero'] || '').trim();
      if (!numero) { skipped.push({ row: index + 2, reason: 'Numero mancante' }); return; }
      const totale = parseFloat(row.totale || row['Totale documento'] || row['Totale'] || 0) || 0;
      const data = normalizeDate(row.data || row['Data documento'] || row['Data']);
      const partitaIva = String(row.piva || row['Partita IVA'] || '').trim() || null;
      const hashDocumento = buildDocumentHash({ numero, data, partita_iva: partitaIva, totale });
      const duplicate = db.prepare('SELECT id FROM fatture WHERE hash_documento = ? LIMIT 1').get(hashDocumento);
      if (duplicate) { skipped.push({ row: index + 2, reason: 'Duplicato' }); return; }
      const tipo = inferInvoiceType(row);
      const label = String(row.cliente || row.fornitore || row['Cliente/Fornitore'] || row['Ragione sociale'] || '').trim();
      const anagrafica = partitaIva
        ? db.prepare('SELECT id FROM anagrafiche WHERE piva = ?').get(partitaIva)
        : (label ? db.prepare('SELECT id FROM anagrafiche WHERE lower(ragione_sociale) = lower(?)').get(label) : null);
      const result = db.prepare(`INSERT INTO fatture (
        numero,numero_documento,tipo,direzione,tipo_documento,anagrafica_id,data,data_ricezione,imponibile,iva,totale,valuta,stato,stato_pagamento,partita_iva,codice_fiscale,cliente_fornitore_label,hash_documento,origine_importazione
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        numero, numero, tipo.tipo, tipo.direzione, tipo.tipo_documento,
        anagrafica?.id || null, data, normalizeDate(row.data_ricezione || row['Data ricezione']) || null,
        parseFloat(row.imponibile || row['Imponibile'] || 0) || 0,
        parseFloat(row.iva || row['IVA'] || 0) || 0,
        totale,
        String(row.valuta || row['Valuta'] || 'EUR').trim() || 'EUR',
        String(row.stato || row['Stato'] || 'ricevuta').trim() || 'ricevuta',
        String(row.stato_pagamento || row['Stato pagamento'] || 'da_pagare').trim() || 'da_pagare',
        partitaIva,
        String(row.cf || row['Codice fiscale'] || '').trim() || null,
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
  const tag = (name) => {
    const m = xml.match(new RegExp(`<${name}[^>]*>([^<]*)<\/${name}>`, 'i'));
    return m ? m[1].trim() : null;
  };
  const imponibile = parseFloat(tag('ImponibileImporto') || '0');
  const iva = parseFloat(tag('Imposta') || '0');
  const righe = [];
  const righeMatch = xml.matchAll(/<DettaglioLinee>([\s\S]*?)<\/DettaglioLinee>/gi);
  for (const m of righeMatch) {
    const r = m[1];
    const qtag = (n) => { const x = r.match(new RegExp(`<${n}>([^<]*)<\/${n}>`, 'i')); return x ? x[1].trim() : null; };
    righe.push({
      descrizione: qtag('Descrizione'),
      quantita: parseFloat(qtag('Quantita') || '1'),
      prezzo_unitario: parseFloat(qtag('PrezzoUnitario') || '0'),
      imponibile: parseFloat(qtag('PrezzoTotale') || '0'),
      aliquota_iva: parseFloat(qtag('AliquotaIVA') || '0'),
      natura_iva: qtag('Natura'),
      importo_iva: null,
      totale_riga: parseFloat(qtag('PrezzoTotale') || '0'),
    });
  }
  const riepilogo_iva = [];
  const riepiloghi = xml.matchAll(/<DatiRiepilogo>([\s\S]*?)<\/DatiRiepilogo>/gi);
  for (const m of riepiloghi) {
    const r = m[1];
    const qtag = (n) => { const x = r.match(new RegExp(`<${n}>([^<]*)<\/${n}>`, 'i')); return x ? x[1].trim() : null; };
    riepilogo_iva.push({
      aliquota_iva: parseFloat(qtag('AliquotaIVA') || '0'),
      natura_iva: qtag('Natura'),
      imponibile: parseFloat(qtag('ImponibileImporto') || '0'),
      imposta: parseFloat(qtag('Imposta') || '0'),
      riferimento_normativo: qtag('RiferimentoNormativo')
    });
  }
  return {
    numero: tag('Numero'),
    data: tag('Data'),
    totale: parseFloat(tag('ImportoTotaleDocumento') || '0'),
    imponibile, iva,
    sdi_id: tag('ProgressivoInvio'),
    tipo_documento: tag('TipoDocumento'),
    fornitore_piva: tag('IdCodice'),
    righe,
    riepilogo_iva
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
  const label = String(row.tipo_documento || row['Tipo documento'] || row.tipo || row['Tipo'] || '').toLowerCase();
  if (label.includes('credito')) return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'nota_credito' };
  if (label.includes('debito')) return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'nota_debito' };
  if (label.includes('auto')) return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'autofattura' };
  if (label.includes('integraz')) return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'integrazione_estero' };
  const direction = String(row.direzione || row['Attiva/Passiva'] || '').toLowerCase();
  if (direction.includes('att')) return { tipo: 'emessa', direzione: 'attiva', tipo_documento: 'fattura' };
  return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'fattura' };
}

module.exports = router;
