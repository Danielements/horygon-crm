const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');
const { getSetting } = require('./google');

const ROOT = path.resolve(__dirname, '../../');
const OUTBOUND_DIR = path.join(ROOT, 'uploads', 'sdi-outbound');

function generateOutboundXmlForInvoice(fatturaId, options = {}) {
  const invoice = loadInvoice(fatturaId);
  if (!invoice) throw new Error('Fattura non trovata');
  if (invoice.tipo !== 'emessa') throw new Error('Il test SDI e disponibile solo per fatture emesse');

  const company = loadCompanyProfile();
  const customer = loadRecipientProfile(invoice.anagrafica_id);
  const payload = buildInvoicePayload(invoice, company, customer, options);
  const xml = buildFatturaPaXml(payload);
  return saveOutboundXml(invoice, customer, xml, payload, options);
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
    cap: String(getSetting('sdi.company.cap', '') || '').trim(),
    city: String(getSetting('sdi.company.city', '') || '').trim(),
    province: String(getSetting('sdi.company.province', '') || '').trim().toUpperCase(),
    pec: String(getSetting('sdi.company.pec', '') || '').trim(),
    reaOffice: String(getSetting('sdi.company.rea_office', '') || '').trim().toUpperCase(),
    reaNumber: String(getSetting('sdi.company.rea_number', '') || '').trim(),
    shareCapital: toAmount(getSetting('sdi.company.share_capital', '0')) || 0
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
    return {
      numeroLinea: index + 1,
      descrizione: line.descrizione || `Riga ${index + 1}`,
      quantita,
      prezzoUnitario,
      totaleRiga,
      aliquotaIva: toAmount(line.aliquota_iva) || 0,
      naturaIva: String(line.natura_iva || '').trim() || null
    };
  });
  if (!lines.length) throw new Error('La fattura non contiene righe da esportare');

  const riepilogo = (invoice.riepilogo_iva || []).length
    ? invoice.riepilogo_iva.map((row) => ({
        aliquotaIva: toAmount(row.aliquota_iva) || 0,
        naturaIva: String(row.natura_iva || '').trim() || null,
        imponibile: toAmount(row.imponibile) || 0,
        imposta: toAmount(row.imposta) || 0,
        riferimentoNormativo: String(row.riferimento_normativo || '').trim() || null
      }))
    : summarizeVat(lines);

  const totaleDocumento = toAmount(invoice.totale) || round2(lines.reduce((sum, line) => sum + line.totaleRiga, 0) + riepilogo.reduce((sum, row) => sum + row.imposta, 0));
  const destinationCode = customer.destinationCode || (customer.pec ? '0000000' : '');
  const country = normalizeCountry(customer.paese || 'IT');
  const fiscalCode = normalizeIdentifier(customer.cf);
  const vat = splitVat(customer.piva);
  const transmissionCountry = customer.isPa ? company.country : (vat.country || country || company.country);
  const fileProgressivo = buildProgressivoInvio(invoice.id);

  return {
    mode: String(options.mode || getSetting('sdi.mode', 'test') || 'test').trim(),
    invoiceId: invoice.id,
    numero,
    data,
    totaleDocumento,
    tipoDocumento: mapDocumentType(invoice.tipo_documento),
    formatoTrasmissione: customer.isPa ? 'FPA12' : 'FPR12',
    fileProgressivo,
    transmissionCountry,
    destinationCode,
    pecDestinatario: customer.pec ? String(customer.pec).trim() : '',
    company,
    customer: {
      denomination: String(customer.ragione_sociale || '').trim(),
      address: String(customer.indirizzo || '').trim(),
      cap: String(customer.cap || '').trim(),
      city: String(customer.citta || '').trim(),
      province: String(customer.provincia || '').trim().toUpperCase(),
      country,
      fiscalCode,
      vat
    },
    lines,
    riepilogo
  };
}

function buildFatturaPaXml(payload) {
  const customerHasVat = Boolean(payload.customer.vat.code);
  const customerHasFiscalCode = Boolean(payload.customer.fiscalCode);
  const bodyLines = payload.lines.map((line) => `
        <DettaglioLinee>
          <NumeroLinea>${line.numeroLinea}</NumeroLinea>
          <Descrizione>${xmlEscape(line.descrizione)}</Descrizione>
          <Quantita>${formatDecimal(line.quantita)}</Quantita>
          <PrezzoUnitario>${formatDecimal(line.prezzoUnitario)}</PrezzoUnitario>
          <PrezzoTotale>${formatDecimal(line.totaleRiga)}</PrezzoTotale>
          <AliquotaIVA>${formatDecimal(line.aliquotaIva)}</AliquotaIVA>
          ${line.naturaIva ? `<Natura>${xmlEscape(line.naturaIva)}</Natura>` : ''}
        </DettaglioLinee>`).join('\n');
  const bodySummary = payload.riepilogo.map((row) => `
        <DatiRiepilogo>
          <AliquotaIVA>${formatDecimal(row.aliquotaIva)}</AliquotaIVA>
          ${row.naturaIva ? `<Natura>${xmlEscape(row.naturaIva)}</Natura>` : ''}
          <ImponibileImporto>${formatDecimal(row.imponibile)}</ImponibileImporto>
          <Imposta>${formatDecimal(row.imposta)}</Imposta>
          ${row.riferimentoNormativo ? `<RiferimentoNormativo>${xmlEscape(row.riferimentoNormativo)}</RiferimentoNormativo>` : ''}
        </DatiRiepilogo>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="${payload.formatoTrasmissione}" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2">
  <FatturaElettronicaHeader>
    <DatiTrasmissione>
      <IdTrasmittente>
        <IdPaese>${xmlEscape(payload.company.country)}</IdPaese>
        <IdCodice>${xmlEscape(payload.company.vat)}</IdCodice>
      </IdTrasmittente>
      <ProgressivoInvio>${xmlEscape(payload.fileProgressivo)}</ProgressivoInvio>
      <FormatoTrasmissione>${payload.formatoTrasmissione}</FormatoTrasmissione>
      <CodiceDestinatario>${xmlEscape(payload.destinationCode || '0000000')}</CodiceDestinatario>
      ${payload.pecDestinatario ? `<PECDestinatario>${xmlEscape(payload.pecDestinatario)}</PECDestinatario>` : ''}
    </DatiTrasmissione>
    <CedentePrestatore>
      <DatiAnagrafici>
        <IdFiscaleIVA>
          <IdPaese>${xmlEscape(payload.company.country)}</IdPaese>
          <IdCodice>${xmlEscape(payload.company.vat)}</IdCodice>
        </IdFiscaleIVA>
        <CodiceFiscale>${xmlEscape(payload.company.fiscalCode)}</CodiceFiscale>
        <Anagrafica>
          <Denominazione>${xmlEscape(payload.company.denomination)}</Denominazione>
        </Anagrafica>
        <RegimeFiscale>${xmlEscape(payload.company.regimeFiscale)}</RegimeFiscale>
      </DatiAnagrafici>
      <Sede>
        <Indirizzo>${xmlEscape(payload.company.address)}</Indirizzo>
        <CAP>${xmlEscape(payload.company.cap)}</CAP>
        <Comune>${xmlEscape(payload.company.city)}</Comune>
        <Provincia>${xmlEscape(payload.company.province)}</Provincia>
        <Nazione>${xmlEscape(payload.company.country)}</Nazione>
      </Sede>
      ${payload.company.reaOffice && payload.company.reaNumber ? `
      <IscrizioneREA>
        <Ufficio>${xmlEscape(payload.company.reaOffice)}</Ufficio>
        <NumeroREA>${xmlEscape(payload.company.reaNumber)}</NumeroREA>
        <CapitaleSociale>${formatDecimal(payload.company.shareCapital)}</CapitaleSociale>
        <SocioUnico>SM</SocioUnico>
        <StatoLiquidazione>LN</StatoLiquidazione>
      </IscrizioneREA>` : ''}
      ${payload.company.pec ? `
      <Contatti>
        <Email>${xmlEscape(payload.company.pec)}</Email>
      </Contatti>` : ''}
    </CedentePrestatore>
    <CessionarioCommittente>
      <DatiAnagrafici>
        ${customerHasVat ? `
        <IdFiscaleIVA>
          <IdPaese>${xmlEscape(payload.customer.vat.country || payload.customer.country || 'IT')}</IdPaese>
          <IdCodice>${xmlEscape(payload.customer.vat.code)}</IdCodice>
        </IdFiscaleIVA>` : ''}
        ${customerHasFiscalCode ? `<CodiceFiscale>${xmlEscape(payload.customer.fiscalCode)}</CodiceFiscale>` : ''}
        <Anagrafica>
          <Denominazione>${xmlEscape(payload.customer.denomination)}</Denominazione>
        </Anagrafica>
      </DatiAnagrafici>
      <Sede>
        <Indirizzo>${xmlEscape(payload.customer.address)}</Indirizzo>
        <CAP>${xmlEscape(payload.customer.cap)}</CAP>
        <Comune>${xmlEscape(payload.customer.city)}</Comune>
        <Provincia>${xmlEscape(payload.customer.province)}</Provincia>
        <Nazione>${xmlEscape(payload.customer.country || 'IT')}</Nazione>
      </Sede>
    </CessionarioCommittente>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali>
      <DatiGeneraliDocumento>
        <TipoDocumento>${xmlEscape(payload.tipoDocumento)}</TipoDocumento>
        <Divisa>EUR</Divisa>
        <Data>${payload.data}</Data>
        <Numero>${xmlEscape(payload.numero)}</Numero>
        <ImportoTotaleDocumento>${formatDecimal(payload.totaleDocumento)}</ImportoTotaleDocumento>
      </DatiGeneraliDocumento>
    </DatiGenerali>
    <DatiBeniServizi>
${bodyLines}
${bodySummary}
    </DatiBeniServizi>
  </FatturaElettronicaBody>
</p:FatturaElettronica>
`;
}

function saveOutboundXml(invoice, customer, xml, payload, options = {}) {
  ensureDir(OUTBOUND_DIR);
  const filename = buildFilename(invoice, customer, payload);
  const absolutePath = path.join(OUTBOUND_DIR, filename);
  fs.writeFileSync(absolutePath, xml, 'utf8');
  const fileHash = crypto.createHash('sha1').update(xml).digest('hex');
  const relativePath = toPosix(path.relative(ROOT, absolutePath));
  const mode = String(options.mode || getSetting('sdi.mode', 'test') || 'test').trim();
  const flow = db.prepare(`
    INSERT INTO fatture_sdi_flussi (
      fattura_id, direzione, modalita, tipo_messaggio, nome_file, stato, xml_path, hash_file, payload_meta, ultimo_evento_il
    ) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
  `).run(
    invoice.id,
    'outbound',
    mode,
    'fattura',
    filename,
    'xml_generato_test',
    `/${relativePath}`,
    fileHash,
    JSON.stringify({
      formato_trasmissione: payload.formatoTrasmissione,
      progressivo_invio: payload.fileProgressivo,
      codice_destinatario: payload.destinationCode,
      cliente: payload.customer.denomination
    })
  );
  db.prepare(`
    UPDATE fatture
    SET xml_path = ?, stato_sdi = ?
    WHERE id = ?
  `).run(`/${relativePath}`, 'xml_generato_test', invoice.id);

  return {
    flowId: flow.lastInsertRowid,
    filename,
    xmlPath: `/${relativePath}`,
    absolutePath,
    hash: fileHash,
    preview: xml
  };
}

function summarizeVat(lines) {
  const grouped = new Map();
  lines.forEach((line) => {
    const key = `${Number(line.aliquotaIva || 0).toFixed(2)}|${line.naturaIva || ''}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        aliquotaIva: Number(line.aliquotaIva || 0),
        naturaIva: line.naturaIva || null,
        imponibile: 0,
        imposta: 0,
        riferimentoNormativo: null
      });
    }
    const row = grouped.get(key);
    row.imponibile = round2(row.imponibile + Number(line.totaleRiga || 0));
    row.imposta = round2(row.imposta + Number(line.totaleRiga || 0) * Number(line.aliquotaIva || 0) / 100);
  });
  return [...grouped.values()];
}

function buildFilename(invoice, customer, payload) {
  const vatCode = xmlSafeFilePart(payload.company.vat || payload.company.fiscalCode || 'azienda');
  const customerCode = xmlSafeFilePart(customer.piva || customer.cf || customer.ragione_sociale || 'cliente');
  const number = xmlSafeFilePart(invoice.numero_documento || invoice.numero || `fattura-${invoice.id}`);
  return `${vatCode}_${customerCode}_${number}_${payload.fileProgressivo}.xml`;
}

function buildProgressivoInvio(invoiceId) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(2, 12);
  return `${stamp}${String(invoiceId).padStart(4, '0')}`.slice(0, 10);
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

function normalizeCountry(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeDate(value) {
  if (!value) return '';
  const str = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  return '';
}

function mapDocumentType(value) {
  const normalized = String(value || 'fattura').trim().toLowerCase();
  if (normalized === 'nota_credito') return 'TD04';
  if (normalized === 'nota_debito') return 'TD05';
  if (normalized === 'autofattura') return 'TD16';
  if (normalized === 'integrazione_estero') return 'TD17';
  return 'TD01';
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlSafeFilePart(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'file';
}

function formatDecimal(value) {
  return Number(value || 0).toFixed(2);
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
  generateOutboundXmlForInvoice
};
