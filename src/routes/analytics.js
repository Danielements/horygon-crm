const fs = require('fs');
const path = require('path');
const express = require('express');
const { parse } = require('csv-parse');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const db = require('../db/database');
const { CPV_HORYGON } = require('../services/mepa-parser');

router.use(authMiddleware);

// CPV Horygon prefissi (inline per evitare dipendenze circolari)
const CPV_PREFISSI_MEPA = [
  '398','3983','3376','3377','3019','3117','3144','3141','3160','3122',
  '3050','2280','3191','3170','3153','3154','3180','3120'
];

const CONSIP_CKAN_API_BASE = process.env.CONSIP_CKAN_API_BASE || 'https://dati.consip.it/api/3/action';
const LOCAL_MEPA_API_FILE = path.join(process.cwd(), 'data', 'mepa', 'beni-servizi-rdo-td-bandite-mepa-2026.csv');
let localMepaApiSummaryCache = {
  mtimeMs: 0,
  summary: null,
  pending: null
};

function cpvFilterMepa() {
  return '(' + CPV_PREFISSI_MEPA.map(p => `codice_cpv LIKE '${p}%'`).join(' OR ') + ')';
}
function cpvFilterCig() {
  return '(' + CPV_PREFISSI_MEPA.map(p => `cod_cpv LIKE '${p}%'`).join(' OR ') + ')';
}

function cpvPrefixExpr(column) {
  return `substr(${column}, 1, 6)`;
}

function getCpvMeta(cpv, fallbackDesc) {
  if (!cpv) return { target_desc: fallbackDesc || null, categoria: null, priorita: null };
  const exact = CPV_HORYGON[cpv];
  if (exact) {
    return {
      target_desc: exact.desc || fallbackDesc || cpv,
      categoria: exact.categoria || null,
      priorita: exact.priorita || null,
    };
  }
  const prefix = Object.entries(CPV_HORYGON).find(([key]) => cpv.startsWith(key.substring(0, 6)));
  if (prefix) {
    const meta = prefix[1] || {};
    return {
      target_desc: meta.desc || fallbackDesc || cpv,
      categoria: meta.categoria || null,
      priorita: meta.priorita || null,
    };
  }
  return { target_desc: fallbackDesc || cpv, categoria: null, priorita: null };
}

function getRecordField(record, matchers = []) {
  if (!record || typeof record !== 'object') return null;
  const entries = Object.entries(record);
  for (const matcher of matchers) {
    const found = entries.find(([key]) => matcher.test(String(key || '')));
    if (found && found[1] !== undefined && found[1] !== null && String(found[1]).trim() !== '') {
      return found[1];
    }
  }
  return null;
}

function normalizeCpvValue(value) {
  const str = String(value || '').replace(/\D/g, '');
  return str.length >= 6 ? str.slice(0, 6) : null;
}

function toNumberLike(value) {
  if (value === null || value === undefined || value === '') return 0;
  const normalized = String(value)
    .replace(/\./g, '')
    .replace(/,/g, '.')
    .replace(/[^\d.-]/g, '');
  const parsed = parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildConsipInsights(records = []) {
  const cpvMap = new Map();

  records.forEach((record) => {
    const cpv = normalizeCpvValue(getRecordField(record, [/cpv/i, /codice.*cpv/i]));
    if (!cpv) return;
    const descrizione = getRecordField(record, [/descr/i, /oggetto/i, /titolo/i, /nome/i, /categoria/i]) || cpv;
    const ente = getRecordField(record, [/ente/i, /amministrazione/i, /stazione/i]);
    const valore = toNumberLike(getRecordField(record, [/importo/i, /valore/i, /totale/i, /base_asta/i]));
    const current = cpvMap.get(cpv) || { cpv, descrizione, occorrenze: 0, valoreTotale: 0, enti: new Set() };
    current.occorrenze += 1;
    current.valoreTotale += valore;
    if (ente) current.enti.add(String(ente));
    if (!current.descrizione && descrizione) current.descrizione = descrizione;
    cpvMap.set(cpv, current);
  });

  const cpvTop = [...cpvMap.values()]
    .map((row) => {
      const meta = getCpvMeta(row.cpv, row.descrizione);
      return {
        cpv: row.cpv,
        descrizione: meta.target_desc || row.descrizione || row.cpv,
        categoria: meta.categoria || null,
        occorrenze: row.occorrenze,
        valoreTotale: row.valoreTotale,
        entiCoinvolti: row.enti.size
      };
    })
    .sort((a, b) => {
      if (b.valoreTotale !== a.valoreTotale) return b.valoreTotale - a.valoreTotale;
      return b.occorrenze - a.occorrenze;
    })
    .slice(0, 10);

  const cpvPrefixes = cpvTop.map((row) => row.cpv);
  let prodottiMatch = [];
  if (cpvPrefixes.length) {
    const placeholders = cpvPrefixes.map(() => '?').join(',');
    prodottiMatch = db.prepare(`
      SELECT
        p.id,
        p.nome,
        p.codice_interno,
        p.cpv_mepa,
        c.nome as categoria_nome
      FROM prodotti p
      LEFT JOIN categorie c ON c.id = p.categoria_id
      WHERE p.attivo = 1
        AND p.cpv_mepa IS NOT NULL
        AND substr(p.cpv_mepa, 1, 6) IN (${placeholders})
      ORDER BY p.nome
    `).all(...cpvPrefixes).map((row) => ({
      ...row,
      cpv_prefix: normalizeCpvValue(row.cpv_mepa)
    }));
  }

  return {
    cpvTop,
    prodottiMatch,
    sampleColumns: records[0] ? Object.keys(records[0]).slice(0, 12) : []
  };
}

async function callConsipAction(action, params = {}) {
  const url = new URL(`${CONSIP_CKAN_API_BASE}/${action}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) {
    throw new Error(`Consip API HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload?.success) {
    throw new Error(payload?.error?.message || 'Risposta CKAN non valida');
  }
  return payload.result;
}

function toCountValue(value) {
  if (value === null || value === undefined || value === '') return 0;
  const normalized = String(value).replace(/\./g, '').replace(/,/g, '.').replace(/[^\d.-]/g, '');
  const parsed = parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function topMapEntries(map, limit = 10) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, valore]) => ({ label, valore }));
}

async function buildLocalMepaApiSummary() {
  const stats = await fs.promises.stat(LOCAL_MEPA_API_FILE);
  if (localMepaApiSummaryCache.summary && localMepaApiSummaryCache.mtimeMs === stats.mtimeMs) {
    return localMepaApiSummaryCache.summary;
  }
  if (localMepaApiSummaryCache.pending) {
    return localMepaApiSummaryCache.pending;
  }

  localMepaApiSummaryCache.pending = new Promise((resolve, reject) => {
    const cpvMap = new Map();
    const categorieMap = new Map();
    const regioniMap = new Map();
    const provinceMap = new Map();
    const negoziazioniMap = new Map();
    const bandiMap = new Map();
    const anniMap = new Map();

    let rows = 0;
    let totaleNegoziazioni = 0;
    let totalePa = 0;
    let totalePo = 0;

    const parser = parse({
      columns: true,
      bom: true,
      skip_empty_lines: true,
      relax_quotes: true,
      trim: true
    });

    parser.on('data', (record) => {
      rows += 1;
      const anno = String(record.Anno_Riferimento || '').trim();
      const tipoNegoziazione = String(record.Tipo_negoziazione || '').trim() || 'n/d';
      const bandoMepa = String(record.Bando_Mepa || '').trim() || 'n/d';
      const categoria = String(record.Categoria_abilitazione || '').trim() || 'n/d';
      const beneServizio = String(record.bene_servizio || '').trim() || 'n/d';
      const codiceCpv = String(record.codice_CPV || '').trim() || 'n/d';
      const descrizioneCpv = String(record.descrizione_CPV || '').trim() || 'n/d';
      const regione = String(record.Regione_PA || '').trim() || 'n/d';
      const provincia = String(record.Provincia_PA || '').trim() || 'n/d';
      const nNegoziazioni = toCountValue(record.N_Negoziazioni_pubblicate);
      const nPa = toCountValue(record.N_PA_Appaltanti);
      const nPo = toCountValue(record.N_PO);

      totaleNegoziazioni += nNegoziazioni;
      totalePa += nPa;
      totalePo += nPo;

      const cpvKey = `${codiceCpv} | ${descrizioneCpv}`;
      const categoriaKey = `${categoria} | ${beneServizio}`;
      const provinciaKey = `${provincia} | ${regione}`;

      cpvMap.set(cpvKey, (cpvMap.get(cpvKey) || 0) + nNegoziazioni);
      categorieMap.set(categoriaKey, (categorieMap.get(categoriaKey) || 0) + nNegoziazioni);
      regioniMap.set(regione, (regioniMap.get(regione) || 0) + nNegoziazioni);
      provinceMap.set(provinciaKey, (provinceMap.get(provinciaKey) || 0) + nNegoziazioni);
      negoziazioniMap.set(tipoNegoziazione, (negoziazioniMap.get(tipoNegoziazione) || 0) + nNegoziazioni);
      bandiMap.set(bandoMepa, (bandiMap.get(bandoMepa) || 0) + nNegoziazioni);
      anniMap.set(anno, (anniMap.get(anno) || 0) + nNegoziazioni);
    });

    parser.on('end', () => {
      const topCpv = topMapEntries(cpvMap, 10).map((row) => {
        const [codice, descrizione] = row.label.split(' | ');
        const meta = getCpvMeta(normalizeCpvValue(codice), descrizione);
        return {
          codice_cpv: codice,
          descrizione_cpv: descrizione,
          target_desc: meta.target_desc || descrizione,
          categoria_horygon: meta.categoria || null,
          priorita_horygon: meta.priorita || null,
          negoziazioni: row.valore
        };
      });

      const cpvPrefixes = [...new Set(topCpv.map((row) => normalizeCpvValue(row.codice_cpv)).filter(Boolean))];
      let prodottiMatch = [];
      if (cpvPrefixes.length) {
        const placeholders = cpvPrefixes.map(() => '?').join(',');
        prodottiMatch = db.prepare(`
          SELECT
            p.id,
            p.nome,
            p.codice_interno,
            p.cpv_mepa,
            c.nome as categoria_nome
          FROM prodotti p
          LEFT JOIN categorie c ON c.id = p.categoria_id
          WHERE p.attivo = 1
            AND p.cpv_mepa IS NOT NULL
            AND substr(p.cpv_mepa, 1, 6) IN (${placeholders})
          ORDER BY p.nome
          LIMIT 20
        `).all(...cpvPrefixes).map((row) => ({
          ...row,
          cpv_prefix: normalizeCpvValue(row.cpv_mepa)
        }));
      }

      const summary = {
        file: path.basename(LOCAL_MEPA_API_FILE),
        fileMtime: stats.mtime.toISOString(),
        rows,
        totaleNegoziazioni,
        totalePa,
        totalePo,
        rapportoTdRdo: {
          td: negoziazioniMap.get('TD') || 0,
          rdo: negoziazioniMap.get('RdO') || 0
        },
        anniRiferimento: [...anniMap.entries()]
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
          .map(([anno, negoziazioni]) => ({ anno, negoziazioni })),
        topCpv,
        topCategorie: topMapEntries(categorieMap, 10).map((row) => {
          const [categoria, bene_servizio] = row.label.split(' | ');
          return { categoria, bene_servizio, negoziazioni: row.valore };
        }),
        topRegioni: topMapEntries(regioniMap, 10).map((row) => ({ regione: row.label, negoziazioni: row.valore })),
        topProvince: topMapEntries(provinceMap, 10).map((row) => {
          const [provincia, regione] = row.label.split(' | ');
          return { provincia, regione, negoziazioni: row.valore };
        }),
        topTipiNegoziazione: topMapEntries(negoziazioniMap, 10).map((row) => ({ tipo: row.label, negoziazioni: row.valore })),
        topBandi: topMapEntries(bandiMap, 10).map((row) => ({ bando: row.label, negoziazioni: row.valore })),
        prodottiMatch
      };

      localMepaApiSummaryCache = {
        mtimeMs: stats.mtimeMs,
        summary,
        pending: null
      };
      resolve(summary);
    });

    parser.on('error', (error) => {
      localMepaApiSummaryCache.pending = null;
      reject(error);
    });

    fs.createReadStream(LOCAL_MEPA_API_FILE)
      .on('error', (error) => {
        localMepaApiSummaryCache.pending = null;
        reject(error);
      })
      .pipe(parser);
  });

  return localMepaApiSummaryCache.pending;
}

// ═══════════════════════════════════════════════
// ANALISI INCROCIATA
// ═══════════════════════════════════════════════
router.get('/incrociata', (req, res) => {
  try {
    const fm = cpvFilterMepa();
    const fc = cpvFilterCig();

    // Verifica tabelle esistenti
    const hasMepa = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mepa_ordini'").get();
    const hasCig  = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cig_stats'").get();

    const mepaAnni = hasMepa ? db.prepare(`
      SELECT anno, SUM(valore_economico) as valore, SUM(n_ordini) as n_ordini,
        COUNT(DISTINCT codice_cpv) as n_cpv
      FROM mepa_ordini WHERE ${fm} GROUP BY anno ORDER BY anno
    `).all() : [];

    const cigAnni = hasCig ? db.prepare(`
      SELECT anno, SUM(importo_totale) as valore, SUM(n_gare) as n_gare,
        COUNT(DISTINCT cod_cpv) as n_cpv
      FROM cig_stats WHERE ${fc} GROUP BY anno ORDER BY anno
    `).all() : [];

    const cigMensile = hasCig ? db.prepare(`
      SELECT anno, mese, SUM(n_gare) as n_gare, SUM(importo_totale) as importo
      FROM cig_stats WHERE ${fc} GROUP BY anno, mese ORDER BY anno, mese
    `).all() : [];

    // CPV confronto
    const mepaPerCpv = hasMepa ? db.prepare(`
      SELECT ${cpvPrefixExpr('codice_cpv')} as cpv, MAX(descrizione_cpv) as desc_cpv,
        SUM(valore_economico) as val_mepa, SUM(n_ordini) as ord_mepa
      FROM mepa_ordini WHERE ${fm} GROUP BY ${cpvPrefixExpr('codice_cpv')} ORDER BY val_mepa DESC LIMIT 30
    `).all() : [];

    const cigPerCpv = hasCig ? db.prepare(`
      SELECT ${cpvPrefixExpr('cod_cpv')} as cpv, MAX(descrizione_cpv) as desc_cpv,
        SUM(importo_totale) as val_cig, SUM(n_gare) as n_cig
      FROM cig_stats WHERE ${fc} GROUP BY ${cpvPrefixExpr('cod_cpv')} ORDER BY val_cig DESC LIMIT 30
    `).all() : [];

    // Merge
    const cpvMap = {};
    mepaPerCpv.forEach(r => { cpvMap[r.cpv] = { cpv: r.cpv, desc: r.desc_cpv, val_mepa: r.val_mepa, ord_mepa: r.ord_mepa, val_cig: 0, n_cig: 0 }; });
    cigPerCpv.forEach(r => {
      if (cpvMap[r.cpv]) { cpvMap[r.cpv].val_cig = r.val_cig; cpvMap[r.cpv].n_cig = r.n_cig; }
      else cpvMap[r.cpv] = { cpv: r.cpv, desc: r.desc_cpv, val_mepa: 0, ord_mepa: 0, val_cig: r.val_cig, n_cig: r.n_cig };
    });

    const cpvConfronto = Object.values(cpvMap).map(c => ({
      ...c,
      ...getCpvMeta(c.cpv, c.desc),
      penetrazione: c.val_cig > 0 ? parseFloat((c.val_mepa / c.val_cig * 100).toFixed(1)) : null
    })).sort((a, b) => (b.val_mepa || 0) - (a.val_mepa || 0));

    const gapOpportunita = cpvConfronto
      .filter(c => c.val_cig > 50000 && (c.penetrazione === null || c.penetrazione < 30))
      .sort((a, b) => b.val_cig - a.val_cig).slice(0, 8);

    // Regioni
    const mepaRegioni = hasMepa ? db.prepare(`
      SELECT regione_pa as regione, SUM(valore_economico) as val_mepa
      FROM mepa_ordini WHERE ${fm} AND regione_pa != ''
      GROUP BY regione_pa ORDER BY val_mepa DESC LIMIT 15
    `).all() : [];

    const cigRegioni = hasCig ? db.prepare(`
      SELECT regione_istat as regione, SUM(importo_totale) as val_cig
      FROM cig_stats WHERE ${fc} AND regione_istat != ''
      GROUP BY regione_istat ORDER BY val_cig DESC LIMIT 15
    `).all() : [];

    const regioniMap = {};
    mepaRegioni.forEach(r => { regioniMap[r.regione] = { regione: r.regione, val_mepa: r.val_mepa, val_cig: 0 }; });
    cigRegioni.forEach(r => {
      if (regioniMap[r.regione]) regioniMap[r.regione].val_cig = r.val_cig;
      else regioniMap[r.regione] = { regione: r.regione, val_mepa: 0, val_cig: r.val_cig };
    });
    const regioniConfronto = Object.values(regioniMap)
      .map(r => ({ ...r, penetrazione: r.val_cig > 0 ? parseFloat((r.val_mepa / r.val_cig * 100).toFixed(1)) : null }))
      .sort((a, b) => (b.val_cig || 0) - (a.val_cig || 0));

    // Top CPV MEPA per stagionalità
    const topCpvMepa = mepaPerCpv.slice(0, 5).map(c => c.cpv);
    const stagTopCpv = hasCig && topCpvMepa.length ? db.prepare(`
      SELECT ${cpvPrefixExpr('cod_cpv')} as cpv, mese, AVG(n_gare) as media_gare
      FROM cig_stats WHERE ${cpvPrefixExpr('cod_cpv')} IN (${topCpvMepa.map(() => '?').join(',')})
      GROUP BY ${cpvPrefixExpr('cod_cpv')}, mese ORDER BY ${cpvPrefixExpr('cod_cpv')}, mese
    `).all(...topCpvMepa) : [];

    // MEPA per CPV e anno (per dettaglio)
    const mepaAnniPerCpv = hasMepa ? db.prepare(`
      SELECT ${cpvPrefixExpr('codice_cpv')} as cpv, MAX(descrizione_cpv) as desc, anno,
        SUM(valore_economico) as valore, SUM(n_ordini) as n_ordini
      FROM mepa_ordini WHERE ${fm} GROUP BY ${cpvPrefixExpr('codice_cpv')}, anno ORDER BY ${cpvPrefixExpr('codice_cpv')}, anno
    `).all() : [];

    // Predizioni
    const predizioni = cpvConfronto
      .filter(c => c.val_mepa > 0)
      .map(c => {
        const rows = mepaAnniPerCpv.filter(r => r.cpv === c.cpv);
        if (rows.length < 2) return null;
        const valori = rows.map(r => r.valore || 0);
        const trend = valori.length >= 2 ? (valori[valori.length-1] - valori[0]) / (valori.length - 1) : 0;
        return { ...c, v_pred: Math.max(0, (valori[valori.length-1] || 0) + trend) };
      })
      .filter(Boolean)
      .sort((a, b) => b.v_pred - a.v_pred)
      .slice(0, 10);

    // KPI
    const totMepa = mepaAnni.reduce((s, r) => s + (r.valore || 0), 0);
    const totCig  = cigAnni.reduce((s, r) => s + (r.valore || 0), 0);
    const lastMepa = mepaAnni[mepaAnni.length - 1] || {};
    const lastCig  = cigAnni[cigAnni.length - 1]  || {};
    const prevCig  = cigAnni[cigAnni.length - 2]  || {};

    res.json({
      mepaAnni, cigAnni, cigMensile,
      cpvConfronto, gapOpportunita,
      mepaAnniPerCpv, stagTopCpv, topCpvMepa,
      regioniConfronto, predizioni,
      kpi: {
        tot_mepa: totMepa, tot_cig: totCig,
        penetrazione_media: totCig > 0 ? parseFloat((totMepa / totCig * 100).toFixed(1)) : null,
        mepa_ultimo_anno: lastMepa.valore || 0,
        cig_ultimo_anno: lastCig.valore || 0,
        cig_crescita: prevCig.valore > 0 ? parseFloat(((lastCig.valore - prevCig.valore) / prevCig.valore * 100).toFixed(1)) : null,
        n_cpv_mepa: mepaPerCpv.length,
        n_cpv_cig: cigPerCpv.length,
      },
    });
  } catch (e) {
    console.error('Analytics incrociata error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════
// STORICO CPV — con filtro anni (1, 2, 3 anni)
// ═══════════════════════════════════════════════
router.get('/mepa-api/config', (req, res) => {
  res.json({
    baseUrl: CONSIP_CKAN_API_BASE,
    examples: {
      search: `${CONSIP_CKAN_API_BASE}/datastore_search?resource_id=RESOURCE_ID&limit=5`,
      sql: `${CONSIP_CKAN_API_BASE}/datastore_search_sql?sql=SELECT * FROM "RESOURCE_ID" LIMIT 10`
    }
  });
});

router.get('/mepa-api/local-summary', async (req, res) => {
  try {
    if (!fs.existsSync(LOCAL_MEPA_API_FILE)) {
      return res.status(404).json({ error: 'File MEPA locale non trovato' });
    }
    const summary = await buildLocalMepaApiSummary();
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/mepa-api/search', async (req, res) => {
  try {
    const { resource_id, q, limit, offset } = req.query;
    if (!resource_id) return res.status(400).json({ error: 'resource_id obbligatorio' });
    const result = await callConsipAction('datastore_search', {
      resource_id,
      q: q || undefined,
      limit: limit || 20,
      offset: offset || 0
    });
    const records = Array.isArray(result.records) ? result.records : [];
    res.json({
      mode: 'search',
      resource_id,
      total: result.total || records.length,
      fields: result.fields || [],
      records,
      insights: buildConsipInsights(records)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/mepa-api/sql', async (req, res) => {
  try {
    const { sql } = req.query;
    if (!sql) return res.status(400).json({ error: 'sql obbligatoria' });
    const result = await callConsipAction('datastore_search_sql', { sql });
    const records = Array.isArray(result.records) ? result.records : [];
    res.json({
      mode: 'sql',
      sql,
      total: result.total || records.length,
      records,
      insights: buildConsipInsights(records)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/cpv-storico', (req, res) => {
  try {
    const { cpv, anni } = req.query;
    const fm = cpvFilterMepa();
    const fc = cpvFilterCig();
    const anniInt = parseInt(anni) || 3;

    // Anni disponibili
    const hasMepa = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mepa_ordini'").get();
    const hasCig  = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cig_stats'").get();

    // Anni da includere
    const tuttiAnniMepa = hasMepa ? db.prepare(`SELECT DISTINCT anno FROM mepa_ordini WHERE ${fm} ORDER BY anno DESC`).all().map(r => r.anno) : [];
    const anniDaIncludere = tuttiAnniMepa.slice(0, anniInt);
    const annoMin = Math.min(...anniDaIncludere);

    let mepaStorico, cigStorico;

    if (cpv && cpv !== 'tutti') {
      const p = cpv.substring(0, 6) + '%';
      mepaStorico = hasMepa ? db.prepare(`
        SELECT anno, SUM(valore_economico) as valore, SUM(n_ordini) as n_ordini,
          MAX(descrizione_cpv) as desc_cpv
        FROM mepa_ordini WHERE codice_cpv LIKE ? AND anno >= ?
        GROUP BY anno ORDER BY anno
      `).all(p, annoMin) : [];

      cigStorico = hasCig ? db.prepare(`
        SELECT anno, mese, SUM(n_gare) as n_gare, SUM(importo_totale) as importo,
          MAX(descrizione_cpv) as desc_cpv
        FROM cig_stats WHERE cod_cpv LIKE ? AND anno >= ?
        GROUP BY anno, mese ORDER BY anno, mese
      `).all(p, annoMin) : [];
    } else {
      mepaStorico = hasMepa ? db.prepare(`
        SELECT anno, SUM(valore_economico) as valore, SUM(n_ordini) as n_ordini
        FROM mepa_ordini WHERE ${fm} AND anno >= ?
        GROUP BY anno ORDER BY anno
      `).all(annoMin) : [];

      cigStorico = hasCig ? db.prepare(`
        SELECT anno, mese, SUM(n_gare) as n_gare, SUM(importo_totale) as importo
        FROM cig_stats WHERE ${fc} AND anno >= ?
        GROUP BY anno, mese ORDER BY anno, mese
      `).all(annoMin) : [];
    }

    // Lista CPV disponibili per il menu
    const cpvList = hasMepa ? db.prepare(`
      SELECT ${cpvPrefixExpr('codice_cpv')} as cpv, MAX(descrizione_cpv) as desc,
        SUM(valore_economico) as tot
      FROM mepa_ordini WHERE ${fm}
      GROUP BY ${cpvPrefixExpr('codice_cpv')} ORDER BY tot DESC LIMIT 30
    `).all() : [];

    res.json({ mepaStorico, cigStorico, cpvList, anniDisponibili: tuttiAnniMepa });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
