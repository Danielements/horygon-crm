const PDFDocument = require('pdfkit');
const db = require('../db/database');

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

const LOGO_PATH_DATA = 'M156.9,94l3.4-5.8c.4-.6.4-1.4,0-2l-2.6-4.5h0s-21.1-36.7-21.1-36.7c-.4-.6-1-1-1.7-1h-42.1c0,0,0,0,0,0h-5.5c-.7,0-1.4.4-1.7,1l-21.1,36.5h0s-2.7,4.8-2.7,4.8c-.4.6-.4,1.4,0,2l2.6,4.5h0s21.1,36.7,21.1,36.7c.4.6,1,1,1.7,1h5.5s0,0,0,0h29.5c0,0,7,0,7,0h0s5.5,0,5.5,0c.7,0,1.4-.4,1.7-1l20.5-35.5ZM115,84.8l21.2-11c1.3-.7,2.9.3,2.9,1.8v26.8c0,.7-.4,1.4-1,1.7l-21.2,12.3c-1.3.8-3-.2-3-1.7v-28.1c0-.8.3-1.4,1-1.8ZM131.8,70.2l-19.9,9.9c-.6.3-1.2.3-1.8,0l-19.7-10c-1.4-.7-1.5-2.7-.1-3.5l19.7-11.4c.6-.4,1.4-.4,2,0l19.9,11.5c1.4.8,1.3,2.8-.1,3.5ZM85.8,73.8l21,11.1c.7.3,1.1,1,1.1,1.8v28c.1,1.5-1.5,2.5-2.9,1.7l-21.2-12.3c-.6-.4-1-1-1-1.7v-26.8c0-1.5,1.6-2.5,2.9-1.8Z';

const DOC_THEMES = {
  preventivo: { accent: '#c59b08', label: 'PREVENTIVO', fill: '#fff8db' },
  ordine: { accent: '#0f766e', label: 'ORDINE', fill: '#ecfeff' },
  ddt: { accent: '#2563eb', label: 'DDT', fill: '#eff6ff' }
};

function money(value, valuta = 'EUR') {
  const num = Number(value || 0);
  return `${valuta} ${num.toFixed(2)}`;
}

function bufferFromDoc(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function formatAddress(name, address, cap, city, province) {
  const line2 = [cap, city, province ? `(${province})` : ''].filter(Boolean).join(' ').trim();
  return [name, address, line2].filter(Boolean).join('\n') || '-';
}

function getBaseColors(accent) {
  return {
    accent,
    ink: '#1f2937',
    muted: '#6b7280',
    border: '#cbd5e1',
    soft: '#f8fafc',
    line: '#e5e7eb'
  };
}

function drawCommonFrame(doc, theme, topRightLines = []) {
  const colors = getBaseColors(theme.accent);
  const startX = 40;
  const pageWidth = doc.page.width - 80;
  const contentRight = startX + pageWidth;
  const logoSize = 50;
  const companyBlockX = 112;

  doc.roundedRect(startX, 36, pageWidth, 102, 12).fillAndStroke('#ffffff', colors.border);
  doc.save();
  doc.translate(startX + 16, 50);
  doc.scale(logoSize / 220);
  doc.path(LOGO_PATH_DATA).fill(theme.accent);
  doc.restore();

  doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(18).text(COMPANY_INFO.name, companyBlockX, 48);
  doc.font('Helvetica').fontSize(9).fillColor(colors.ink)
    .text(COMPANY_INFO.addressLine1, companyBlockX, 72)
    .text(COMPANY_INFO.addressLine2, companyBlockX, 84)
    .text(`Email ${COMPANY_INFO.email}  |  ${COMPANY_INFO.website}`, companyBlockX, 96)
    .text(`PEC ${COMPANY_INFO.pec}`, companyBlockX, 108);

  const labelBoxWidth = theme.label.length > 8 ? 188 : 172;
  const labelBoxX = contentRight - (labelBoxWidth + 16);
  const labelFontSize = theme.label.length > 8 ? 20 : 22;
  doc.roundedRect(labelBoxX, 48, labelBoxWidth, 78, 10).fillAndStroke(theme.fill, colors.border);
  doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(labelFontSize).text(theme.label, labelBoxX + 16, 60, { width: labelBoxWidth - 24, align: 'left' });
  doc.fontSize(9).fillColor(colors.ink).font('Helvetica');
  topRightLines.forEach((line, index) => {
    doc.text(line, labelBoxX + 16, 90 + (index * 14), { width: labelBoxWidth - 22 });
  });

  doc.moveTo(startX, 786).lineTo(contentRight, 786).stroke(colors.line);
  doc.font('Helvetica').fontSize(8).fillColor(colors.muted)
    .text(`REA ${COMPANY_INFO.rea}  |  P.IVA ${COMPANY_INFO.piva}`, startX, 792, { width: 260 })
    .text(`${COMPANY_INFO.website}  |  ${COMPANY_INFO.email}`, contentRight - 200, 792, { width: 200, align: 'right' });

  return { colors, startX, pageWidth, contentRight };
}

function drawInfoBox(doc, colors, accent, x, y, w, h, title, body, fill = '#ffffff') {
  doc.roundedRect(x, y, w, h, 8).fillAndStroke(fill, colors.border);
  doc.fillColor(accent).fontSize(8).font('Helvetica-Bold').text(String(title).toUpperCase(), x + 10, y + 8);
  doc.fillColor(colors.ink).fontSize(10).font('Helvetica').text(body || '-', x + 10, y + 23, {
    width: w - 20,
    height: h - 28
  });
}

function drawRowsTable(doc, theme, setup) {
  const { colors, startX, contentRight } = setup;
  let y = setup.y;
  const width = contentRight - startX;
  const columns = setup.columns;
  const rows = setup.rows || [];
  const title = setup.title || 'Righe';
  const footerTop = 730;

  const headerHeight = 24;
  const drawHeader = () => {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(colors.ink).text(title, startX, y);
    y += 18;
    doc.roundedRect(startX, y, width, headerHeight, 6).fill(theme.accent);
    doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold');
    columns.forEach((col) => {
      doc.text(col.label, startX + col.x, y + 7, { width: col.width, align: col.align || 'left' });
    });
    y += headerHeight + 2;
  };

  drawHeader();

  rows.forEach((row, idx) => {
    const rowHeight = 26;
    if (y > footerTop) {
      doc.addPage();
      drawCommonFrame(doc, theme, setup.headerLines || []);
      y = 72;
      drawHeader();
    }
    const fill = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
    doc.roundedRect(startX, y, width, rowHeight, 4).fillAndStroke(fill, colors.line);
    doc.fillColor(colors.ink).font('Helvetica').fontSize(8.5);
    columns.forEach((col) => {
      const value = typeof col.value === 'function' ? col.value(row) : row[col.key];
      doc.text(String(value ?? '-'), startX + col.x, y + 8, { width: col.width, align: col.align || 'left' });
    });
    y += rowHeight + 4;
  });

  return y;
}

async function createPreventivoPdfBuffer(id) {
  const row = db.prepare(`
    SELECT p.*, a.ragione_sociale, a.indirizzo, a.cap, a.citta, a.provincia, a.piva, a.cf, a.email
    FROM preventivi p
    LEFT JOIN anagrafiche a ON a.id = p.anagrafica_id
    WHERE p.id = ?
  `).get(id);
  if (!row) throw new Error('Preventivo non trovato');
  const righe = db.prepare(`
    SELECT r.*, pr.nome, pr.codice_interno
    FROM preventivi_righe r
    LEFT JOIN prodotti pr ON pr.id = r.prodotto_id
    WHERE r.preventivo_id = ?
    ORDER BY r.id
  `).all(id);

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const done = bufferFromDoc(doc);
  const theme = DOC_THEMES.preventivo;
  const frame = drawCommonFrame(doc, theme, [
    `Numero: ${row.codice_preventivo || row.id}`,
    `Data: ${row.data_preventivo || '-'}`,
    `Scadenza: ${row.data_scadenza || '-'}`
  ]);
  const { colors, startX } = frame;

  let y = 156;
  drawInfoBox(doc, colors, theme.accent, startX, y, 250, 76, 'Emittente', formatAddress(
    COMPANY_INFO.name,
    COMPANY_INFO.addressLine1,
    '04100',
    'Latina',
    'LT'
  ));
  drawInfoBox(doc, colors, theme.accent, 305, y, 250, 76, 'Cliente', formatAddress(
    row.ragione_sociale,
    row.indirizzo,
    row.cap,
    row.citta,
    row.provincia
  ));

  y += 90;
  drawInfoBox(doc, colors, theme.accent, 40, y, 165, 54, 'Stato', row.stato || 'bozza', theme.fill);
  drawInfoBox(doc, colors, theme.accent, 215, y, 165, 54, 'Valuta', row.valuta || 'EUR', theme.fill);
  drawInfoBox(doc, colors, theme.accent, 390, y, 165, 54, 'P.IVA / CF', [row.piva, row.cf].filter(Boolean).join(' • ') || '-', theme.fill);

  y += 74;
  y = drawRowsTable(doc, theme, {
    ...frame,
    y,
    title: 'Articoli preventivo',
    headerLines: [
      `Numero: ${row.codice_preventivo || row.id}`,
      `Data: ${row.data_preventivo || '-'}`,
      `Scadenza: ${row.data_scadenza || '-'}`
    ],
    rows: righe,
    columns: [
      { label: 'Codice', x: 8, width: 72, value: (r) => r.codice_interno || '-' },
      { label: 'Descrizione', x: 86, width: 200, value: (r) => r.descrizione || r.nome || '-' },
      { label: 'Q.tà', x: 292, width: 40, align: 'right', value: (r) => Number(r.quantita || 0).toFixed(2) },
      { label: 'Prezzo', x: 338, width: 64, align: 'right', value: (r) => money(r.prezzo_unitario || 0, row.valuta || 'EUR') },
      { label: 'IVA', x: 408, width: 40, align: 'right', value: (r) => r.natura_iva || `${Number(r.aliquota_iva || 0).toFixed(0)}%` },
      { label: 'Totale', x: 454, width: 53, align: 'right', value: (r) => money(r.totale_riga || 0, row.valuta || 'EUR') }
    ]
  });

  y += 18;
  drawInfoBox(doc, colors, theme.accent, 305, y, 250, 86, 'Totali', [
    `Imponibile: ${money(row.imponibile || 0, row.valuta || 'EUR')}`,
    `IVA: ${money(row.iva || 0, row.valuta || 'EUR')}`,
    `Totale: ${money(row.totale || 0, row.valuta || 'EUR')}`
  ].join('\n'), theme.fill);
  drawInfoBox(doc, colors, theme.accent, 40, y, 250, 86, 'Note', row.note || 'Nessuna nota');

  doc.end();
  return {
    buffer: await done,
    filename: `preventivo-${row.codice_preventivo || row.id}.pdf`,
    row
  };
}

async function createOrdinePdfBuffer(id) {
  const row = db.prepare(`
    SELECT o.*, a.ragione_sociale, a.indirizzo, a.cap, a.citta, a.provincia, a.piva, a.cf, a.email
    FROM ordini o
    LEFT JOIN anagrafiche a ON a.id = o.anagrafica_id
    WHERE o.id = ?
  `).get(id);
  if (!row) throw new Error('Ordine non trovato');
  const righe = db.prepare(`
    SELECT r.*, p.nome, p.codice_interno
    FROM ordini_righe r
    LEFT JOIN prodotti p ON p.id = r.prodotto_id
    WHERE r.ordine_id = ?
    ORDER BY r.id
  `).all(id);

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const done = bufferFromDoc(doc);
  const theme = DOC_THEMES.ordine;
  const frame = drawCommonFrame(doc, theme, [
    `Numero: ${row.codice_ordine || row.id}`,
    `Data: ${row.data_ordine || '-'}`,
    `Consegna: ${row.data_consegna_prevista || '-'}`
  ]);
  const { colors, startX } = frame;

  let y = 156;
  drawInfoBox(doc, colors, theme.accent, startX, y, 250, 76, 'Emittente', formatAddress(
    COMPANY_INFO.name,
    COMPANY_INFO.addressLine1,
    '04100',
    'Latina',
    'LT'
  ));
  drawInfoBox(doc, colors, theme.accent, 305, y, 250, 76, row.tipo === 'acquisto' ? 'Fornitore' : 'Cliente', formatAddress(
    row.ragione_sociale,
    row.indirizzo,
    row.cap,
    row.citta,
    row.provincia
  ));

  y += 90;
  drawInfoBox(doc, colors, theme.accent, 40, y, 118, 54, 'Tipo', row.tipo || '-', theme.fill);
  drawInfoBox(doc, colors, theme.accent, 168, y, 86, 54, 'Canale', row.canale || '-', theme.fill);
  drawInfoBox(doc, colors, theme.accent, 264, y, 86, 54, 'Stato', row.stato || '-', theme.fill);
  drawInfoBox(doc, colors, theme.accent, 360, y, 195, 54, 'Collegamenti', row.preventivo_id ? `Da preventivo #${row.preventivo_id}` : 'Ordine autonomo', theme.fill);

  y += 74;
  y = drawRowsTable(doc, theme, {
    ...frame,
    y,
    title: 'Articoli ordine',
    headerLines: [
      `Numero: ${row.codice_ordine || row.id}`,
      `Data: ${row.data_ordine || '-'}`,
      `Consegna: ${row.data_consegna_prevista || '-'}`
    ],
    rows: righe,
    columns: [
      { label: 'Codice', x: 8, width: 72, value: (r) => r.codice_interno || '-' },
      { label: 'Descrizione', x: 86, width: 230, value: (r) => r.nome || r.descrizione || '-' },
      { label: 'Q.tà', x: 322, width: 45, align: 'right', value: (r) => Number(r.quantita || 0).toFixed(2) },
      { label: 'Prezzo', x: 373, width: 72, align: 'right', value: (r) => money(r.prezzo_unitario || 0, 'EUR') },
      { label: 'Sconto', x: 451, width: 56, align: 'right', value: (r) => `${Number(r.sconto || 0).toFixed(2)}%` }
    ]
  });

  y += 18;
  drawInfoBox(doc, colors, theme.accent, 305, y, 250, 86, 'Totali', [
    `Imponibile: ${money(row.imponibile || 0, 'EUR')}`,
    `IVA: ${money(row.iva || 0, 'EUR')}`,
    `Totale: ${money(row.totale || 0, 'EUR')}`
  ].join('\n'), theme.fill);
  drawInfoBox(doc, colors, theme.accent, 40, y, 250, 86, 'Note', row.note || 'Nessuna nota');

  doc.end();
  return {
    buffer: await done,
    filename: `ordine-${row.codice_ordine || row.id}.pdf`,
    row
  };
}

async function createDdtPdfBuffer(id) {
  const row = db.prepare(`
    SELECT d.*,
      dest.ragione_sociale as destinatario_nome,
      dest.indirizzo as destinatario_indirizzo,
      dest.cap as destinatario_cap,
      dest.citta as destinatario_citta,
      dest.provincia as destinatario_provincia,
      dest.email as destinatario_email,
      f.numero as fattura_numero
    FROM ddt d
    LEFT JOIN anagrafiche dest ON dest.id = d.destinatario_id
    LEFT JOIN fatture f ON f.id = d.fattura_id
    WHERE d.id = ?
  `).get(id);
  if (!row) throw new Error('DDT non trovato');
  const righe = db.prepare(`
    SELECT r.*, p.codice_interno, p.nome
    FROM ddt_righe r
    JOIN prodotti p ON p.id = r.prodotto_id
    WHERE r.ddt_id = ?
    ORDER BY r.id
  `).all(id);

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const done = bufferFromDoc(doc);
  const theme = DOC_THEMES.ddt;
  const frame = drawCommonFrame(doc, theme, [
    `Numero: ${row.numero_ddt || row.id}`,
    `Data: ${row.data || '-'}`,
    `Tipo: ${row.tipo || '-'}`
  ]);
  const { colors, startX } = frame;

  let y = 156;
  drawInfoBox(doc, colors, theme.accent, startX, y, 250, 76, 'Mittente', formatAddress(
    COMPANY_INFO.name,
    COMPANY_INFO.addressLine1,
    '04100',
    'Latina',
    'LT'
  ));
  drawInfoBox(doc, colors, theme.accent, 305, y, 250, 76, 'Destinatario', formatAddress(
    row.destinatario_nome,
    row.indirizzo_consegna || row.destinatario_indirizzo,
    row.destinatario_cap,
    row.destinatario_citta,
    row.destinatario_provincia
  ));

  y += 90;
  drawInfoBox(doc, colors, theme.accent, 40, y, 118, 54, 'Causale', row.causale || '-', theme.fill);
  drawInfoBox(doc, colors, theme.accent, 168, y, 86, 54, 'Porto', row.porto || '-', theme.fill);
  drawInfoBox(doc, colors, theme.accent, 264, y, 86, 54, 'Resa', row.resa || '-', theme.fill);
  drawInfoBox(doc, colors, theme.accent, 360, y, 90, 54, 'Colli', row.colli || '-', theme.fill);
  drawInfoBox(doc, colors, theme.accent, 460, y, 95, 54, 'Peso', row.peso_totale ? `${row.peso_totale} kg` : '-', theme.fill);

  y += 74;
  y = drawRowsTable(doc, theme, {
    ...frame,
    y,
    title: 'Beni trasportati',
    headerLines: [
      `Numero: ${row.numero_ddt || row.id}`,
      `Data: ${row.data || '-'}`,
      `Tipo: ${row.tipo || '-'}`
    ],
    rows: righe,
    columns: [
      { label: 'Codice', x: 8, width: 80, value: (r) => r.codice_interno || '-' },
      { label: 'Descrizione', x: 94, width: 280, value: (r) => r.nome || '-' },
      { label: 'Lotto', x: 380, width: 70, value: (r) => r.lotto || '-' },
      { label: 'Q.tà', x: 456, width: 51, align: 'right', value: (r) => Number(r.quantita || 0).toFixed(0) }
    ]
  });

  y += 18;
  drawInfoBox(doc, colors, theme.accent, 40, y, 515, 72, 'Annotazioni', [
    row.vettore ? `Vettore: ${row.vettore}` : '',
    row.corriere ? `Corriere: ${row.corriere}` : '',
    row.numero_spedizione ? `Tracking: ${row.numero_spedizione}` : '',
    row.fattura_numero ? `Fattura collegata: ${row.fattura_numero}` : '',
    row.note ? `Note: ${row.note}` : ''
  ].filter(Boolean).join('\n') || 'Nessuna annotazione');

  doc.end();
  return {
    buffer: await done,
    filename: `ddt-${row.numero_ddt || row.id}.pdf`,
    row
  };
}

async function getDocumentPdf(kind, id) {
  if (kind === 'preventivo') return createPreventivoPdfBuffer(id);
  if (kind === 'ordine') return createOrdinePdfBuffer(id);
  if (kind === 'ddt') return createDdtPdfBuffer(id);
  throw new Error('Tipo documento non supportato');
}

module.exports = {
  getDocumentPdf,
  createPreventivoPdfBuffer,
  createOrdinePdfBuffer,
  createDdtPdfBuffer
};
