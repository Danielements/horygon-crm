const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');

const s = (v) => (v === undefined || v === '' || v === null) ? null : v;
const n = (v) => { const p = parseFloat(v); return isNaN(p) ? null : p; };
const i = (v) => { const p = parseInt(v); return isNaN(p) ? null : p; };

// Upload prodotti media
const storageProdotti = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads/prodotti';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).substring(2)}${ext}`);
  }
});
const uploadProdotto = multer({ storage: storageProdotti, limits: { fileSize: 20 * 1024 * 1024 } });

router.use(authMiddleware);

// Lista prodotti con giacenza
router.get('/', (req, res) => {
  const { q, categoria_id } = req.query;
  let sql = `SELECT p.*, c.nome as categoria_nome FROM prodotti p
    LEFT JOIN categorie c ON c.id = p.categoria_id WHERE p.attivo = 1`;
  const params = [];
  if (q) { sql += ' AND (p.nome LIKE ? OR p.codice_interno LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  if (categoria_id) { sql += ' AND p.categoria_id = ?'; params.push(categoria_id); }
  const rows = db.prepare(sql + ' ORDER BY p.nome').all(...params);
  // Aggiungi giacenza e prima immagine
  rows.forEach(p => {
    const mov = db.prepare(`SELECT tipo, SUM(quantita) as tot FROM magazzino_movimenti WHERE prodotto_id = ? GROUP BY tipo`).all(p.id);
    let g = 0; mov.forEach(m => { g += m.tipo === 'carico' ? m.tot : -m.tot; });
    p.giacenza = g;
    const img = db.prepare(`SELECT path FROM prodotti_media WHERE prodotto_id = ? AND tipo = 'immagine' LIMIT 1`).get(p.id);
    p.immagine = img ? img.path : null;
    p.listini = db.prepare('SELECT * FROM prodotti_listini WHERE prodotto_id = ? ORDER BY canale, valido_dal DESC').all(p.id);
    p.fornitori = db.prepare(`SELECT pf.*, a.ragione_sociale FROM prodotti_fornitori pf
      JOIN anagrafiche a ON a.id = pf.fornitore_id WHERE pf.prodotto_id = ? ORDER BY pf.aggiornato_il DESC`).all(p.id);
    p.fatture_count = db.prepare('SELECT COUNT(*) as n FROM fatture_righe WHERE prodotto_id = ?').get(p.id).n;
    p.ddt_count = db.prepare('SELECT COUNT(*) as n FROM ddt_righe WHERE prodotto_id = ?').get(p.id).n;
  });
  res.json(rows);
});

// Singolo prodotto completo
router.get('/:id', (req, res) => {
  const p = db.prepare(`SELECT p.*, c.nome as categoria_nome FROM prodotti p
    LEFT JOIN categorie c ON c.id = p.categoria_id WHERE p.id = ?`).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Non trovato' });
  p.media = db.prepare('SELECT * FROM prodotti_media WHERE prodotto_id = ? ORDER BY caricato_il DESC').all(req.params.id);
  p.listini = db.prepare('SELECT * FROM prodotti_listini WHERE prodotto_id = ?').all(req.params.id);
  p.fornitori = db.prepare(`SELECT pf.*, a.ragione_sociale FROM prodotti_fornitori pf
    JOIN anagrafiche a ON a.id = pf.fornitore_id WHERE pf.prodotto_id = ?`).all(req.params.id);
  p.fatture = db.prepare(`
    SELECT f.id, f.numero, f.tipo, f.data, f.totale, f.stato, a.ragione_sociale,
           fr.quantita, fr.prezzo_unitario, fr.totale_riga, fr.descrizione
    FROM fatture_righe fr
    JOIN fatture f ON f.id = fr.fattura_id
    LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id
    WHERE fr.prodotto_id = ?
    ORDER BY f.data DESC, f.id DESC
  `).all(req.params.id);
  p.ddt = db.prepare(`
    SELECT d.id, d.numero_ddt, d.tipo, d.data, d.vettore, d.corriere, d.numero_spedizione,
           d.firmato, d.note, dr.quantita, dr.lotto
    FROM ddt_righe dr
    JOIN ddt d ON d.id = dr.ddt_id
    WHERE dr.prodotto_id = ?
    ORDER BY d.data DESC, d.id DESC
  `).all(req.params.id);
  p.movimenti = db.prepare(`
    SELECT * FROM magazzino_movimenti
    WHERE prodotto_id = ?
    ORDER BY data DESC, id DESC
    LIMIT 50
  `).all(req.params.id);
  const mov = db.prepare(`SELECT tipo, SUM(quantita) as tot FROM magazzino_movimenti WHERE prodotto_id = ? GROUP BY tipo`).all(req.params.id);
  let g = 0; mov.forEach(m => { g += m.tipo === 'carico' ? m.tot : -m.tot; });
  p.giacenza = g;
  res.json(p);
});

// Crea prodotto
router.post('/', requirePermesso('prodotti', 'edit'), (req, res) => {
  const b = req.body || {};
  try {
    const r = db.prepare(`
      INSERT INTO prodotti (codice_interno,barcode,nome,descrizione,categoria_id,unita_misura,peso_kg)
      VALUES (?,?,?,?,?,?,?)
    `).run(s(b.codice_interno), s(b.barcode), s(b.nome), s(b.descrizione),
          i(b.categoria_id), s(b.unita_misura) || 'pz', n(b.peso_kg));
    res.json({ id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Aggiorna prodotto
router.put('/:id', requirePermesso('prodotti', 'edit'), (req, res) => {
  const b = req.body || {};
  try {
    db.prepare(`
      UPDATE prodotti SET codice_interno=?,barcode=?,nome=?,descrizione=?,categoria_id=?,unita_misura=?,peso_kg=?,attivo=?
      WHERE id=?
    `).run(s(b.codice_interno), s(b.barcode), s(b.nome), s(b.descrizione),
           i(b.categoria_id), s(b.unita_misura), n(b.peso_kg),
           b.attivo !== undefined ? i(b.attivo) : 1,
           req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Upload foto/media prodotto (multipli)
router.post('/:id/media', requirePermesso('prodotti', 'edit'), uploadProdotto.array('files', 10), (req, res) => {
  const tipo = req.body.tipo || 'immagine';
  const results = [];
  for (const file of req.files || []) {
    const filePath = `/uploads/prodotti/${file.filename}`;
    const r = db.prepare(`INSERT INTO prodotti_media (prodotto_id,tipo,nome_file,path) VALUES (?,?,?,?)`)
      .run(req.params.id, tipo, file.originalname, filePath);
    results.push({ id: r.lastInsertRowid, path: filePath, nome: file.originalname });
  }
  res.json({ ok: true, files: results });
});

// Elimina media
router.delete('/:id/media/:mediaId', requirePermesso('prodotti', 'edit'), (req, res) => {
  const media = db.prepare('SELECT * FROM prodotti_media WHERE id = ?').get(req.params.mediaId);
  if (media && media.path) {
    const fullPath = '.' + media.path;
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  }
  db.prepare('DELETE FROM prodotti_media WHERE id = ?').run(req.params.mediaId);
  res.json({ ok: true });
});

// Aggiungi listino
router.post('/:id/listino', requirePermesso('prodotti', 'edit'), (req, res) => {
  const b = req.body || {};
  const r = db.prepare(`INSERT INTO prodotti_listini (prodotto_id,canale,prezzo,cpv,valido_dal,valido_al) VALUES (?,?,?,?,?,?)`)
    .run(req.params.id, s(b.canale) || 'mepa', n(b.prezzo), s(b.cpv), s(b.valido_dal), s(b.valido_al));
  res.json({ id: r.lastInsertRowid });
});

// Aggiungi fornitore
router.post('/:id/fornitore', requirePermesso('prodotti', 'edit'), (req, res) => {
  const b = req.body || {};
  try {
    const r = db.prepare(`
      INSERT INTO prodotti_fornitori (prodotto_id,fornitore_id,codice_fornitore,prezzo_acquisto,valuta,lead_time_giorni,note)
      VALUES (?,?,?,?,?,?,?)
    `).run(req.params.id, i(b.fornitore_id), s(b.codice_fornitore), n(b.prezzo_acquisto), s(b.valuta) || 'CNY', i(b.lead_time_giorni), s(b.note));
    if (b.prezzo_acquisto) {
      db.prepare('INSERT INTO prezzi_storico (prodotto_fornitore_id,prezzo,valuta) VALUES (?,?,?)')
        .run(r.lastInsertRowid, n(b.prezzo_acquisto), s(b.valuta) || 'CNY');
    }
    res.json({ id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Giacenze magazzino
router.get('/magazzino/giacenze', (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.codice_interno, p.nome, c.nome as categoria,
      COALESCE(SUM(CASE WHEN m.tipo='carico' THEN m.quantita WHEN m.tipo IN ('scarico','reso') THEN -m.quantita ELSE 0 END),0) as giacenza
    FROM prodotti p
    LEFT JOIN categorie c ON c.id = p.categoria_id
    LEFT JOIN magazzino_movimenti m ON m.prodotto_id = p.id
    WHERE p.attivo = 1 GROUP BY p.id ORDER BY p.nome
  `).all();
  res.json(rows);
});

// QR code
router.get('/:id/qr', async (req, res) => {
  try {
    const QRCode = require('qrcode');
    const p = db.prepare('SELECT * FROM prodotti WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Non trovato' });
    const url = `${process.env.BASE_URL || 'http://localhost:3001'}/prodotto/${p.id}`;
    const qr = await QRCode.toDataURL(url);
    res.json({ qr, codice: p.codice_interno, nome: p.nome, url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
