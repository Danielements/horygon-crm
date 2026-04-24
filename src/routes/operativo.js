const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const { createEvent, updateEvent, deleteEvent, processMepaAutomation } = require('../services/google');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');

router.use(authMiddleware);

try { db.exec(`ALTER TABLE ddt ADD COLUMN fattura_id INTEGER`); } catch {}
try { db.exec(`ALTER TABLE ddt ADD COLUMN spedizione_attiva INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE ddt ADD COLUMN corriere TEXT`); } catch {}
try { db.exec(`ALTER TABLE ddt ADD COLUMN numero_spedizione TEXT`); } catch {}
try { db.exec(`ALTER TABLE ddt ADD COLUMN tracking_url TEXT`); } catch {}
try { db.exec(`ALTER TABLE ddt ADD COLUMN note_spedizione TEXT`); } catch {}
try { db.exec(`ALTER TABLE ddt ADD COLUMN causale TEXT`); } catch {}
try { db.exec(`ALTER TABLE ddt ADD COLUMN resa TEXT`); } catch {}
try { db.exec(`ALTER TABLE ddt ADD COLUMN porto TEXT`); } catch {}
try { db.exec(`ALTER TABLE ddt ADD COLUMN colli INTEGER`); } catch {}
try { db.exec(`ALTER TABLE ddt ADD COLUMN peso_totale REAL`); } catch {}
try { db.exec(`ALTER TABLE ddt ADD COLUMN aspetto_beni TEXT`); } catch {}
try { db.exec(`ALTER TABLE ddt ADD COLUMN data_ora_trasporto TEXT`); } catch {}
try { db.exec(`ALTER TABLE attivita ADD COLUMN assegnato_a INTEGER`); } catch {}
try { db.exec(`ALTER TABLE attivita ADD COLUMN stato TEXT DEFAULT 'aperta'`); } catch {}
try { db.exec(`ALTER TABLE attivita ADD COLUMN stato_origine TEXT`); } catch {}
try { db.exec(`ALTER TABLE attivita ADD COLUMN origine_id INTEGER`); } catch {}

const s = (v) => (v === undefined || v === '' || v === null) ? null : v;
const i = (v) => { const p = parseInt(v); return isNaN(p) ? null : p; };
const n = (v) => { const p = parseFloat(v); return isNaN(p) ? null : p; };
const normalizeGoogleDateTime = (value) => {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(value))) return `${value}:00`;
  return String(value);
};

function buildGoogleEventPayload(event = {}) {
  const start = normalizeGoogleDateTime(event.start);
  const end = normalizeGoogleDateTime(event.end || event.start);
  if (!start || !end) throw new Error('Data evento Google non valida');
  return {
    summary: s(event.title) || 'Attività CRM',
    description: s(event.description) || '',
    start: event.allDay ? { date: start.slice(0, 10) } : { dateTime: start, timeZone: 'Europe/Rome' },
    end: event.allDay ? { date: end.slice(0, 10) } : { dateTime: end, timeZone: 'Europe/Rome' }
  };
}

function getGiacenza(prodottoId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE
      WHEN tipo = 'carico' THEN quantita
      WHEN tipo IN ('scarico','reso') THEN -quantita
      WHEN tipo = 'rettifica' THEN quantita
      ELSE 0
    END), 0) as giacenza
    FROM magazzino_movimenti
    WHERE prodotto_id = ?
  `).get(prodottoId);
  return row?.giacenza || 0;
}

function syncMovimentiFromDdt(ddtId, tipo, righe = []) {
  if (!['entrata', 'uscita'].includes(tipo)) return;
  const existing = db.prepare(`SELECT COUNT(*) as n FROM magazzino_movimenti WHERE riferimento_tipo = 'ddt' AND riferimento_id = ?`).get(ddtId);
  if (existing.n > 0) return;
  const movTipo = tipo === 'entrata' ? 'carico' : 'scarico';
  const ins = db.prepare('INSERT INTO magazzino_movimenti (prodotto_id,tipo,quantita,riferimento_tipo,riferimento_id,note) VALUES (?,?,?,?,?,?)');
  righe.forEach(r => {
    const prodottoId = i(r.prodotto_id);
    const quantita = i(r.quantita);
    if (prodottoId && quantita && quantita > 0) {
      if (tipo === 'uscita' && getGiacenza(prodottoId) < quantita) {
        throw new Error(`Giacenza insufficiente per il prodotto ${prodottoId}`);
      }
      ins.run(prodottoId, movTipo, quantita, 'ddt', ddtId, `Movimento automatico da DDT ${tipo}`);
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
    corriere, numero_spedizione, tracking_url, note_spedizione, causale, resa,
    porto, colli, peso_totale, aspetto_beni, data_ora_trasporto, note, righe
  } = req.body;
  try {
    const ddtTipo = ['entrata', 'uscita'].includes(s(tipo)) ? s(tipo) : 'uscita';
    const ddtNumero = s(numero_ddt) || `DDT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Date.now().toString().slice(-5)}`;
    const cleanRighe = (righe || [])
      .map(r => ({ prodotto_id: i(r.prodotto_id), quantita: i(r.quantita), lotto: s(r.lotto) }))
      .filter(r => r.prodotto_id && r.quantita && r.quantita > 0);
    db.exec('BEGIN');
    const r = db.prepare(`INSERT INTO ddt
      (numero_ddt,tipo,ordine_id,fattura_id,data,mittente_id,destinatario_id,indirizzo_consegna,lat_consegna,lng_consegna,vettore,spedizione_attiva,corriere,numero_spedizione,tracking_url,note_spedizione,causale,resa,porto,colli,peso_totale,aspetto_beni,data_ora_trasporto,note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(ddtNumero, ddtTipo, i(ordine_id), i(fattura_id), s(data), i(mittente_id), i(destinatario_id),
        s(indirizzo_consegna), lat_consegna || null, lng_consegna || null, s(vettore),
        spedizione_attiva ? 1 : 0, s(corriere), s(numero_spedizione), s(tracking_url), s(note_spedizione),
        s(causale), s(resa), s(porto), i(colli), n(peso_totale), s(aspetto_beni), s(data_ora_trasporto), s(note));
    const id = r.lastInsertRowid;
    if (cleanRighe.length) {
      const ins = db.prepare('INSERT INTO ddt_righe (ddt_id,prodotto_id,quantita,lotto) VALUES (?,?,?,?)');
      cleanRighe.forEach(riga => ins.run(id, riga.prodotto_id, riga.quantita, riga.lotto));
      syncMovimentiFromDdt(id, ddtTipo, cleanRighe);
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
  const pageWidth = doc.page.width - 80;
  doc.rect(40, 35, pageWidth, 64).fill('#111827');
  doc.fillColor('#ffffff').fontSize(18).text('HORYGON', 55, 47);
  doc.fontSize(10).text('Documento di Trasporto', 55, 72);
  doc.fontSize(18).text('DDT', 430, 47, { width: 130, align: 'right' });
  doc.fontSize(9).text(`N. ${d.numero_ddt || '-'}`, 430, 72, { width: 130, align: 'right' });
  doc.fillColor('#111827');

  const box = (x, y, w, h, title, body) => {
    doc.roundedRect(x, y, w, h, 6).stroke('#d1d5db');
    doc.fillColor('#6b7280').fontSize(8).text(title.toUpperCase(), x + 10, y + 8);
    doc.fillColor('#111827').fontSize(10).text(body || '-', x + 10, y + 24, { width: w - 20, height: h - 30 });
  };

  box(40, 120, 250, 72, 'Mittente', d.mittente_nome || 'Horygon');
  box(305, 120, 250, 72, 'Destinatario', d.destinatario_nome || '-');
  box(40, 205, 120, 54, 'Numero', d.numero_ddt || '-');
  box(170, 205, 100, 54, 'Data', d.data || '-');
  box(280, 205, 120, 54, 'Causale', d.causale || (d.tipo === 'entrata' ? 'Reso/entrata' : 'Vendita'));
  box(410, 205, 145, 54, 'Fattura', d.fattura_numero || '-');
  box(40, 272, 120, 54, 'Porto', d.porto || '-');
  box(170, 272, 100, 54, 'Resa', d.resa || '-');
  box(280, 272, 120, 54, 'Colli / peso', `${d.colli || '-'} colli${d.peso_totale ? ` - ${d.peso_totale} kg` : ''}`);
  box(410, 272, 145, 54, 'Aspetto beni', d.aspetto_beni || '-');

  if (d.spedizione_attiva || d.vettore || d.corriere || d.numero_spedizione) {
    box(40, 339, 515, 54, 'Trasporto', `${d.vettore || ''} ${d.corriere || ''} ${d.numero_spedizione || ''}${d.data_ora_trasporto ? ` - ${d.data_ora_trasporto}` : ''}`.trim() || '-');
  }

  let y = 420;
  doc.fontSize(11).fillColor('#111827').text('Articoli', 40, y);
  y += 20;
  doc.rect(40, y, 515, 22).fill('#f3f4f6');
  doc.fillColor('#111827').fontSize(8).text('Codice', 48, y + 7);
  doc.text('Descrizione', 125, y + 7);
  doc.text('Lotto', 400, y + 7);
  doc.text('Q.ta', 510, y + 7, { width: 35, align: 'right' });
  y += 22;
  righe.forEach((r, idx) => {
    if (y > 720) { doc.addPage(); y = 50; }
    doc.rect(40, y, 515, 24).stroke('#e5e7eb');
    doc.fontSize(8).fillColor('#111827').text(r.codice_interno || '-', 48, y + 7, { width: 70 });
    doc.text(r.nome || '-', 125, y + 7, { width: 265 });
    doc.text(r.lotto || '-', 400, y + 7, { width: 80 });
    doc.text(String(r.quantita || '-'), 510, y + 7, { width: 35, align: 'right' });
    y += 24;
  });
  if (!righe.length) {
    doc.rect(40, y, 515, 24).stroke('#e5e7eb');
    doc.fontSize(8).fillColor('#6b7280').text('Nessun articolo indicato', 48, y + 7);
    y += 24;
  }

  y += 18;
  if (d.note || d.note_spedizione) {
    doc.fontSize(9).fillColor('#6b7280').text('Note', 40, y);
    y += 14;
    doc.fillColor('#111827').fontSize(9).text([d.note, d.note_spedizione ? `Spedizione: ${d.note_spedizione}` : ''].filter(Boolean).join('\n'), 40, y, { width: 515 });
    y += 42;
  }
  doc.fontSize(9).fillColor('#111827').text('Firma vettore __________________________', 40, 765);
  doc.text('Firma destinatario __________________________', 320, 765);
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
router.get('/attivita', async (req, res) => {
  const { anagrafica_id, tipo } = req.query;
  try { await processMepaAutomation(req.user.id); } catch {}
  let sql = `SELECT a.*, u.nome as utente_nome, au.nome as assegnato_nome, an.ragione_sociale FROM attivita a
    LEFT JOIN utenti u ON u.id = a.utente_id
    LEFT JOIN utenti au ON au.id = a.assegnato_a
    LEFT JOIN anagrafiche an ON an.id = a.anagrafica_id WHERE 1=1`;
  const params = [];
  if (anagrafica_id) { sql += ' AND a.anagrafica_id = ?'; params.push(anagrafica_id); }
  if (tipo) { sql += ' AND a.tipo = ?'; params.push(tipo); }
  sql += ' ORDER BY a.data_ora DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/attivita/meta', (req, res) => {
  const utenti = db.prepare(`
    SELECT id, nome, email
    FROM utenti
    WHERE attivo = 1
    ORDER BY nome
  `).all();
  const anagrafiche = db.prepare(`
    SELECT id, ragione_sociale, tipo
    FROM anagrafiche
    WHERE attivo = 1
    ORDER BY ragione_sociale
  `).all();
  res.json({ utenti, anagrafiche });
});

router.post('/attivita', (req, res) => {
  const { tipo, anagrafica_id, ordine_id, assegnato_a, data_ora, durata_minuti, oggetto, note, esito, promemoria_il, stato } = req.body || {};
  const assegnatoId = i(assegnato_a);
  const r = db.prepare(`INSERT INTO attivita (tipo,anagrafica_id,ordine_id,utente_id,assegnato_a,data_ora,durata_minuti,oggetto,note,esito,promemoria_il,stato)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      s(tipo) || 'nota',
      i(anagrafica_id),
      i(ordine_id),
      req.user.id,
      assegnatoId,
      s(data_ora),
      i(durata_minuti),
      s(oggetto) || 'Attivita',
      s(note),
      s(esito),
      s(promemoria_il),
      s(stato) || 'aperta'
    );
  if (assegnatoId && assegnatoId !== req.user.id) {
    db.prepare(`
      INSERT OR IGNORE INTO notifiche_app (utente_id, tipo, titolo, messaggio, entita_tipo, entita_id, unique_key)
      VALUES (?, 'attivita_assegnata', ?, ?, 'attivita', ?, ?)
    `).run(
      assegnatoId,
      'Nuova attività assegnata',
      s(oggetto) || 'Attività CRM',
      r.lastInsertRowid,
      `attivita:${assegnatoId}:${r.lastInsertRowid}`
    );
  }
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
  const prodottoId = i(prodotto_id);
  let qty = i(quantita);
  const movTipo = s(tipo);
  if (!prodottoId || qty === null || qty < 0) return res.status(400).json({ error: 'Prodotto e quantita sono obbligatori' });
  if (!['carico', 'scarico', 'rettifica', 'reso'].includes(movTipo)) return res.status(400).json({ error: 'Tipo movimento non valido' });
  if (movTipo === 'rettifica') qty = qty - getGiacenza(prodottoId);
  if (['scarico', 'reso'].includes(movTipo) && getGiacenza(prodottoId) < qty) {
    return res.status(400).json({ error: 'Giacenza insufficiente per questo movimento' });
  }
  if (movTipo !== 'rettifica' && qty <= 0) return res.status(400).json({ error: 'La quantita deve essere maggiore di zero' });
  const r = db.prepare('INSERT INTO magazzino_movimenti (prodotto_id,tipo,quantita,riferimento_tipo,note) VALUES (?,?,?,?,?)')
    .run(prodottoId, movTipo, qty, 'manuale', s(note));
  res.json({ id: r.lastInsertRowid });
});

router.put('/attivita/:id', async (req, res) => {
  try {
    const current = db.prepare('SELECT * FROM attivita WHERE id = ?').get(req.params.id);
    if (!current) return res.status(404).json({ error: 'Attività non trovata' });
    const { tipo, anagrafica_id, ordine_id, assegnato_a, data_ora, durata_minuti, oggetto, note, esito, promemoria_il, stato } = req.body || {};
    db.prepare(`UPDATE attivita
      SET tipo = ?, anagrafica_id = ?, ordine_id = ?, assegnato_a = ?, data_ora = ?, durata_minuti = ?,
          oggetto = ?, note = ?, esito = ?, promemoria_il = ?, stato = ?
      WHERE id = ?`).run(
        s(tipo) || current.tipo || 'nota',
        i(anagrafica_id),
        i(ordine_id),
        i(assegnato_a),
        s(data_ora),
        i(durata_minuti),
        s(oggetto) || current.oggetto || 'Attivita',
        s(note),
        s(esito),
        s(promemoria_il),
        s(stato) || current.stato || 'aperta',
        req.params.id
      );
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/attivita/:id/google-sync', async (req, res) => {
  try {
    const current = db.prepare('SELECT * FROM attivita WHERE id = ?').get(req.params.id);
    if (!current) return res.status(404).json({ error: 'Attività non trovata' });
    const payload = buildGoogleEventPayload(req.body || {});
    let googleEventId = current.google_event_id || null;
    if (googleEventId) {
      await updateEvent(req.user.id, googleEventId, payload);
    } else {
      const created = await createEvent(req.user.id, payload);
      googleEventId = created?.id || null;
    }
    db.prepare('UPDATE attivita SET google_event_id = ? WHERE id = ?').run(googleEventId, req.params.id);
    res.json({ ok: true, google_event_id: googleEventId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/attivita/:id', async (req, res) => {
  try {
    const current = db.prepare('SELECT * FROM attivita WHERE id = ?').get(req.params.id);
    if (!current) return res.status(404).json({ error: 'Attività non trovata' });
    if (current.google_event_id) {
      try { await deleteEvent(req.user.id, current.google_event_id); } catch {}
    }
    db.prepare('DELETE FROM attivita WHERE id = ?').run(req.params.id);
    try {
      db.prepare(`UPDATE mepa_mail_alerts
        SET attivita_id = NULL, sync_attiva = 0, attivita_disattivata = 1, stato = CASE WHEN stato = 'nuova' THEN 'archiviata' ELSE stato END
        WHERE attivita_id = ?`).run(req.params.id);
    } catch {}
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
