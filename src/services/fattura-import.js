const crypto = require('crypto');
const db = require('../db/database');

function importInvoiceXml(xml, options = {}) {
  const parsed = parseFatturaPAXml(xml);
  parsed.hash_file = sha1(xml);
  parsed.xml_path = options.xmlPath || null;

  if (parsed.fornitore_piva) {
    const vatCandidates = [parsed.fornitore_piva, stripVatCountryPrefix(parsed.fornitore_piva)].filter(Boolean);
    const anag = db.prepare(`SELECT id FROM anagrafiche WHERE piva IN (${vatCandidates.map(() => '?').join(',')}) LIMIT 1`).get(...vatCandidates);
    if (anag) parsed.anagrafica_id = anag.id;
  }

  const hashDocumento = buildDocumentHash({
    numero: parsed.numero,
    data: parsed.data,
    partita_iva: parsed.fornitore_piva,
    totale: parsed.totale
  });
  const duplicate = db.prepare('SELECT id FROM fatture WHERE hash_file = ? OR hash_documento = ? LIMIT 1').get(parsed.hash_file, hashDocumento);
  if (duplicate) {
    return { duplicate: true, existingId: duplicate.id, parsed };
  }

  const result = db.prepare(`
    INSERT INTO fatture (
      numero,numero_documento,tipo,direzione,tipo_documento,anagrafica_id,data,data_ricezione,imponibile,iva,totale,sdi_id,xml_path,stato,partita_iva,codice_fiscale,cliente_fornitore_label,tipo_esteso,documento_meta,hash_file,hash_documento,origine_importazione
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    parsed.numero, parsed.numero, 'ricevuta', 'passiva', parsed.tipo_documento || 'fattura',
    parsed.anagrafica_id || null, parsed.data, normalizeDate(options.receivedAt) || new Date().toISOString().slice(0, 10),
    parsed.imponibile, parsed.iva, parsed.totale, parsed.sdi_id, parsed.xml_path, 'ricevuta',
    parsed.fornitore_piva || null, parsed.fornitore_codice_fiscale || null, parsed.fornitore_nome || null, parsed.tipo_esteso || null, JSON.stringify(parsed.documento_meta || {}), parsed.hash_file, hashDocumento, options.source || 'xml'
  );

  if (result.lastInsertRowid && parsed.righe?.length) {
    const ins = db.prepare('INSERT INTO fatture_righe (fattura_id,descrizione,quantita,prezzo_unitario,imponibile,aliquota_iva,natura_iva,importo_iva,totale_riga) VALUES (?,?,?,?,?,?,?,?,?)');
    parsed.righe.forEach((riga) => ins.run(
      result.lastInsertRowid,
      riga.descrizione,
      riga.quantita,
      riga.prezzo_unitario,
      riga.imponibile || null,
      riga.aliquota_iva || null,
      riga.natura_iva || null,
      riga.importo_iva || null,
      riga.totale_riga
    ));
  }
  saveVatSummary(result.lastInsertRowid, parsed.riepilogo_iva);
  return { duplicate: false, id: result.lastInsertRowid, parsed };
}

function parseFatturaPAXml(xml) {
  const normalizedXml = stripXmlNamespaces(xml);
  const tag = (name, source = normalizedXml) => {
    const m = source.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, 'i'));
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
  for (const match of righeMatch) {
    const rowXml = match[1];
    const qtag = (name) => {
      const found = rowXml.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'));
      return found ? found[1].trim() : null;
    };
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
      totale_riga: totaleRiga
    });
  }
  const riepilogo_iva = [];
  const riepiloghi = normalizedXml.matchAll(/<DatiRiepilogo>([\s\S]*?)<\/DatiRiepilogo>/gi);
  for (const match of riepiloghi) {
    const rowXml = match[1];
    const qtag = (name) => {
      const found = rowXml.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'));
      return found ? found[1].trim() : null;
    };
    riepilogo_iva.push({
      aliquota_iva: parseDecimal(qtag('AliquotaIVA')) || 0,
      natura_iva: qtag('Natura'),
      imponibile: parseDecimal(qtag('ImponibileImporto')) || 0,
      imposta: parseDecimal(qtag('Imposta')) || 0,
      riferimento_normativo: qtag('RiferimentoNormativo')
    });
  }
  // DatiPagamento: una fattura puo' avere piu' rate, ognuna con la sua
  // scadenza. La colonna scadenza e' una sola, quindi si tiene la prima in
  // ordine di data, che e' quella che conta per lo scadenzario; le altre
  // restano in documento_meta invece di andare perse.
  const pagamenti = [];
  for (const match of normalizedXml.matchAll(/<DettaglioPagamento>([\s\S]*?)<\/DettaglioPagamento>/gi)) {
    const rowXml = match[1];
    const ptag = (name) => {
      const found = rowXml.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'));
      return found ? found[1].trim() : null;
    };
    const scadenza = ptag('DataScadenzaPagamento');
    pagamenti.push({
      data_scadenza: scadenza,
      importo: parseDecimal(ptag('ImportoPagamento')),
      modalita: ptag('ModalitaPagamento'),
      iban: ptag('IBAN')
    });
  }
  const scadenze = pagamenti
    .map((row) => row.data_scadenza)
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')))
    .sort();

  const imponibile = riepilogo_iva.length
    ? riepilogo_iva.reduce((sum, row) => sum + Number(row.imponibile || 0), 0)
    : righe.reduce((sum, row) => sum + Number(row.imponibile || 0), 0);
  const iva = riepilogo_iva.reduce((sum, row) => sum + Number(row.imposta || 0), 0);
  const totaleDocumento = parseDecimal(tag('ImportoTotaleDocumento')) || (imponibile + iva);
  const rawTipoDocumento = tag('TipoDocumento');
  return {
    numero: tag('Numero'),
    data: tag('Data'),
    scadenza: scadenze[0] || null,
    totale: totaleDocumento,
    imponibile,
    iva,
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
      codice_destinatario: tag('CodiceDestinatario'),
      pagamenti: pagamenti.length ? pagamenti : undefined,
      scadenze: scadenze.length > 1 ? scadenze : undefined
    }
  };
}

function buildDocumentHash({ numero, data, partita_iva, totale }) {
  const raw = [numero || '', data || '', partita_iva || '', Number(totale || 0).toFixed(2)].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex');
}

function saveVatSummary(fatturaId, rows) {
  if (!fatturaId || !Array.isArray(rows) || !rows.length) return;
  const ins = db.prepare(`
    INSERT INTO fatture_iva_riepilogo (fattura_id, aliquota_iva, natura_iva, imponibile, imposta, riferimento_normativo)
    VALUES (?,?,?,?,?,?)
  `);
  rows.forEach((row) => ins.run(
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

function parseDecimal(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let str = String(value).trim();
  if (!str) return null;
  str = str.replace(/[â‚¬\s]/g, '');
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
  const match = source.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i'));
  return match ? match[1] : '';
}

function firstNonEmpty(values = []) {
  return values.find((value) => value && String(value).trim()) || null;
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

function sha1(content) {
  return crypto.createHash('sha1').update(Buffer.from(String(content), 'utf8')).digest('hex');
}

module.exports = {
  importInvoiceXml,
  parseFatturaPAXml
};
