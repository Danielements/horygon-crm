const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const db = require('../db/database');

// ═══════════════════════════════════════════════
// CPV MONITORATI PER HORYGON
// ═══════════════════════════════════════════════
const CPV_HORYGON = {
  // Pulizia
  '39800000': 'Prodotti pulizia e lucidatura',
  '39831000': 'Preparati per la pulizia',
  '39831200': 'Detergenti',
  '39831300': 'Detartrants',
  '39831700': 'Distributori automatici sapone',
  '33711900': 'Sapone',
  '33760000': 'Carta igienica fazzoletti asciugamani',
  '33761000': 'Carta igienica',
  '33763000': 'Asciugamani di carta',
  '33770000': 'Prodotti carta igienica',
  // Cancelleria
  '30192000': 'Materiale per ufficio',
  '30197000': 'Attrezzatura minuta uffici',
  '30197600': 'Carta e cartone trattati',
  '30197642': 'Carta per fotocopie',
  '30199000': 'Articoli di cancelleria',
  '30199230': 'Buste',
  '30193700': 'Scatole per archiviazione',
  '30191400': 'Tritacarta',
  '30192800': 'Etichette autoadesive',
  '30192150': 'Datari',
  '30192124': 'Pennarelli',
  '30192125': 'Evidenziatori',
  '30192130': 'Matite',
  '30197500': 'Ceralacca',
  '30197621': 'Carta lavagne a fogli',
  '30197641': 'Carta termografica',
  '22800000': 'Registri e raccoglitori',
  '30199240': 'Kit per spedizioni',
  // Elettrico
  '31440000': 'Batterie',
  '31410000': 'Pile elettriche',
  '31500000': 'Apparecchi di illuminazione',
  '31531000': 'Lampadine',
  '31532000': 'Lampade',
  '31224000': 'Adattatori e spine',
  '31224100': 'Spine e prese',
  '31224800': 'Kit di raccordo cavi',
  '31600000': 'Materiale elettrico',
};

// ═══════════════════════════════════════════════
// INIT TABELLE DB
// ═══════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS mepa_ordini (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anno INTEGER NOT NULL,
    tipologia_pa TEXT,
    regione_pa TEXT,
    provincia_pa TEXT,
    regione_fornitore TEXT,
    bando_mepa TEXT,
    categoria_abilitazione TEXT,
    codice_cpv TEXT,
    descrizione_cpv TEXT,
    n_ordini INTEGER DEFAULT 0,
    valore_economico REAL DEFAULT 0,
    n_pa INTEGER DEFAULT 0,
    n_fornitori INTEGER DEFAULT 0,
    UNIQUE(anno, codice_cpv, tipologia_pa, regione_pa, provincia_pa)
  );

  CREATE TABLE IF NOT EXISTS mepa_pa (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    id_amministrazione TEXT,
    id_ipa TEXT,
    tipologia TEXT,
    codice_fiscale TEXT,
    denominazione TEXT,
    regione TEXT,
    provincia TEXT,
    comune TEXT,
    lat REAL,
    lng REAL,
    po_attivi INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS mepa_import_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anno INTEGER,
    tipo TEXT,
    righe INTEGER,
    cpv_trovati INTEGER,
    data TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_mepa_cpv ON mepa_ordini(codice_cpv);
  CREATE INDEX IF NOT EXISTS idx_mepa_anno ON mepa_ordini(anno);
  CREATE INDEX IF NOT EXISTS idx_mepa_regione ON mepa_ordini(regione_pa);
`);

// ═══════════════════════════════════════════════
// CARICAMENTO AUTOMATICO CSV DA data/mepa/
// ═══════════════════════════════════════════════
function autoLoadMepaFiles() {
  const dataDir = path.join(__dirname, '../../data/mepa');
  if (!fs.existsSync(dataDir)) return;

  const files = fs.readdirSync(dataDir);

  // Carica file ordini per anno
  const ordiniFiles = files.filter(f => f.match(/ordini-mepa-(\d{4})\.csv/i));
  for (const file of ordiniFiles) {
    const match = file.match(/(\d{4})/);
    if (!match) continue;
    const anno = parseInt(match[1]);
    // Controlla se già importato
    const existing = db.prepare('SELECT id FROM mepa_import_log WHERE anno = ? AND tipo = ?').get(anno, 'ordini');
    if (existing) continue;
    console.log(`[MEPA] Carico ${file}...`);
    try {
      const csvData = fs.readFileSync(path.join(dataDir, file), 'latin1');
      const result = importOrdiniCSV(csvData, anno);
      db.prepare('INSERT INTO mepa_import_log (anno, tipo, righe, cpv_trovati) VALUES (?,?,?,?)').run(anno, 'ordini', result.righe, result.cpvTrovati);
      console.log(`[MEPA] ${anno}: ${result.righe} righe, ${result.cpvTrovati} CPV`);
    } catch (e) {
      console.error(`[MEPA] Errore ${file}:`, e.message);
    }
  }

  // Carica PA
  const paFile = files.find(f => f.includes('amministrazioni'));
  if (paFile) {
    const existingPA = db.prepare('SELECT COUNT(*) as n FROM mepa_pa').get();
    if (existingPA.n === 0) {
      console.log(`[MEPA] Carico anagrafica PA...`);
      try {
        const csvData = fs.readFileSync(path.join(dataDir, paFile), 'latin1');
        const n = importPaCSV(csvData);
        console.log(`[MEPA] PA importate: ${n}`);
      } catch (e) {
        console.error('[MEPA] Errore PA:', e.message);
      }
    }
  }
}

// ═══════════════════════════════════════════════
// IMPORT ORDINI MEPA CSV
// ═══════════════════════════════════════════════
function importOrdiniCSV(csvData, anno) {
  // Rimuovi # iniziale dall'header
  csvData = csvData.replace(/^#/, '');
  let records;
  try {
    records = parse(csvData, {
      columns: true, skip_empty_lines: true,
      delimiter: ',', relax_quotes: true, trim: true,
      encoding: 'latin1'
    });
  } catch (e) {
    throw new Error(`Parsing CSV fallito: ${e.message}`);
  }

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO mepa_ordini
    (anno, tipologia_pa, regione_pa, provincia_pa, regione_fornitore, bando_mepa,
     categoria_abilitazione, codice_cpv, descrizione_cpv, n_ordini, valore_economico, n_pa, n_fornitori)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  let righe = 0;
  let cpvSet = new Set();

  for (const r of records) {
    righe++;
    const cpv_raw = (r['codice_CPV'] || r['Codice_CPV'] || '').trim().replace(/"/g, '');
    const cpv = cpv_raw.replace(/[^0-9]/g, '').substring(0, 8);
    const desc_cpv = (r['descrizione_CPV'] || r['Descrizione_CPV'] || '').trim().replace(/"/g, '');
    const valore_raw = (r['Valore_economico_Ordini'] || '').trim().replace(/"/g, '').replace(',', '.');
    const n_ord_raw = (r['N_Ordini'] || '').trim().replace(/"/g, '').replace(',', '.');
    const n_pa_raw = (r['N_PA'] || '').trim().replace(/"/g, '').replace(',', '.');
    const n_forn_raw = (r['N_fornitori'] || '').trim().replace(/"/g, '').replace(',', '.');

    const valore = parseFloat(valore_raw) || 0;
    const n_ord = parseInt(parseFloat(n_ord_raw)) || 1;
    const n_pa = parseInt(parseFloat(n_pa_raw)) || 0;
    const n_forn = parseInt(parseFloat(n_forn_raw)) || 0;

    if (!cpv || cpv.length < 6) continue;
    cpvSet.add(cpv);

    try {
      upsert.run(
        parseInt(r['Anno_Riferimento']) || anno,
        (r['Tipologia_Amministrazione'] || '').trim().replace(/"/g, ''),
        (r['Regione_PA'] || '').trim().replace(/"/g, ''),
        (r['Provincia_PA'] || '').trim().replace(/"/g, ''),
        (r['Regione_Fornitore'] || '').trim().replace(/"/g, ''),
        (r['Bando_Mepa'] || '').trim().replace(/"/g, ''),
        (r['Categoria_Abilitazione'] || '').trim().replace(/"/g, ''),
        cpv, desc_cpv, n_ord, valore, n_pa, n_forn
      );
    } catch {}
  }

  return { righe, cpvTrovati: cpvSet.size };
}

// ═══════════════════════════════════════════════
// IMPORT PA CSV
// ═══════════════════════════════════════════════
function importPaCSV(csvData) {
  csvData = csvData.replace(/^#/, '');
  let records;
  try {
    records = parse(csvData, { columns: true, skip_empty_lines: true, delimiter: ',', relax_quotes: true, trim: true });
  } catch { return 0; }

  const ins = db.prepare(`
    INSERT OR IGNORE INTO mepa_pa (id_amministrazione, id_ipa, tipologia, codice_fiscale, denominazione, regione, provincia, comune, lat, lng, po_attivi)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `);

  let n = 0;
  for (const r of records) {
    try {
      ins.run(
        r['Identificativo_Amministrazione'] || '', r['Identificativo_IPA_amministrazione'] || '',
        r['Tipologia_Amministrazione'] || '', r['Codice_Fiscale'] || '',
        r['Denominazione'] || '', r['Regione'] || '', r['Provincia'] || '',
        r['Comune'] || '', parseFloat(r['Latitudine']) || null, parseFloat(r['Longitudine']) || null,
        parseInt(r['Numero_PO_attivi']) || 0
      );
      n++;
    } catch {}
  }
  return n;
}

// ═══════════════════════════════════════════════
// ANALYTICS MEPA
// ═══════════════════════════════════════════════
function getMepaAnalytics() {
  // Trend per anno per CPV Horygon
  const cpvFilter = Object.keys(CPV_HORYGON).map(c => `codice_cpv LIKE '${c.substring(0,6)}%'`).join(' OR ');

  const trendAnni = db.prepare(`
    SELECT anno, codice_cpv, descrizione_cpv,
      SUM(n_ordini) as n_ordini,
      SUM(valore_economico) as valore_totale,
      COUNT(DISTINCT regione_pa) as n_regioni
    FROM mepa_ordini
    WHERE (${cpvFilter})
    GROUP BY anno, codice_cpv
    ORDER BY anno, valore_totale DESC
  `).all();

  // Top CPV per valore totale 3 anni
  const topCpv = db.prepare(`
    SELECT codice_cpv, descrizione_cpv,
      SUM(valore_economico) as valore_totale,
      SUM(n_ordini) as n_ordini_totale,
      COUNT(DISTINCT anno) as anni_presenti,
      SUM(CASE WHEN anno=2025 THEN valore_economico ELSE 0 END) as v2025,
      SUM(CASE WHEN anno=2024 THEN valore_economico ELSE 0 END) as v2024,
      SUM(CASE WHEN anno=2023 THEN valore_economico ELSE 0 END) as v2023
    FROM mepa_ordini
    WHERE (${cpvFilter})
    GROUP BY codice_cpv
    ORDER BY valore_totale DESC
    LIMIT 30
  `).all();

  // Aggiungi CPV desc da CPV_HORYGON se mancante
  topCpv.forEach(c => {
    if (!c.descrizione_cpv || c.descrizione_cpv === 'ND') {
      const match = Object.keys(CPV_HORYGON).find(k => c.codice_cpv.startsWith(k.substring(0,6)));
      if (match) c.descrizione_cpv = CPV_HORYGON[match];
    }
    // Calcola trend YoY
    c.yoy_2024 = c.v2023 > 0 ? ((c.v2024 - c.v2023) / c.v2023 * 100).toFixed(1) : null;
    c.yoy_2025 = c.v2024 > 0 ? ((c.v2025 - c.v2024) / c.v2024 * 100).toFixed(1) : null;
    c.trend = c.v2025 > c.v2024 && c.v2024 > c.v2023 ? 'crescita_forte' :
              c.v2025 > c.v2023 ? 'crescita' :
              c.v2025 < c.v2024 && c.v2024 < c.v2023 ? 'calo_forte' :
              c.v2025 < c.v2023 ? 'calo' : 'stabile';
  });

  // Top regioni 3 anni
  const topRegioni = db.prepare(`
    SELECT regione_pa,
      SUM(valore_economico) as valore_totale,
      SUM(n_ordini) as n_ordini_totale,
      SUM(CASE WHEN anno=2025 THEN valore_economico ELSE 0 END) as v2025,
      SUM(CASE WHEN anno=2024 THEN valore_economico ELSE 0 END) as v2024,
      SUM(CASE WHEN anno=2023 THEN valore_economico ELSE 0 END) as v2023
    FROM mepa_ordini
    WHERE (${cpvFilter}) AND regione_pa != '' AND regione_pa IS NOT NULL
    GROUP BY regione_pa ORDER BY valore_totale DESC LIMIT 20
  `).all();

  // Top tipologie PA
  const topTipologie = db.prepare(`
    SELECT tipologia_pa,
      SUM(valore_economico) as valore_totale,
      SUM(n_ordini) as n_ordini_totale
    FROM mepa_ordini
    WHERE (${cpvFilter}) AND tipologia_pa != '' AND tipologia_pa IS NOT NULL
    GROUP BY tipologia_pa ORDER BY valore_totale DESC LIMIT 15
  `).all();

  // Top categorie MEPA
  const topCategorie = db.prepare(`
    SELECT categoria_abilitazione,
      SUM(valore_economico) as valore_totale,
      SUM(n_ordini) as n_ordini_totale
    FROM mepa_ordini
    WHERE (${cpvFilter}) AND categoria_abilitazione != '' AND categoria_abilitazione != 'NA'
    GROUP BY categoria_abilitazione ORDER BY valore_totale DESC LIMIT 20
  `).all();

  // Serie temporale per predizione
  const serieTemporali = db.prepare(`
    SELECT anno,
      SUM(n_ordini) as n_ordini,
      SUM(valore_economico) as valore_totale
    FROM mepa_ordini WHERE (${cpvFilter})
    GROUP BY anno ORDER BY anno ASC
  `).all();

  // KPI globali
  const kpi = db.prepare(`
    SELECT
      SUM(valore_economico) as mercato_totale_3anni,
      SUM(CASE WHEN anno=2025 THEN valore_economico ELSE 0 END) as mercato_2025,
      SUM(CASE WHEN anno=2024 THEN valore_economico ELSE 0 END) as mercato_2024,
      SUM(CASE WHEN anno=2023 THEN valore_economico ELSE 0 END) as mercato_2023,
      COUNT(DISTINCT codice_cpv) as cpv_attivi,
      COUNT(DISTINCT regione_pa) as regioni_attive
    FROM mepa_ordini WHERE (${cpvFilter})
  `).get();

  return {
    trendAnni, topCpv, topRegioni, topTipologie, topCategorie,
    serieTemporali, kpi, cpvHorygon: CPV_HORYGON,
    anniDisponibili: [2023, 2024, 2025]
  };
}

// ═══════════════════════════════════════════════
// RACCOMANDAZIONI ACQUISTO/VENDITA
// ═══════════════════════════════════════════════
function getRaccomandazioni(topCpv) {
  const raccomandazioni = [];

  for (const c of topCpv) {
    const score = calcScore(c);
    if (score.azione !== 'neutro') {
      raccomandazioni.push({
        cpv: c.codice_cpv,
        desc: c.descrizione_cpv,
        azione: score.azione,
        priorita: score.priorita,
        motivo: score.motivo,
        v2023: c.v2023, v2024: c.v2024, v2025: c.v2025,
        yoy_2024: c.yoy_2024, yoy_2025: c.yoy_2025,
        trend: c.trend,
      });
    }
  }

  return raccomandazioni.sort((a, b) => b.priorita - a.priorita);
}

function calcScore(c) {
  const yoy24 = parseFloat(c.yoy_2024) || 0;
  const yoy25 = parseFloat(c.yoy_2025) || 0;
  const v25 = c.v2025 || 0;

  // COMPRA: crescita continua + mercato grande
  if (yoy24 > 20 && yoy25 > 10 && v25 > 500000) {
    return { azione: 'compra', priorita: 3, motivo: `Crescita costante +${yoy24}% → +${yoy25}% YoY, mercato €${fmtM(v25)}` };
  }
  if (yoy24 > 30 && v25 > 200000) {
    return { azione: 'compra', priorita: 2, motivo: `Forte crescita +${yoy24}% nel 2024, mercato €${fmtM(v25)}` };
  }
  if (yoy25 > 30 && v25 > 100000) {
    return { azione: 'compra', priorita: 2, motivo: `Accelerazione nel 2025 +${yoy25}%, opportunità immediata` };
  }
  if (v25 > 1000000 && Math.abs(yoy25) < 10) {
    return { azione: 'mantieni', priorita: 2, motivo: `Mercato grande €${fmtM(v25)}, stabile (${yoy25}% YoY)` };
  }

  // RIDUCI: calo continuo
  if (yoy24 < -15 && yoy25 < -10) {
    return { azione: 'riduci', priorita: 3, motivo: `Calo continuo ${yoy24}% → ${yoy25}% YoY` };
  }
  if (yoy25 < -25) {
    return { azione: 'riduci', priorita: 2, motivo: `Calo forte -${Math.abs(yoy25)}% nel 2025` };
  }

  return { azione: 'neutro', priorita: 0, motivo: '' };
}

function fmtM(v) {
  if (v >= 1000000) return (v/1000000).toFixed(1) + 'M';
  if (v >= 1000) return (v/1000).toFixed(0) + 'K';
  return v.toFixed(0);
}

// ═══════════════════════════════════════════════
// PREDIZIONE LINEARE
// ═══════════════════════════════════════════════
function getPredictions(serieTemporali) {
  if (!serieTemporali || serieTemporali.length < 2) return null;
  const anni = serieTemporali.map(s => s.anno);
  const valori = serieTemporali.map(s => s.valore_totale || 0);
  const ordini = serieTemporali.map(s => s.n_ordini || 0);
  const rv = linReg(valori);
  const ro = linReg(ordini);
  if (!rv) return null;

  const predictions = [];
  const lastAnno = anni[anni.length - 1];
  for (let i = 1; i <= 3; i++) {
    const idx = valori.length - 1 + i;
    predictions.push({
      anno: lastAnno + i,
      valore_pred: Math.max(0, rv.slope * idx + rv.intercept),
      ordini_pred: Math.max(0, Math.round((ro?.slope || 0) * idx + (ro?.intercept || 0))),
    });
  }

  const crescita_3y = valori.length >= 2
    ? ((valori[valori.length-1] - valori[0]) / (valori[0] || 1) * 100).toFixed(1)
    : null;

  return {
    predictions, r2: rv.r2,
    trend: rv.slope > 0 ? 'crescita' : 'calo',
    crescita_3y,
    cagr: valori.length >= 2 && valori[0] > 0
      ? (Math.pow(valori[valori.length-1]/valori[0], 1/(valori.length-1)) - 1) * 100
      : null,
  };
}

function linReg(data) {
  const n = data.length;
  if (n < 2) return null;
  const sumX = (n*(n-1))/2, sumY = data.reduce((a,b)=>a+b,0);
  const sumXY = data.reduce((s,y,i)=>s+i*y,0);
  const sumX2 = (n*(n-1)*(2*n-1))/6;
  const denom = n*sumX2 - sumX*sumX;
  if (denom === 0) return null;
  const slope = (n*sumXY - sumX*sumY)/denom;
  const intercept = (sumY - slope*sumX)/n;
  const mean = sumY/n;
  const ssTot = data.reduce((s,y)=>s+Math.pow(y-mean,2),0);
  const ssRes = data.reduce((s,y,i)=>s+Math.pow(y-(slope*i+intercept),2),0);
  return { slope, intercept, r2: ssTot===0 ? 1 : Math.max(0, 1-ssRes/ssTot) };
}

module.exports = { autoLoadMepaFiles, getMepaAnalytics, getRaccomandazioni, getPredictions, CPV_HORYGON, importOrdiniCSV };
