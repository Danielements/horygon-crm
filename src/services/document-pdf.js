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
  ddt: { accent: '#2563eb', label: 'DDT', fill: '#eff6ff' },
  fattura: { accent: '#7c3aed', label: 'FATTURA', fill: '#f5f3ff' }
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

function addPageNumbers(doc) {
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let index = 0; index < total; index += 1) {
    doc.switchToPage(index);
    doc.font('Helvetica').fontSize(8).fillColor('#6b7280')
      .text(`${index + 1}/${total}`, 0, 792, { width: doc.page.width, align: 'center' });
  }
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
  doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(labelFontSize).text(theme.label, labelBoxX + 16, 60, {
    width: labelBoxWidth - 24,
    align: 'left'
  });
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

function drawDdtFrame(doc, theme, topRightLines = []) {
  const colors = getBaseColors(theme.accent);
  const startX = 40;
  const pageWidth = doc.page.width - 80;
  const contentRight = startX + pageWidth;
  const logoSize = 50;
  const companyBlockX = 112;
  const normalizedTopRightLines = topRightLines.map((line) => String(line || ''));
  const widestTopRightLine = normalizedTopRightLines.reduce((max, line) => Math.max(max, line.length), 0);
  const labelBoxWidth = widestTopRightLine > 28 ? 260 : 196;
  const labelBoxX = contentRight - (labelBoxWidth + 16);
  const labelFontSize = 22;
  const titleY = 60;
  const topRightTextY = 96;
  const topRightGap = 8;
  const companyTextWidth = Math.max(150, labelBoxX - companyBlockX - 20);
  const companyInfoStartY = 72;
  const companyLineGap = 2;
  const topRightLabelWidth = 54;
  const topRightValueX = labelBoxX + 16 + topRightLabelWidth + 8;
  const topRightValueWidth = labelBoxWidth - 24 - topRightLabelWidth - 8;
  const topRightItems = normalizedTopRightLines.map((line) => {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) return { label: '', value: line };
    return {
      label: line.slice(0, separatorIndex + 1).trim(),
      value: line.slice(separatorIndex + 1).trim()
    };
  });
  const companyInfoLines = [
    COMPANY_INFO.addressLine1,
    COMPANY_INFO.addressLine2,
    `Email ${COMPANY_INFO.email}`,
    `Web ${COMPANY_INFO.website}`,
    `PEC ${COMPANY_INFO.pec}`
  ];

  doc.font('Helvetica').fontSize(8.5).fillColor(colors.ink);
  const topRightHeights = topRightItems.map((item) => {
    const valueHeight = doc.heightOfString(item.value || '-', {
      width: item.label ? topRightValueWidth : labelBoxWidth - 22,
      lineGap: 1
    });
    return Math.max(10, valueHeight);
  });
  const companyInfoHeights = companyInfoLines.map((line) => Math.max(10, doc.heightOfString(line, {
    width: companyTextWidth,
    lineGap: companyLineGap
  })));
  const companyInfoHeight = companyInfoHeights.reduce((sum, height) => sum + height, 0)
    + (Math.max(0, companyInfoHeights.length - 1) * companyLineGap);
  const companyBottomY = companyInfoStartY + companyInfoHeight;
  const topRightTextHeight = topRightHeights.reduce((sum, height) => sum + height, 0)
    + (Math.max(0, topRightHeights.length - 1) * topRightGap);
  const labelBoxHeight = Math.max(112, (topRightTextY - 48) + topRightTextHeight + 14);
  const frameHeight = Math.max(126, labelBoxHeight + 24, companyBottomY - 36 + 18);
  const contentStartY = Math.max(156, 36 + frameHeight + 12);

  doc.roundedRect(startX, 36, pageWidth, frameHeight, 12).fillAndStroke('#ffffff', colors.border);
  doc.save();
  doc.translate(startX + 16, 50);
  doc.scale(logoSize / 220);
  doc.path(LOGO_PATH_DATA).fill(theme.accent);
  doc.restore();

  doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(18).text(COMPANY_INFO.name, companyBlockX, 48, {
    width: companyTextWidth
  });
  doc.font('Helvetica').fontSize(9).fillColor(colors.ink);
  let currentCompanyY = companyInfoStartY;
  companyInfoLines.forEach((line, index) => {
    doc.text(line, companyBlockX, currentCompanyY, { width: companyTextWidth, lineGap: companyLineGap });
    currentCompanyY += companyInfoHeights[index] + companyLineGap;
  });

  doc.roundedRect(labelBoxX, 48, labelBoxWidth, labelBoxHeight, 10).fillAndStroke(theme.fill, colors.border);
  doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(labelFontSize).text(theme.label, labelBoxX + 16, titleY, {
    width: labelBoxWidth - 24,
    align: 'left'
  });
  doc.fontSize(8.5).fillColor(colors.ink).font('Helvetica');
  let currentTopRightY = topRightTextY;
  topRightItems.forEach((item, index) => {
    if (item.label) {
      doc.font('Helvetica-Bold').text(item.label, labelBoxX + 16, currentTopRightY, {
        width: topRightLabelWidth
      });
      doc.font('Helvetica').text(item.value || '-', topRightValueX, currentTopRightY, {
        width: topRightValueWidth,
        lineGap: 1
      });
    } else {
      doc.font('Helvetica').text(item.value || '-', labelBoxX + 16, currentTopRightY, {
        width: labelBoxWidth - 22,
        lineGap: 1
      });
    }
    currentTopRightY += topRightHeights[index] + topRightGap;
  });

  doc.moveTo(startX, 786).lineTo(contentRight, 786).stroke(colors.line);
  doc.font('Helvetica').fontSize(8).fillColor(colors.muted)
    .text(`REA ${COMPANY_INFO.rea}  |  P.IVA ${COMPANY_INFO.piva}`, startX, 792, { width: 260 })
    .text(`${COMPANY_INFO.website}  |  ${COMPANY_INFO.email}`, contentRight - 200, 792, { width: 200, align: 'right' });

  return { colors, startX, pageWidth, contentRight, contentStartY };
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
  const continuationY = setup.continuationY || 156;

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
    const rowHeight = typeof setup.rowHeight === 'function' ? setup.rowHeight(row) : (setup.rowHeight || 26);
    if (y + rowHeight > footerTop) {
      doc.addPage();
      const drawFrame = setup.drawFrame || drawCommonFrame;
      drawFrame(doc, theme, setup.headerLines || []);
      y = continuationY;
      drawHeader();
    }
    const fill = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
    doc.roundedRect(startX, y, width, rowHeight, 4).fillAndStroke(fill, colors.line);
    if (typeof setup.drawRow === 'function') {
      setup.drawRow({ doc, row, y, rowHeight, startX, width, colors, columns, theme });
    } else {
      doc.fillColor(colors.ink).font('Helvetica').fontSize(8.5);
      columns.forEach((col) => {
        const value = typeof col.value === 'function' ? col.value(row) : row[col.key];
        doc.text(String(value ?? '-'), startX + col.x, y + 8, { width: col.width, align: col.align || 'left' });
      });
    }
    y += rowHeight + 4;
  });

  return y;
}

function ensureDocumentSpace(doc, theme, headerLines, requiredHeight, currentY, continuationY = 156, options = {}) {
  const footerTop = 730;
  if (currentY + requiredHeight <= footerTop) return currentY;
  doc.addPage();
  const drawFrame = options.drawFrame || drawCommonFrame;
  drawFrame(doc, theme, headerLines || []);
  return continuationY;
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

  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  const done = bufferFromDoc(doc);
  const theme = DOC_THEMES.preventivo;
  const publicBaseUrl = process.env.BASE_URL || 'http://localhost:3001';
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
    continuationY: 156,
    title: 'Articoli preventivo',
    headerLines: [
      `Numero: ${row.codice_preventivo || row.id}`,
      `Data: ${row.data_preventivo || '-'}`,
      `Scadenza: ${row.data_scadenza || '-'}`
    ],
    rows: righe,
    rowHeight: (r) => {
      doc.font('Helvetica').fontSize(8.3);
      const desc = r.descrizione || r.nome || '-';
      const descHeight = doc.heightOfString(desc, { width: 200 });
      const linkHeight = r.prodotto_id ? 11 : 0;
      return Math.max(26, 14 + descHeight + linkHeight);
    },
    drawRow: ({ doc: currentDoc, row: currentRow, y: rowY, startX: tableStartX, colors: tableColors, theme: tableTheme }) => {
      const publicUrl = currentRow.prodotto_id ? `${publicBaseUrl}/prodotto/${currentRow.prodotto_id}` : '';
      const description = currentRow.descrizione || currentRow.nome || '-';
      currentDoc.fillColor(tableColors.ink).font('Helvetica').fontSize(8.3);
      currentDoc.text(currentRow.codice_interno || '-', tableStartX + 8, rowY + 8, { width: 72 });
      currentDoc.text(description, tableStartX + 86, rowY + 8, { width: 200 });
      const descHeight = currentDoc.heightOfString(description, { width: 200 });
      if (publicUrl) {
        currentDoc.fillColor(tableTheme.accent).fontSize(7.5).text('Scheda prodotto / QR', tableStartX + 86, rowY + 10 + descHeight, {
          width: 200,
          underline: true,
          link: publicUrl
        });
      }
      currentDoc.fillColor(tableColors.ink).font('Helvetica').fontSize(8.3);
      currentDoc.text(Number(currentRow.quantita || 0).toFixed(2), tableStartX + 292, rowY + 8, { width: 40, align: 'right' });
      currentDoc.text(money(currentRow.prezzo_unitario || 0, row.valuta || 'EUR'), tableStartX + 338, rowY + 8, { width: 64, align: 'right' });
      currentDoc.text(currentRow.natura_iva || `${Number(currentRow.aliquota_iva || 0).toFixed(0)}%`, tableStartX + 408, rowY + 8, { width: 40, align: 'right' });
      currentDoc.text(money(currentRow.totale_riga || 0, row.valuta || 'EUR'), tableStartX + 454, rowY + 8, { width: 53, align: 'right' });
    },
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
  y = ensureDocumentSpace(doc, theme, [
    `Numero: ${row.codice_preventivo || row.id}`,
    `Data: ${row.data_preventivo || '-'}`,
    `Scadenza: ${row.data_scadenza || '-'}`
  ], 92, y);
  drawInfoBox(doc, colors, theme.accent, 305, y, 250, 86, 'Totali', [
    `Imponibile: ${money(row.imponibile || 0, row.valuta || 'EUR')}`,
    `IVA: ${money(row.iva || 0, row.valuta || 'EUR')}`,
    `Totale: ${money(row.totale || 0, row.valuta || 'EUR')}`
  ].join('\n'), theme.fill);
  drawInfoBox(doc, colors, theme.accent, 40, y, 250, 86, 'Note', row.note || 'Nessuna nota');

  addPageNumbers(doc);
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

  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
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
  y = ensureDocumentSpace(doc, theme, [
    `Numero: ${row.codice_ordine || row.id}`,
    `Data: ${row.data_ordine || '-'}`,
    `Consegna: ${row.data_consegna_prevista || '-'}`
  ], 92, y);
  drawInfoBox(doc, colors, theme.accent, 305, y, 250, 86, 'Totali', [
    `Imponibile: ${money(row.imponibile || 0, 'EUR')}`,
    `IVA: ${money(row.iva || 0, 'EUR')}`,
    `Totale: ${money(row.totale || 0, 'EUR')}`
  ].join('\n'), theme.fill);
  drawInfoBox(doc, colors, theme.accent, 40, y, 250, 86, 'Note', row.note || 'Nessuna nota');

  addPageNumbers(doc);
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

  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  const done = bufferFromDoc(doc);
  const theme = DOC_THEMES.ddt;
  const headerLines = [
    `Numero: ${row.numero_ddt || row.id}`,
    `Data: ${row.data || '-'}`,
    `Tipo: ${row.tipo || '-'}`
  ];
  const frame = drawDdtFrame(doc, theme, headerLines);
  const { colors, startX, contentStartY } = frame;
  const notesText = [
    row.vettore ? `Vettore: ${row.vettore}` : '',
    row.corriere ? `Corriere: ${row.corriere}` : '',
    row.numero_spedizione ? `Tracking: ${row.numero_spedizione}` : '',
    row.data_ora_trasporto ? `Data/ora trasporto: ${row.data_ora_trasporto}` : '',
    row.aspetto_beni ? `Aspetto beni: ${row.aspetto_beni}` : '',
    row.fattura_numero ? `Fattura collegata: ${row.fattura_numero}` : '',
    row.note_spedizione ? `Note spedizione: ${row.note_spedizione}` : '',
    row.note ? `Note: ${row.note}` : ''
  ].filter(Boolean).join('\n') || 'Nessuna annotazione';

  let y = contentStartY;
  drawInfoBox(doc, colors, theme.accent, startX, y, 250, 76, 'Mittente', formatAddress(
    row.mittente_nome || COMPANY_INFO.name,
    row.mittente_indirizzo || COMPANY_INFO.addressLine1,
    row.mittente_cap || '04100',
    row.mittente_citta || 'Latina',
    row.mittente_provincia || 'LT'
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
    continuationY: contentStartY,
    drawFrame: drawDdtFrame,
    headerLines,
    rows: righe,
    rowHeight: (r) => {
      doc.font('Helvetica').fontSize(8.3);
      const descriptionHeight = doc.heightOfString(r.nome || '-', { width: 280 });
      const lottoHeight = doc.heightOfString(r.lotto || '-', { width: 70 });
      return Math.max(26, 14 + Math.max(descriptionHeight, lottoHeight));
    },
    drawRow: ({ doc: currentDoc, row: currentRow, y: rowY, startX: tableStartX, colors: tableColors }) => {
      currentDoc.fillColor(tableColors.ink).font('Helvetica').fontSize(8.3);
      currentDoc.text(currentRow.codice_interno || '-', tableStartX + 8, rowY + 8, { width: 80 });
      currentDoc.text(currentRow.nome || '-', tableStartX + 94, rowY + 8, { width: 280 });
      currentDoc.text(currentRow.lotto || '-', tableStartX + 380, rowY + 8, { width: 70 });
      currentDoc.text(Number(currentRow.quantita || 0).toFixed(0), tableStartX + 456, rowY + 8, {
        width: 51,
        align: 'right'
      });
    },
    columns: [
      { label: 'Codice', x: 8, width: 80, value: (r) => r.codice_interno || '-' },
      { label: 'Descrizione', x: 94, width: 280, value: (r) => r.nome || '-' },
      { label: 'Lotto', x: 380, width: 70, value: (r) => r.lotto || '-' },
      { label: 'Q.tà', x: 456, width: 51, align: 'right', value: (r) => Number(r.quantita || 0).toFixed(0) }
    ]
  });

  y += 18;
  doc.font('Helvetica').fontSize(10);
  const notesHeight = Math.max(72, Math.min(160, doc.heightOfString(notesText, { width: 495 }) + 34));
  y = ensureDocumentSpace(doc, theme, headerLines, notesHeight + 6, y, contentStartY, { drawFrame: drawDdtFrame });
  drawInfoBox(doc, colors, theme.accent, 40, y, 515, notesHeight, 'Annotazioni', notesText);

  addPageNumbers(doc);
  doc.end();
  return {
    buffer: await done,
    filename: `ddt-${row.numero_ddt || row.id}.pdf`,
    row
  };
}

// Copia di cortesia della fattura.
//
// Non e' il documento fiscale: quello e' l'XML trasmesso al SdI, e questo PDF
// non lo sostituisce ne' lo integra. Serve a chi la fattura la deve leggere -
// il cliente, l'ufficio acquisti di una PA - e per questo porta il riepilogo
// IVA per trattamento, che nella riga della tabella non si vede.
async function createFatturaPdfBuffer(id) {
  const row = db.prepare(`
    SELECT f.*, a.ragione_sociale, a.indirizzo, a.cap, a.citta, a.provincia, a.piva, a.cf, a.email,
           o.codice_ordine
    FROM fatture f
    LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id
    LEFT JOIN ordini o ON o.id = f.ordine_id
    WHERE f.id = ?
  `).get(id);
  if (!row) throw new Error('Fattura non trovata');
  const righe = db.prepare(`
    SELECT r.*, p.nome, p.codice_interno
    FROM fatture_righe r
    LEFT JOIN prodotti p ON p.id = r.prodotto_id
    WHERE r.fattura_id = ?
    ORDER BY r.id
  `).all(id);
  const riepilogo = db.prepare(`
    SELECT * FROM fatture_iva_riepilogo WHERE fattura_id = ? ORDER BY id
  `).all(id);
  return renderFatturaPdf({ row, righe, riepilogo });
}

// Il disegno e' separato dalla lettura per poterlo misurare senza toccare il
// database: la prima versione aveva le colonne fuori dal foglio e la tabella
// sopra l'intestazione a pagina due, e senza un modo di provarla su dati finti
// quei difetti si vedevano solo aprendo il PDF.
async function renderFatturaPdf({ row, righe = [], riepilogo = [] }) {
  const valuta = row.valuta || 'EUR';
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  const done = bufferFromDoc(doc);
  const theme = DOC_THEMES.fattura;
  const headerLines = [
    `Numero: ${row.numero_documento || row.numero || row.id}`,
    `Data: ${row.data || '-'}`,
    `Scadenza: ${row.scadenza || '-'}`
  ];
  // Frame adattivo, lo stesso del DDT: allarga il riquadro e manda a capo il
  // valore in una colonna sua invece di sovrapporlo alla riga dopo. Con
  // `drawCommonFrame` un numero lungo finiva sopra la data.
  const frame = drawDdtFrame(doc, theme, headerLines);
  const { colors, startX, contentStartY } = frame;

  // Su una fattura emessa il cedente siamo noi; su una ricevuta e' la
  // controparte. Invertire le due intestazioni farebbe leggere il documento
  // al contrario.
  const emessa = row.tipo !== 'ricevuta';
  const nostro = formatAddress(COMPANY_INFO.name, COMPANY_INFO.addressLine1, '04100', 'Latina', 'LT');
  const loro = formatAddress(
    row.ragione_sociale || row.cliente_fornitore_label,
    row.indirizzo, row.cap, row.citta, row.provincia
  );

  let y = contentStartY;
  drawInfoBox(doc, colors, theme.accent, startX, y, 250, 76, emessa ? 'Cedente / prestatore' : 'Fornitore', emessa ? nostro : loro);
  drawInfoBox(doc, colors, theme.accent, 305, y, 250, 76, emessa ? 'Cessionario / committente' : 'Cessionario', emessa ? loro : nostro);

  y += 90;
  const identificativo = row.partita_iva || row.piva || row.codice_fiscale || row.cf || '-';
  drawInfoBox(doc, colors, theme.accent, 40, y, 118, 54, 'Documento', row.tipo_esteso || row.tipo_documento || 'Fattura', theme.fill);
  drawInfoBox(doc, colors, theme.accent, 168, y, 128, 54, 'P.IVA / C.F.', identificativo, theme.fill);
  drawInfoBox(doc, colors, theme.accent, 306, y, 108, 54, 'Pagamento', row.stato_pagamento || '-', theme.fill);
  drawInfoBox(doc, colors, theme.accent, 424, y, 131, 54, 'Riferimenti', [
    row.codice_ordine ? `Ordine ${row.codice_ordine}` : null,
    row.cig ? `CIG ${row.cig}` : null,
    row.cup ? `CUP ${row.cup}` : null
  ].filter(Boolean).join('\n') || 'Nessuno', theme.fill);

  y += 74;
  y = drawRowsTable(doc, theme, {
    ...frame,
    y,
    // La tabella e' larga quanto il foglio meno i margini: 515 punti. Le
    // colonne stanno fra 8 e 507, come nelle altre. Prima l'ultima finiva a
    // 572 e usciva dal riquadro.
    title: `Righe fattura (importi in ${valuta})`,
    headerLines,
    continuationY: contentStartY,
    drawFrame: drawDdtFrame,
    rows: righe,
    // La descrizione va a capo: l'altezza della riga si misura, non si
    // presume, altrimenti due righe di testo escono dalla loro cornice.
    rowHeight: (r) => {
      doc.font('Helvetica').fontSize(8.3);
      return Math.max(26, 14 + doc.heightOfString(String(r.descrizione || r.nome || '-'), { width: 176 }));
    },
    columns: [
      { label: 'Codice', x: 8, width: 54, value: (r) => r.codice_articolo || r.codice_interno || '-' },
      { label: 'Descrizione', x: 66, width: 176, value: (r) => r.descrizione || r.nome || '-' },
      { label: 'Q.tà', x: 246, width: 32, align: 'right', value: (r) => Number(r.quantita || 0).toFixed(2) },
      { label: 'Prezzo', x: 282, width: 56, align: 'right', value: (r) => Number(r.prezzo_unitario || 0).toFixed(2) },
      { label: 'Imponibile', x: 342, width: 60, align: 'right', value: (r) => Number(r.imponibile || 0).toFixed(2) },
      // Su una riga con Natura la percentuale non vuol dire niente: si stampa
      // il codice, che e' l'informazione fiscale vera.
      { label: 'IVA', x: 406, width: 38, align: 'right', value: (r) => r.natura_iva || `${Number(r.aliquota_iva || 0).toFixed(0)}%` },
      { label: 'Totale', x: 448, width: 59, align: 'right', value: (r) => Number(r.totale_riga || 0).toFixed(2) }
    ]
  });

  y += 18;
  const dettaglioIva = riepilogo.length
    ? riepilogo.map((r) => {
        const etichetta = r.natura_iva ? r.natura_iva : `${Number(r.aliquota_iva || 0).toFixed(0)}%`;
        return `${etichetta}  imponibile ${Number(r.imponibile || 0).toFixed(2)}  imposta ${Number(r.imposta || 0).toFixed(2)}`;
      }).join('\n')
    : 'Nessun riepilogo IVA registrato';
  const totaliText = [
    `Imponibile: ${money(row.imponibile || 0, valuta)}`,
    `IVA: ${money(row.iva || 0, valuta)}`,
    `Totale documento: ${money(row.totale || 0, valuta)}`
  ].join('\n');

  // L'altezza dei due riquadri si misura sul testo che ci va dentro invece di
  // stimarla a quattordici punti per riga: con molti trattamenti IVA il
  // riepilogo usciva dalla sua cornice.
  doc.font('Helvetica').fontSize(9);
  const altezzaRiepilogo = Math.max(
    76,
    34 + doc.heightOfString(dettaglioIva, { width: 230 }),
    34 + doc.heightOfString(totaliText, { width: 230 })
  );
  y = ensureDocumentSpace(doc, theme, headerLines, altezzaRiepilogo + 12, y, contentStartY, { drawFrame: drawDdtFrame });

  drawInfoBox(doc, colors, theme.accent, 40, y, 250, altezzaRiepilogo, 'Riepilogo IVA', dettaglioIva);
  drawInfoBox(doc, colors, theme.accent, 305, y, 250, altezzaRiepilogo, 'Totali', totaliText, theme.fill);

  y += altezzaRiepilogo + 14;
  doc.font('Helvetica').fontSize(10);
  const testoNote = row.note || 'Nessuna nota';
  const altezzaNote = Math.max(60, Math.min(160, 34 + doc.heightOfString(testoNote, { width: 495 })));
  y = ensureDocumentSpace(doc, theme, headerLines, altezzaNote + 6, y, contentStartY, { drawFrame: drawDdtFrame });
  drawInfoBox(doc, colors, theme.accent, 40, y, 515, altezzaNote, 'Note', testoNote);

  y += altezzaNote + 14;
  y = ensureDocumentSpace(doc, theme, headerLines, 30, y, contentStartY, { drawFrame: drawDdtFrame });
  doc.fillColor(colors.muted).font('Helvetica').fontSize(8)
    .text(
      'Copia di cortesia. L\'originale della fattura elettronica e\' il file XML trasmesso al Sistema di Interscambio.',
      40, y, { width: 515 }
    );

  addPageNumbers(doc);
  doc.end();
  return {
    buffer: await done,
    filename: `fattura-${String(row.numero_documento || row.numero || row.id).replace(/[^A-Za-z0-9._-]+/g, '-')}.pdf`,
    row
  };
}

async function getDocumentPdf(kind, id) {
  if (kind === 'preventivo') return createPreventivoPdfBuffer(id);
  if (kind === 'ordine') return createOrdinePdfBuffer(id);
  if (kind === 'ddt') return createDdtPdfBuffer(id);
  if (kind === 'fattura') return createFatturaPdfBuffer(id);
  throw new Error('Tipo documento non supportato');
}

module.exports = {
  getDocumentPdf,
  createPreventivoPdfBuffer,
  createOrdinePdfBuffer,
  createDdtPdfBuffer,
  createFatturaPdfBuffer,
  renderFatturaPdf
};
