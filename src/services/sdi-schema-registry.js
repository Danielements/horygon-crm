const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');

const ROOT = path.resolve(__dirname, '../../');
const RESOURCE_ROOT = path.join(ROOT, 'resources', 'sdi');

const SCHEMA_ENTRIES = [
  {
    format: 'FPA12',
    schemaName: 'Schema_VFPR12_v1.2.3.xsd',
    schemaVersion: '1.2.3',
    localPath: path.join(RESOURCE_ROOT, 'invoices', 'ordinary', 'Schema_VFPR12_v1.2.3.xsd'),
    namespace: 'http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2',
    rootElement: 'FatturaElettronica',
    validFrom: '2026-05-15',
    validTo: null,
    enabled: true
  },
  {
    format: 'FPR12',
    schemaName: 'Schema_VFPR12_v1.2.3.xsd',
    schemaVersion: '1.2.3',
    localPath: path.join(RESOURCE_ROOT, 'invoices', 'ordinary', 'Schema_VFPR12_v1.2.3.xsd'),
    namespace: 'http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2',
    rootElement: 'FatturaElettronica',
    validFrom: '2026-05-15',
    validTo: null,
    enabled: true
  },
  {
    format: 'FSM10',
    schemaName: 'Schema_VFSM10_v1.0.2.xsd',
    schemaVersion: '1.0.2',
    localPath: path.join(RESOURCE_ROOT, 'invoices', 'simplified', 'Schema_VFSM10_v1.0.2.xsd'),
    namespace: 'http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.0',
    rootElement: 'FatturaElettronicaSemplificata',
    validFrom: '2026-05-15',
    validTo: null,
    enabled: true
  }
];

function listSchemaRegistry() {
  return SCHEMA_ENTRIES.map(enrichEntry);
}

function getSchemaRegistryEntry(format) {
  const entry = SCHEMA_ENTRIES.find((item) => item.format === format);
  if (!entry) throw new Error(`Schema SDI non configurato per formato ${format}`);
  return enrichEntry(entry);
}

function syncSchemaRegistry() {
  const upsert = db.prepare(`
    INSERT INTO sdi_schema_registry (
      format, schema_name, schema_version, local_path, namespace, root_element, valid_from, valid_to, sha256, enabled, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(format) DO UPDATE SET
      schema_name = excluded.schema_name,
      schema_version = excluded.schema_version,
      local_path = excluded.local_path,
      namespace = excluded.namespace,
      root_element = excluded.root_element,
      valid_from = excluded.valid_from,
      valid_to = excluded.valid_to,
      sha256 = excluded.sha256,
      enabled = excluded.enabled,
      updated_at = datetime('now')
  `);
  listSchemaRegistry().forEach((entry) => {
    upsert.run(
      entry.format,
      entry.schemaName,
      entry.schemaVersion,
      entry.localPath,
      entry.namespace || null,
      entry.rootElement,
      entry.validFrom || null,
      entry.validTo || null,
      entry.sha256,
      entry.enabled ? 1 : 0
    );
  });
  return db.prepare('SELECT * FROM sdi_schema_registry ORDER BY format').all();
}

function enrichEntry(entry) {
  const localPath = path.resolve(entry.localPath);
  return {
    ...entry,
    localPath,
    sha256: sha256File(localPath)
  };
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

module.exports = {
  RESOURCE_ROOT,
  getSchemaRegistryEntry,
  listSchemaRegistry,
  syncSchemaRegistry
};
