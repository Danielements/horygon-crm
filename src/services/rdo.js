const path = require('path');
const XLSX = require('xlsx');
const db = require('../db/database');
const { getCpvCatalogEntries, formatCpvCode } = require('./mepa-parser');

db.exec(`
  CREATE TABLE IF NOT EXISTS rdo_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT NOT NULL,
    sheet_name TEXT,
    row_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rdo_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL,
    row_index INTEGER NOT NULL,
    ente TEXT,
    gara TEXT,
    categoria TEXT,
    scadenza TEXT,
    raw_json TEXT NOT NULL,
    search_text TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (import_id) REFERENCES rdo_imports(id) ON DELETE CASCADE
  );
`);

const STOPWORDS = new Set([
  'della', 'delle', 'degli', 'dell', 'dello', 'dalla', 'dalle', 'agli', 'alla', 'alle',
  'con', 'per', 'del', 'dei', 'gli', 'una', 'uno', 'nel', 'nella', 'nelle', 'non',
  'gara', 'rdo', 'mepa', 'offerta', 'presentazione', 'servizi', 'fornitura', 'forniture',
  'acquisto', 'acquisti', 'relativa', 'comunicazione', 'lavori', 'beni'
]);

function normalizeHeader(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeText(value = '') {
  return normalizeText(value)
    .split(' ')
    .map(token => token.trim())
    .filter(token => token.length >= 4 && !STOPWORDS.has(token));
}

function pickField(row, predicate) {
  for (const [key, value] of Object.entries(row || {})) {
    const header = normalizeHeader(key);
    if (predicate(header, key)) {
      const text = String(value || '').trim();
      if (text) return text;
    }
  }
  return '';
}

function guessRowFields(row = {}) {
  return {
    ente: pickField(row, header =>
      header.includes('ente') ||
      header.includes('amministrazione') ||
      header.includes('stazione appaltante') ||
      header.includes('amministrazione aggiudicatrice')
    ),
    gara: pickField(row, header =>
      header.includes('gara') ||
      header.includes('oggetto') ||
      header.includes('descrizione') ||
      header.includes('titolo')
    ),
    categoria: pickField(row, header =>
      header.includes('categoria') ||
      header.includes('cpv') ||
      header.includes('merceologica')
    ),
    scadenza: pickField(row, header =>
      header.includes('scadenza') ||
      header.includes('termine') ||
      header.includes('data')
    ),
  };
}

function buildSearchText(row = {}) {
  return Object.values(row)
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(' \n ');
}

function scoreDescriptionMatch(text, entry) {
  const haystack = normalizeText(text);
  const description = normalizeText(entry?.desc || '');
  if (!haystack || !description) return null;

  if (haystack.includes(description)) {
    return { score: Math.min(100, 70 + Math.round(description.length / 4)), reason: 'match descrizione completa' };
  }

  const tokens = [...new Set(tokenizeText(description))];
  if (!tokens.length) return null;
  const matched = tokens.filter(token => haystack.includes(token));
  const coverage = matched.length / tokens.length;

  if (matched.length < 2 && coverage < 0.7) return null;
  if (coverage < 0.45) return null;

  return {
    score: Math.min(99, Math.round(coverage * 100) + matched.length * 4),
    reason: matched.slice(0, 5).join(', ')
  };
}

function importRdoWorkbook(buffer, fileName = 'rdo.xlsx') {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('Nessun foglio Excel trovato');
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (!rows.length) throw new Error('Il file Excel non contiene righe utili');

  const imported = db.prepare(`
    INSERT INTO rdo_imports (file_name, sheet_name, row_count)
    VALUES (?, ?, ?)
  `).run(path.basename(fileName), sheetName, rows.length);

  const importId = imported.lastInsertRowid;
  const insertRow = db.prepare(`
    INSERT INTO rdo_rows (import_id, row_index, ente, gara, categoria, scadenza, raw_json, search_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN');
  try {
    rows.forEach((row, index) => {
      const guessed = guessRowFields(row);
      insertRow.run(
        importId,
        index + 1,
        guessed.ente,
        guessed.gara,
        guessed.categoria,
        guessed.scadenza,
        JSON.stringify(row),
        buildSearchText(row)
      );
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return db.prepare('SELECT * FROM rdo_imports WHERE id = ?').get(importId);
}

function listRdoImports() {
  return db.prepare(`
    SELECT *
    FROM rdo_imports
    ORDER BY id DESC
    LIMIT 20
  `).all();
}

function getRdoMatches({ importId = null, q = '', matchedOnly = false } = {}) {
  const imports = listRdoImports();
  const selectedImportId = importId ? Number(importId) : (imports[0]?.id || null);
  if (!selectedImportId) {
    return { imports, selectedImportId: null, total: 0, matched: 0, unmatched: 0, results: [] };
  }

  const rows = db.prepare(`
    SELECT *
    FROM rdo_rows
    WHERE import_id = ?
    ORDER BY row_index ASC
  `).all(selectedImportId);

  const catalog = getCpvCatalogEntries({ activeOnly: true });
  const enriched = rows.map(row => {
    const matches = catalog
      .map(entry => {
        const result = scoreDescriptionMatch(row.search_text, entry);
        if (!result) return null;
        return {
          codice_cpv: entry.codice_cpv,
          codice_cpv_display: formatCpvCode(entry.codice_cpv),
          descrizione: entry.desc || '',
          categoria_catalogo: entry.categoria || '',
          score: result.score,
          reason: result.reason,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    return {
      ...row,
      match_count: matches.length,
      best_score: matches[0]?.score || 0,
      cpv_matches: matches,
      raw: JSON.parse(row.raw_json || '{}'),
    };
  });

  const loweredQuery = String(q || '').trim().toLowerCase();
  const filtered = enriched.filter(row => {
    if (matchedOnly && !row.match_count) return false;
    if (!loweredQuery) return true;
    const blob = [
      row.ente,
      row.gara,
      row.categoria,
      row.scadenza,
      ...Object.values(row.raw || {}),
      ...(row.cpv_matches || []).map(item => `${item.codice_cpv_display} ${item.descrizione} ${item.categoria_catalogo}`)
    ].filter(Boolean).join(' ').toLowerCase();
    return blob.includes(loweredQuery);
  });

  return {
    imports,
    selectedImportId,
    total: enriched.length,
    matched: enriched.filter(row => row.match_count > 0).length,
    unmatched: enriched.filter(row => !row.match_count).length,
    results: filtered,
  };
}

module.exports = {
  importRdoWorkbook,
  listRdoImports,
  getRdoMatches,
};
