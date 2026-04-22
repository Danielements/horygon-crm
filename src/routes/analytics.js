const express = require('express');
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
