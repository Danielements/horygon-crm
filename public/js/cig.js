// ═══════════════════════════════════════════════
// CIG ANALYTICS — Stagionalità mensile
// ═══════════════════════════════════════════════
let cigCharts = {};

const MESI = ['Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic'];
const MESI_FULL = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];

async function loadCIG() {
  const stato = await api('GET', '/cig/stato');
  const total = stato ? (stato.totalRecords || 0) : 0;
  const noDataEl = document.getElementById('cig-no-data');
  const dataEl = document.getElementById('cig-data');
  if (!noDataEl || !dataEl) return;

  if (total === 0) {
    noDataEl.style.display = 'block'; dataEl.style.display = 'none'; return;
  }

  noDataEl.style.display = 'none'; dataEl.style.display = 'block';

  const infoEl = document.getElementById('cig-info');
  if (infoEl && stato.anni) infoEl.textContent = stato.anni.join(', ') + ' · ' + stato.totalRecords.toLocaleString('it') + ' bandi';

  const data = await api('GET', '/cig/analytics');
  if (!data) return;

  renderStagionalitaRadar(data);
  renderSerieMensile(data);
  renderStagionalitaHeatmap(data);
  renderTopProvince(data);
  renderPicchiCpv(data);
  renderConsigli(data);
}

// ───────────────────────────────────────────────
// RADAR STAGIONALITÀ
// ───────────────────────────────────────────────
function renderStagionalitaRadar(data) {
  const stag = data.stagionalita || [];
  if (stag.length < 6) return;
  const medie = Array(12).fill(0);
  stag.forEach(s => { if (s.mese >= 1 && s.mese <= 12) medie[s.mese - 1] = s.media_gare || 0; });
  const maxM = medie.indexOf(Math.max(...medie));

  destroyCigChart('cig-radar');
  const canvas = document.getElementById('cig-radar');
  if (!canvas) return;
  cigCharts['cig-radar'] = new Chart(canvas.getContext('2d'), {
    type: 'radar',
    data: {
      labels: MESI,
      datasets: [{
        label: 'Media gare mensile',
        data: medie,
        borderColor: '#0057ff',
        backgroundColor: 'rgba(0,87,255,0.12)',
        borderWidth: 2,
        pointBackgroundColor: medie.map((_, i) => i === maxM ? '#f59e0b' : '#0057ff'),
        pointRadius: medie.map((_, i) => i === maxM ? 7 : 3),
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ' ' + Math.round(ctx.parsed.r) + ' bandi in media' } }
      },
      scales: {
        r: {
          ticks: { color: '#7d8590', font: { size: 10 }, backdropColor: 'transparent' },
          grid: { color: 'rgba(128,128,128,0.2)' },
          pointLabels: { color: medie.map((_, i) => i === maxM ? '#f59e0b' : '#7d8590'), font: { size: 12, weight: medie.map((_, i) => i === maxM ? '700' : '400') } }
        }
      }
    }
  });
}

// ───────────────────────────────────────────────
// SERIE MENSILE per anno
// ───────────────────────────────────────────────
function renderSerieMensile(data) {
  const serie = data.serieMensile || [];
  if (!serie.length) return;
  const anni = [...new Set(serie.map(s => s.anno))].sort();
  const colori = ['#0057ff', '#00d4ff', '#10b981', '#f59e0b'];

  destroyCigChart('cig-serie');
  const canvas = document.getElementById('cig-serie');
  if (!canvas) return;

  cigCharts['cig-serie'] = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: MESI,
      datasets: anni.map((anno, i) => {
        const dati = Array(12).fill(null);
        serie.filter(s => s.anno === anno).forEach(s => { dati[s.mese - 1] = s.n_gare; });
        return {
          label: String(anno),
          data: dati,
          borderColor: colori[i % colori.length],
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 4,
          tension: 0.3,
        };
      })
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#7d8590' } }, tooltip: { callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + ctx.parsed.y + ' bandi' } } },
      scales: {
        x: { ticks: { color: '#7d8590' }, grid: { color: 'rgba(128,128,128,0.1)' } },
        y: { ticks: { color: '#7d8590' }, grid: { color: 'rgba(128,128,128,0.1)' } }
      }
    }
  });
}

// ───────────────────────────────────────────────
// HEATMAP mese × CPV
// ───────────────────────────────────────────────
function renderStagionalitaHeatmap(data) {
  const el = document.getElementById('cig-heatmap');
  if (!el) return;

  const cpvData = data.topCpvMensile || [];
  if (!cpvData.length) { el.innerHTML = '<p style="color:var(--text-muted)">Nessun dato</p>'; return; }

  // Aggrega per CPV e mese
  const cpvMap = {};
  cpvData.forEach(r => {
    const k = r.cod_cpv;
    if (!cpvMap[k]) cpvMap[k] = { desc: (r.descrizione_cpv || k).substring(0, 25), mesi: Array(12).fill(0) };
    if (r.mese >= 1 && r.mese <= 12) cpvMap[k].mesi[r.mese - 1] = r.n_gare || 0;
  });

  const cpvList = Object.entries(cpvMap).slice(0, 12);
  const maxVal = Math.max(...cpvList.flatMap(([, v]) => v.mesi));

  let html = `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:11px">
    <thead><tr><th style="text-align:left;padding:4px 8px;color:var(--text-muted)">Prodotto</th>
    ${MESI.map(m => `<th style="text-align:center;padding:4px;color:var(--text-muted)">${m}</th>`).join('')}
    </tr></thead><tbody>`;

  for (const [cpv, v] of cpvList) {
    const picco = v.mesi.indexOf(Math.max(...v.mesi));
    html += `<tr><td style="padding:4px 8px;font-size:11px;white-space:nowrap">${v.desc}</td>`;
    v.mesi.forEach((val, i) => {
      const intensity = maxVal > 0 ? val / maxVal : 0;
      const bg = val === 0 ? 'transparent' : `rgba(0,87,255,${Math.max(0.08, intensity * 0.85)})`;
      const bold = i === picco ? 'font-weight:700;' : '';
      html += `<td style="text-align:center;padding:3px;background:${bg};${bold}border-radius:3px;color:${intensity > 0.5 ? '#fff' : 'var(--text)'}">
        ${val > 0 ? val : ''}
      </td>`;
    });
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  el.innerHTML = html;
}

// ───────────────────────────────────────────────
// TOP PROVINCE
// ───────────────────────────────────────────────
function renderTopProvince(data) {
  const prov = (data.topProvince || []).slice(0, 15);
  if (!prov.length) return;

  destroyCigChart('cig-province');
  const canvas = document.getElementById('cig-province');
  if (!canvas) return;

  cigCharts['cig-province'] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: prov.map(p => p.provincia || '—'),
      datasets: [{
        label: 'Importo €',
        data: prov.map(p => p.importo_totale),
        backgroundColor: prov.map(p => ['GE','SP','SV','IM'].includes(p.provincia) ? '#f59e0b' : ['RM','LT','FR','VT','RI'].includes(p.provincia) ? '#10b981' : '#0057ff'),
        borderRadius: 4,
      }]
    },
    options: {
      indexAxis: 'y', responsive: true,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ' ' + formatEuroC(ctx.parsed.x) + ' — ' + (prov[ctx.dataIndex]?.regione_istat || '') } } },
      scales: { x: { ticks: { color: '#7d8590', callback: v => formatEuroC(v) }, grid: { color: 'rgba(128,128,128,0.1)' } }, y: { ticks: { color: '#7d8590', font: { size: 10 } }, grid: { display: false } } }
    }
  });
}

// ───────────────────────────────────────────────
// PICCHI CPV
// ───────────────────────────────────────────────
function renderPicchiCpv(data) {
  const el = document.getElementById('cig-picchi');
  if (!el) return;
  const picchi = data.picchiCpv || [];
  if (!picchi.length) { el.innerHTML = '<p style="color:var(--text-muted)">Nessun dato</p>'; return; }

  el.innerHTML = picchi.slice(0, 12).map(p => {
    const mese = MESI_FULL[p.mese - 1] || '—';
    return `<div style="display:flex;align-items:center;gap:10px;padding:9px;border:1px solid var(--border);border-radius:7px;margin-bottom:7px">
      <div style="font-size:20px">${getMeseEmoji(p.mese)}</div>
      <div style="flex:1">
        <div style="font-weight:600;font-size:12px">${(p.descrizione_cpv || p.cod_cpv).substring(0,30)}</div>
        <div style="font-size:11px;color:var(--text-muted)">${p.cod_cpv}</div>
      </div>
      <div style="text-align:right">
        <div style="font-weight:700;color:var(--accent);font-size:13px">📅 ${mese}</div>
        <div style="font-size:11px;color:var(--text-muted)">${(p.n_gare||0)} bandi · ${formatEuroC(p.importo)}</div>
      </div>
    </div>`;
  }).join('');
}

// ───────────────────────────────────────────────
// CONSIGLI OPERATIVI
// ───────────────────────────────────────────────
function renderConsigli(data) {
  const el = document.getElementById('cig-consigli');
  if (!el) return;
  const stag = data.stagionalita || [];
  if (stag.length < 3) { el.innerHTML = '<p style="color:var(--text-muted)">Carica i dati CIG per i consigli</p>'; return; }

  const medie = Array(12).fill(0);
  stag.forEach(s => { if (s.mese >= 1 && s.mese <= 12) medie[s.mese - 1] = s.media_importo || 0; });

  const max1 = medie.indexOf(Math.max(...medie));
  const sorted = medie.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const top3 = sorted.slice(0, 3).map(s => MESI_FULL[s.i]);
  const low3 = sorted.slice(-3).map(s => MESI_FULL[s.i]);

  // Mese precedente al picco = quando preparare le scorte
  const mesePrepara = MESI_FULL[(max1 - 1 + 12) % 12];
  const meseVendi = MESI_FULL[max1];

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div style="padding:16px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.3);border-radius:10px">
        <div style="font-size:20px;margin-bottom:8px">📦 Quando ORDINARE al fornitore</div>
        <div style="font-weight:700;font-size:16px;color:#10b981">${mesePrepara}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Un mese prima del picco di bandi. Assicura disponibilità di magazzino.</div>
      </div>
      <div style="padding:16px;background:rgba(0,87,255,0.08);border:1px solid rgba(0,87,255,0.3);border-radius:10px">
        <div style="font-size:20px;margin-bottom:8px">🎯 Mesi HOT per vendere</div>
        <div style="font-weight:700;font-size:16px;color:var(--accent)">${top3.join(', ')}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px">I mesi con più bandi pubblicati. Massimizza la presenza su MEPA.</div>
      </div>
      <div style="padding:16px;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:10px">
        <div style="font-size:20px;margin-bottom:8px">📉 Mesi lenti</div>
        <div style="font-weight:700;font-size:16px;color:#ef4444">${low3.join(', ')}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Mesi con meno bandi. Usa questo periodo per rinnovare il catalogo MEPA.</div>
      </div>
      <div style="padding:16px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:10px">
        <div style="font-size:20px;margin-bottom:8px">🚀 Strategia consigliata</div>
        <div style="font-weight:700;font-size:13px;color:#f59e0b">Ordina → ${mesePrepara}<br>Pubblica offerte → ${top3[0]}<br>Gestisci consegne → ${top3[1]}</div>
      </div>
    </div>
  `;
}

function getMeseEmoji(m) {
  const e = ['❄️','💙','🌱','🌸','☀️','🌊','🌞','🌴','🍂','🎃','🍁','🎄'];
  return e[(m-1) % 12] || '📅';
}

// Sync
async function syncCIG() {
  const btn = document.getElementById('btn-sync-cig');
  if (btn) { btn.textContent = '⏳ Scan...'; btn.disabled = true; }
  try {
    const result = await api('POST', '/cig/scan');
    toast('Scan CIG avviato in background — ricontrolla tra qualche minuto', 'info');
    setTimeout(() => { loadCIG(); }, 30000);
  } catch (e) { toast('Errore: ' + e.message, 'error'); }
  if (btn) { btn.textContent = '🔄 Scan CIG'; btn.disabled = false; }
}

async function uploadCIG(input) {
  const file = input.files[0];
  if (!file) return;
  const res = document.getElementById('cig-upload-result');
  if (res) { res.style.display = 'block'; res.textContent = '⏳ Caricamento ' + file.name + ' (' + (file.size/1024/1024).toFixed(0) + 'MB)...'; }
  const fd = new FormData(); fd.append('file', file);
  try {
    const result = await apiForm('POST', '/cig/upload', fd);
    if (result && result.ok) {
      if (res) { res.style.background = 'rgba(16,185,129,0.1)'; res.textContent = '✅ ' + file.name + ' caricato — elaborazione in background (~2-5 min)'; }
      toast('File CIG caricato — elaborazione in corso', 'info');
      // Polling ogni 30s
      const poll = setInterval(async () => {
        const s = await api('GET', '/cig/stato');
        if (s && s.totalRecords > 0) { clearInterval(poll); loadCIG(); toast('Dati CIG pronti!', 'success'); }
      }, 30000);
    }
  } catch (e) {
    if (res) { res.style.background = 'rgba(239,68,68,0.1)'; res.textContent = '❌ ' + e.message; }
  }
}

function destroyCigChart(id) {
  if (cigCharts[id]) { cigCharts[id].destroy(); delete cigCharts[id]; }
}

function formatEuroC(v) {
  if (!v && v !== 0) return '—';
  const n = parseFloat(v);
  if (isNaN(n)) return '—';
  if (n >= 1000000) return '€' + (n/1000000).toFixed(1) + 'M';
  if (n >= 1000) return '€' + (n/1000).toFixed(0) + 'K';
  return '€' + n.toFixed(0);
}
