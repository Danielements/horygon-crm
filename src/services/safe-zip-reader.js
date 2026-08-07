const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yauzl = require('yauzl');

// Lettore ZIP difensivo per gli archivi provenienti dai Servizi Massivi SdI.
//
// Gli archivi arrivano da una fonte fidata, ma restano contenuto esterno non
// controllato: il lettore valida sempre l'intera central directory prima di
// estrarre qualunque cosa, e non si fida mai dei nomi contenuti nell'archivio.
//
// yauzl non deve essere usato direttamente altrove: tutto passa da qui.

const DEFAULT_LIMITS = {
  maxEntries: 5000,
  maxEntrySize: 32 * 1024 * 1024,          // 32 MB per singolo file
  maxTotalUncompressedSize: 512 * 1024 * 1024,
  maxCompressedSize: 128 * 1024 * 1024,
  maxCompressionRatio: 200,                 // difesa zip bomb
  maxDirectoryDepth: 8,
  timeoutMs: 120000
};

class SafeZipError extends Error {
  constructor(message, code, entryName = null) {
    super(message);
    this.name = 'SafeZipError';
    this.code = code;
    this.entryName = entryName;
  }
}

function resolveLimits(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS };
  Object.entries(overrides).forEach(([key, value]) => {
    if (value !== undefined && value !== null && Number.isFinite(Number(value))) {
      limits[key] = Number(value);
    }
  });
  return limits;
}

// Il nome dentro l'archivio non e' mai un percorso di destinazione: viene
// normalizzato e ridotto a segmenti sicuri.
function validateEntryName(rawName, limits) {
  const name = String(rawName || '');
  if (!name) throw new SafeZipError('Voce senza nome', 'EMPTY_NAME');
  if (name.includes('\0')) throw new SafeZipError('Nome voce con byte NUL', 'NUL_BYTE', name);
  if (/^[A-Za-z]:[\\/]/.test(name) || name.startsWith('/') || name.startsWith('\\')) {
    throw new SafeZipError(`Percorso assoluto non ammesso: ${name}`, 'ABSOLUTE_PATH', name);
  }
  if (name.includes('\\')) {
    throw new SafeZipError(`Separatore Windows non ammesso: ${name}`, 'BACKSLASH', name);
  }
  const segments = name.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    throw new SafeZipError(`Traversal non ammesso: ${name}`, 'PATH_TRAVERSAL', name);
  }
  if (segments.length > limits.maxDirectoryDepth) {
    throw new SafeZipError(`Profondita' oltre il limite (${segments.length}): ${name}`, 'DEPTH_EXCEEDED', name);
  }
  return segments.join('/');
}

// yauzl applica da solo alcune verifiche strutturali e le segnala come errori
// generici: vengono ricondotte ai codici stabili di questo modulo, cosi' chi
// chiama non deve sapere quale strato ha intercettato il problema.
function classifyZipError(message, fallback) {
  const text = String(message || '');
  if (/invalid relative path|absolute path/i.test(text)) return 'PATH_TRAVERSAL';
  if (/size mismatch/i.test(text)) return 'SIZE_MISMATCH';
  if (/backslash|invalid characters/i.test(text)) return 'BACKSLASH';
  return fallback;
}

function isDirectoryEntry(entry) {
  return /\/$/.test(entry.fileName);
}

// Le entry con attributi di symlink vengono rifiutate: negli archivi SdI non
// servono e sono un vettore di fuga dalla directory di lavoro.
function isSymlinkEntry(entry) {
  const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
  return mode === 0xa000;
}

function openZip(filePath, limits) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (error, zipfile) => {
      if (error) return reject(new SafeZipError(`Archivio ZIP non leggibile: ${error.message}`, 'UNREADABLE'));
      if (!zipfile) return reject(new SafeZipError('Archivio ZIP vuoto o non valido', 'UNREADABLE'));
      if (zipfile.entryCount > limits.maxEntries) {
        zipfile.close();
        return reject(new SafeZipError(`Troppe voci nell'archivio: ${zipfile.entryCount} oltre il limite di ${limits.maxEntries}`, 'TOO_MANY_ENTRIES'));
      }
      resolve(zipfile);
    });
  });
}

// Primo passaggio: enumera e valida tutta la central directory senza estrarre.
function inspect(zipfile, limits) {
  return new Promise((resolve, reject) => {
    const entries = [];
    let totalUncompressed = 0;
    let totalCompressed = 0;

    zipfile.on('entry', (entry) => {
      try {
        if (isDirectoryEntry(entry)) return zipfile.readEntry();
        if (isSymlinkEntry(entry)) {
          throw new SafeZipError(`Symlink non ammesso: ${entry.fileName}`, 'SYMLINK', entry.fileName);
        }
        const safeName = validateEntryName(entry.fileName, limits);
        if (entry.uncompressedSize > limits.maxEntrySize) {
          throw new SafeZipError(`Voce troppo grande (${entry.uncompressedSize} byte): ${entry.fileName}`, 'ENTRY_TOO_LARGE', entry.fileName);
        }
        totalUncompressed += entry.uncompressedSize;
        totalCompressed += entry.compressedSize;
        if (totalUncompressed > limits.maxTotalUncompressedSize) {
          throw new SafeZipError(`Dimensione estratta complessiva oltre il limite (${totalUncompressed} byte)`, 'TOTAL_TOO_LARGE', entry.fileName);
        }
        if (totalCompressed > limits.maxCompressedSize) {
          throw new SafeZipError(`Dimensione compressa oltre il limite (${totalCompressed} byte)`, 'COMPRESSED_TOO_LARGE', entry.fileName);
        }
        if (entry.compressedSize > 0) {
          const ratio = entry.uncompressedSize / entry.compressedSize;
          if (ratio > limits.maxCompressionRatio) {
            throw new SafeZipError(`Rapporto di compressione sospetto (${ratio.toFixed(0)}:1): ${entry.fileName}`, 'COMPRESSION_RATIO', entry.fileName);
          }
        }
        entries.push({ entry, safeName, uncompressedSize: entry.uncompressedSize, compressedSize: entry.compressedSize });
        zipfile.readEntry();
      } catch (error) {
        reject(error);
      }
    });

    zipfile.on('end', () => resolve({ entries, totalUncompressed, totalCompressed }));
    zipfile.on('error', (error) => reject(
      new SafeZipError(`Errore di lettura ZIP: ${error.message}`, classifyZipError(error.message, 'READ_ERROR'))
    ));
    zipfile.readEntry();
  });
}

function readEntryBuffer(zipfile, entry, limit) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error) return reject(new SafeZipError(`Voce non estraibile: ${error.message}`, 'ENTRY_UNREADABLE', entry.fileName));
      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        // Il campo dichiarato nella central directory puo' mentire: si verifica
        // anche durante lo streaming.
        if (size > limit) {
          stream.destroy();
          return reject(new SafeZipError(`Voce oltre il limite in fase di lettura: ${entry.fileName}`, 'ENTRY_TOO_LARGE', entry.fileName));
        }
        chunks.push(chunk);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', (streamError) => reject(new SafeZipError(`Errore in lettura: ${streamError.message}`, 'READ_ERROR', entry.fileName)));
    });
  });
}

// Legge un archivio applicando tutti i limiti. Restituisce le voci in memoria
// una alla volta al callback, senza mai estrarre su disco fuori da destDir.
async function readZip(filePath, options = {}) {
  const limits = resolveLimits(options.limits);
  const started = Date.now();
  const zipfile = await openZip(filePath, limits);
  try {
    const { entries, totalUncompressed, totalCompressed } = await inspect(zipfile, limits);
    const results = [];
    for (const item of entries) {
      if (Date.now() - started > limits.timeoutMs) {
        throw new SafeZipError('Timeout nella lettura dell archivio', 'TIMEOUT');
      }
      const buffer = await readEntryBuffer(zipfile, item.entry, limits.maxEntrySize);
      const record = {
        name: item.safeName,
        originalName: item.entry.fileName,
        size: buffer.length,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        buffer
      };
      if (typeof options.onEntry === 'function') await options.onEntry(record);
      results.push(options.keepBuffers === false ? { ...record, buffer: undefined } : record);
    }
    return { entries: results, totalUncompressed, totalCompressed, limits };
  } finally {
    zipfile.close();
  }
}

// Estrae dentro una directory di lavoro assegnata al job, ricostruendo i nomi
// solo da segmenti validati e verificando che il percorso finale non esca.
async function extractTo(filePath, destDir, options = {}) {
  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true });
  const written = [];
  await readZip(filePath, {
    ...options,
    keepBuffers: false,
    onEntry: async (record) => {
      const target = path.resolve(root, record.name);
      if (target !== root && !target.startsWith(root + path.sep)) {
        throw new SafeZipError(`Destinazione fuori dalla directory di lavoro: ${record.originalName}`, 'PATH_ESCAPE', record.originalName);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, record.buffer);
      written.push({ name: record.name, path: target, size: record.size, sha256: record.sha256 });
      if (typeof options.onExtracted === 'function') await options.onExtracted({ ...record, path: target });
    }
  });
  return { root, files: written };
}

module.exports = {
  DEFAULT_LIMITS,
  SafeZipError,
  extractTo,
  readZip,
  validateEntryName
};
