const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');

router.use(authMiddleware);

try { db.exec(`ALTER TABLE ddt ADD COLUMN fattura_id INTEGER`); } catch {}
try { db.exec(`ALTER TABLE ddt ADD COLUMN spedizione_attiva INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE ddt ADD COLUMN corriere TEXT`); } catch {}
try { db.exec(`ALTER TABLE ddt ADD COLUMN numero_spedizione TEXT`); } catch {}
try { db.exec(`ALTER TABLE ddt ADD COLUMN tracking_url TEXT`); } catch {}
try { db.exec(`ALTER TABLE ddt ADD COLUMN note_spedizione TEXT`); } catch {}

const s = (v) => (v === undefined || v === '' || v === null) ? null : v;
const i = (v) => { const p = parseInt(v); return isNaN(p) ? null : p; };

function syncMovimentiFromDdt(ddtId, tipo, righe = []) {
  if (!['entrata', 'uscita'].includes(tipo)) return;
  const existing = db.prepare(`SELECT COUNT(*) as n FROM magazzino_movimenti WHERE riferimento_tipo = 'ddt' AND riferimento_id = ?`).get(ddtId);
  if (existing.n > 0) return;
  const movTipo = tipo === 'entrata' ? 'carico' : 'scarico';
  const ins = db.prepare('INSERT INTO magazzino_movimenti (prodotto_id,tipo,quantita,riferimento_tipo,riferimento_id,note) VALUES (?,?,?,?,?,?)');
  righe.forEach(r => {
    if (r.prodotto_id && r.quantita) {
      ins.run(i(r.prodotto_id), movTipo, i(r.quantita), 'ddt', ddtId, `Movimento automatico da DDT ${tipo}`);
    }
  });
}

// ═══════════════════════════════
// DDT
// ═══════════════════════════════
router.get('/ddt', (req, res) => {
  res.json(db.prepare(`SELECT d.*, a.ragione_sociale as destinatario_nome,
      f.numero as fattura_numero,
      (SELECT COUNT(*) FROM ddt_righe dr WHERE dr.ddt_id = d.id) as righe_count
    FROM ddt d
    LEFT JOIN anagrafiche a ON a.id = d.destinatario_id
    LEFT JOIN fatture f ON f.id = d.fattura_id
    ORDER BY d.creato_il DESC`).all());
});

router.get('/ddt/:id', (req, res) => {
  const d = db.prepare(`SELECT d.*, f.numero as fattura_numero
    FROM ddt d LEFT JOIN fatture f ON f.id = d.fattura_id WHERE d.id = ?`).get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Non trovato' });
  d.righe = db.prepare(`SELECT r.*, p.nome, p.codice_interno FROM ddt_righe r 
    JOIN prodotti p ON p.id = r.prodotto_id WHERE r.ddt_id = ?`).all(req.params.id);
  res.json(d);
});

router.post('/ddt', (req, res) => {
  const {
    numero_ddt, tipo, ordine_id, fattura_id, data, mittente_id, destinatario_id,
    indirizzo_consegna, lat_consegna, lng_consegna, vettore, spedizione_attiva,
    corriere, numero_spedizione, tracking_url, note_spedizione, note, righe
  } = req.body;
  try {
    const ddtTipo = ['entrata', 'uscita'].includes(s(tipo)) ? s(tipo) : 'uscita';
    const ddtNumero = s(numero_ddt) || `DDT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Date.now().toString().slice(-5)}`;
    db.exec('BEGIN');
    const r = db.prepare(`INSERT INTO ddt
      (numero_ddt,tipo,ordine_id,fattura_id,data,mittente_id,destinatario_id,indirizzo_consegna,lat_consegna,lng_consegna,vettore,spedizione_attiva,corriere,numero_spedizione,tracking_url,note_spedizione,note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(ddtNumero, ddtTipo, i(ordine_id), i(fattura_id), s(data), i(mittente_id), i(destinatario_id),
        s(indirizzo_consegna), lat_consegna || null, lng_consegna || null, s(vettore),
        spedizione_attiva ? 1 : 0, s(corriere), s(numero_spedizione), s(tracking_url), s(note_spedizione), s(note));
    const id = r.lastInsertRowid;
    if (righe?.length) {
      const ins = db.prepare('INSERT INTO ddt_righe (ddt_id,prodotto_id,quantita,lotto) VALUES (?,?,?,?)');
      righe.forEach(riga => ins.run(id, i(riga.prodotto_id), i(riga.quantita), s(riga.lotto)));
      syncMovimentiFromDdt(id, ddtTipo, righe);
    }
    db.exec('COMMIT');
    res.json({ id });
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    res.status(400).json({ error: e.message });
  }
});

router.get('/ddt/:id/pdf', (req, res) => {
  const d = db.prepare(`SELECT d.*, dest.ragione_sociale as destinatario_nome, mitt.ragione_sociale as mittente_nome,
      f.numero as fattura_numero
    FROM ddt d
    LEFT JOIN anagrafiche dest ON dest.id = d.destinatario_id
    LEFT JOIN anagrafiche mitt ON mitt.id = d.mittente_id
    LEFT JOIN fatture f ON f.id = d.fattura_id
    WHERE d.id = ?`).get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Non trovato' });
  const righe = db.prepare(`SELECT r.*, p.codice_interno, p.nome FROM ddt_righe r
    JOIN prodotti p ON p.id = r.prodotto_id WHERE r.ddt_id = ?`).all(req.params.id);

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename=ddt-${d.numero_ddt || d.id}.pdf`);
  doc.pipe(res);
  doc.fontSize(18).text('Documento di Trasporto', { align: 'center' });
  doc.moveDown();
  doc.fontSize(11).text(`Numero: ${d.numero_ddt || '-'}`);
  doc.text(`Data: ${d.data || '-'}`);
  doc.text(`Tipo: ${d.tipo || '-'}`);
  doc.text(`Mittente: ${d.mittente_nome || '-'}`);
  doc.text(`Destinatario: ${d.destinatario_nome || '-'}`);
  if (d.fattura_numero) doc.text(`Fattura associata: ${d.fattura_numero}`);
  if (d.spedizione_attiva) doc.text(`Spedizione: ${d.corriere || '-'} ${d.numero_spedizione || ''}`);
  doc.moveDown();
  doc.fontSize(12).text('Righe', { underline: true });
  doc.moveDown(0.5);
  righe.forEach((r, idx) => {
    doc.fontSize(10).text(`${idx + 1}. ${r.codice_interno} - ${r.nome} | Q.ta ${r.quantita}${r.lotto ? ' | Lotto ' + r.lotto : ''}`);
  });
  if (d.note || d.note_spedizione) {
    doc.moveDown();
    doc.fontSize(12).text('Note', { underline: true });
    if (d.note) doc.fontSize(10).text(d.note);
    if (d.note_spedizione) doc.fontSize(10).text(`Spedizione: ${d.note_spedizione}`);
  }
  doc.moveDown(3);
  doc.fontSize(10).text('Firma mittente ____________________', { continued: true });
  doc.text('   Firma destinatario ____________________');
  doc.end();
});

// ═══════════════════════════════
// CONTAINER
// ═══════════════════════════════
router.get('/container', (req, res) => {
  res.json(db.prepare(`SELECT c.*, a.ragione_sociale as fornitore_nome 
    FROM container c LEFT JOIN anagrafiche a ON a.id = c.fornitore_id ORDER BY c.creato_il DESC`).all());
});

router.get('/container/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM container WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Non trovato' });
  c.righe = db.prepare(`SELECT r.*, p.nome, p.codice_interno FROM container_righe r 
    JOIN prodotti p ON p.id = r.prodotto_id WHERE r.container_id = ?`).all(req.params.id);
  res.json(c);
});

router.post('/container', (req, res) => {
  const { fornitore_id, numero_bl, porto_partenza, porto_arrivo, data_partenza, data_arrivo_prevista, costo_trasporto, costo_dogana, costo_altri, note, righe } = req.body;
  try {
    const r = db.prepare(`INSERT INTO container (fornitore_id,numero_bl,porto_partenza,porto_arrivo,data_partenza,data_arrivo_prevista,costo_trasporto,costo_dogana,costo_altri,note)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(fornitore_id,numero_bl,porto_partenza||'Guangzhou',porto_arrivo||'Genova',data_partenza,data_arrivo_prevista,costo_trasporto,costo_dogana,costo_altri,note);
    const id = r.lastInsertRowid;
    if (righe?.length) {
      const ins = db.prepare('INSERT INTO container_righe (container_id,prodotto_id,quantita,costo_unitario,valuta) VALUES (?,?,?,?,?)');
      righe.forEach(riga => ins.run(id, riga.prodotto_id, riga.quantita, riga.costo_unitario, riga.valuta||'CNY'));
    }
    res.json({ id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/container/:id/stato', (req, res) => {
  db.prepare('UPDATE container SET stato=? WHERE id=?').run(req.body.stato, req.params.id);
  // Se consegnato, genera movimenti magazzino
  if (req.body.stato === 'consegnato') {
    const righe = db.prepare('SELECT * FROM container_righe WHERE container_id = ?').all(req.params.id);
    const ins = db.prepare('INSERT INTO magazzino_movimenti (prodotto_id,tipo,quantita,riferimento_tipo,riferimento_id) VALUES (?,?,?,?,?)');
    righe.forEach(r => ins.run(r.prodotto_id, 'carico', r.quantita, 'container', req.params.id));
  }
  res.json({ ok: true });
});

// ═══════════════════════════════
// ATTIVITA CRM
// ═══════════════════════════════
router.get('/attivita', (req, res) => {
  const { anagrafica_id, tipo } = req.query;
  let sql = `SELECT a.*, u.nome as utente_nome, an.ragione_sociale FROM attivita a
    LEFT JOIN utenti u ON u.id = a.utente_id
    LEFT JOIN anagrafiche an ON an.id = a.anagrafica_id WHERE 1=1`;
  const params = [];
  if (anagrafica_id) { sql += ' AND a.anagrafica_id = ?'; params.push(anagrafica_id); }
  if (tipo) { sql += ' AND a.tipo = ?'; params.push(tipo); }
  sql += ' ORDER BY a.data_ora DESC';
  res.json(db.prepare(sql).all(...params));
});

router.post('/attivita', (req, res) => {
  const { tipo, anagrafica_id, ordine_id, data_ora, durata_minuti, oggetto, note, esito, promemoria_il } = req.body;
  const r = db.prepare(`INSERT INTO attivita (tipo,anagrafica_id,ordine_id,utente_id,data_ora,durata_minuti,oggetto,note,esito,promemoria_il)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(tipo,anagrafica_id,ordine_id,req.user.id,data_ora,durata_minuti,oggetto,note,esito,promemoria_il);
  res.json({ id: r.lastInsertRowid });
});

// ═══════════════════════════════
// ETICHETTE E QR CODE
// ═══════════════════════════════
router.get('/etichetta/:prodotto_id/qr', async (req, res) => {
  const p = db.prepare('SELECT * FROM prodotti WHERE id = ?').get(req.params.prodotto_id);
  if (!p) return res.status(404).json({ error: 'Non trovato' });
  const url = `${process.env.BASE_URL || 'http://localhost:3001'}/prodotto/${p.id}`;
  const qr = await QRCode.toDataURL(url);
  res.json({ qr, codice: p.codice_interno, nome: p.nome, url });
});

router.get('/etichetta/:prodotto_id/pdf', async (req, res) => {
  const p = db.prepare('SELECT * FROM prodotti WHERE id = ?').get(req.params.prodotto_id);
  if (!p) return res.status(404).json({ error: 'Non trovato' });
  const url = `${process.env.BASE_URL || 'http://localhost:3001'}/prodotto/${p.id}`;
  const qrBuffer = await QRCode.toBuffer(url);
  const doc = new PDFDocument({ size: [200, 100], margin: 5 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=etichetta-${p.codice_interno}.pdf`);
  doc.pipe(res);
  doc.image(qrBuffer, 5, 5, { width: 80 });
  doc.fontSize(8).text(p.codice_interno, 90, 10, { width: 105 });
  doc.fontSize(6).text(p.nome, 90, 25, { width: 105 });
  doc.end();
});

// Magazzino movimenti manuali
router.post('/magazzino', (req, res) => {
  const { prodotto_id, tipo, quantita, note } = req.body;
  const r = db.prepare('INSERT INTO magazzino_movimenti (prodotto_id,tipo,quantita,riferimento_tipo,note) VALUES (?,?,?,?,?)')
    .run(prodotto_id, tipo, quantita, 'manuale', note);
  res.json({ id: r.lastInsertRowid });
});

module.exports = router;
