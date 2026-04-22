const https = require('https');
const { parse } = require('csv-parse/sync');
const db = require('../db/database');

// CPV rilevanti per Horygon
const CPV_HORYGON = {
  '39800000': 'Prodotti pulizia e lucidatura',
  '39830000': 'Prodotti per la pulizia',
  '39831000': 'Preparati per la pulizia',
  '39831200': 'Detersivi',
  '39831300': 'Detartrants',
  '39832000': 'Prodotti per lavastoviglie',
  '33711900': 'Sapone',
  '33760000': 'Carta igienica',
  '33770000': 'Prodotti di carta igienica',
  '30192000': 'Articoli di cancelleria',
  '30197000': 'Articoli cancelleria vari',
  '30199000': 'Articoli di cartoleria',
  '22800000': 'Registri e raccoglitori',
  '30125000': 'Toner e cartucce',
  '31500000': 'Apparecchi di illuminazione',
  '31531000': 'Lampadine',
  '31532000': 'Lampade',
  '31440000': 'Batterie',
  '31410000': 'Pile elettriche',
  '31600000': 'Materiale elettrico',
  '31611000': 'Quadri elettrici',
  '31224000': 'Adattatori e spine',
  '39700000': 'Elettrodomestici',
  '39500000': 'Prodotti tessili',
  '33190000': 'Dispositivi medici vari',
};

// Inizializza tabelle
db.exec(`
  CREATE TABLE IF NOT EXISTS cpv_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anno INTEGER NOT NULL,
    mese INTEGER NOT NULL,
    cpv TEXT NOT NULL,
    cpv_desc TEXT,
    num_gare INTEGER DEFAULT 0,
    importo_totale REAL DEFAULT 0,
    importo_medio REAL DEFAULT 0,
    regione TEXT DEFAULT 'ITALIA',
    aggiornato_il TEXT DEFAULT (datetime('now')),
    UNIQUE(anno, mese, cpv, regione)
  );

  CREATE TABLE IF NOT EXISTS gare_dettaglio (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anno INTEGER,
    mese INTEGER,
    cpv TEXT,
    cpv_desc TEXT,
    titolo_gara TEXT,
    descrizione_articolo TEXT,
    quantita REAL,
    unita_misura TEXT,
    importo REAL,
    pa_nome TEXT,
    pa_comune TEXT,
    regione TEXT,
    num_concorrenti INTEGER,
    data_pubblicazione TEXT,
    ocid TEXT UNIQUE,
    creato_il TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS anac_sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anno INTEGER,
    mese INTEGER,
    righe_processate INTEGER DEFAULT 0,
    cpv_trovati INTEGER DEFAULT 0,
    salvati INTEGER DEFAULT 0,
    stato TEXT,
    errore TEXT,
    data TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_gare_cpv ON gare_dettaglio(cpv);
  CREATE INDEX IF NOT EXISTS idx_gare_regione ON gare_dettaglio(regione);
  CREATE INDEX IF NOT EXISTS idx_gare_pa ON gare_dettaglio(pa_nome);
  CREATE INDEX IF NOT EXISTS idx_cpv_stats_anno ON cpv_stats(anno, mese);
`);

// ═══════════════════════════════════════════════
// STREAMING JSON OCDS
// ═══════════════════════════════════════════════
function streamAnacOCDS(anno, mese, onProgress) {
  return new Promise((resolve, reject) => {
    const meseStr = String(mese).padStart(2, '0');
    const url = `https://dati.anticorruzione.it/opendata/download/dataset/ocds/filesystem/bulk/${anno}/${meseStr}.json`;
    console.log(`[ANAC] Streaming: ${url}`);

    const req = https.get(url, {
      headers: { 'User-Agent': 'HorygonCRM/1.0', 'Accept': 'application/json' }
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return streamAnacOCDS(anno, mese, onProgress).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      let buffer = '';
      let righeProcessate = 0;
      let bytesRicevuti = 0;
      const agg = {};

      // Prepara statement per inserimento dettagli
      const insertGara = db.prepare(`
        INSERT OR IGNORE INTO gare_dettaglio
        (anno,mese,cpv,cpv_desc,titolo_gara,descrizione_articolo,quantita,unita_misura,importo,pa_nome,pa_comune,regione,num_concorrenti,data_pubblicazione,ocid)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);

      res.on('data', (chunk) => {
        bytesRicevuti += chunk.length;
        buffer += chunk.toString();

        let depth = 0;
        let inObject = false;
        let objStart = -1;
        let start = 0;

        for (let i = 0; i < buffer.length; i++) {
          const c = buffer[i];
          if (c === '{') {
            if (depth === 1 && !inObject) { objStart = i; inObject = true; }
            depth++;
          } else if (c === '}') {
            depth--;
            if (depth === 1 && inObject) {
              const objStr = buffer.substring(objStart, i + 1);
              const extracted = extractFromRelease(objStr, anno, mese);
              if (extracted) {
                // Aggiorna aggregati
                for (const e of extracted) {
                  const key = `${e.cpv}|${e.regione}`;
                  if (!agg[key]) agg[key] = { cpv: e.cpv, cpv_desc: e.cpv_desc, regione: e.regione, num: 0, tot: 0 };
                  agg[key].num++;
                  agg[key].tot += e.importo || 0;
                  // Salva dettaglio gara
                  try {
                    insertGara.run(anno, mese, e.cpv, e.cpv_desc, e.titolo, e.descrizione_articolo,
                      e.quantita, e.unita_misura, e.importo, e.pa_nome, e.pa_comune,
                      e.regione, e.num_concorrenti, e.data_pubblicazione, e.ocid);
                  } catch {}
                }
              }
              righeProcessate++;
              inObject = false;
              start = i + 1;

              // Flush ogni 500 release
              if (righeProcessate % 500 === 0) {
                salvaAggregati(agg, anno, mese);
                if (onProgress) onProgress({
                  bytesRicevuti,
                  righeProcessate,
                  cpvTrovati: Object.keys(agg).length
                });
              }
            }
          }
        }

        if (start > 0) buffer = buffer.substring(start);
        if (buffer.length > 5 * 1024 * 1024) buffer = buffer.substring(buffer.length - 1024 * 1024);
      });

      res.on('end', () => {
        const salvati = salvaAggregati(agg, anno, mese);
        try {
          db.prepare('INSERT OR REPLACE INTO anac_sync_log (anno,mese,righe_processate,cpv_trovati,salvati,stato) VALUES (?,?,?,?,?,?)')
            .run(anno, mese, righeProcessate, Object.keys(agg).length, salvati, 'ok');
        } catch {
          db.prepare('INSERT INTO anac_sync_log (anno,mese,righe_processate,cpv_trovati,salvati,stato) VALUES (?,?,?,?,?,?)')
            .run(anno, mese, righeProcessate, Object.keys(agg).length, salvati, 'ok');
        }
        console.log(`[ANAC] Completato: ${righeProcessate} release, ${salvati} CPV salvati`);
        resolve({ righeProcessate, cpvTrovati: Object.keys(agg).length, salvati, bytesRicevuti });
      });

      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(600000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Estrae dati rilevanti da una release OCDS
function extractFromRelease(objStr, anno, mese) {
  try {
    const release = JSON.parse(objStr);
    const tender = release.tender || {};
    const buyer = release.buyer || {};
    const items = tender.items || [];

    const importo = parseFloat((tender.value || tender.estimatedValue || {}).amount || 0);
    const pa_nome = buyer.name || null;
    const pa_comune = (buyer.address || {}).locality || null;
    const regione = (buyer.address || {}).region || 'ITALIA';
    const num_concorrenti = tender.numberOfTenderers || null;
    const data_pub = (release.date || '').substring(0, 10) || null;
    const ocid = release.ocid || null;
    const titolo = tender.title || null;

    const results = [];

    if (items.length > 0) {
      for (const item of items) {
        const cls = item.classification || {};
        const cpvRaw = String(cls.id || '').replace(/[^0-9]/g, '').substring(0, 8);
        if (!cpvRaw || cpvRaw.length < 7) continue;

        const isHorygon = Object.keys(CPV_HORYGON).some(k => cpvRaw.startsWith(k.substring(0, 6)));
        if (!isHorygon) continue;

        const cpv_desc = CPV_HORYGON[cpvRaw] || cls.description || null;
        const quantita = parseFloat(item.quantity || 0) || null;
        const unita = (item.unit || {}).name || null;
        const desc_art = item.description || null;

        results.push({
          cpv: cpvRaw, cpv_desc, titolo, descrizione_articolo: desc_art,
          quantita, unita_misura: unita, importo, pa_nome, pa_comune,
          regione, num_concorrenti, data_pubblicazione: data_pub,
          ocid: ocid ? `${ocid}_${item.id || results.length}` : null,
        });
      }
    } else {
      // Nessun item — usa CPV del tender se disponibile
      const cpvRaw = String((tender.mainProcurementCategory || '')).replace(/[^0-9]/g, '');
      // Prova anche additionalClassifications
      const addCls = (tender.additionalClassifications || []);
      for (const cls of addCls) {
        const cv = String(cls.id || '').replace(/[^0-9]/g, '').substring(0, 8);
        if (!cv || cv.length < 7) continue;
        const isHorygon = Object.keys(CPV_HORYGON).some(k => cv.startsWith(k.substring(0, 6)));
        if (!isHorygon) continue;
        results.push({
          cpv: cv, cpv_desc: CPV_HORYGON[cv] || cls.description || null,
          titolo, descrizione_articolo: tender.description || null,
          quantita: null, unita_misura: null, importo, pa_nome, pa_comune,
          regione, num_concorrenti, data_pubblicazione: data_pub, ocid,
        });
      }
    }

    return results.length > 0 ? results : null;
  } catch { return null; }
}

// Salva aggregati nel DB
function salvaAggregati(agg, anno, mese) {
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO cpv_stats (anno,mese,cpv,cpv_desc,num_gare,importo_totale,importo_medio,regione)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  let salvati = 0;
  for (const v of Object.values(agg)) {
    try {
      upsert.run(anno, mese, v.cpv, v.cpv_desc, v.num, v.tot, v.num > 0 ? v.tot / v.num : 0, v.regione);
      salvati++;
    } catch {}
  }
  return salvati;
}

// ═══════════════════════════════════════════════
// IMPORT CSV
// ═══════════════════════════════════════════════
function processCSV(csvData, anno, mese) {
  let records;
  for (const delimiter of [';', ',', '\t']) {
    try {
      records = parse(csvData, { columns: true, skip_empty_lines: true, delimiter, relax_quotes: true, trim: true });
      if (records.length > 0) break;
    } catch {}
  }
  if (!records || !records.length) throw new Error('CSV non parsabile');

  const agg = {};
  let righe = 0;

  for (const r of records) {
    righe++;
    const cpvRaw = (r.CPV || r.CODICE_CPV || r.cod_cpv || r.cpv || '').replace(/[^0-9]/g, '').substring(0, 8);
    if (!cpvRaw || cpvRaw.length < 7) continue;
    const importo = parseFloat(String(r.IMPORTO_COMPLESSIVO_GARA || r.importo || '0').replace(',', '.')) || 0;
    const regione = r.REGIONE || r.regione || 'ITALIA';
    const key = `${cpvRaw}|${regione}`;
    if (!agg[key]) agg[key] = { cpv: cpvRaw, cpv_desc: CPV_HORYGON[cpvRaw] || null, regione, num: 0, tot: 0 };
    agg[key].num++;
    agg[key].tot += importo;
  }

  const salvati = salvaAggregati(agg, anno, mese);
  try {
    db.prepare('INSERT OR REPLACE INTO anac_sync_log (anno,mese,righe_processate,cpv_trovati,salvati,stato) VALUES (?,?,?,?,?,?)')
      .run(anno, mese, righe, Object.keys(agg).length, salvati, 'ok');
  } catch {
    db.prepare('INSERT INTO anac_sync_log (anno,mese,righe_processate,cpv_trovati,salvati,stato) VALUES (?,?,?,?,?,?)')
      .run(anno, mese, righe, Object.keys(agg).length, salvati, 'ok');
  }
  return { righe, cpvTrovati: Object.keys(agg).length, salvati };
}

// ═══════════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════════
function getAnalytics(cpvList) {
  const cpvFilter = cpvList?.length
    ? `AND (${cpvList.map(c => `s.cpv LIKE '${c.substring(0, 6)}%'`).join(' OR ')})`
    : `AND (${Object.keys(CPV_HORYGON).map(c => `s.cpv LIKE '${c.substring(0, 6)}%'`).join(' OR ')})`;

  const topCpv = db.prepare(`
    SELECT cpv, cpv_desc,
      SUM(num_gare) as num_gare,
      SUM(importo_totale) as importo_totale,
      COUNT(DISTINCT anno||mese) as mesi_presenti
    FROM cpv_stats s WHERE 1=1 ${cpvFilter}
    GROUP BY cpv ORDER BY importo_totale DESC LIMIT 20
  `).all();

  const topRegioni = db.prepare(`
    SELECT regione, SUM(num_gare) as num_gare, SUM(importo_totale) as importo_totale
    FROM cpv_stats s WHERE regione != 'ITALIA' ${cpvFilter}
    GROUP BY regione ORDER BY importo_totale DESC LIMIT 15
  `).all();

  const serieTemporali = db.prepare(`
    SELECT anno, mese, SUM(num_gare) as num_gare, SUM(importo_totale) as importo_totale
    FROM cpv_stats s WHERE 1=1 ${cpvFilter}
    GROUP BY anno, mese ORDER BY anno ASC, mese ASC
  `).all();

  // Top gare dettaglio
  const topGare = db.prepare(`
    SELECT cpv, cpv_desc, titolo_gara, descrizione_articolo,
      quantita, unita_misura, importo, pa_nome, pa_comune, regione, num_concorrenti
    FROM gare_dettaglio
    WHERE cpv IS NOT NULL
    ORDER BY importo DESC LIMIT 50
  `).all();

  // Top PA per volume acquisti
  const topPA = db.prepare(`
    SELECT pa_nome, pa_comune, regione,
      COUNT(*) as num_gare,
      SUM(importo) as importo_totale
    FROM gare_dettaglio
    WHERE pa_nome IS NOT NULL
    GROUP BY pa_nome ORDER BY importo_totale DESC LIMIT 20
  `).all();

  // Articoli più acquistati
  const topArticoli = db.prepare(`
    SELECT descrizione_articolo, cpv, cpv_desc,
      COUNT(*) as frequenza,
      AVG(quantita) as quantita_media,
      AVG(importo) as importo_medio
    FROM gare_dettaglio
    WHERE descrizione_articolo IS NOT NULL
    GROUP BY descrizione_articolo
    ORDER BY frequenza DESC LIMIT 30
  `).all();

  return { topCpv, topRegioni, serieTemporali, topGare, topPA, topArticoli, cpvHorygon: CPV_HORYGON };
}

// ═══════════════════════════════════════════════
// PREDIZIONE
// ═══════════════════════════════════════════════
function getPredictions(serieTemporali, mesiAvanti = 6) {
  if (!serieTemporali || serieTemporali.length < 4) return null;
  const gare = serieTemporali.map(s => s.num_gare || 0);
  const importi = serieTemporali.map(s => s.importo_totale || 0);
  const rg = linReg(gare);
  const ri = linReg(importi);
  if (!rg || !ri) return null;

  const predictions = [];
  const last = serieTemporali[serieTemporali.length - 1];
  let anno = last.anno, mese = last.mese;

  for (let i = 1; i <= mesiAvanti; i++) {
    mese++;
    if (mese > 12) { mese = 1; anno++; }
    const idx = serieTemporali.length - 1 + i;
    predictions.push({
      anno, mese,
      num_gare_pred: Math.max(0, Math.round(rg.slope * idx + rg.intercept)),
      importo_pred: Math.max(0, ri.slope * idx + ri.intercept),
    });
  }

  const crescita_pct = gare.length >= 13
    ? ((gare[gare.length - 1] - gare[gare.length - 13]) / (gare[gare.length - 13] || 1) * 100).toFixed(1)
    : null;

  return {
    predictions, r2_gare: rg.r2, r2_importi: ri.r2,
    trend_gare: rg.slope > 0 ? 'crescita' : 'calo',
    trend_importi: ri.slope > 0 ? 'crescita' : 'calo',
    crescita_pct_gare: crescita_pct,
  };
}

function linReg(data) {
  const n = data.length;
  if (n < 3) return null;
  const sumX = (n * (n - 1)) / 2;
  const sumY = data.reduce((a, b) => a + b, 0);
  const sumXY = data.reduce((s, y, i) => s + i * y, 0);
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const mean = sumY / n;
  const ssTot = data.reduce((s, y) => s + Math.pow(y - mean, 2), 0);
  const ssRes = data.reduce((s, y, i) => s + Math.pow(y - (slope * i + intercept), 2), 0);
  return { slope, intercept, r2: ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot) };
}

module.exports = { streamAnacOCDS, processCSV, getAnalytics, getPredictions, CPV_HORYGON };
