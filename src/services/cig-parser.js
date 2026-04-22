const fs = require('fs');
const readline = require('readline');
const path = require('path');
const db = require('../db/database');
const { CPV_HORYGON } = require('./mepa-parser');

// Inizializza tabelle CIG
db.exec(`
  CREATE TABLE IF NOT EXISTS cig_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anno INTEGER NOT NULL,
    mese INTEGER NOT NULL,
    cod_cpv TEXT NOT NULL,
    descrizione_cpv TEXT,
    n_gare INTEGER DEFAULT 0,
    importo_totale REAL DEFAULT 0,
    importo_medio REAL DEFAULT 0,
    provincia TEXT DEFAULT '',
    regione_istat TEXT DEFAULT '',
    file_fonte TEXT,
    UNIQUE(anno, mese, cod_cpv, provincia)
  );

  CREATE TABLE IF NOT EXISTS cig_import_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_nome TEXT UNIQUE,
    righe_totali INTEGER,
    righe_horygon INTEGER,
    valore_horygon REAL,
    anni TEXT,
    data_import TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_cig_anno_mese ON cig_stats(anno, mese);
  CREATE INDEX IF NOT EXISTS idx_cig_cpv ON cig_stats(cod_cpv);
`);

// Mappa province → regioni
const PROVINCE_REGIONI = {
  'TO':'PIEMONTE','VC':'PIEMONTE','NO':'PIEMONTE','CN':'PIEMONTE','AT':'PIEMONTE','AL':'PIEMONTE','BI':'PIEMONTE','VB':'PIEMONTE',
  'AO':'VALLE D\'AOSTA',
  'VA':'LOMBARDIA','CO':'LOMBARDIA','SO':'LOMBARDIA','MI':'LOMBARDIA','BG':'LOMBARDIA','BS':'LOMBARDIA','PV':'LOMBARDIA','CR':'LOMBARDIA','MN':'LOMBARDIA','LC':'LOMBARDIA','LO':'LOMBARDIA','MB':'LOMBARDIA',
  'BZ':'TRENTINO-ALTO ADIGE','TN':'TRENTINO-ALTO ADIGE',
  'VR':'VENETO','VI':'VENETO','BL':'VENETO','TV':'VENETO','VE':'VENETO','PD':'VENETO','RO':'VENETO',
  'UD':'FRIULI VENEZIA GIULIA','GO':'FRIULI VENEZIA GIULIA','TS':'FRIULI VENEZIA GIULIA','PN':'FRIULI VENEZIA GIULIA',
  'GE':'LIGURIA','SV':'LIGURIA','IM':'LIGURIA','SP':'LIGURIA',
  'PC':'EMILIA ROMAGNA','PR':'EMILIA ROMAGNA','RE':'EMILIA ROMAGNA','MO':'EMILIA ROMAGNA','BO':'EMILIA ROMAGNA','FE':'EMILIA ROMAGNA','RA':'EMILIA ROMAGNA','FC':'EMILIA ROMAGNA','RN':'EMILIA ROMAGNA',
  'MS':'TOSCANA','LU':'TOSCANA','PT':'TOSCANA','FI':'TOSCANA','LI':'TOSCANA','PI':'TOSCANA','AR':'TOSCANA','SI':'TOSCANA','GR':'TOSCANA','PO':'TOSCANA',
  'PG':'UMBRIA','TR':'UMBRIA',
  'PU':'MARCHE','AN':'MARCHE','MC':'MARCHE','AP':'MARCHE','FM':'MARCHE',
  'VT':'LAZIO','RI':'LAZIO','RM':'LAZIO','LT':'LAZIO','FR':'LAZIO',
  'AQ':'ABRUZZO','TE':'ABRUZZO','PE':'ABRUZZO','CH':'ABRUZZO',
  'IS':'MOLISE','CB':'MOLISE',
  'CE':'CAMPANIA','BN':'CAMPANIA','NA':'CAMPANIA','AV':'CAMPANIA','SA':'CAMPANIA',
  'FG':'PUGLIA','BA':'PUGLIA','TA':'PUGLIA','BR':'PUGLIA','LE':'PUGLIA','BT':'PUGLIA',
  'PZ':'BASILICATA','MT':'BASILICATA',
  'CS':'CALABRIA','CZ':'CALABRIA','RC':'CALABRIA','KR':'CALABRIA','VV':'CALABRIA',
  'PA':'SICILIA','ME':'SICILIA','AG':'SICILIA','CL':'SICILIA','EN':'SICILIA','CT':'SICILIA','RG':'SICILIA','SR':'SICILIA','TP':'SICILIA',
  'SS':'SARDEGNA','NU':'SARDEGNA','CA':'SARDEGNA','OR':'SARDEGNA','OT':'SARDEGNA','OG':'SARDEGNA','VS':'SARDEGNA','CI':'SARDEGNA','SU':'SARDEGNA',
};

// Streaming parser per file CIG grandi
function parseCIGStream(filePath, nomeFile, onProgress) {
  return new Promise((resolve, reject) => {
    const CPV_PREFISSI = Object.keys(CPV_HORYGON).map(k => k.substring(0, 6));

    const stream = fs.createReadStream(filePath, { encoding: 'latin1' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let headers = null;
    let totale = 0;
    let horygon = 0;
    let valoreHorygon = 0;
    const agg = {}; // key: anno|mese|cpv|provincia
    const anniTrovati = new Set();

    const upsert = db.prepare(`
      INSERT OR REPLACE INTO cig_stats
      (anno, mese, cod_cpv, descrizione_cpv, n_gare, importo_totale, importo_medio, provincia, regione_istat, file_fonte)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `);

    rl.on('line', (line) => {
      if (!line.trim()) return;

      if (!headers) {
        // Prima riga = header. I file CIG possono arrivare TSV oppure CSV con ';'
        headers = parseTSVLine(line).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
        return;
      }

      totale++;
      const cols = parseTSVLine(line);
      const row = {};
      headers.forEach((h, i) => row[h] = (cols[i] || '').replace(/^"|"$/g, '').trim());

      const cpv = (row['cod_cpv'] || '').replace(/[^0-9]/g, '').substring(0, 8);
      if (!cpv || cpv.length < 6) return;

      const isHorygon = CPV_PREFISSI.some(p => cpv.startsWith(p));
      if (!isHorygon) return;

      const anno = parseInt(row['anno_pubblicazione'] || '0');
      const mese = parseInt(row['mese_pubblicazione'] || '0');
      if (!anno || !mese || mese < 1 || mese > 12) return;

      anniTrovati.add(anno);
      const desc = (row['descrizione_cpv'] || '').toUpperCase();
      const provincia = (row['provincia'] || '').toUpperCase().trim();
      const regione = PROVINCE_REGIONI[provincia] || '';
      const importoRaw = (row['importo_complessivo_gara'] || '0').replace(',', '.');
      const importo = parseFloat(importoRaw) || 0;
      const stato = (row['stato'] || '').toLowerCase();

      // Escludi cancellati
      if (stato.includes('cancellat')) return;

      horygon++;
      valoreHorygon += importo;

      const key = `${anno}|${mese}|${cpv}|${provincia}`;
      if (!agg[key]) agg[key] = { anno, mese, cpv, desc, provincia, regione, n: 0, tot: 0 };
      agg[key].n++;
      agg[key].tot += importo;

      // Flush ogni 10000
      if (horygon % 10000 === 0) {
        flushAgg(agg, upsert, nomeFile);
        if (onProgress) onProgress({ totale, horygon, valoreHorygon, anni: [...anniTrovati] });
      }
    });

    rl.on('close', () => {
      flushAgg(agg, upsert, nomeFile);
      try {
        db.prepare(`INSERT OR REPLACE INTO cig_import_log (file_nome, righe_totali, righe_horygon, valore_horygon, anni)
          VALUES (?,?,?,?,?)`).run(nomeFile, totale, horygon, valoreHorygon, [...anniTrovati].join(','));
      } catch {}
      console.log(`[CIG] ${nomeFile}: ${totale} righe, ${horygon} Horygon, €${valoreHorygon.toLocaleString('it')}`);
      resolve({ totale, horygon, valoreHorygon, anni: [...anniTrovati].sort() });
    });

    rl.on('error', reject);
  });
}

function flushAgg(agg, upsert, nomeFile) {
  for (const v of Object.values(agg)) {
    try {
      upsert.run(v.anno, v.mese, v.cpv, v.desc, v.n, v.tot, v.n > 0 ? v.tot / v.n : 0, v.provincia, v.regione, nomeFile);
    } catch {}
  }
  // Non svuotiamo agg — continuiamo ad accumulare per avere totali corretti
  // Ma resettiamo i contatori già salvati per evitare doppi
}

function parseTSVLine(line) {
  // Gestisce sia tab che punto e virgola
  const sep = line.includes('\t') ? '\t' : ';';
  return line.split(sep);
}

// ═══════════════════════════════════════════════
// ANALYTICS CIG — stagionalità mensile
// ═══════════════════════════════════════════════
function getCIGAnalytics() {
  const CPV_PREFISSI = Object.keys(CPV_HORYGON).map(c => `s.cod_cpv LIKE '${c.substring(0,6)}%'`).join(' OR ');
  const cpvFilter = `AND (${CPV_PREFISSI})`;

  // Anni disponibili
  const anni = db.prepare(`SELECT DISTINCT anno FROM cig_stats ${cpvFilter.replace('AND','')} ORDER BY anno`).all().map(r => r.anno);

  // Stagionalità mensile (media su tutti gli anni)
  const stagionalita = db.prepare(`
    SELECT mese,
      AVG(n_gare_mese) as media_gare,
      AVG(importo_mese) as media_importo
    FROM (
      SELECT anno, mese,
        SUM(n_gare) as n_gare_mese,
        SUM(importo_totale) as importo_mese
      FROM cig_stats WHERE 1=1 ${cpvFilter}
      GROUP BY anno, mese
    ) GROUP BY mese ORDER BY mese
  `).all();

  // Serie mensile completa per anno (per chart)
  const serieMensile = db.prepare(`
    SELECT anno, mese,
      SUM(n_gare) as n_gare,
      SUM(importo_totale) as importo_totale
    FROM cig_stats WHERE 1=1 ${cpvFilter}
    GROUP BY anno, mese ORDER BY anno, mese
  `).all();

  // Top CPV per mese (peak mensile)
  const topCpvMensile = db.prepare(`
    SELECT cod_cpv, descrizione_cpv, mese,
      SUM(n_gare) as n_gare,
      SUM(importo_totale) as importo_totale
    FROM cig_stats WHERE 1=1 ${cpvFilter}
    GROUP BY cod_cpv, mese ORDER BY importo_totale DESC LIMIT 100
  `).all();

  // Province top
  const topProvince = db.prepare(`
    SELECT provincia, regione_istat,
      SUM(n_gare) as n_gare,
      SUM(importo_totale) as importo_totale
    FROM cig_stats WHERE provincia != '' ${cpvFilter}
    GROUP BY provincia ORDER BY importo_totale DESC LIMIT 30
  `).all();

  // Mese di picco per CPV
  const picchiCpv = db.prepare(`
    SELECT cod_cpv, descrizione_cpv, mese,
      SUM(n_gare) as n_gare, SUM(importo_totale) as importo
    FROM cig_stats WHERE 1=1 ${cpvFilter}
    GROUP BY cod_cpv, mese
    ORDER BY cod_cpv, importo DESC
  `).all();

  // Calcola picco per ogni CPV
  const picchiMap = {};
  for (const r of picchiCpv) {
    if (!picchiMap[r.cod_cpv]) picchiMap[r.cod_cpv] = r;
  }

  return { anni, stagionalita, serieMensile, topCpvMensile, topProvince, picchiCpv: Object.values(picchiMap) };
}

// Auto-scan cartella data/cig/
function scanCIGFolder(onProgress) {
  const dataDir = path.join(process.cwd(), 'data', 'cig');
  if (!fs.existsSync(dataDir)) { fs.mkdirSync(dataDir, { recursive: true }); return Promise.resolve([]); }

  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.csv') || f.endsWith('.tsv'));
  const promises = [];

  for (const file of files) {
    const already = db.prepare('SELECT id FROM cig_import_log WHERE file_nome = ?').get(file);
    if (already) { console.log(`[CIG] ${file} già importato`); continue; }
    promises.push(
      parseCIGStream(path.join(dataDir, file), file, onProgress)
        .then(r => ({ file, status: 'importato', ...r }))
        .catch(e => ({ file, status: 'errore', errore: e.message }))
    );
  }

  return Promise.all(promises);
}

module.exports = { parseCIGStream, getCIGAnalytics, scanCIGFolder };
