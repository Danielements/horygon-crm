const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const { createEvent, updateEvent, deleteEvent, processMepaAutomation, notifyUsersWithEmail, emailCustomerIfEnabled, sendMail, getSetting } = require('../services/google');
const { writeSystemLog } = require('../services/system-log');
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
const COMPANY_INFO = {
  name: 'HORYGON S.R.L.',
  addressLine1: 'Via Monte Lupone 4C',
  addressLine2: '04100 Latina (LT) - Italia',
  email: 'info@horygon.com',
  website: 'www.horygon.com',
  pec: 'horygonsrl@pec.it',
  rea: 'LT - 335485',
  piva: '03365990591'
};

async function sendAssignmentEmailDirect(senderUserId, assigneeUser, { titolo, data, stato, note, operatore }) {
  if (getSetting('automation.email_users_activity_assignments', '0') !== '1') {
    return { skipped: true, reason: 'setting_disabled' };
  }
  const email = String(assigneeUser?.email || '').trim();
  if (!email) {
    writeSystemLog({
      livello: 'warning',
      origine: 'crm.attivita.assignment.direct-email',
      utente_id: senderUserId || null,
      messaggio: 'Utente assegnato senza email diretta in utenti.email',
      dettagli: { assigneeUserId: assigneeUser?.id || null, assigneeName: assigneeUser?.nome || null, titolo }
    });
    return { skipped: true, reason: 'missing_user_email' };
  }
  const subject = `[Horygon] Assegnazione attivita a ${assigneeUser?.nome || 'utente'}`;
  const text = `Ti e stata assegnata l'attivita "${titolo || 'Attivita CRM'}".\n\nAttivita assegnata a: ${assigneeUser?.nome || 'Utente'}\nTitolo: ${titolo || 'Attivita CRM'}\nData: ${data || '-'}\nStato: ${stato || '-'}\n\n${note ? `Note:\n${note}\n\n` : ''}Operatore: ${operatore || 'Horygon CRM'}`;
  await sendMail(senderUserId, email, subject, text);
  return { sent: true, email };
}
const DDT_LOGO_PATH_DATA = 'M156.9,94l3.4-5.8c.4-.6.4-1.4,0-2l-2.6-4.5h0s-21.1-36.7-21.1-36.7c-.4-.6-1-1-1.7-1h-42.1c0,0,0,0,0,0h-5.5c-.7,0-1.4.4-1.7,1l-21.1,36.5h0s-2.7,4.8-2.7,4.8c-.4.6-.4,1.4,0,2l2.6,4.5h0s21.1,36.7,21.1,36.7c.4.6,1,1,1.7,1h5.5s0,0,0,0h29.5c0,0,7,0,7,0h0s5.5,0,5.5,0c.7,0,1.4-.4,1.7-1l20.5-35.5ZM115,84.8l21.2-11c1.3-.7,2.9.3,2.9,1.8v26.8c0,.7-.4,1.4-1,1.7l-21.2,12.3c-1.3.8-3-.2-3-1.7v-28.1c0-.8.3-1.4,1-1.8ZM131.8,70.2l-19.9,9.9c-.6.3-1.2.3-1.8,0l-19.7-10c-1.4-.7-1.5-2.7-.1-3.5l19.7-11.4c.6-.4,1.4-.4,2,0l19.9,11.5c1.4.8,1.3,2.8-.1,3.5ZM85.8,73.8l21,11.1c.7.3,1.1,1,1.1,1.8v28c.1,1.5-1.5,2.5-2.9,1.7l-21.2-12.3c-.6-.4-1-1-1-1.7v-26.8c0-1.5,1.6-2.5,2.9-1.8Z';
const DDT_COLOR = '#2563eb';
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
      (SELECT COUNT(*) FROM ddt_righe dr WHERE dr.ddt_id = d.id) as righe_count,
      (
        SELECT COUNT(*)
        FROM audit_log l
        WHERE l.entita_tipo = 'ddt' AND l.entita_id = d.id AND l.azione = 'documento_inviato'
      ) AS sent_count,
      (
        SELECT MAX(l.creato_il)
        FROM audit_log l
        WHERE l.entita_tipo = 'ddt' AND l.entita_id = d.id AND l.azione = 'documento_inviato'
      ) AS last_sent_at
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

router.delete('/ddt/:id', requirePermesso('ddt', 'delete'), (req, res) => {
  db.prepare('DELETE FROM magazzino_movimenti WHERE riferimento_tipo = ? AND riferimento_id = ?').run('ddt', req.params.id);
  const result = db.prepare('DELETE FROM ddt WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'DDT non trovato' });
  res.json({ ok: true });
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

router.post('/ordini/:id/convert-to-ddt', (req, res) => {
  const ordine = db.prepare(`
    SELECT o.*, a.ragione_sociale
    FROM ordini o
    LEFT JOIN anagrafiche a ON a.id = o.anagrafica_id
    WHERE o.id = ?
  `).get(req.params.id);
  if (!ordine) return res.status(404).json({ error: 'Ordine non trovato' });

  const existing = db.prepare('SELECT id, numero_ddt FROM ddt WHERE ordine_id = ? ORDER BY id DESC LIMIT 1').get(req.params.id);
  if (existing) return res.status(400).json({ error: `DDT già creato: ${existing.numero_ddt}` });

  const righe = db.prepare(`
    SELECT prodotto_id, quantita
    FROM ordini_righe
    WHERE ordine_id = ?
    ORDER BY id
  `).all(req.params.id);
  if (!righe.length) return res.status(400).json({ error: 'Ordine senza righe articolo' });

  const ddtTipo = ordine.tipo === 'acquisto' ? 'entrata' : 'uscita';
  const cleanRighe = righe
    .map(r => ({ prodotto_id: i(r.prodotto_id), quantita: i(r.quantita), lotto: null }))
    .filter(r => r.prodotto_id && r.quantita && r.quantita > 0);

  const ddtNumero = `DDT-${String(ordine.codice_ordine || ordine.id).replace(/[^A-Za-z0-9-]/g, '').slice(-20)}-${Date.now().toString().slice(-4)}`;

  try {
    db.exec('BEGIN');
    const r = db.prepare(`
      INSERT INTO ddt
      (numero_ddt, tipo, ordine_id, data, destinatario_id, vettore, causale, note)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      ddtNumero,
      ddtTipo,
      ordine.id,
      s(ordine.data_ordine) || new Date().toISOString().slice(0, 10),
      i(ordine.anagrafica_id),
      s(ordine.corriere),
      ordine.tipo === 'acquisto' ? 'Ricevimento merce da ordine' : 'Consegna merce da ordine',
      s(ordine.note)
    );
    const ddtId = r.lastInsertRowid;
    const ins = db.prepare('INSERT INTO ddt_righe (ddt_id,prodotto_id,quantita,lotto) VALUES (?,?,?,?)');
    cleanRighe.forEach(riga => ins.run(ddtId, riga.prodotto_id, riga.quantita, riga.lotto));
    syncMovimentiFromDdt(ddtId, ddtTipo, cleanRighe);
    db.exec('COMMIT');
    res.json({ ok: true, ddt_id: ddtId, numero_ddt: ddtNumero });
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    res.status(400).json({ error: e.message });
  }
});

router.get('/ddt/:id/pdf', (req, res) => {
  const d = db.prepare(`SELECT d.*,
      dest.ragione_sociale as destinatario_nome,
      dest.indirizzo as destinatario_indirizzo,
      dest.cap as destinatario_cap,
      dest.citta as destinatario_citta,
      dest.provincia as destinatario_provincia,
      dest.email as destinatario_email,
      dest.telefono as destinatario_telefono,
      mitt.ragione_sociale as mittente_nome,
      mitt.indirizzo as mittente_indirizzo,
      mitt.cap as mittente_cap,
      mitt.citta as mittente_citta,
      mitt.provincia as mittente_provincia,
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
  const colors = {
    ink: '#1f2937',
    muted: '#6b7280',
    border: '#cbd5e1',
    soft: '#eef2ff',
    line: '#e5e7eb'
  };
  const startX = 40;
  const pageWidth = doc.page.width - 80;
  const contentRight = startX + pageWidth;
  const logoSize = 50;
  const companyBlockX = 112;

  const formatAddress = (name, address, cap, city, province) => {
    const line2 = [cap, city, province ? `(${province})` : ''].filter(Boolean).join(' ').trim();
    return [name, address, line2].filter(Boolean).join('\n') || '-';
  };

  const infoBox = (x, y, w, h, title, body, opts = {}) => {
    const titleColor = opts.titleColor || DDT_COLOR;
    const fill = opts.fill || '#ffffff';
    doc.roundedRect(x, y, w, h, 8).fillAndStroke(fill, colors.border);
    doc.fillColor(titleColor).fontSize(8).font('Helvetica-Bold').text(String(title).toUpperCase(), x + 10, y + 8);
    doc.fillColor(colors.ink).fontSize(10).font('Helvetica').text(body || '-', x + 10, y + 23, {
      width: w - 20,
      height: h - 28
    });
  };

  const drawHeader = () => {
    doc.roundedRect(startX, 36, pageWidth, 102, 12).fillAndStroke('#ffffff', colors.border);
    doc.save();
    doc.translate(startX + 16, 50);
    doc.scale(logoSize / 220);
    doc.path(DDT_LOGO_PATH_DATA).fill(DDT_COLOR);
    doc.restore();
    doc.fillColor(DDT_COLOR).font('Helvetica-Bold').fontSize(18).text(COMPANY_INFO.name, companyBlockX, 48);
    doc.font('Helvetica').fontSize(9).fillColor(colors.ink)
      .text(COMPANY_INFO.addressLine1, companyBlockX, 72)
      .text(COMPANY_INFO.addressLine2, companyBlockX, 84)
      .text(`Email ${COMPANY_INFO.email}  |  ${COMPANY_INFO.website}`, companyBlockX, 96)
      .text(`PEC ${COMPANY_INFO.pec}`, companyBlockX, 108);

    doc.roundedRect(contentRight - 188, 48, 172, 78, 10).fillAndStroke(colors.soft, colors.border);
    doc.fillColor(DDT_COLOR).font('Helvetica-Bold').fontSize(22).text('DDT', contentRight - 172, 60, { width: 120, align: 'left' });
    doc.fontSize(9).fillColor(colors.ink).font('Helvetica')
      .text(`Numero: ${d.numero_ddt || '-'}`, contentRight - 172, 90, { width: 150 })
      .text(`Data: ${d.data || '-'}`, contentRight - 172, 104, { width: 150 });
  };

  const drawFooter = () => {
    doc.moveTo(startX, 786).lineTo(contentRight, 786).stroke(colors.line);
    doc.font('Helvetica').fontSize(8).fillColor(colors.muted)
      .text(`REA ${COMPANY_INFO.rea}  |  P.IVA ${COMPANY_INFO.piva}`, startX, 792, { width: 260 })
      .text(`${COMPANY_INFO.website}  |  ${COMPANY_INFO.email}`, contentRight - 200, 792, { width: 200, align: 'right' });
  };

  drawHeader();
  drawFooter();

  let y = 156;
  infoBox(startX, y, 250, 76, 'Mittente', formatAddress(
    d.mittente_nome || COMPANY_INFO.name,
    d.mittente_indirizzo || COMPANY_INFO.addressLine1,
    d.mittente_cap || '04100',
    d.mittente_citta || 'Latina',
    d.mittente_provincia || 'LT'
  ));
  infoBox(305, y, 250, 76, 'Destinatario', formatAddress(
    d.destinatario_nome,
    d.indirizzo_consegna || d.destinatario_indirizzo,
    d.destinatario_cap,
    d.destinatario_citta,
    d.destinatario_provincia
  ));

  y += 90;
  infoBox(40, y, 118, 54, 'Causale', d.causale || (d.tipo === 'entrata' ? 'Reso / entrata merce' : 'Vendita'));
  infoBox(168, y, 86, 54, 'Porto', d.porto || '-');
  infoBox(264, y, 86, 54, 'Resa', d.resa || '-');
  infoBox(360, y, 90, 54, 'Colli', d.colli || '-');
  infoBox(460, y, 95, 54, 'Peso', d.peso_totale ? `${d.peso_totale} kg` : '-');

  y += 66;
  infoBox(40, y, 165, 54, 'Aspetto beni', d.aspetto_beni || '-');
  infoBox(215, y, 165, 54, 'Fattura', d.fattura_numero || '-');
  infoBox(390, y, 165, 54, 'Trasporto a cura di', d.vettore || d.corriere || '-');

  y += 66;
  const trasportoText = [
    d.corriere ? `Corriere: ${d.corriere}` : '',
    d.numero_spedizione ? `Spedizione n. ${d.numero_spedizione}` : '',
    d.data_ora_trasporto ? `Data/ora trasporto: ${d.data_ora_trasporto}` : ''
  ].filter(Boolean).join('  |  ');
  infoBox(40, y, 515, 54, 'Annotazioni trasporto', trasportoText || 'Nessuna annotazione di trasporto');

  y += 78;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(colors.ink).text('Dettaglio beni trasportati', startX, y);
  y += 18;
  doc.roundedRect(startX, y, 515, 22, 6).fill(DDT_COLOR);
  doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold')
    .text('Codice', 48, y + 7, { width: 72 })
    .text('Descrizione', 126, y + 7, { width: 258 })
    .text('Lotto', 390, y + 7, { width: 86 })
    .text('Q.tà', 500, y + 7, { width: 35, align: 'right' });
  y += 24;

  const drawRowsHeader = () => {
    doc.roundedRect(startX, y, 515, 22, 6).fill(DDT_COLOR);
    doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold')
      .text('Codice', 48, y + 7, { width: 72 })
      .text('Descrizione', 126, y + 7, { width: 258 })
      .text('Lotto', 390, y + 7, { width: 86 })
      .text('Q.tà', 500, y + 7, { width: 35, align: 'right' });
    y += 24;
  };

  righe.forEach((r, idx) => {
    if (y > 710) {
      doc.addPage();
      drawHeader();
      drawFooter();
      y = 72;
      drawRowsHeader();
    }
    const rowFill = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
    doc.roundedRect(startX, y, 515, 24, 4).fillAndStroke(rowFill, colors.line);
    doc.fillColor(colors.ink).font('Helvetica').fontSize(8)
      .text(r.codice_interno || '-', 48, y + 7, { width: 70 })
      .text(r.nome || '-', 126, y + 7, { width: 255 })
      .text(r.lotto || '-', 390, y + 7, { width: 84 })
      .text(String(r.quantita || '-'), 500, y + 7, { width: 35, align: 'right' });
    y += 26;
  });

  if (!righe.length) {
    doc.roundedRect(startX, y, 515, 24, 4).fillAndStroke('#ffffff', colors.line);
    doc.fillColor(colors.muted).font('Helvetica').fontSize(8).text('Nessun articolo indicato', 48, y + 7);
    y += 26;
  }

  y += 12;
  if (d.note || d.note_spedizione) {
    const notes = [d.note, d.note_spedizione ? `Note spedizione: ${d.note_spedizione}` : ''].filter(Boolean).join('\n');
    const notesHeight = Math.max(58, Math.min(100, doc.heightOfString(notes, { width: 495 }) + 26));
    infoBox(40, y, 515, notesHeight, 'Note', notes);
    y += notesHeight + 18;
  }

  if (y > 700) {
    doc.addPage();
    drawHeader();
    drawFooter();
    y = 640;
  }

  doc.font('Helvetica').fontSize(9).fillColor(colors.ink)
    .text('Firma del vettore ________________________________', 40, 748)
    .text('Firma del destinatario ________________________________', 290, 748);
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

router.post('/attivita', async (req, res, next) => {
  const { tipo, anagrafica_id, ordine_id, assegnato_a, data_ora, durata_minuti, oggetto, note, esito, promemoria_il, stato } = req.body || {};
  try {
    const assegnatoId = i(assegnato_a);
    const titoloAttivita = s(oggetto) || 'Attivita CRM';
    const nextState = s(stato) || 'aperta';
    const assegnatoUser = assegnatoId
      ? db.prepare('SELECT id, nome, email FROM utenti WHERE id = ? AND attivo = 1').get(assegnatoId)
      : null;
    const r = db.prepare(`INSERT INTO attivita (tipo,anagrafica_id,ordine_id,utente_id,assegnato_a,data_ora,durata_minuti,oggetto,note,esito,promemoria_il,stato)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        s(tipo) || 'nota',
        i(anagrafica_id),
        i(ordine_id),
        req.user.id,
        assegnatoId,
        s(data_ora),
        i(durata_minuti),
        titoloAttivita,
        s(note),
        s(esito),
        s(promemoria_il),
        nextState
      );
    const activityId = r.lastInsertRowid;
    const recipientIds = assegnatoId ? [assegnatoId] : [req.user.id];
    let notificationResult = null;
    let assignmentEmailResult = null;
    if (recipientIds.length) {
      notificationResult = await notifyUsersWithEmail({
        senderUserId: req.user.id,
        userIds: recipientIds,
        tipo: assegnatoId ? 'attivita_assegnata' : 'attivita_creata',
        titolo: assegnatoId ? `Nuova attivita CRM per ${assegnatoUser?.nome || 'utente'}` : `Nuova attivita CRM: ${titoloAttivita}`,
        messaggio: `${assegnatoId ? 'Attivita assegnata' : 'Nuova attivita'}: ${titoloAttivita}${data_ora ? ` • ${data_ora}` : ''}`,
        livello_urgenza: 'alta',
        entita_tipo: 'attivita',
        entita_id: activityId,
        uniqueSuffix: assegnatoId ? 'assigned' : 'created',
        emailSettingKey: assegnatoId ? 'automation.email_users_activity_assignments' : 'automation.email_users_activity_updates',
        emailSubject: assegnatoId ? `[Horygon] Assegnazione attivita a ${assegnatoUser?.nome || 'utente'}` : `[Horygon] Nuova attivita CRM: ${titoloAttivita}`,
        emailText: `${assegnatoId ? `Ti e stata assegnata l'attivita "${titoloAttivita}".` : 'E stata creata una nuova attivita CRM.'}\n\nAttivita assegnata a: ${assegnatoUser?.nome || req.user.nome || 'Utente'}\nTitolo: ${titoloAttivita}\nData: ${data_ora || '-'}\nStato: ${nextState}\n\n${note ? `Note:\n${note}\n\n` : ''}Operatore: ${req.user.nome || 'Horygon CRM'}`
      });
      if (assegnatoId && assegnatoUser) {
        try {
          assignmentEmailResult = await sendAssignmentEmailDirect(req.user.id, assegnatoUser, {
            titolo: titoloAttivita,
            data: data_ora || '-',
            stato: nextState,
            note,
            operatore: req.user.nome || 'Horygon CRM'
          });
        } catch (error) {
          writeSystemLog({
            livello: 'error',
            origine: 'crm.attivita.create.assignment.direct-email',
            utente_id: req.user.id,
            messaggio: error?.message || 'Errore invio email assegnazione attività',
            stack: error?.stack || null,
            dettagli: {
              activityId,
              assegnatoId,
              assigneeName: assegnatoUser?.nome || null,
              assigneeEmail: assegnatoUser?.email || null
            }
          });
        }
      }
    }
    res.json({ id: activityId, notificationResult, assignmentEmailResult });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT') return next();
    res.status(400).json({ error: e.message });
  }
});

router.post('/attivita-legacy-disabled', (req, res) => {
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
  if (assegnatoId) {
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

router.put('/attivita/:id', async (req, res, next) => {
  try {
    const current = db.prepare(`
      SELECT a.*, an.ragione_sociale, an.email as anagrafica_email
      FROM attivita a
      LEFT JOIN anagrafiche an ON an.id = a.anagrafica_id
      WHERE a.id = ?
    `).get(req.params.id);
    if (!current) return res.status(404).json({ error: 'Attivita non trovata' });
    const { tipo, anagrafica_id, ordine_id, assegnato_a, data_ora, durata_minuti, oggetto, note, esito, promemoria_il, stato } = req.body || {};
    const nextAssignedId = i(assegnato_a);
    const nextState = s(stato) || current.stato || 'aperta';
    const nextDate = s(data_ora);
    const nextTitle = s(oggetto) || current.oggetto || 'Attivita';
    db.prepare(`UPDATE attivita
      SET tipo = ?, anagrafica_id = ?, ordine_id = ?, assegnato_a = ?, data_ora = ?, durata_minuti = ?,
          oggetto = ?, note = ?, esito = ?, promemoria_il = ?, stato = ?
      WHERE id = ?`).run(
        s(tipo) || current.tipo || 'nota',
        i(anagrafica_id),
        i(ordine_id),
        nextAssignedId,
        nextDate,
        i(durata_minuti),
        nextTitle,
        s(note),
        s(esito),
        s(promemoria_il),
        nextState,
        req.params.id
      );
    const updated = db.prepare(`
      SELECT a.*, an.ragione_sociale, an.email as anagrafica_email
      FROM attivita a
      LEFT JOIN anagrafiche an ON an.id = a.anagrafica_id
      WHERE a.id = ?
    `).get(req.params.id);
    const changedFields = [];
    if ((current.assegnato_a || null) !== (updated.assegnato_a || null)) changedFields.push('assegnazione');
    if ((current.stato || '') !== (updated.stato || '')) changedFields.push('stato');
    if ((current.data_ora || '') !== (updated.data_ora || '')) changedFields.push('data');
    if ((current.oggetto || '') !== (updated.oggetto || '')) changedFields.push('titolo');
    if ((current.esito || '') !== (updated.esito || '')) changedFields.push('esito');
    if ((current.promemoria_il || '') !== (updated.promemoria_il || '')) changedFields.push('promemoria');

    if (updated.assegnato_a && updated.assegnato_a !== current.assegnato_a) {
      const assignedUser = db.prepare('SELECT id, nome, email FROM utenti WHERE id = ? AND attivo = 1').get(updated.assegnato_a);
      await notifyUsersWithEmail({
        senderUserId: req.user.id,
        userIds: [updated.assegnato_a],
        tipo: 'attivita_assegnata',
        titolo: `Nuova attivita CRM per ${assignedUser?.nome || 'utente'}`,
        messaggio: `Attivita assegnata: ${updated.oggetto || 'Attivita CRM'}${updated.data_ora ? ` • ${updated.data_ora}` : ''}`,
        livello_urgenza: 'alta',
        entita_tipo: 'attivita',
        entita_id: updated.id,
        uniqueSuffix: `assigned:${updated.assegnato_a}`,
        emailSettingKey: 'automation.email_users_activity_assignments',
        emailSubject: `[Horygon] Assegnazione attivita a ${assignedUser?.nome || 'utente'}`,
        emailText: `Ti e stata assegnata l'attivita "${updated.oggetto || 'Attivita CRM'}".\n\nAttivita assegnata a: ${assignedUser?.nome || 'Utente'}\nTitolo: ${updated.oggetto || 'Attivita CRM'}\nData: ${updated.data_ora || '-'}\nStato: ${updated.stato || '-'}\n\nAggiornata da: ${req.user.nome || 'Horygon CRM'}`
      });
      try {
        await sendAssignmentEmailDirect(req.user.id, assignedUser, {
          titolo: updated.oggetto || 'Attivita CRM',
          data: updated.data_ora || '-',
          stato: updated.stato || '-',
          note: updated.note || '',
          operatore: req.user.nome || 'Horygon CRM'
        });
      } catch (error) {
        writeSystemLog({
          livello: 'error',
          origine: 'crm.attivita.update.assignment.direct-email',
          utente_id: req.user.id,
          messaggio: error?.message || 'Errore invio email assegnazione attività',
          stack: error?.stack || null,
          dettagli: {
            activityId: updated.id,
            assegnatoId: updated.assegnato_a,
            assigneeName: assignedUser?.nome || null,
            assigneeEmail: assignedUser?.email || null
          }
        });
      }
    }

    const assignmentOnly = changedFields.length === 1 && changedFields[0] === 'assegnazione';
    if (changedFields.length && !assignmentOnly) {
      const recipientIds = [...new Set([updated.assegnato_a, updated.utente_id].filter(v => v))];
      if (recipientIds.length) {
        await notifyUsersWithEmail({
          senderUserId: req.user.id,
          userIds: recipientIds,
          tipo: 'attivita_aggiornata',
          titolo: 'Attivita aggiornata',
          messaggio: `${updated.oggetto || 'Attivita CRM'} • aggiornati: ${changedFields.join(', ')}`,
          livello_urgenza: updated.stato === 'chiusa' ? 'media' : 'alta',
          entita_tipo: 'attivita',
          entita_id: updated.id,
          uniqueSuffix: `updated:${changedFields.join('-')}:${updated.stato || ''}:${updated.data_ora || ''}`,
          emailSettingKey: 'automation.email_users_activity_updates',
          emailSubject: '[Horygon] Attivita aggiornata',
          emailText: `E stata aggiornata un'attivita CRM.\n\nTitolo: ${updated.oggetto || 'Attivita CRM'}\nCliente: ${updated.ragione_sociale || '-'}\nStato: ${current.stato || '-'} -> ${updated.stato || '-'}\nData: ${updated.data_ora || '-'}\nCampi aggiornati: ${changedFields.join(', ')}\n\nAggiornata da: ${req.user.nome || 'Horygon CRM'}`
        });
      }

      if (updated.anagrafica_email && (changedFields.includes('stato') || changedFields.includes('data'))) {
        await emailCustomerIfEnabled({
          senderUserId: req.user.id,
          to: updated.anagrafica_email,
          settingKey: 'automation.email_clients_activity_updates',
          subject: `Aggiornamento attivita ${updated.oggetto || 'CRM'}`,
          text: `Gentile ${updated.ragione_sociale || 'cliente'},\n\nla vostra attivita collegata al CRM e stata aggiornata.\n\nTitolo: ${updated.oggetto || 'Attivita'}\nStato: ${updated.stato || '-'}\nData: ${updated.data_ora || '-'}\n\nPer qualsiasi esigenza potete contattarci rispondendo a questa email.\n\nHorygon CRM`
        });
      }
    }
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT') return next();
    res.status(400).json({ error: e.message });
  }
});

router.put('/attivita-legacy-disabled/:id', async (req, res) => {
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
