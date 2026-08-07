const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');
const { getSetting } = require('./google');
const { getSchemaRegistryEntry, syncSchemaRegistry } = require('./sdi-schema-registry');
const { validateInvoiceXml } = require('./sdi-xml-validator');
const { allocateOutboundProgressivo } = require('./sdi-progressivo');
const { applySdiSignature, getSignatureStatus, isSignatureRequired } = require('./sdi-signature');
const {
  buildOrdinaryInvoiceXml,
  buildSimplifiedInvoiceXml,
  buildProgressivoInvio,
  mapDocumentType,
  summarizeVat
} = require('./sdi-fatturapa-builder');

const ROOT = path.resolve(__dirname, '../../');
const OUTBOUND_DIR = path.join(ROOT, 'uploads', 'sdi-outbound');

async function generateOutboundXmlForInvoice(fatturaId, options = {}) {
  syncSchemaRegistry();
  const invoice = loadInvoice(fatturaId);
  if (!invoice) throw new Error('Fattura non trovata');
  if (invoice.tipo !== 'emessa') throw new Error('La generazione XML SDI e disponibile solo per fatture emesse');

  const company = loadCompanyProfile();
  const customer = loadRecipientProfile(invoice.anagrafica_id);
  const format = options.forceFormat || (customer.isPa ? 'FPA12' : 'FPR12');

  // Firma e codice destinatario vanno verificati prima di consumare un
  // progressivo: un nome file bruciato non e' piu' riutilizzabile presso il SdI.
  if (isSignatureRequired(format) && !options.allowUnsigned) {
    const status = getSignatureStatus();
    if (!status.available) {
      throw new Error(
        `La fattura ${format} e' destinata alla PA e deve essere firmata `
        + `(Specifiche tecniche SdI par. 2.1), ma la firma non e' disponibile: ${status.reason}`
      );
    }
  }
  resolveDestinationCode(customer, format);

  const payload = buildInvoicePayload(invoice, company, customer, {
    ...options,
    progressivo: options.progressivo || allocateOutboundProgressivo()
  });
  const xml = payload.formatoTrasmissione === 'FSM10'
    ? buildSimplifiedInvoiceXml(payload)
    : buildOrdinaryInvoiceXml(payload);
  const validation = await validateInvoiceXml({ xml, format: payload.formatoTrasmissione });
  if (!validation.ok) {
    const messages = [
      ...(validation.xsd.errors || []).map((item) => item.message),
      ...(validation.application.errors || []),
      ...(validation.fiscal?.errors || []).map((item) => `${item.code} ${item.message}`)
    ].filter(Boolean);
    throw new Error(`XML FatturaPA non valido: ${messages.join(' | ')}`);
  }

  const signature = applySdiSignature(xml, {
    format: payload.formatoTrasmissione,
    force: Boolean(options.allowUnsigned)
  });
  return saveOutboundXml(invoice, customer, xml, payload, validation, options, signature);
}

function loadInvoice(fatturaId) {
  const invoice = db.prepare(`
    SELECT
      f.*,
      a.ragione_sociale,
      a.piva AS cliente_piva,
      a.cf AS cliente_cf,
      a.pec AS cliente_pec,
      a.email AS cliente_email,
      a.indirizzo AS cliente_indirizzo,
      a.cap AS cliente_cap,
      a.citta AS cliente_citta,
      a.provincia AS cliente_provincia,
      a.paese AS cliente_paese,
      a.codice_destinatario AS cliente_codice_destinatario,
      a.tipo AS cliente_tipo,
      p.codice_univoco_sdi AS cliente_codice_univoco_pa
    FROM fatture f
    LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id
    LEFT JOIN pa_dettagli p ON p.anagrafica_id = a.id
    WHERE f.id = ?
  `).get(fatturaId);
  if (!invoice) return null;
  invoice.righe = db.prepare(`
    SELECT *
    FROM fatture_righe
    WHERE fattura_id = ?
    ORDER BY id
  `).all(fatturaId);
  invoice.riepilogo_iva = db.prepare(`
    SELECT *
    FROM fatture_iva_riepilogo
    WHERE fattura_id = ?
    ORDER BY id
  `).all(fatturaId);
  return invoice;
}

function loadCompanyProfile() {
  const company = {
    country: normalizeCountry(getSetting('sdi.company.country', 'IT')),
    vat: normalizeVat(getSetting('sdi.company.vat', '')),
    fiscalCode: normalizeIdentifier(getSetting('sdi.company.fiscal_code', '')),
    denomination: String(getSetting('sdi.company.denomination', '') || '').trim(),
    regimeFiscale: String(getSetting('sdi.company.regime_fiscale', 'RF01') || 'RF01').trim(),
    address: String(getSetting('sdi.company.address', '') || '').trim(),
    streetNumber: String(getSetting('sdi.company.street_number', '') || '').trim(),
    cap: String(getSetting('sdi.company.cap', '') || '').trim(),
    city: String(getSetting('sdi.company.city', '') || '').trim(),
    province: String(getSetting('sdi.company.province', '') || '').trim().toUpperCase(),
    pec: String(getSetting('sdi.company.pec', '') || '').trim(),
    email: String(getSetting('sdi.company.email', '') || '').trim(),
    phone: String(getSetting('sdi.company.phone', '') || '').trim(),
    fax: String(getSetting('sdi.company.fax', '') || '').trim(),
    reaOffice: String(getSetting('sdi.company.rea_office', '') || '').trim().toUpperCase(),
    reaNumber: String(getSetting('sdi.company.rea_number', '') || '').trim(),
    shareCapital: toAmount(getSetting('sdi.company.share_capital', '0')),
    soleShareholder: String(getSetting('sdi.company.sole_shareholder', '') || '').trim(),
    liquidationState: String(getSetting('sdi.company.liquidation_state', 'LN') || 'LN').trim(),
    referenceAdministration: String(getSetting('sdi.company.reference_administration', '') || '').trim()
  };
  const missing = [];
  if (!company.country) missing.push('sdi.company.country');
  if (!company.vat) missing.push('sdi.company.vat');
  if (!company.fiscalCode) missing.push('sdi.company.fiscal_code');
  if (!company.denomination) missing.push('sdi.company.denomination');
  if (!company.address) missing.push('sdi.company.address');
  if (!company.cap) missing.push('sdi.company.cap');
  if (!company.city) missing.push('sdi.company.city');
  if (!company.province) missing.push('sdi.company.province');
  if (missing.length) throw new Error(`Configurazione azienda SDI incompleta: ${missing.join(', ')}`);
  return company;
}

function loadRecipientProfile(anagraficaId) {
  if (!anagraficaId) throw new Error('La fattura non ha un cliente associato');
  const customer = db.prepare(`
    SELECT
      a.*,
      p.codice_ipa,
      p.codice_univoco_sdi
    FROM anagrafiche a
    LEFT JOIN pa_dettagli p ON p.anagrafica_id = a.id
    WHERE a.id = ?
  `).get(anagraficaId);
  if (!customer) throw new Error('Cliente anagrafico non trovato');
  const destinationCode = String(customer.codice_univoco_sdi || customer.codice_destinatario || '').trim().toUpperCase();
  return {
    ...customer,
    destinationCode,
    isPa: customer.tipo === 'pa'
  };
}

function buildInvoicePayload(invoice, company, customer, options = {}) {
  const numero = String(invoice.numero_documento || invoice.numero || '').trim();
  const data = normalizeDate(invoice.data);
  if (!numero) throw new Error('La fattura non ha un numero valorizzato');
  if (!data) throw new Error('La fattura non ha una data valida');
  if (!customer.ragione_sociale) throw new Error('L anagrafica cliente non ha la ragione sociale');
  if (!customer.destinationCode && !customer.pec) {
    throw new Error('Il cliente non ha Codice Destinatario o PEC per la trasmissione SDI');
  }
  if (!customer.indirizzo || !customer.cap || !customer.citta || !customer.provincia) {
    throw new Error('L anagrafica cliente deve avere indirizzo, CAP, citta e provincia');
  }

  const lines = (invoice.righe || []).map((line, index) => {
    const quantita = toAmount(line.quantita) || 1;
    const prezzoUnitario = toAmount(line.prezzo_unitario) || 0;
    const totaleRiga = toAmount(line.totale_riga) || toAmount(line.imponibile) || round2(quantita * prezzoUnitario);
    const aliquotaIva = toAmount(line.aliquota_iva) || 0;
    return {
      numeroLinea: index + 1,
      descrizione: line.descrizione || `Riga ${index + 1}`,
      quantita,
      unitaMisura: String(line.unita_misura || 'NR').trim(),
      prezzoUnitario,
      scontoMaggiorazione: buildScontoMaggiorazione(line, quantita),
      totaleRiga,
      aliquotaIva,
      importoIva: toAmount(line.importo_iva) ?? round2(totaleRiga * aliquotaIva / 100),
      naturaIva: String(line.natura_iva || '').trim() || null,
      riferimentoNormativo: null
    };
  });
  if (!lines.length) throw new Error('La fattura non contiene righe da esportare');

  const riepilogo = (invoice.riepilogo_iva || []).length
    ? invoice.riepilogo_iva.map((row) => ({
        aliquotaIva: toAmount(row.aliquota_iva) || 0,
        naturaIva: String(row.natura_iva || '').trim() || null,
        imponibile: toAmount(row.imponibile) || 0,
        imposta: toAmount(row.imposta) || 0,
        riferimentoNormativo: String(row.riferimento_normativo || '').trim() || null,
        esigibilitaIva: (toAmount(row.aliquota_iva) || 0) > 0 ? 'I' : undefined
      }))
    : summarizeVat(lines);

  const format = options.forceFormat || (customer.isPa ? 'FPA12' : 'FPR12');
  const destinationCode = resolveDestinationCode(customer, format);
  const schema = getSchemaRegistryEntry(format);
  const totaleDocumento = toAmount(invoice.totale) || round2(lines.reduce((sum, line) => sum + line.totaleRiga, 0) + riepilogo.reduce((sum, row) => sum + row.imposta, 0));
  const customerVat = splitVat(customer.piva);

  return {
    mode: String(options.mode || getSetting('sdi.mode', 'test') || 'test').trim(),
    invoiceId: invoice.id,
    numero,
    data,
    tipoDocumento: mapDocumentType(invoice.tipo_documento),
    formatoTrasmissione: format,
    namespace: schema.namespace,
    fileProgressivo: options.progressivo || buildProgressivoInvio(invoice.id),
    destinationCode,
    // Il builder emette PECDestinatario solo quando la regola lo consente
    // (CodiceDestinatario 0000000 e destinatario diverso dalla PA).
    pecDestinatario: customer.pec ? String(customer.pec).trim() : '',
    company,
    transmitter: {
      email: String(getSetting('sdi.transmitter.email', company.pec || company.email || '') || '').trim(),
      phone: String(getSetting('sdi.transmitter.phone', company.phone || '') || '').trim()
    },
    customer: {
      denomination: String(customer.ragione_sociale || '').trim(),
      address: String(customer.indirizzo || '').trim(),
      streetNumber: '',
      cap: String(customer.cap || '').trim(),
      city: String(customer.citta || '').trim(),
      province: String(customer.provincia || '').trim().toUpperCase(),
      country: normalizeCountry(customer.paese || 'IT'),
      fiscalCode: normalizeCustomerFiscalCode(customer.cf, customerVat),
      vat: customerVat
    },
    importoTotaleDocumento: totaleDocumento,
    divisa: String(invoice.valuta || 'EUR').trim() || 'EUR',
    causali: [],
    lines,
    riepilogo,
    payment: buildPaymentPayload(invoice, totaleDocumento)
  };
}

function saveOutboundXml(invoice, customer, xml, payload, validation, options = {}, signature = null) {
  const schema = getSchemaRegistryEntry(payload.formatoTrasmissione);
  const dayDir = path.join(OUTBOUND_DIR, new Date().toISOString().slice(0, 10).replace(/-/g, '/'));
  ensureDir(dayDir);
  const applied = signature || { signed: false, buffer: Buffer.from(xml, 'utf8'), extension: '.xml', meta: { signed: false } };
  const filename = buildFilename(invoice, customer, payload, applied.extension);
  const mode = String(options.mode || getSetting('sdi.mode', 'test') || 'test').trim();

  const xmlSha256 = crypto.createHash('sha256').update(xml).digest('hex');
  const transmittedSha256 = crypto.createHash('sha256').update(applied.buffer).digest('hex');

  // Il file trasmesso e' quello firmato quando la firma e' richiesta; l'XML in
  // chiaro resta comunque archiviato in forma immutabile per l'audit.
  const absolutePath = path.join(dayDir, `${transmittedSha256}_${filename}`);
  if (!fs.existsSync(absolutePath)) fs.writeFileSync(absolutePath, applied.buffer);
  const relativePath = `/${toPosix(path.relative(ROOT, absolutePath))}`;

  let xmlRelativePath = relativePath;
  if (applied.signed) {
    const xmlAbsolutePath = path.join(dayDir, `${xmlSha256}_${filename.replace(/\.p7m$/i, '')}`);
    if (!fs.existsSync(xmlAbsolutePath)) fs.writeFileSync(xmlAbsolutePath, xml, 'utf8');
    xmlRelativePath = `/${toPosix(path.relative(ROOT, xmlAbsolutePath))}`;
  }

  const flow = db.prepare(`
    INSERT INTO fatture_sdi_flussi (
      fattura_id, direzione, modalita, tipo_messaggio, nome_file, stato, xml_path, hash_file, payload_meta, ultimo_evento_il,
      sdi_formato, sdi_schema_name, sdi_schema_version, sdi_schema_sha256, sdi_xml_sha256, sdi_xml_immutabile_path,
      firma_applicata, firma_meta
    ) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),?,?,?,?,?,?,?,?)
  `).run(
    invoice.id,
    'outbound',
    mode,
    'fattura',
    filename,
    `xml_generato_${mode}`,
    relativePath,
    transmittedSha256,
    JSON.stringify({
      formato_trasmissione: payload.formatoTrasmissione,
      progressivo_invio: payload.fileProgressivo,
      codice_destinatario: payload.destinationCode,
      cliente: payload.customer.denomination,
      firma: applied.meta,
      validation
    }),
    payload.formatoTrasmissione,
    schema.schemaName,
    schema.schemaVersion,
    schema.sha256,
    xmlSha256,
    xmlRelativePath,
    applied.signed ? (applied.meta?.format || 'CAdES-BES') : null,
    JSON.stringify(applied.meta || {})
  );

  db.prepare(`
    UPDATE fatture
    SET xml_path = ?, stato_sdi = ?
    WHERE id = ?
  `).run(relativePath, `xml_generato_${mode}`, invoice.id);

  return {
    flowId: flow.lastInsertRowid,
    filename,
    mode,
    signed: applied.signed,
    signature: applied.meta,
    xmlPath: relativePath,
    unsignedXmlPath: xmlRelativePath,
    absolutePath,
    hash: transmittedSha256,
    xmlHash: xmlSha256,
    validation,
    preview: xml
  };
}

function buildFilename(invoice, customer, payload, extension = '.xml') {
  const transmitterCountry = xmlSafeFilePart(payload.company.country || 'IT').slice(0, 2).toUpperCase();
  const transmitterCode = xmlSafeFilePart(payload.company.vat || payload.company.fiscalCode || '00000000000').slice(0, 28);
  const progressivo = buildFilenameProgressivo(payload.fileProgressivo || buildProgressivoInvio(invoice.id));
  return `${transmitterCountry}${transmitterCode}_${progressivo}${extension}`;
}

function buildFilenameProgressivo(value) {
  return xmlSafeFilePart(value).slice(-5).padStart(5, '0').toUpperCase();
}

function buildPaymentPayload(invoice, total) {
  return {
    condizioniPagamento: String(getSetting('sdi.payment.condizioni', 'TP02') || 'TP02').trim(),
    details: [{
      modalitaPagamento: String(getSetting('sdi.payment.modalita', 'MP05') || 'MP05').trim(),
      dataScadenzaPagamento: normalizeDate(invoice.scadenza || invoice.data) || undefined,
      importoPagamento: total,
      istitutoFinanziario: String(getSetting('sdi.payment.istituto', '') || '').trim() || undefined,
      iban: normalizeIdentifier(getSetting('sdi.payment.iban', '')) || undefined,
      bic: normalizeIdentifier(getSetting('sdi.payment.bic', '')) || undefined
    }]
  };
}

// Il CRM registra lo sconto di riga come importo assoluto sul totale della riga
// (totale_riga = quantita * prezzo_unitario - sconto), mentre il controllo SdI
// 00423 confronta PrezzoTotale con (PrezzoUnitario - ScontoTot) * Quantita, dove
// lo sconto e' riferito alla singola unita'. Va quindi riportato per unita'.
function buildScontoMaggiorazione(line, quantita) {
  const sconto = toAmount(line.sconto) || 0;
  if (!sconto || !quantita) return null;
  const perUnit = sconto / quantita;
  return [{
    tipo: perUnit >= 0 ? 'SC' : 'MG',
    importo: Math.abs(perUnit)
  }];
}

// Controllo SdI 00427: FPA12 richiede un codice di 6 caratteri, FPR12 e FSM10 di
// 7. Il codice convenzionale 0000000 vale solo per i destinatari privati.
function resolveDestinationCode(customer, format) {
  const configured = String(customer.destinationCode || '').trim().toUpperCase();
  if (format === 'FPA12') {
    if (!configured) {
      throw new Error('La fattura e destinata a una PA ma il Codice Univoco Ufficio (6 caratteri) non e valorizzato');
    }
    if (configured.length !== 6) {
      throw new Error(`Codice Univoco Ufficio "${configured}" non valido per una fattura PA: sono richiesti 6 caratteri`);
    }
    return configured;
  }
  if (!configured) return '0000000';
  if (configured.length !== 7) {
    throw new Error(`Codice Destinatario "${configured}" non valido per il formato ${format}: sono richiesti 7 caratteri`);
  }
  return configured;
}

function splitVat(value) {
  const normalized = normalizeVat(value);
  if (!normalized) return { country: '', code: '' };
  const match = normalized.match(/^([A-Z]{2})(.+)$/);
  if (!match) return { country: 'IT', code: normalized };
  return { country: match[1], code: match[2] };
}

function normalizeVat(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function normalizeIdentifier(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function normalizeCustomerFiscalCode(value, vat = {}) {
  const fiscalCode = normalizeIdentifier(value);
  if (!fiscalCode) return '';
  const vatCode = normalizeIdentifier(vat.code || '').replace(/^[A-Z]{2}/, '');
  const fiscalWithoutCountry = fiscalCode.replace(/^[A-Z]{2}(?=\d)/, '');
  if (vatCode && fiscalWithoutCountry === vatCode) return '';
  return fiscalCode;
}

function normalizeCountry(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeDate(value) {
  if (!value) return '';
  const str = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  return '';
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function xmlSafeFilePart(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_.]+/g, '')
    .replace(/\.+/g, '.')
    .replace(/^\.+|\.+$/g, '') || 'file';
}

function toAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  let normalized = String(value).trim().replace(/\s+/g, '');
  if (normalized.includes(',') && normalized.includes('.')) {
    normalized = normalized.replace(/\./g, '').replace(',', '.');
  } else if (normalized.includes(',')) {
    normalized = normalized.replace(',', '.');
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

module.exports = {
  buildFilename,
  buildFilenameProgressivo,
  buildInvoicePayload,
  generateOutboundXmlForInvoice,
  normalizeCustomerFiscalCode
};
