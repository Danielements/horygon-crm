

// ───────────────────────────────────────────────
// PRODOTTI — upload foto multiple
// ───────────────────────────────────────────────
async function uploadFotoProdotto(prodottoId, files, tipo) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  fd.append('tipo', tipo || 'immagine');
  try {
    const r = await apiForm('POST', `/prodotti/${prodottoId}/media`, fd);
    if (r?.ok) toast(`${r.files?.length || 0} file caricati`, 'success');
    return r;
  } catch (e) { toast(e.message, 'error'); return null; }
}

async function eliminaMediaProdotto(prodottoId, mediaId) {
  if (!confirm('Eliminare questo file?')) return;
  await api('DELETE', `/prodotti/${prodottoId}/media/${mediaId}`);
  toast('File eliminato', 'success');
  editProdotto(prodottoId);
}

// Aggiungi tab media nella scheda prodotto
function renderMediaProdotto(prodotto) {
  const media = prodotto.media || [];
  const immagini = media.filter(m => m.tipo === 'immagine');
  const docs = media.filter(m => m.tipo !== 'immagine');

  return `
    <div style="margin-bottom:12px">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        ${immagini.map(m => `
          <div style="position:relative;width:80px;height:80px;border:1px solid var(--border);border-radius:6px;overflow:hidden">
            <img src="${m.path}" style="width:100%;height:100%;object-fit:cover">
            <button onclick="eliminaMediaProdotto(${prodotto.id},${m.id})"
              style="position:absolute;top:2px;right:2px;background:rgba(239,68,68,0.8);border:none;border-radius:3px;color:#fff;cursor:pointer;font-size:10px;padding:1px 4px">✕</button>
          </div>`).join('')}
        <label style="width:80px;height:80px;border:2px dashed var(--border);border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-direction:column;gap:4px">
          <span style="font-size:20px">📷</span>
          <span style="font-size:9px;color:var(--text-muted)">Aggiungi</span>
          <input type="file" accept="image/*" multiple style="display:none"
            onchange="uploadFotoProdotto(${prodotto.id},this.files,'immagine').then(()=>editProdotto(${prodotto.id}))">
        </label>
      </div>
      ${docs.length ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">Documenti:</div>
        ${docs.map(m => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border)">
          <span>📄</span><a href="${m.path}" target="_blank" style="color:var(--accent);font-size:12px">${m.nome_file}</a>
          <button onclick="eliminaMediaProdotto(${prodotto.id},${m.id})" class="btn btn-danger btn-sm" style="padding:2px 8px;font-size:11px">✕</button>
        </div>`).join('')}` : ''}
      <label class="btn btn-outline btn-sm" style="cursor:pointer;margin-top:8px;display:inline-flex;align-items:center;gap:6px">
        📎 Allega PDF/Cert
        <input type="file" accept=".pdf,.doc,.docx" multiple style="display:none"
          onchange="uploadFotoProdotto(${prodotto.id},this.files,'pdf').then(()=>editProdotto(${prodotto.id}))">
      </label>
    </div>`;
}

// Modifica editProdotto per includere tab media
const _editProdottoOrig = window.editProdotto;
async function editProdotto(id) {
  const p = await api('GET', `/prodotti/${id}`);
  if (!p) return;
  document.getElementById('prod-id').value = p.id;
  document.getElementById('prod-codice').value = p.codice_interno || '';
  document.getElementById('prod-barcode').value = p.barcode || '';
  document.getElementById('prod-nome').value = p.nome || '';
  document.getElementById('prod-desc').value = p.descrizione || '';
  document.getElementById('prod-um').value = p.unita_misura || 'pz';
  document.getElementById('prod-peso').value = p.peso_kg || '';
  await loadCategorie();
  document.getElementById('prod-categoria').value = p.categoria_id || '';

  const tabs = document.getElementById('prod-tabs');
  if (tabs) {
    tabs.style.display = 'block';
    document.getElementById('prod-tab-fornitori').innerHTML =
      (p.fornitori||[]).length
        ? p.fornitori.map(f => `<div style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;font-size:13px">
            <strong>${f.ragione_sociale}</strong> — ${f.codice_fornitore||'—'}
            <span style="float:right;color:var(--text-muted)">${f.prezzo_acquisto||'—'} ${f.valuta||'CNY'}</span>
          </div>`).join('')
        : '<p style="color:var(--text-muted);font-size:13px">Nessun fornitore</p>';

    document.getElementById('prod-tab-fatture').innerHTML = renderMediaProdotto(p);
    showProdTab('fornitori');
  }
  openModal('modal-prodotto');
}

// ───────────────────────────────────────────────
// ORDINI — tracking + allegati
// ───────────────────────────────────────────────
async function apriTracking(ordineId) {
  const data = await api('GET', `/ordini/${ordineId}/tracking`);
  if (!data) return;

  const win = window.open('', '_blank', 'width=500,height=600');
  const eventi = (data.eventi || []).map(e =>
    `<div style="padding:8px 0;border-bottom:1px solid #eee;font-size:13px">
      <div style="color:#666;font-size:11px">${e.data||''} ${e.luogo ? '· '+e.luogo : ''}</div>
      <div>${e.descrizione||''}</div>
    </div>`).join('');

  win.document.write(`<html><body style="font-family:Inter,sans-serif;padding:20px;background:#f8fafc">
    <h2 style="margin:0 0 8px">📦 Tracking ${data.numero||''}</h2>
    <div style="font-size:13px;color:#666;margin-bottom:16px">Corriere: ${data.corriere||'—'}</div>
    <div style="background:#0057ff;color:#fff;padding:10px 14px;border-radius:8px;margin-bottom:16px;font-weight:600">
      Stato: ${data.stato||'—'}
    </div>
    ${data.link ? `<a href="${data.link}" target="_blank" style="color:#0057ff;font-size:13px;display:block;margin-bottom:16px">🔗 Vedi sul sito del corriere →</a>` : ''}
    ${data.info ? `<div style="background:#fff3cd;padding:10px;border-radius:6px;font-size:12px;margin-bottom:12px">ℹ️ ${data.info}</div>` : ''}
    ${eventi ? `<h3 style="font-size:14px;margin-bottom:8px">Aggiornamenti:</h3>${eventi}` : ''}
  </body></html>`);
}

async function salvaTracking(ordineId) {
  const numero = document.getElementById('ord-tracking-num')?.value;
  const corriere = document.getElementById('ord-tracking-corriere')?.value;
  try {
    await api('PATCH', `/ordini/${ordineId}/tracking`, { numero_spedizione: numero, corriere });
    toast('Tracking salvato', 'success');
    closeAllModals();
  } catch (e) { toast(e.message, 'error'); }
}

async function uploadAllegatiOrdine(ordineId, files) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  fd.append('tipo', 'foto');
  try {
    const r = await apiForm('POST', `/ordini/${ordineId}/allegati`, fd);
    if (r?.ok) toast(`${r.files?.length||0} allegati caricati`, 'success');
    return r;
  } catch (e) { toast(e.message, 'error'); return null; }
}

// ───────────────────────────────────────────────
// ANALYTICS — storico CPV con filtro anni
// ───────────────────────────────────────────────
let storCharts = {};

async function loadStoricoCPV() {
  const cpv = document.getElementById('stor-cpv-sel')?.value || 'tutti';
  const anni = document.getElementById('stor-anni-sel')?.value || '3';
  const data = await api('GET', `/analytics/cpv-storico?cpv=${encodeURIComponent(cpv)}&anni=${anni}`);
  if (!data) return;

  // Popola select CPV al primo caricamento
  const sel = document.getElementById('stor-cpv-sel');
  if (sel && sel.options.length <= 1) {
    sel.innerHTML = '<option value="tutti">Tutti i prodotti</option>' +
      (data.cpvList || []).map(c => `<option value="${c.cpv}">${c.cpv} — ${(c.desc||'').substring(0,30)}</option>`).join('');
    sel.value = cpv;
  }

  renderStoricoCharts(data, anni);
}

function renderStoricoCharts(data, anni) {
  const mepa = data.mepaStorico || [];
  const cig  = data.cigStorico  || [];

  // Serie annuale MEPA
  if (storCharts['stor-mepa-bar']) { storCharts['stor-mepa-bar'].destroy(); }
  const c1 = document.getElementById('stor-mepa-bar');
  if (c1 && mepa.length) {
    storCharts['stor-mepa-bar'] = new Chart(c1.getContext('2d'), {
      type: 'bar',
      data: {
        labels: mepa.map(r => r.anno),
        datasets: [
          { label: 'Valore acquistato €', data: mepa.map(r => r.valore||0), backgroundColor: '#0057ff', borderRadius: 8 },
          { label: 'N° Ordini', data: mepa.map(r => r.n_ordini||0), backgroundColor: '#00d4ff', borderRadius: 8, yAxisID: 'y1' }
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: '#7d8590' } }, tooltip: { callbacks: { label: ctx => ctx.datasetIndex===0?' '+fEuro(ctx.parsed.y):' '+ctx.parsed.y+' ordini' } } },
        scales: { x:{ticks:{color:'#7d8590'},grid:{display:false}}, y:{ticks:{color:'#7d8590',callback:v=>fEuro(v)},grid:{color:'rgba(128,128,128,0.1)'}}, y1:{position:'right',ticks:{color:'#7d8590'},grid:{display:false}} }
      }
    });
  }

  // Serie mensile CIG per anno
  if (storCharts['stor-cig-line']) { storCharts['stor-cig-line'].destroy(); }
  const c2 = document.getElementById('stor-cig-line');
  if (c2 && cig.length) {
    const anniCig = [...new Set(cig.map(r=>r.anno))].sort();
    const colori = ['#f59e0b','#ef4444','#10b981','#8b5cf6'];
    storCharts['stor-cig-line'] = new Chart(c2.getContext('2d'), {
      type: 'line',
      data: {
        labels: ['Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic'],
        datasets: anniCig.map((anno,i) => {
          const dati = Array(12).fill(null);
          cig.filter(r=>r.anno===anno).forEach(r=>{dati[r.mese-1]=r.n_gare||0;});
          return { label: String(anno), data: dati, borderColor: colori[i%colori.length], backgroundColor:'transparent', borderWidth:2, pointRadius:4, tension:0.3 };
        })
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: '#7d8590' } } },
        scales: { x:{ticks:{color:'#7d8590'},grid:{display:false}}, y:{ticks:{color:'#7d8590'},grid:{color:'rgba(128,128,128,0.1)'}} }
      }
    });
  }

  // YoY comparison
  const el = document.getElementById('stor-yoy');
  if (el && mepa.length >= 2) {
    const rows = [];
    for (let i = 1; i < mepa.length; i++) {
      const prev = mepa[i-1], curr = mepa[i];
      const delta = curr.valore - prev.valore;
      const pct = prev.valore > 0 ? (delta/prev.valore*100).toFixed(1) : null;
      const col = delta >= 0 ? '#10b981' : '#ef4444';
      rows.push(`<tr>
        <td>${prev.anno} → ${curr.anno}</td>
        <td style="text-align:right">${fEuro(prev.valore)}</td>
        <td style="text-align:right">${fEuro(curr.valore)}</td>
        <td style="text-align:right;color:${col};font-weight:700">${pct!==null?(delta>=0?'+':'')+pct+'%':'—'}</td>
        <td style="text-align:right;color:${col}">${delta>=0?'+':''} ${fEuro(Math.abs(delta))}</td>
      </tr>`);
    }
    el.innerHTML = rows.join('');
  }
}

function fEuro(v) {
  if (!v && v !== 0) return '—';
  const n = parseFloat(v); if (isNaN(n)) return '—';
  if (n >= 1000000) return '€'+(n/1000000).toFixed(1)+'M';
  if (n >= 1000) return '€'+(n/1000).toFixed(0)+'K';
  return '€'+n.toFixed(0);
}
