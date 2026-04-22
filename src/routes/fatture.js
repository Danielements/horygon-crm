const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const db = require('../db/database');

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
  const { tipo, stato } = req.query;
  let sql = `SELECT f.*, a.ragione_sociale FROM fatture f LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id WHERE 1=1`;
  const params = [];
  if (tipo) { sql += ' AND f.tipo = ?'; params.push(tipo); }
  if (stato) { sql += ' AND f.stato = ?'; params.push(stato); }
  sql += ' ORDER BY f.data DESC';
  res.json(db.prepare(sql).all(...params));
});

// Singola fattura con righe
router.get('/:id', requirePermesso('fatture', 'read'), (req, res) => {
  const f = db.prepare(`SELECT f.*, a.ragione_sociale FROM fatture f LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id WHERE f.id = ?`).get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Non trovata' });
  f.righe = db.prepare(`SELECT r.*, p.nome, p.codice_interno FROM fatture_righe r LEFT JOIN prodotti p ON p.id = r.prodotto_id WHERE r.fattura_id = ?`).all(req.params.id);
  res.json(f);
});

// Crea fattura manuale
router.post('/', requirePermesso('fatture', 'edit'), (req, res) => {
  const { numero, tipo, anagrafica_id, ordine_id, data, scadenza, imponibile, iva, totale, sdi_id, stato, note, righe } = req.body;
  try {
    const r = db.prepare(`INSERT INTO fatture (numero,tipo,anagrafica_id,ordine_id,data,scadenza,imponibile,iva,totale,sdi_id,stato,note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(numero,tipo,anagrafica_id,ordine_id,data,scadenza,imponibile,iva,totale,sdi_id,stato||'ricevuta',note);
    const id = r.lastInsertRowid;
    if (righe?.length) {
      const ins = db.prepare('INSERT INTO fatture_righe (fattura_id,prodotto_id,descrizione,quantita,prezzo_unitario,totale_riga) VALUES (?,?,?,?,?,?)');
      righe.forEach(riga => ins.run(id, riga.prodotto_id||null, riga.descrizione, riga.quantita, riga.prezzo_unitario, riga.totale_riga));
    }
    res.json({ id });
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
    parsed.xml_path = `/uploads/fatture/${req.file.filename}`;
    // Cerca anagrafica fornitore per P.IVA
    if (parsed.fornitore_piva) {
      const anag = db.prepare('SELECT id FROM anagrafiche WHERE piva = ?').get(parsed.fornitore_piva);
      if (anag) parsed.anagrafica_id = anag.id;
    }
    // Salva fattura
    const r = db.prepare(`INSERT OR IGNORE INTO fatture (numero,tipo,anagrafica_id,data,imponibile,iva,totale,sdi_id,xml_path,stato)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      parsed.numero, 'ricevuta', parsed.anagrafica_id||null,
      parsed.data, parsed.imponibile, parsed.iva, parsed.totale,
      parsed.sdi_id, parsed.xml_path, 'ricevuta'
    );
    if (r.lastInsertRowid && parsed.righe?.length) {
      const ins = db.prepare('INSERT INTO fatture_righe (fattura_id,descrizione,quantita,prezzo_unitario,totale_riga) VALUES (?,?,?,?,?)');
      parsed.righe.forEach(riga => ins.run(r.lastInsertRowid, riga.descrizione, riga.quantita, riga.prezzo_unitario, riga.totale_riga));
    }
    res.json({ id: r.lastInsertRowid, parsed });
  } catch (e) { res.status(400).json({ error: e.message }); }
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
      totale_riga: parseFloat(qtag('PrezzoTotale') || '0'),
    });
  }
  return {
    numero: tag('Numero'),
    data: tag('Data'),
    totale: parseFloat(tag('ImportoTotaleDocumento') || '0'),
    imponibile, iva,
    sdi_id: tag('ProgressivoInvio'),
    fornitore_piva: tag('IdCodice'),
    righe
  };
}

module.exports = router;
