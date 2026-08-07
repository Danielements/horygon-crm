const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { readZip, extractTo, validateEntryName, SafeZipError, DEFAULT_LIMITS } = require('../src/services/safe-zip-reader');

// Scrittore ZIP minimale (solo store/deflate) per costruire archivi di prova,
// compresi quelli malevoli che una libreria non produrrebbe mai.
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  entries.forEach((entry) => {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '', 'utf8');
    const deflated = entry.deflate ? zlib.deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const method = entry.deflate ? 8 : 0;
    // Permette di dichiarare dimensioni false nella central directory.
    const declaredUncompressed = entry.declaredUncompressedSize ?? raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, deflated);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(deflated.length, 20);
    header.writeUInt32LE(declaredUncompressed, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(entry.externalAttributes || 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, name]));
    offset += local.length + name.length + deflated.length;
  });

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuffer, end]);
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = [];
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeTempZip(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safezip-'));
  const file = path.join(dir, 'archivio.zip');
  fs.writeFileSync(file, buildZip(entries));
  return { dir, file };
}

// --- validazione dei nomi -------------------------------------------------

test('i nomi di percorso pericolosi vengono rifiutati', () => {
  const cases = [
    ['../fuori.xml', 'PATH_TRAVERSAL'],
    ['a/../../fuori.xml', 'PATH_TRAVERSAL'],
    ['/etc/passwd', 'ABSOLUTE_PATH'],
    ['C:\\Windows\\system.ini', 'ABSOLUTE_PATH'],
    ['cartella\\file.xml', 'BACKSLASH'],
    ['file\u0000.xml', 'NUL_BYTE']
  ];
  cases.forEach(([name, code]) => {
    assert.throws(
      () => validateEntryName(name, DEFAULT_LIMITS),
      (error) => error instanceof SafeZipError && error.code === code,
      `atteso ${code} per ${JSON.stringify(name)}`
    );
  });
});

test('la profondita di annidamento e limitata', () => {
  const deep = Array.from({ length: 12 }, (_, i) => `d${i}`).join('/') + '/f.xml';
  assert.throws(
    () => validateEntryName(deep, DEFAULT_LIMITS),
    (error) => error.code === 'DEPTH_EXCEEDED'
  );
  assert.equal(validateEntryName('./a/./b/f.xml', DEFAULT_LIMITS), 'a/b/f.xml');
});

// --- lettura ---------------------------------------------------------------

test('un archivio valido viene letto con hash per ogni voce', async () => {
  const { file } = writeTempZip([
    { name: 'IT03365990591_H0001.xml', data: '<FatturaElettronica/>' },
    { name: 'meta/IT03365990591_H0001_MT_001.xml', data: '<Metadati/>', deflate: true }
  ]);
  const result = await readZip(file);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].name, 'IT03365990591_H0001.xml');
  assert.equal(result.entries[0].buffer.toString('utf8'), '<FatturaElettronica/>');
  assert.match(result.entries[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.entries[1].name, 'meta/IT03365990591_H0001_MT_001.xml');
});

test('lo Zip Slip non riesce a scrivere fuori dalla directory di lavoro', async () => {
  const { dir, file } = writeTempZip([{ name: '../evaso.xml', data: 'x' }]);
  const dest = path.join(dir, 'lavoro');
  await assert.rejects(
    () => extractTo(file, dest),
    (error) => error instanceof SafeZipError && error.code === 'PATH_TRAVERSAL'
  );
  assert.equal(fs.existsSync(path.join(dir, 'evaso.xml')), false, 'nessun file scritto fuori');
});

test('l estrazione resta dentro la directory assegnata al job', async () => {
  const { dir, file } = writeTempZip([
    { name: 'a/b/fattura.xml', data: '<x/>' },
    { name: 'radice.xml', data: '<y/>' }
  ]);
  const dest = path.join(dir, 'lavoro');
  const result = await extractTo(file, dest);
  assert.equal(result.files.length, 2);
  result.files.forEach((f) => assert.ok(f.path.startsWith(path.resolve(dest) + path.sep)));
  assert.equal(fs.readFileSync(path.join(dest, 'a', 'b', 'fattura.xml'), 'utf8'), '<x/>');
});

// --- limiti e zip bomb -----------------------------------------------------

test('il numero massimo di voci e applicato', async () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.xml`, data: 'x' }));
  const { file } = writeTempZip(entries);
  await assert.rejects(
    () => readZip(file, { limits: { maxEntries: 3 } }),
    (error) => error.code === 'TOO_MANY_ENTRIES'
  );
});

test('una voce oltre il limite di dimensione viene rifiutata', async () => {
  const { file } = writeTempZip([{ name: 'grande.xml', data: Buffer.alloc(4096, 0x41) }]);
  await assert.rejects(
    () => readZip(file, { limits: { maxEntrySize: 1024 } }),
    (error) => error.code === 'ENTRY_TOO_LARGE'
  );
});

test('il rapporto di compressione sospetto blocca la zip bomb', async () => {
  // 2 MB di zeri si comprimono in pochissimo: rapporto ben oltre il limite.
  const { file } = writeTempZip([{ name: 'bomba.xml', data: Buffer.alloc(2 * 1024 * 1024, 0), deflate: true }]);
  await assert.rejects(
    () => readZip(file, { limits: { maxCompressionRatio: 50 } }),
    (error) => error.code === 'COMPRESSION_RATIO'
  );
});

test('la dimensione estratta complessiva e limitata', async () => {
  const { file } = writeTempZip([
    { name: 'a.xml', data: Buffer.alloc(2048, 0x41) },
    { name: 'b.xml', data: Buffer.alloc(2048, 0x42) }
  ]);
  await assert.rejects(
    () => readZip(file, { limits: { maxTotalUncompressedSize: 3000 } }),
    (error) => error.code === 'TOTAL_TOO_LARGE'
  );
});

test('una dimensione dichiarata falsa viene intercettata', async () => {
  // La central directory dichiara 10 byte, il contenuto reale ne ha 4096:
  // l incoerenza viene rilevata prima di leggere il contenuto.
  const { file } = writeTempZip([
    { name: 'bugiardo.xml', data: Buffer.alloc(4096, 0x41), declaredUncompressedSize: 10 }
  ]);
  await assert.rejects(
    () => readZip(file, { limits: { maxEntrySize: 100 } }),
    (error) => error instanceof SafeZipError && error.code === 'SIZE_MISMATCH'
  );
});

test('i symlink vengono rifiutati', async () => {
  const { file } = writeTempZip([
    { name: 'link.xml', data: '/etc/passwd', externalAttributes: 0xa1ff0000 }
  ]);
  await assert.rejects(
    () => readZip(file),
    (error) => error.code === 'SYMLINK'
  );
});

test('un file non ZIP produce un errore controllato', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safezip-'));
  const file = path.join(dir, 'finto.zip');
  fs.writeFileSync(file, Buffer.from('questo non e un archivio'));
  await assert.rejects(
    () => readZip(file),
    (error) => error instanceof SafeZipError && error.code === 'UNREADABLE'
  );
});
