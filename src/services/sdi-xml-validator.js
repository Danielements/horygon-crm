const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const { getSchemaRegistryEntry, syncSchemaRegistry } = require('./sdi-schema-registry');

let libxmlPromise = null;

function getLibxml() {
  if (!libxmlPromise) libxmlPromise = import('libxml2-wasm');
  return libxmlPromise;
}

async function validateInvoiceXml({ xml, format }) {
  syncSchemaRegistry();
  const schema = getSchemaRegistryEntry(format);
  const parser = createParser();
  const parsed = parser.parse(xml);
  const rootInfo = detectRoot(parsed);
  const appErrors = validateApplicationRules({ parsed, rootInfo, format, schema });
  const xsd = await validateXsd(xml, schema);
  return {
    ok: xsd.ok && appErrors.length === 0,
    format,
    schema,
    rootInfo,
    xmlSha256: sha256(xml),
    xsd,
    application: {
      ok: appErrors.length === 0,
      errors: appErrors
    }
  };
}

async function validateXsd(xml, schema) {
  const { XmlDocument, XsdValidator, ParseOption } = await getLibxml();
  let xsdDoc;
  let xmlDoc;
  let validator;
  try {
    xsdDoc = XmlDocument.fromBuffer(Buffer.from(normalizeSchemaForUnsignedValidation(fs.readFileSync(schema.localPath, 'utf8')), 'utf8'), {
      url: `file://${schema.localPath.replace(/\\/g, '/')}`,
      option: ParseOption.XML_PARSE_NONET | ParseOption.XML_PARSE_NO_XXE
    });
    validator = XsdValidator.fromDoc(xsdDoc);
    xmlDoc = XmlDocument.fromString(xml, {
      url: `file://${schema.localPath.replace(/\\/g, '/')}`,
      option: ParseOption.XML_PARSE_NONET | ParseOption.XML_PARSE_NO_XXE
    });
    validator.validate(xmlDoc);
    return { ok: true, errors: [] };
  } catch (error) {
    return { ok: false, errors: normalizeValidationError(error) };
  } finally {
    try { validator?.dispose(); } catch {}
    try { xmlDoc?.dispose(); } catch {}
    try { xsdDoc?.dispose(); } catch {}
  }
}

function detectInvoiceFormatFromXml(xml) {
  const parsed = createParser().parse(xml);
  const rootInfo = detectRoot(parsed);
  const version = rootInfo.attributes?.versione || '';
  if (version === 'FSM10' || rootInfo.rootName === 'FatturaElettronicaSemplificata') return 'FSM10';
  if (version === 'FPA12') return 'FPA12';
  if (version === 'FPR12') return 'FPR12';
  return null;
}

function validateApplicationRules({ parsed, rootInfo, format, schema }) {
  const errors = [];
  if (rootInfo.rootName !== schema.rootElement) {
    errors.push(`Root element atteso ${schema.rootElement}, trovato ${rootInfo.rootName || 'n/d'}`);
  }
  if (schema.namespace && rootInfo.namespace && rootInfo.namespace !== schema.namespace) {
    errors.push(`Namespace atteso ${schema.namespace}, trovato ${rootInfo.namespace}`);
  }
  const version = rootInfo.attributes?.versione;
  if (version !== format) {
    errors.push(`Versione XML attesa ${format}, trovata ${version || 'n/d'}`);
  }
  const tipoDocumento = findText(parsed, ['TipoDocumento']);
  if (!isTipoDocumentoAllowed(format, tipoDocumento)) {
    errors.push(`TipoDocumento ${tipoDocumento || 'n/d'} non ammesso per formato ${format}`);
  }
  const codiceDestinatario = findText(parsed, ['CodiceDestinatario']);
  const pecDestinatario = findText(parsed, ['PECDestinatario']);
  if (['FPR12', 'FSM10'].includes(format) && codiceDestinatario === '0000000' && !pecDestinatario) {
    errors.push('Per FPR12/FSM10 con CodiceDestinatario 0000000 occorre PECDestinatario');
  }
  if (format === 'FSM10' && !['TD07', 'TD08', 'TD09'].includes(String(tipoDocumento || '').toUpperCase())) {
    errors.push('FSM10 consente solo TD07, TD08 o TD09');
  }
  return errors;
}

function createParser() {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true
  });
}

function detectRoot(parsed) {
  const rootName = Object.keys(parsed || {}).find((key) => key !== '?xml') || '';
  const root = rootName ? parsed[rootName] : {};
  return {
    rootName,
    namespace: root?.['@_xmlns:p'] || root?.['@_xmlns'] || root?.['@_xmlns:ns2'] || '',
    attributes: Object.fromEntries(
      Object.entries(root || {})
        .filter(([key]) => key.startsWith('@_'))
        .map(([key, value]) => [key.replace(/^@_/, ''), value])
    )
  };
}

function findText(node, names) {
  if (node == null) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const value = findText(item, names);
      if (value != null) return value;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  for (const [key, value] of Object.entries(node)) {
    if (names.includes(key) && typeof value !== 'object') return String(value).trim();
    const nested = findText(value, names);
    if (nested != null) return nested;
  }
  return null;
}

function isTipoDocumentoAllowed(format, tipoDocumento) {
  const value = String(tipoDocumento || '').trim().toUpperCase();
  if (!value) return false;
  if (format === 'FSM10') return ['TD07', 'TD08', 'TD09'].includes(value);
  return new Set([
    'TD01', 'TD02', 'TD03', 'TD04', 'TD05', 'TD06',
    'TD16', 'TD17', 'TD18', 'TD19', 'TD20', 'TD21',
    'TD22', 'TD23', 'TD24', 'TD25', 'TD26', 'TD27',
    'TD28', 'TD29'
  ]).has(value);
}

function normalizeValidationError(error) {
  if (Array.isArray(error?.details)) {
    return error.details.map((item) => ({
      message: item.message || String(item),
      line: item.line || null,
      column: item.column || null,
      level: item.level || null
    }));
  }
  return [{ message: error?.message || String(error) }];
}

function normalizeSchemaForUnsignedValidation(source) {
  return String(source || '')
    .replace(/^\s*<xs:import[^>]*xmldsig-core-schema\.xsd[^>]*\/>\s*$/m, '')
    .replace(/^\s*<xs:element\s+ref="ds:Signature"[^>]*\/>\s*$/m, '');
}

function sha256(content) {
  return crypto.createHash('sha256').update(Buffer.from(String(content), 'utf8')).digest('hex');
}

module.exports = {
  detectInvoiceFormatFromXml,
  validateInvoiceXml
};
