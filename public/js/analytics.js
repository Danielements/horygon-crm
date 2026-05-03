// ═══════════════════════════════════════════════
// ANALISI INCROCIATA MEPA + CIG
// ═══════════════════════════════════════════════
let analyticsCharts = {};

const MESI_L = ['Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic'];
const MESI_F = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
const COL_MEPA = '#0057ff';
const COL_CIG  = '#f59e0b';
const COL_UP   = '#10b981';
const COL_DN   = '#ef4444';

function formatApiLink(url, label) {
  return `<a href="${url}" target="_blank" rel="noreferrer" style="display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border:1px solid var(--border);border-radius:999px;background:var(--bg-input);color:var(--text);text-decoration:none;font-size:12px;font-weight:600">${label}</a>`;
}

function ensureAnalyticsApiIntro() {
  const section = document.getElementById('section-analytics');
  if (!section) return null;
  let wrap = document.getElementById('analytics-api-intro');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'analytics-api-intro';
    wrap.className = 'dash-card';
    wrap.style.marginBottom = '16px';
    const pageHeader = section.querySelector('.page-header');
    if (pageHeader?.nextSibling) section.insertBefore(wrap, pageHeader.nextSibling);
    else section.appendChild(wrap);
  }
  return wrap;
}

function renderAnalyticsApiIntro(data, mepaStato, cigStato) {
  const wrap = ensureAnalyticsApiIntro();
  if (!wrap) return;

  const cpvRows = (data?.cpvConfronto || []).filter(row => (row.val_cig || 0) > 0);
  const shortlist = cpvRows
    .map((row) => {
      const gap = Math.max(0, (row.val_cig || 0) - (row.val_mepa || 0));
      const penetration = row.penetrazione === null || row.penetrazione === undefined ? null : Number(row.penetrazione);
      return {
        cpv: row.cpv || 'n/d',
        nome: row.target_desc || row.desc || row.descrizione_cpv || 'Prodotto/CPV',
        categoria: row.categoria || 'Categoria non classificata',
        gap,
        cig: row.val_cig || 0,
        penetration
      };
    })
    .sort((a, b) => {
      if (b.gap !== a.gap) return b.gap - a.gap;
      return (a.penetration ?? 9999) - (b.penetration ?? 9999);
    })
    .slice(0, 5);

  wrap.innerHTML = `
    <div style="display:grid;grid-template-columns:2fr 1.1fr;gap:16px;align-items:start">
      <div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px">
          <div>
            <div style="font-size:18px;font-weight:700">Analisi API MEPA</div>
            <div style="font-size:13px;color:var(--text-muted)">API Consip, storico MEPA e opportunita per capire cosa proporre alle PA.</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${formatApiLink('https://dati.consip.it/api/3/action/datastore_search', 'datastore_search')}
            ${formatApiLink('https://dati.consip.it/api/3/action/datastore_search_sql', 'search_sql')}
            ${formatApiLink('https://dati.consip.it/api/3/action/package_search', 'package_search')}
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:12px">
          <div style="border:1px solid var(--border);border-radius:12px;background:var(--bg-input);padding:12px">
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em">MEPA disponibili</div>
            <div style="font-size:22px;font-weight:700;color:${COL_MEPA};margin-top:6px">${mepaStato?.totalRecords || 0}</div>
            <div style="font-size:12px;color:var(--text-muted)">record disponibili per analisi</div>
          </div>
          <div style="border:1px solid var(--border);border-radius:12px;background:var(--bg-input);padding:12px">
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em">CIG disponibili</div>
            <div style="font-size:22px;font-weight:700;color:${COL_CIG};margin-top:6px">${cigStato?.totalRecords || 0}</div>
            <div style="font-size:12px;color:var(--text-muted)">mercato utile al confronto</div>
          </div>
          <div style="border:1px solid var(--border);border-radius:12px;background:var(--bg-input);padding:12px">
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em">Uso consigliato</div>
            <div style="font-size:14px;font-weight:700;margin-top:8px">CPV, enti, trend</div>
            <div style="font-size:12px;color:var(--text-muted)">cosa vendere, a chi, dove e quando</div>
          </div>
        </div>
        <div style="font-size:12px;color:var(--text-muted);line-height:1.6">
          Query base: <code>https://dati.consip.it/api/3/action/datastore_search?resource_id=RESOURCE_ID&amp;limit=5</code><br>
          Query SQL: <code>https://dati.consip.it/api/3/action/datastore_search_sql?sql=SELECT * FROM "RESOURCE_ID" LIMIT 10</code>
        </div>
      </div>
      <div style="border:1px solid var(--border);border-radius:16px;background:linear-gradient(180deg, rgba(0,87,255,0.08), rgba(245,158,11,0.04));padding:14px">
        <div style="font-size:14px;font-weight:700;margin-bottom:10px">Cosa vendere sul portale</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">CPV con mercato attivo e spazio commerciale da presidiare.</div>
        ${shortlist.length ? shortlist.map((row) => `
          <div style="padding:10px 0;border-top:1px solid var(--border)">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
              <div>
                <div style="font-size:13px;font-weight:700">${escapeHtml(row.nome)}</div>
                <div style="font-size:11px;color:var(--text-muted)">${escapeHtml(row.cpv)} · ${escapeHtml(row.categoria)}</div>
              </div>
              <span style="font-size:11px;font-weight:700;padding:4px 8px;border-radius:999px;background:${row.penetration !== null && row.penetration < 20 ? 'rgba(239,68,68,0.15)' : 'rgba(16,185,129,0.15)'};color:${row.penetration !== null && row.penetration < 20 ? COL_DN : COL_UP}">
                ${row.penetration === null ? 'n/d' : `${row.penetration}%`}
              </span>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;font-size:11px;color:var(--text-muted)">
              <div>CIG: <strong style="color:var(--text)">${fE(row.cig)}</strong></div>
              <div>Gap: <strong style="color:var(--text)">${fE(row.gap)}</strong></div>
            </div>
          </div>
        `).join('') : `<div style="font-size:12px;color:var(--text-muted)">Appena colleghiamo dataset o CSV qui comparira la shortlist automatica.</div>`}
      </div>
    </div>
  `;
}

async function loadAnalytics() {
  const noDataEl = document.getElementById('analytics-no-data');
  const dataEl   = document.getElementById('analytics-data');
  const headerTitle = document.querySelector('#section-analytics .page-header h1');
  const headerSubtitle = document.querySelector('#section-analytics .page-header span');
  if (!noDataEl || !dataEl) return;
  if (headerTitle) headerTitle.textContent = 'Analisi API MEPA';
  if (headerSubtitle) headerSubtitle.textContent = 'API Consip, storico MEPA, gap di mercato e potenziale commerciale';

  // Controlla se abbiamo dati
  const [mepaStato, cigStato] = await Promise.all([
    api('GET', '/mepa/stato'),
    api('GET', '/cig/stato'),
  ]);

  const hasMepa = mepaStato && mepaStato.totalRecords > 0;
  const hasCig  = cigStato  && cigStato.totalRecords  > 0;

  if (!hasMepa && !hasCig) {
    noDataEl.style.display = 'block'; dataEl.style.display = 'none';
    document.getElementById('analytics-missing').textContent = 'Mancano i dati MEPA: per ora importa i CSV, poi possiamo affiancare la lettura API Consip';
    document.getElementById('analytics-missing').textContent =
      'Carica i CSV MEPA (sezione Analisi MEPA) e il file CIG (sezione Stagionalità CIG)';
    const noDataTitle = noDataEl.querySelector('h2');
    if (noDataTitle) noDataTitle.textContent = "Dati insufficienti per l'analisi API MEPA";
    document.getElementById('analytics-missing').textContent =
      'Carica i CSV MEPA oppure prepara la futura lettura API Consip, poi integra il file CIG in Stagionalita CIG';
    renderAnalyticsApiIntro(null, mepaStato, cigStato);
    return;
  }
  if (!hasMepa) {
    const noDataTitleMepa = noDataEl.querySelector('h2');
    if (noDataTitleMepa) noDataTitleMepa.textContent = "Mancano i dati MEPA per l'analisi API";
    renderAnalyticsApiIntro(null, mepaStato, cigStato);
    noDataEl.style.display = 'block'; dataEl.style.display = 'none';
    document.getElementById('analytics-missing').textContent = 'Mancano i dati MEPA — vai su Analisi MEPA e importa i CSV';
    return;
  }
  if (!hasCig) {
    const noDataTitleCig = noDataEl.querySelector('h2');
    if (noDataTitleCig) noDataTitleCig.textContent = 'Mancano i dati CIG per il confronto';
    renderAnalyticsApiIntro(null, mepaStato, cigStato);
    noDataEl.style.display = 'block'; dataEl.style.display = 'none';
    document.getElementById('analytics-missing').textContent = 'Mancano i dati CIG — vai su Stagionalità CIG e carica il file';
    return;
  }

  noDataEl.style.display = 'none';
  dataEl.style.display   = 'block';

  const data = await api('GET', '/analytics/incrociata');
  if (!data) return;

  renderAnalyticsApiIntro(data, mepaStato, cigStato);
  renderAnalyticsKPI(data);
  renderConfronto3Anni(data);
  renderCpvBubble(data);
  renderStagionalitaIncrociata(data);
  renderRegioniBubble(data);
  renderGapAnalysis(data);
  renderTopCpvDetail(data);
  renderCalendarioVendita(data);
  loadStoricoCPV();
}

// ───────────────────────────────────────────────
// KPI
// ───────────────────────────────────────────────
function renderAnalyticsKPI(data) {
  const kpi = data.kpi || {};
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.innerHTML = v; };

  set('an-mepa', fE(kpi.mepa_ultimo_anno));
  set('an-cig',  fE(kpi.cig_ultimo_anno));
  set('an-penet', kpi.penetrazione_media !== null
    ? `<span style="color:${kpi.penetrazione_media > 50 ? COL_UP : kpi.penetrazione_media > 20 ? COL_CIG : COL_DN}">${kpi.penetrazione_media}%</span>`
    : '—');
  set('an-gap',  fE((kpi.cig_ultimo_anno || 0) - (kpi.mepa_ultimo_anno || 0)));
  set('an-crescita', kpi.cig_crescita !== null
    ? `<span style="color:${kpi.cig_crescita >= 0 ? COL_UP : COL_DN}">${kpi.cig_crescita >= 0 ? '↑' : '↓'} ${Math.abs(kpi.cig_crescita)}%</span>`
    : '—');
}

// ───────────────────────────────────────────────
// CONFRONTO 3 ANNI — MEPA vs CIG
// ───────────────────────────────────────────────
function renderConfronto3Anni(data) {
  const mepa = data.mepaAnni || [];
  const cig  = data.cigAnni  || [];

  // Unisci anni
  const anniSet = new Set([...mepa.map(r => r.anno), ...cig.map(r => r.anno)]);
  const anni = [...anniSet].sort();

  const mepaMap = Object.fromEntries(mepa.map(r => [r.anno, r.valore || 0]));
  const cigMap  = Object.fromEntries(cig.map(r  => [r.anno, r.valore  || 0]));

  destroyAChart('an-bar');
  const canvas = document.getElementById('an-bar');
  if (!canvas) return;

  analyticsCharts['an-bar'] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: anni,
      datasets: [
        { label: 'Valore MEPA (acquistato)', data: anni.map(a => mepaMap[a] || 0), backgroundColor: COL_MEPA, borderRadius: 8 },
        { label: 'Valore CIG (bandito)',    data: anni.map(a => cigMap[a]  || 0), backgroundColor: COL_CIG,  borderRadius: 8 },
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#7d8590' } },
        tooltip: { callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + fE(ctx.parsed.y) } }
      },
      scales: {
        x: { ticks: { color: '#7d8590' }, grid: { display: false } },
        y: { ticks: { color: '#7d8590', callback: v => fE(v) }, grid: { color: 'rgba(128,128,128,0.15)' } }
      }
    }
  });

  // Penetrazione per anno
  destroyAChart('an-penet-line');
  const canvas2 = document.getElementById('an-penet-line');
  if (!canvas2) return;
  analyticsCharts['an-penet-line'] = new Chart(canvas2.getContext('2d'), {
    type: 'line',
    data: {
      labels: anni,
      datasets: [{
        label: 'Penetrazione MEPA su CIG (%)',
        data: anni.map(a => {
          const m = mepaMap[a] || 0;
          const c = cigMap[a] || 0;
          return c > 0 ? parseFloat((m/c*100).toFixed(1)) : null;
        }),
        borderColor: COL_UP, backgroundColor: 'rgba(16,185,129,0.1)',
        borderWidth: 3, pointRadius: 6, fill: true, tension: 0.3,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ' Penetrazione: ' + ctx.parsed.y + '%' } } },
      scales: {
        x: { ticks: { color: '#7d8590' }, grid: { display: false } },
        y: { ticks: { color: '#7d8590', callback: v => v + '%' }, grid: { color: 'rgba(128,128,128,0.15)' }, min: 0, max: 100 }
      }
    }
  });
}

// ───────────────────────────────────────────────
// BUBBLE CHART CPV — dimensione = gap
// ───────────────────────────────────────────────
function renderCpvBubble(data) {
  const cpv = (data.cpvConfronto || []).filter(c => c.val_mepa > 0 || c.val_cig > 0).slice(0, 20);
  if (!cpv.length) return;

  destroyAChart('an-bubble');
  const canvas = document.getElementById('an-bubble');
  if (!canvas) return;

  analyticsCharts['an-bubble'] = new Chart(canvas.getContext('2d'), {
    type: 'bubble',
    data: {
      datasets: cpv.map((c, i) => ({
        label: (c.desc || c.descrizione_cpv || c.cpv || '').substring(0, 20),
        data: [{
          x: (c.val_cig || 0) / 1000,
          y: (c.val_mepa || 0) / 1000,
          r: Math.max(4, Math.min(30, Math.sqrt((c.val_mepa || 0) / 50000))),
        }],
        backgroundColor: c.penetrazione !== null && c.penetrazione > 50
          ? 'rgba(16,185,129,0.6)'
          : c.penetrazione !== null && c.penetrazione > 20
          ? 'rgba(245,158,11,0.6)'
          : 'rgba(239,68,68,0.6)',
      }))
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const c = cpv[ctx.datasetIndex];
              return [
                ('Prodotto Horygon: ' + (c.target_desc || c.desc || c.cpv || '')).substring(0, 50),
                'Categoria: ' + (c.categoria || 'n/d'),
                'CPV: ' + (c.cpv || 'n/d'),
                'CIG bandito: ' + fE((c.val_cig||0)),
                'MEPA acquistato: ' + fE((c.val_mepa||0)),
                'Penetrazione: ' + (c.penetrazione !== null ? c.penetrazione + '%' : '—'),
              ];
            }
          }
        }
      },
      scales: {
        x: { title: { display: true, text: 'Valore CIG bandito (K€)', color: '#7d8590' }, ticks: { color: '#7d8590', callback: v => v + 'K' }, grid: { color: 'rgba(128,128,128,0.1)' } },
        y: { title: { display: true, text: 'Valore MEPA acquistato (K€)', color: '#7d8590' }, ticks: { color: '#7d8590', callback: v => v + 'K' }, grid: { color: 'rgba(128,128,128,0.1)' } }
      }
    }
  });
}

// ───────────────────────────────────────────────
// STAGIONALITÀ INCROCIATA — CIG mensile sovrapposto ai valori MEPA annuali
// ───────────────────────────────────────────────
function renderStagionalitaIncrociata(data) {
  const cigMensile = data.cigMensile || [];
  const mepaAnni   = data.mepaAnni   || [];
  if (!cigMensile.length) return;

  // Media mensile CIG su tutti gli anni
  const mediaMensile = Array(12).fill(0).map((_, i) => {
    const rows = cigMensile.filter(r => r.mese === i + 1);
    return rows.length > 0 ? rows.reduce((s, r) => s + (r.n_gare || 0), 0) / rows.length : 0;
  });

  // Media mensile importo CIG
  const mediaImportoMensile = Array(12).fill(0).map((_, i) => {
    const rows = cigMensile.filter(r => r.mese === i + 1);
    return rows.length > 0 ? rows.reduce((s, r) => s + (r.importo || 0), 0) / rows.length : 0;
  });

  // Stima acquistato per mese (distribuiamo il totale MEPA per anno secondo i pesi CIG)
  const ultimoAnnoMepa = mepaAnni[mepaAnni.length - 1];
  const totalePesiCig = mediaMensile.reduce((s, v) => s + v, 0);
  const mepaEstimatoMensile = mediaMensile.map(v =>
    totalePesiCig > 0 ? ((v / totalePesiCig) * (ultimoAnnoMepa?.valore || 0)) : 0
  );

  destroyAChart('an-stagionale');
  const canvas = document.getElementById('an-stagionale');
  if (!canvas) return;

  analyticsCharts['an-stagionale'] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: MESI_L,
      datasets: [
        {
          label: 'Bandi CIG (media mensile)',
          data: mediaMensile,
          backgroundColor: 'rgba(245,158,11,0.6)',
          borderRadius: 4, yAxisID: 'y1',
        },
        {
          type: 'line',
          label: 'Acquisti MEPA stimati',
          data: mepaEstimatoMensile,
          borderColor: COL_MEPA, backgroundColor: 'rgba(0,87,255,0.1)',
          borderWidth: 2.5, pointRadius: 5, fill: true, tension: 0.4, yAxisID: 'y',
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#7d8590' } },
        tooltip: { callbacks: { label: ctx => ctx.datasetIndex === 0 ? ' Bandi: ' + Math.round(ctx.parsed.y) : ' MEPA stimato: ' + fE(ctx.parsed.y) } }
      },
      scales: {
        x: { ticks: { color: '#7d8590' }, grid: { display: false } },
        y: { ticks: { color: '#7d8590', callback: v => fE(v) }, grid: { color: 'rgba(128,128,128,0.1)' }, position: 'left' },
        y1: { ticks: { color: '#7d8590' }, grid: { display: false }, position: 'right' }
      }
    }
  });
}

// ───────────────────────────────────────────────
// REGIONI BUBBLE — MEPA vs CIG
// ───────────────────────────────────────────────
function renderRegioniBubble(data) {
  const reg = (data.regioniConfronto || []).filter(r => r.val_cig > 0 || r.val_mepa > 0).slice(0, 15);
  if (!reg.length) return;

  destroyAChart('an-regioni');
  const canvas = document.getElementById('an-regioni');
  if (!canvas) return;

  // Barre affiancate MEPA vs CIG per regione
  analyticsCharts['an-regioni'] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: reg.map(r => r.regione),
      datasets: [
        { label: 'MEPA acquistato', data: reg.map(r => r.val_mepa || 0), backgroundColor: COL_MEPA, borderRadius: 4 },
        { label: 'CIG bandito',     data: reg.map(r => r.val_cig  || 0), backgroundColor: COL_CIG,  borderRadius: 4 },
      ]
    },
    options: {
      indexAxis: 'y', responsive: true,
      plugins: {
        legend: { labels: { color: '#7d8590' } },
        tooltip: { callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + fE(ctx.parsed.x) } }
      },
      scales: {
        x: { ticks: { color: '#7d8590', callback: v => fE(v) }, grid: { color: 'rgba(128,128,128,0.1)' } },
        y: { ticks: { color: '#7d8590', font: { size: 10 } }, grid: { display: false } }
      }
    }
  });

  // Tabella penetrazione
  const el = document.getElementById('an-regioni-table');
  if (!el) return;
  el.innerHTML = reg.map(r => {
    const pen = r.penetrazione;
    const col = pen === null ? '#7d8590' : pen > 50 ? COL_UP : pen > 20 ? COL_CIG : COL_DN;
    const isBase = r.regione === 'LAZIO' || r.regione === 'LIGURIA';
    return `<tr${isBase ? ' style="background:rgba(0,87,255,0.05)"' : ''}>
      <td style="font-weight:${isBase?'700':'400'}">${r.regione} ${isBase?'⭐':''}</td>
      <td style="text-align:right">${fE(r.val_mepa)}</td>
      <td style="text-align:right">${fE(r.val_cig)}</td>
      <td style="text-align:right;color:${col};font-weight:600">${pen !== null ? pen + '%' : '—'}</td>
    </tr>`;
  }).join('');
}

// ───────────────────────────────────────────────
// GAP ANALYSIS — opportunità non sfruttate
// ───────────────────────────────────────────────
function renderGapAnalysis(data) {
  const el = document.getElementById('an-gap-list');
  if (!el) return;
  const gap = data.gapOpportunita || [];
  if (!gap.length) { el.innerHTML = '<p style="color:var(--text-muted)">Nessun gap significativo trovato</p>'; return; }

  el.innerHTML = `
    <div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:8px;padding:12px;margin-bottom:16px;font-size:13px">
      💡 Questi prodotti vengono <strong>banditi frequentemente</strong> dalle PA ma hanno una <strong>bassa presenza su MEPA</strong>.
      Sono le opportunità commerciali più immediate per Horygon.
    </div>
    ${gap.map(c => {
      const pen = c.penetrazione !== null ? c.penetrazione : 0;
      const potenziale = (c.val_cig || 0) - (c.val_mepa || 0);
      return `
      <div style="display:flex;align-items:center;gap:14px;padding:13px;border:1px solid var(--border);border-left:4px solid ${COL_CIG};border-radius:8px;margin-bottom:8px;background:var(--bg-card)">
        <div style="min-width:52px;text-align:center">
          <div style="font-size:18px;font-weight:800;color:${COL_CIG}">${pen.toFixed(0)}%</div>
          <div style="font-size:9px;color:var(--text-muted);text-transform:uppercase">penetraz.</div>
        </div>
        <div style="flex:1">
          <div style="font-weight:700;font-size:13px">${(c.target_desc || c.desc || c.cpv || '').substring(0, 45)}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px">
            Prodotto Horygon: ${(c.target_desc || c.desc || c.cpv || '').substring(0, 55)}
            ${c.categoria ? `Â· ${c.categoria}` : ''}
            ${c.priorita ? `Â· prioritÃ  ${c.priorita}` : ''}
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px">
            ${c.cpv} · Bandito: ${fE(c.val_cig)} · Su MEPA: ${fE(c.val_mepa)}
          </div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-size:13px;font-weight:700;color:${COL_UP}">+${fE(potenziale)}</div>
          <div style="font-size:10px;color:var(--text-muted)">potenziale</div>
        </div>
      </div>`;
    }).join('')}`;
}

// ───────────────────────────────────────────────
// TOP CPV DETAIL — MEPA annuale + CIG mensile
// ───────────────────────────────────────────────
function renderTopCpvDetail(data) {
  const stagTopCpv = data.stagTopCpv || [];
  const topCpvList = data.topCpvMepa || [];
  const mepaAnniPerCpv = data.mepaAnniPerCpv || [];
  if (!topCpvList.length) return;

  // Prendi primo CPV come esempio
  const cpv = topCpvList[0];
  renderSingleCpvChart(cpv, stagTopCpv, mepaAnniPerCpv);

  // Popola select
  const sel = document.getElementById('an-cpv-sel');
  if (sel) {
    sel.innerHTML = topCpvList.map(c => `<option value="${c}">${c}</option>`).join('');
    sel.onchange = () => renderSingleCpvChart(sel.value, stagTopCpv, mepaAnniPerCpv);
  }
}

function renderSingleCpvChart(cpv, stagTopCpv, mepaAnniPerCpv) {
  const mepaRows = mepaAnniPerCpv.filter(r => r.cpv === cpv);
  const stagRows = stagTopCpv.filter(r => r.cpv === cpv);

  destroyAChart('an-cpv-detail');
  const canvas = document.getElementById('an-cpv-detail');
  if (!canvas) return;

  const mepaAnni = mepaRows.map(r => r.anno);
  const mepaValori = mepaRows.map(r => r.valore || 0);
  const stagMesi = Array(12).fill(0);
  stagRows.forEach(r => { if (r.mese >= 1 && r.mese <= 12) stagMesi[r.mese - 1] = r.media_gare || 0; });

  analyticsCharts['an-cpv-detail'] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: MESI_L,
      datasets: [
        {
          label: 'Bandi CIG mensili (media)',
          data: stagMesi,
          backgroundColor: 'rgba(245,158,11,0.55)', borderRadius: 4, yAxisID: 'y1',
        }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#7d8590' } } },
      scales: {
        x: { ticks: { color: '#7d8590' }, grid: { display: false } },
        y1: { ticks: { color: '#7d8590' }, grid: { color: 'rgba(128,128,128,0.1)' } }
      }
    }
  });
}

// ───────────────────────────────────────────────
// CALENDARIO VENDITA
// ───────────────────────────────────────────────
function renderCalendarioVendita(data) {
  const el = document.getElementById('an-calendario');
  if (!el) return;
  const cigMensile = data.cigMensile || [];
  if (!cigMensile.length) { el.innerHTML = '<p style="color:var(--text-muted)">Nessun dato CIG mensile</p>'; return; }

  const mediaMensile = Array(12).fill(0).map((_, i) => {
    const rows = cigMensile.filter(r => r.mese === i + 1);
    return rows.length > 0 ? rows.reduce((s, r) => s + (r.n_gare || 0), 0) / rows.length : 0;
  });

  const max = Math.max(...mediaMensile);
  const mesiInfo = mediaMensile.map((v, i) => {
    const pct = max > 0 ? v / max : 0;
    let label, col, icon;
    if (pct > 0.8)       { label = 'HOT';      col = '#ef4444'; icon = '🔥'; }
    else if (pct > 0.6)  { label = 'Alto';     col = '#f97316'; icon = '📈'; }
    else if (pct > 0.4)  { label = 'Medio';    col = COL_CIG;   icon = '📊'; }
    else if (pct > 0.2)  { label = 'Basso';    col = '#7d8590'; icon = '📉'; }
    else                  { label = 'Lento';    col = '#475569'; icon = '💤'; }
    return { mese: MESI_F[i], v: Math.round(v), pct, label, col, icon };
  });

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
      ${mesiInfo.map((m, i) => `
        <div style="padding:14px;border:1px solid var(--border);border-top:3px solid ${m.col};border-radius:8px;text-align:center;background:var(--bg-card)">
          <div style="font-size:20px">${m.icon}</div>
          <div style="font-weight:700;font-size:14px;margin:4px 0">${m.mese}</div>
          <div style="font-size:11px;font-weight:600;color:${m.col}">${m.label}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${m.v} bandi/mese</div>
          ${i === 0 || mesiInfo[i-1].pct < m.pct - 0.2
            ? `<div style="font-size:10px;color:${COL_UP};margin-top:4px;font-weight:600">▲ Ordina ${i > 0 ? MESI_F[i-1] : 'in anticipo'}</div>`
            : ''}
        </div>`).join('')}
    </div>`;
}

// ───────────────────────────────────────────────
// UTILS
// ───────────────────────────────────────────────
function fE(v) {
  if (!v && v !== 0) return '—';
  const n = parseFloat(v); if (isNaN(n)) return '—';
  if (n >= 1000000) return '€' + (n/1000000).toFixed(1) + 'M';
  if (n >= 1000)    return '€' + (n/1000).toFixed(0) + 'K';
  return '€' + n.toFixed(0);
}

function destroyAChart(id) {
  if (analyticsCharts[id]) { analyticsCharts[id].destroy(); delete analyticsCharts[id]; }
}
