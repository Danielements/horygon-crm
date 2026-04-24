// ═══════════════════════════════════════════════
// MEPA ANALYTICS DASHBOARD v4
// ═══════════════════════════════════════════════
let mepaCharts = {};
let mepaData = null;
let mepaSelectedCategoryId = localStorage.getItem('mepa_selected_category_id') || '';

const COLORS = ['#0057ff','#00d4ff','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#06b6d4','#84cc16','#f97316','#6366f1','#14b8a6','#e11d48','#7c3aed','#059669'];

function formatCpvDisplay(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  if (digits.length === 9) return digits.slice(0, 8) + '-' + digits.slice(8);
  return String(value || '');
}

function getMepaTopLimit() {
  const el = document.getElementById('mepa-top-limit');
  const raw = parseInt(el ? el.value : '20', 10);
  return [10, 20, 50].includes(raw) ? raw : 20;
}

function getTopCpvRows(data) {
  return (data.topCpv || []).filter(c => (c.tot_valore || 0) > 0).slice(0, getMepaTopLimit());
}

function getCpvLabel(c) {
  return (c.target_desc || c.desc || c.descrizione_cpv || c.codice_cpv || '').substring(0, 32);
}

function renderMepaViews() {
  if (!mepaData) return;
  renderTopCpvTrendChart(mepaData);
  renderTopCpvTable(mepaData);
  ensureMepaCpvDetail(mepaData);
}

function getSelectedMepaCategoryId() {
  return mepaSelectedCategoryId ? parseInt(mepaSelectedCategoryId, 10) || '' : '';
}

function setSelectedMepaCategoryId(value) {
  mepaSelectedCategoryId = value ? String(value) : '';
  if (mepaSelectedCategoryId) localStorage.setItem('mepa_selected_category_id', mepaSelectedCategoryId);
  else localStorage.removeItem('mepa_selected_category_id');
}

function getMepaCategoryQuery() {
  const id = getSelectedMepaCategoryId();
  return id ? ('?categoria_id=' + encodeURIComponent(id)) : '';
}

function ensureMepaCategoryManager() {
  if (document.getElementById('mepa-category-manager')) return;
  const host = document.getElementById('mepa-data');
  if (!host) return;

  const wrapper = document.createElement('div');
  wrapper.id = 'mepa-category-manager';
  wrapper.className = 'dash-card';
  wrapper.style.marginBottom = '16px';
  wrapper.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:16px">
      <div>
        <h3 style="font-size:14px;font-weight:600;color:var(--text-muted);margin:0 0 6px">Categorie abilitate</h3>
        <div id="mepa-category-summary" style="font-size:12px;color:var(--text-muted)">Caricamento...</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn-secondary" onclick="rebuildMepaStats()">Rigenera statistiche</button>
        <button class="btn-primary" onclick="openMepaCategoryModal()">Aggiungi categoria abilitata</button>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:minmax(240px,320px) 1fr;gap:12px;align-items:end;margin-bottom:16px">
      <div class="form-group" style="margin:0">
        <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:6px">Categoria in analisi</label>
        <select id="mepa-category-select" onchange="selectMepaCategory(this.value)"></select>
      </div>
      <div id="mepa-category-active-info" style="font-size:12px;color:var(--text-muted);padding-bottom:8px"></div>
    </div>
    <div style="display:grid;grid-template-columns:minmax(240px,1fr) auto;gap:10px;align-items:end;margin-bottom:16px">
      <div class="form-group" style="margin:0">
        <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:6px">Ricerca singolo CPV</label>
        <input id="mepa-cpv-search-input" type="text" placeholder="Es. 18143000-3 oppure descrizione" onkeydown="if(event.key==='Enter'){searchMepaCpv()}">
      </div>
      <button class="btn-secondary" onclick="searchMepaCpv()">Cerca CPV</button>
    </div>
    <div id="mepa-cpv-search-results" style="display:none;margin-bottom:16px"></div>
    <div style="overflow:auto;margin-top:12px">
      <table class="data-table">
        <thead><tr><th>Categoria</th><th>Fonte</th><th>CPV</th><th>Attivi</th><th>Stato</th><th>Azioni</th></tr></thead>
        <tbody id="mepa-categorie-body"></tbody>
      </table>
    </div>
  `;

  host.insertBefore(wrapper, host.firstChild);
  ensureMepaCategoryModal();
}

function setMepaDashboardVisibility(showAnalytics) {
  const host = document.getElementById('mepa-data');
  if (!host) return;
  Array.from(host.children).forEach(child => {
    if (child.id === 'mepa-category-manager') child.style.display = '';
    else child.style.display = showAnalytics ? '' : 'none';
  });
}

function renderMepaEmptyState(mode, stato) {
  const noData = document.getElementById('mepa-no-data');
  if (!noData) return;

  if (mode === 'governance') {
    noData.innerHTML = `
      <div style="font-size:52px;margin-bottom:16px">🧭</div>
      <h2 style="margin-bottom:12px;font-size:20px">Configura prima i CPV da monitorare</h2>
      <p style="color:var(--text-muted);margin-bottom:24px;max-width:620px;margin-left:auto;margin-right:auto;line-height:1.6">
        La pagina Analisi MEPA ora lavora solo sui CPV caricati da voi. Finché non aggiungete almeno una categoria abilitata con i relativi CPV dal pop-up, i CSV non vengono analizzati.
      </p>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
        <button class="btn btn-accent" onclick="openMepaCategoryModal()">Aggiungi categoria abilitata</button>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:18px">
        Categorie attive: ${(stato?.categorieAbilitate || 0).toLocaleString('it')} · CPV monitorati: ${(stato?.cpvMonitorati || 0).toLocaleString('it')}
      </div>
    `;
    return;
  }

  noData.innerHTML = `
    <div style="font-size:52px;margin-bottom:16px">📄</div>
    <h2 style="margin-bottom:12px;font-size:20px">Governance pronta, ora carica i CSV MEPA</h2>
    <p style="color:var(--text-muted);margin-bottom:24px;max-width:620px;margin-left:auto;margin-right:auto;line-height:1.6">
      Le categorie e i CPV sono configurati. Puoi caricare i file CSV oppure fare la scansione della cartella <code>data/mepa</code>: l’analisi userà solo i CPV governati nel catalogo.
    </p>
    <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
      <button class="btn btn-accent" onclick="openModal('modal-import-anac')">Upload CSV</button>
      <button class="btn btn-outline" onclick="syncAnac()">Scan cartella MEPA</button>
    </div>
    <div style="font-size:12px;color:var(--text-muted);margin-top:18px">
      CPV monitorati: ${(stato?.cpvMonitorati || 0).toLocaleString('it')} · File duplicati rilevati: ${(stato?.fileDuplicati || 0).toLocaleString('it')}
    </div>
  `;
}

function ensureMepaCategoryModal() {
  if (document.getElementById('modal-mepa-categoria')) return;
  const modal = document.createElement('div');
  modal.id = 'modal-mepa-categoria';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:920px">
      <div class="modal-title">Aggiungi categoria abilitata</div>
      <div class="form-group">
        <label>Nome categoria *</label>
        <input type="text" id="mepa-modal-cat-nome" placeholder="Es. Tessuti, indumenti e DPI">
      </div>
      <div class="form-group">
        <label>Fonte / riferimento</label>
        <input type="text" id="mepa-modal-cat-fonte" placeholder="Es. Allegato 12 Consip giugno 2025">
      </div>
      <div class="form-group">
        <label>Incolla testo</label>
        <textarea id="mepa-modal-import-text" rows="12" placeholder="Incolla qui il testo con i CPV"></textarea>
      </div>
      <div class="form-group">
        <label>Oppure carica file testo / CSV</label>
        <input id="mepa-modal-import-file" type="file" accept=".txt,.csv,.md">
      </div>
      <div id="mepa-modal-import-result" style="font-size:12px;color:var(--text-muted);margin:8px 0 12px"></div>
      <div id="mepa-modal-import-preview" style="display:none;margin-bottom:12px"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeAllModals()">Annulla</button>
        <button class="btn btn-outline" onclick="previewMepaCpvs()">Anteprima</button>
        <button class="btn btn-accent" onclick="saveMepaCategory()">Salva categoria</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function loadMepaCategoryManager() {
  ensureMepaCategoryManager();
  const [categorie, stato] = await Promise.all([
    api('GET', '/mepa/categorie-abilitate'),
    api('GET', '/mepa/stato'),
  ]);
  if (!categorie) return;

  const body = document.getElementById('mepa-categorie-body');
  const summary = document.getElementById('mepa-category-summary');
  const select = document.getElementById('mepa-category-select');
  const activeInfo = document.getElementById('mepa-category-active-info');
  const activeCategories = (categorie || []).filter(cat => Number(cat.attiva) === 1);
  const selectedId = getSelectedMepaCategoryId();
  const selectedCategory = activeCategories.find(cat => cat.id === selectedId) || activeCategories[0] || categorie[0] || null;
  setSelectedMepaCategoryId(selectedCategory ? selectedCategory.id : '');

  if (summary && stato) {
    summary.textContent = (stato.categorieAbilitate || categorie.length || 0) + ' categorie abilitate · ' +
      (stato.cpvMonitorati || 0) + ' CPV monitorati · ' +
      (stato.fileDuplicati || 0) + ' file doppioni rilevati';
  }

  if (select) {
    select.innerHTML = activeCategories.length
      ? activeCategories.map(cat => '<option value="' + cat.id + '"' + (selectedCategory && selectedCategory.id === cat.id ? ' selected' : '') + '>' + escapeHtml(cat.nome) + '</option>').join('')
      : '<option value="">Nessuna categoria attiva</option>';
    select.disabled = !activeCategories.length;
  }

  if (activeInfo) {
    activeInfo.textContent = selectedCategory
      ? ('Dashboard filtrata su: ' + selectedCategory.nome + ' · ' + ((selectedCategory.cpv_attivi || 0).toLocaleString('it')) + ' CPV attivi')
      : 'Nessuna categoria attiva selezionabile';
  }

  if (body) {
    body.innerHTML = categorie.map(cat =>
      '<tr>' +
      '<td><strong>' + escapeHtml(cat.nome) + '</strong><div style="font-size:11px;color:var(--text-muted)">' + escapeHtml(cat.descrizione || '') + '</div></td>' +
      '<td style="font-size:12px">' + escapeHtml(cat.fonte || '-') + '</td>' +
      '<td style="text-align:right">' + ((cat.cpv_count || 0).toLocaleString('it')) + '</td>' +
      '<td style="text-align:right">' + ((cat.cpv_attivi || 0).toLocaleString('it')) + '</td>' +
      '<td style="text-align:center"><span style="display:inline-block;padding:4px 8px;border-radius:999px;font-size:11px;font-weight:600;background:' + (Number(cat.attiva) === 1 ? 'rgba(16,185,129,0.12);color:#10b981' : 'rgba(125,133,144,0.12);color:#7d8590') + '">' + (Number(cat.attiva) === 1 ? 'Attiva' : 'Esclusa') + '</span></td>' +
      '<td style="white-space:nowrap">' +
      (Number(cat.attiva) === 1 ? '<button class="btn-secondary" style="margin-right:6px" onclick="selectMepaCategory(' + cat.id + ')">Usa</button>' : '') +
      '<button class="btn-secondary" style="margin-right:6px" onclick="toggleMepaCategoryState(' + cat.id + ',' + (Number(cat.attiva) === 1 ? 0 : 1) + ')">' + (Number(cat.attiva) === 1 ? 'Escludi' : 'Riattiva') + '</button>' +
      '<button class="btn-secondary" onclick="deleteMepaCategory(' + cat.id + ')">Elimina</button>' +
      '</td>' +
      '</tr>'
    ).join('') || '<tr><td colspan="6" style="padding:18px;text-align:center;color:var(--text-muted)">Nessuna categoria registrata</td></tr>';
  }
}

async function searchMepaCpv() {
  const input = document.getElementById('mepa-cpv-search-input');
  const target = document.getElementById('mepa-cpv-search-results');
  if (!target) return;

  const query = input ? input.value.trim() : '';
  target.style.display = 'block';
  target.innerHTML = '<div style="padding:14px;border:1px solid var(--border);border-radius:10px;color:var(--text-muted)">Ricerca in corso...</div>';

  const result = await api('GET', '/mepa/cpv-search?q=' + encodeURIComponent(query) + (getSelectedMepaCategoryId() ? '&categoria_id=' + encodeURIComponent(getSelectedMepaCategoryId()) : ''));
  if (!result || !result.ok) return;

  const rows = result.results || [];
  if (!rows.length) {
    target.innerHTML = '<div style="padding:14px;border:1px solid var(--border);border-radius:10px;color:var(--text-muted)">Nessun CPV trovato nel catalogo governato.</div>';
    return;
  }

  target.innerHTML = rows.map(row =>
    '<div style="padding:12px 14px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px">' +
      '<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">' +
        '<div>' +
          '<div style="font-weight:700"><code>' + escapeHtml(formatCpvDisplay(row.codice_cpv_display || row.codice_cpv)) + '</code> · ' + escapeHtml(row.categoria || 'Senza categoria') + '</div>' +
          '<div style="font-size:12px;color:var(--text-muted);margin-top:4px">' + escapeHtml(row.desc || row.descrizione || '-') + '</div>' +
        '</div>' +
        '<div style="text-align:right;font-size:12px;min-width:180px">' +
          '<div><strong>' + formatEuro(row.valore_totale || 0) + '</strong></div>' +
          '<div style="color:var(--text-muted);margin-top:4px">' + ((row.ordini_totali || 0).toLocaleString('it')) + ' ordini · ' + ((row.anni_coperti || 0).toLocaleString('it')) + ' anni</div>' +
        '</div>' +
      '</div>' +
    '</div>'
  ).join('');
}

function openMepaCategoryModal() {
  ensureMepaCategoryModal();
  const nome = document.getElementById('mepa-modal-cat-nome');
  const fonte = document.getElementById('mepa-modal-cat-fonte');
  const text = document.getElementById('mepa-modal-import-text');
  const file = document.getElementById('mepa-modal-import-file');
  const result = document.getElementById('mepa-modal-import-result');
  const preview = document.getElementById('mepa-modal-import-preview');
  if (nome) nome.value = '';
  if (fonte) fonte.value = '';
  if (text) text.value = '';
  if (file) file.value = '';
  if (result) result.textContent = '';
  if (preview) {
    preview.style.display = 'none';
    preview.innerHTML = '';
  }
  openModal('modal-mepa-categoria');
}

function getMepaModalState() {
  return {
    nome: document.getElementById('mepa-modal-cat-nome'),
    fonte: document.getElementById('mepa-modal-cat-fonte'),
    text: document.getElementById('mepa-modal-import-text'),
    file: document.getElementById('mepa-modal-import-file'),
    resultEl: document.getElementById('mepa-modal-import-result'),
    previewEl: document.getElementById('mepa-modal-import-preview'),
  };
}

async function saveMepaCategory() {
  const { nome, fonte, text, file, resultEl } = getMepaModalState();
  const categoryName = String(nome?.value || '').trim();

  if (!categoryName) {
    toast('Inserisci il nome categoria', 'error');
    return;
  }

  const categoryRes = await api('POST', '/mepa/categorie-abilitate', {
    nome: categoryName,
    categoria: categoryName,
    fonte: fonte ? fonte.value.trim() : '',
    descrizione: '',
    attiva: 1,
  });
  if (!categoryRes || !categoryRes.ok) return;

  const hasText = !!(text && text.value.trim());
  const hasFile = !!(file && file.files && file.files[0]);
  if (hasText || hasFile) {
    const fd = new FormData();
    fd.append('categoria_id', categoryRes.categoria.id);
    fd.append('categoria', categoryRes.categoria.nome);
    fd.append('fonte', fonte ? fonte.value.trim() : '');
    fd.append('testo', text ? text.value : '');
    if (hasFile) fd.append('file', file.files[0]);
    if (resultEl) resultEl.textContent = 'Import in corso...';
    const importRes = await apiForm('POST', '/mepa/cpv-import', fd);
    if (!importRes || !importRes.ok) return;
    if (resultEl) resultEl.textContent = 'Categoria salvata e import completato: ' + importRes.totaleLetti + ' CPV letti';
    toast('Categoria e CPV salvati', 'success');
  } else {
    toast('Categoria abilitata salvata', 'success');
  }

  closeAllModals();
  await loadMepaCategoryManager();
  await loadMepa();
}

async function importMepaCpvs() {
  return saveMepaCategory();
}

async function previewMepaCpvs() {
  const { nome, text, file, resultEl, previewEl } = getMepaModalState();

  if (!nome || !nome.value.trim()) {
    toast('Inserisci il nome categoria', 'error');
    return;
  }

  const fd = new FormData();
  fd.append('categoria', nome.value.trim());
  fd.append('testo', text ? text.value : '');
  if (file && file.files && file.files[0]) fd.append('file', file.files[0]);

  if (resultEl) resultEl.textContent = 'Analisi testo in corso...';
  try {
    const result = await apiForm('POST', '/mepa/cpv-preview', fd);
    if (!result || !result.ok) return;
    if (resultEl) {
      resultEl.textContent = 'Anteprima pronta: ' + result.totaleLetti + ' CPV riconosciuti · ' + result.nuovi + ' nuovi · ' + result.esistenti + ' gia presenti';
    }
    if (previewEl) {
      previewEl.style.display = 'block';
      previewEl.style.marginTop = '10px';
      previewEl.innerHTML =
        '<div style="max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:10px">' +
        '<table class="data-table">' +
        '<thead><tr><th>CPV</th><th>Descrizione rilevata</th><th>Stato</th></tr></thead>' +
        '<tbody>' +
        (result.rows || []).slice(0, 80).map(row =>
          '<tr>' +
          '<td><code>' + escapeHtml(formatCpvDisplay(row.codice_cpv_display || row.codice_cpv)) + '</code></td>' +
          '<td style="font-size:12px">' + escapeHtml(row.descrizione || '-') +
            (row.esistente && row.descrizione_esistente && row.descrizione_esistente !== row.descrizione
              ? '<div style="font-size:11px;color:var(--text-muted)">Gia in catalogo: ' + escapeHtml(row.descrizione_esistente) + '</div>'
              : '') +
          '</td>' +
          '<td style="font-size:12px;color:' + (row.esistente ? '#f59e0b' : '#10b981') + ';font-weight:600">' + (row.esistente ? 'Gia presente' : 'Nuovo') + '</td>' +
          '</tr>'
        ).join('') +
        '</tbody></table></div>' +
        ((result.rows || []).length > 80 ? '<div style="font-size:11px;color:var(--text-muted);margin-top:6px">Mostrati i primi 80 risultati.</div>' : '');
    }
  } catch (error) {
    if (resultEl) resultEl.textContent = error.message || 'Errore anteprima';
  }
}

async function rebuildMepaStats() {
  const confirmed = confirm('Rigenero tutte le statistiche MEPA partendo solo dai file unici presenti in data/mepa. Continuare?');
  if (!confirmed) return;
  const result = await api('POST', '/mepa/rebuild');
  if (!result || !result.ok) return;
  const imported = (result.results || []).filter(item => item.status === 'importato').length;
  const duplicates = (result.results || []).filter(item => item.status.includes('duplicato')).length;
  toast('Rigenerazione completata: ' + imported + ' file importati, ' + duplicates + ' doppioni ignorati', 'success');
  await loadMepa();
  await loadMepaCategoryManager();
}

async function selectMepaCategory(categoryId) {
  setSelectedMepaCategoryId(categoryId);
  await loadMepaCategoryManager();
  await loadMepa();
}

async function toggleMepaCategoryState(categoryId, attiva) {
  const message = attiva ? 'Riattivo questa categoria per l’analisi?' : 'Escludo questa categoria dalla dashboard MEPA?';
  if (!confirm(message)) return;
  await api('PATCH', '/mepa/categorie-abilitate/' + encodeURIComponent(categoryId), { attiva });
  if (!attiva && String(getSelectedMepaCategoryId()) === String(categoryId)) {
    setSelectedMepaCategoryId('');
  }
  toast(attiva ? 'Categoria riattivata' : 'Categoria esclusa', 'success');
  await loadMepaCategoryManager();
  await loadMepa();
}

async function deleteMepaCategory(categoryId) {
  if (!confirm('Elimino categoria e CPV collegati? Questa azione rimuove la governance associata.')) return;
  await api('DELETE', '/mepa/categorie-abilitate/' + encodeURIComponent(categoryId));
  if (String(getSelectedMepaCategoryId()) === String(categoryId)) {
    setSelectedMepaCategoryId('');
  }
  toast('Categoria eliminata', 'success');
  await loadMepaCategoryManager();
  await loadMepa();
}

function ensureMepaTopSelector() {
  if (document.getElementById('mepa-top-limit')) return;
  const canvas = document.getElementById('chart-cpv-trend');
  if (!canvas || !canvas.parentElement) return;
  const existingTitle = canvas.parentElement.querySelector('h3');
  if (existingTitle) existingTitle.style.marginBottom = '0';

  const toolbar = document.createElement('div');
  toolbar.style.display = 'flex';
  toolbar.style.alignItems = 'center';
  toolbar.style.justifyContent = 'space-between';
  toolbar.style.gap = '12px';
  toolbar.style.marginBottom = '16px';
  toolbar.style.flexWrap = 'wrap';

  if (existingTitle) toolbar.appendChild(existingTitle);

  const label = document.createElement('label');
  label.style.display = 'flex';
  label.style.alignItems = 'center';
  label.style.gap = '8px';
  label.style.fontSize = '12px';
  label.style.color = 'var(--text-muted)';
  label.appendChild(document.createTextNode('Mostra top'));

  const select = document.createElement('select');
  select.id = 'mepa-top-limit';
  select.innerHTML = '<option value="10">10</option><option value="20" selected>20</option><option value="50">50</option>';
  select.onchange = renderMepaViews;
  select.style.background = 'var(--bg-input)';
  select.style.border = '1px solid var(--border)';
  select.style.borderRadius = '6px';
  select.style.padding = '6px 10px';
  select.style.color = 'var(--text)';
  select.style.fontSize = '12px';
  label.appendChild(select);
  toolbar.appendChild(label);

  canvas.parentElement.insertBefore(toolbar, canvas);
}

function ensureMepaCpvDetail(data) {
  if (!document.getElementById('mepa-cpv-detail-card')) {
    const trendCanvas = document.getElementById('chart-cpv-trend');
    if (!trendCanvas || !trendCanvas.parentElement) return;
    const card = document.createElement('div');
    card.id = 'mepa-cpv-detail-card';
    card.className = 'dash-card';
    card.style.marginBottom = '16px';
    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;flex-wrap:wrap">
        <h3 style="font-size:14px;font-weight:600;color:var(--text-muted);margin:0">Andamento per CPV attivo Horygon</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <select id="mepa-cpv-detail-sel" onchange="loadMepaCpvDetail()" style="background:var(--bg-input);border:1px solid var(--border);border-radius:6px;padding:6px 10px;color:var(--text);font-size:12px"></select>
          <select id="mepa-cpv-detail-years" onchange="loadMepaCpvDetail()" style="background:var(--bg-input);border:1px solid var(--border);border-radius:6px;padding:6px 10px;color:var(--text);font-size:12px">
            <option value="1">Ultimo anno</option>
            <option value="2">Ultimi 2 anni</option>
            <option value="3" selected>Ultimi 3 anni</option>
          </select>
        </div>
      </div>
      <canvas id="chart-mepa-cpv-detail" height="170"></canvas>
    `;
    trendCanvas.parentElement.insertAdjacentElement('afterend', card);
  }

  const sel = document.getElementById('mepa-cpv-detail-sel');
  if (!sel || sel.dataset.loaded === '1') return;
  const rows = (data.topCpv || []).filter(c => c.codice_cpv);
  sel.innerHTML = rows.map(c => '<option value="' + c.codice_cpv + '">' + c.codice_cpv + ' - ' + getCpvLabel(c) + '</option>').join('');
  sel.dataset.loaded = '1';
  if (rows.length) loadMepaCpvDetail();
}

async function loadMepaCpvDetail() {
  const sel = document.getElementById('mepa-cpv-detail-sel');
  const yearsSel = document.getElementById('mepa-cpv-detail-years');
  if (!sel || !sel.value) return;
  const detail = await api('GET', '/mepa/cpv/' + encodeURIComponent(sel.value));
  if (!detail) return;
  const range = parseInt(yearsSel ? yearsSel.value : '3', 10) || 3;
  const anni = (detail.anni || []).slice(-range);
  destroyChart('chart-mepa-cpv-detail');
  const canvas = document.getElementById('chart-mepa-cpv-detail');
  if (!canvas || !anni.length) return;
  mepaCharts['chart-mepa-cpv-detail'] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: anni.map(r => r.anno),
      datasets: [
        { label: 'Valore', data: anni.map(r => r.valore || 0), backgroundColor: '#0057ff', borderRadius: 6, yAxisID: 'y' },
        { label: 'Ordini', data: anni.map(r => r.n_ordini || 0), backgroundColor: '#00d4ff', borderRadius: 6, yAxisID: 'y1' },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#7d8590' } }, tooltip: { callbacks: { label: ctx => ctx.datasetIndex === 0 ? ' ' + formatEuro(ctx.parsed.y) : ' ' + ctx.parsed.y.toLocaleString('it') + ' ordini' } } },
      scales: {
        x: { ticks: { color: '#7d8590' }, grid: { display: false } },
        y: { ticks: { color: '#7d8590', callback: v => formatEuro(v) }, grid: { color: 'rgba(128,128,128,0.15)' } },
        y1: { position: 'right', ticks: { color: '#7d8590' }, grid: { display: false } },
      },
    },
  });
}

async function loadMepa() {
  ensureMepaCategoryManager();
  const stato = await api('GET', '/mepa/stato' + getMepaCategoryQuery());
  const total = stato ? (stato.totalRecords || 0) : 0;
  const noData = document.getElementById('mepa-no-data');
  const dataEl = document.getElementById('mepa-data');
  if (!noData || !dataEl) return;
  dataEl.style.display = 'block';
  if (!stato || !stato.governanceReady) {
    noData.style.display = 'block';
    setMepaDashboardVisibility(false);
    renderMepaEmptyState('governance', stato);
    const el = document.getElementById('mepa-last-sync');
    if (el) el.textContent = 'Configura categorie e CPV governati';
    await loadMepaCategoryManager();
    return;
  }
  if (total === 0) {
    noData.style.display = 'block';
    setMepaDashboardVisibility(false);
    renderMepaEmptyState('csv', stato);
    const el = document.getElementById('mepa-last-sync');
    if (el) el.textContent = 'Governance pronta · nessun CSV analizzato';
    await loadMepaCategoryManager();
    return;
  }
  noData.style.display = 'none';
  setMepaDashboardVisibility(true);
  if (stato.anni && stato.anni.length) {
    const el = document.getElementById('mepa-last-sync');
    if (el) el.textContent = stato.anni.join(', ') + ' · ' + stato.totalRecords + ' righe · ' + formatEuro(stato.totValore);
  }
  if (stato.anni && stato.anni.length) {
    const el = document.getElementById('mepa-last-sync');
    const righeVista = stato.totalRecordsHorygon || stato.totalRecords || 0;
    const valoreVista = stato.totValoreHorygon || stato.totValore || 0;
    if (el) el.textContent = stato.anni.join(', ') + ' - vista Horygon: ' + righeVista + ' righe - ' + formatEuro(valoreVista);
  }
  const data = await api('GET', '/mepa/analytics' + getMepaCategoryQuery());
  if (!data) return;
  ensureMepaTopSelector();
  mepaData = data;
  renderMepaKPI(data);
  renderSerieAnniChart(data);
  renderRegioniChart(data);
  renderOpportunita(data);
  renderDeclino(data);
  renderPredizioni(data);
  renderMepaViews();
  renderTipologiePA(data);
  renderRegioniFocus(data);
  await loadMepaCategoryManager();
}

function renderMepaKPI(data) {
  const anni = data.anni || [];
  const ultimo = data.kpiAnni ? data.kpiAnni[data.kpiAnni.length - 1] : null;
  const penultimo = data.kpiAnni ? data.kpiAnni[data.kpiAnni.length - 2] : null;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.innerHTML = val; };
  set('mk-gare', ultimo ? (ultimo.tot_ordini || 0).toLocaleString('it') : '—');
  set('mk-importo', ultimo ? formatEuro(ultimo.tot_valore) : '—');
  set('mk-cpv', ultimo ? (ultimo.num_cpv || 0) : '—');
  if (ultimo && penultimo && penultimo.tot_valore > 0) {
    const cr = ((ultimo.tot_valore - penultimo.tot_valore) / penultimo.tot_valore * 100).toFixed(1);
    const col = cr > 0 ? '#10b981' : '#ef4444';
    set('mk-trend', '<span style="color:' + col + '">' + (cr > 0 ? '↑' : '↓') + ' ' + Math.abs(cr) + '%</span>');
  }
  set('mk-anni', anni.length > 0 ? anni.join(' · ') : '—');
}

function renderSerieAnniChart(data) {
  const serie = data.serieAnni || [];
  if (!serie.length) return;
  destroyChart('chart-serie');
  const canvas = document.getElementById('chart-serie');
  if (!canvas) return;
  mepaCharts['chart-serie'] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: serie.map(s => s.anno),
      datasets: [
        { label: 'Valore', data: serie.map(s => s.tot_valore), backgroundColor: '#0057ff', borderRadius: 8, yAxisID: 'y' },
        { label: 'Ordini', data: serie.map(s => s.tot_ordini), backgroundColor: '#00d4ff', borderRadius: 8, yAxisID: 'y1' }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#7d8590' } }, tooltip: { callbacks: { label: ctx => ctx.datasetIndex === 0 ? ' ' + formatEuro(ctx.parsed.y) : ' ' + ctx.parsed.y.toLocaleString('it') + ' ordini' } } },
      scales: { x: { ticks: { color: '#7d8590' }, grid: { display: false } }, y: { ticks: { color: '#7d8590', callback: v => formatEuro(v) }, grid: { color: 'rgba(128,128,128,0.15)' } }, y1: { position: 'right', ticks: { color: '#7d8590' }, grid: { display: false } } }
    }
  });
}

function renderTopCpvTrendChart(data) {
  const top = getTopCpvRows(data);
  if (!top.length) return;
  const anni = data.anni || ['2023','2024','2025'];
  destroyChart('chart-cpv-trend');
  const canvas = document.getElementById('chart-cpv-trend');
  if (!canvas) return;
  mepaCharts['chart-cpv-trend'] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: top.map(getCpvLabel),
      datasets: [
        { label: anni[0] || '2023', data: top.map(c => c.v_primo || 0), backgroundColor: 'rgba(0,87,255,0.35)', borderRadius: 4 },
        { label: anni[1] || '2024', data: top.map(c => c.v_medio || 0), backgroundColor: 'rgba(0,87,255,0.6)', borderRadius: 4 },
        { label: anni[2] || '2025', data: top.map(c => c.v_ultimo || 0), backgroundColor: '#0057ff', borderRadius: 4 },
      ]
    },
    options: { responsive: true, plugins: { legend: { labels: { color: '#7d8590' } }, tooltip: { callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + formatEuro(ctx.parsed.y) } } },
      scales: { x: { ticks: { color: '#7d8590', font: { size: 10 } }, grid: { display: false } }, y: { ticks: { color: '#7d8590', callback: v => formatEuro(v) }, grid: { color: 'rgba(128,128,128,0.15)' } } } }
  });
}

function renderRegioniChart(data) {
  const reg = (data.topRegioni || []).slice(0, 12);
  if (!reg.length) return;
  destroyChart('chart-regioni');
  const canvas = document.getElementById('chart-regioni');
  if (!canvas) return;
  mepaCharts['chart-regioni'] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: reg.map(r => r.regione_pa),
      datasets: [{ label: 'Valore', data: reg.map(r => r.v_ultimo || r.tot_valore), backgroundColor: reg.map(r => (r.crescita_pct || 0) >= 0 ? 'rgba(16,185,129,0.7)' : 'rgba(239,68,68,0.7)'), borderRadius: 4 }]
    },
    options: { indexAxis: 'y', responsive: true, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ' ' + formatEuro(ctx.parsed.x) + (reg[ctx.dataIndex]?.crescita_pct !== null ? ' | YoY: ' + (reg[ctx.dataIndex].crescita_pct > 0 ? '+' : '') + reg[ctx.dataIndex].crescita_pct + '%' : '') } } },
      scales: { x: { ticks: { color: '#7d8590', callback: v => formatEuro(v) }, grid: { color: 'rgba(128,128,128,0.15)' } }, y: { ticks: { color: '#7d8590', font: { size: 11 } }, grid: { display: false } } } }
  });
}

function renderCategoriChart(data) {
  const cat = (data.topCategorie || []).filter(c => c.tot_valore > 0).slice(0, 8);
  if (!cat.length) return;
  destroyChart('chart-categorie');
  const canvas = document.getElementById('chart-categorie');
  if (!canvas) return;
  mepaCharts['chart-categorie'] = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: { labels: cat.map(c => c.categoria_mepa), datasets: [{ data: cat.map(c => c.tot_valore), backgroundColor: COLORS.slice(0, cat.length), borderWidth: 2 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      radius: '78%',
      plugins: {
        legend: { position: 'bottom', labels: { color: '#7d8590', font: { size: 10 }, boxWidth: 10 } },
        tooltip: { callbacks: { label: ctx => ' ' + ctx.label + ': ' + formatEuro(ctx.parsed) } },
      },
    }
  });
}

function renderOpportunita(data) {
  const el = document.getElementById('opp-list');
  if (!el) return;
  const opps = data.opportunita || [];
  if (!opps.length) { el.innerHTML = '<p style="color:var(--text-muted);font-size:13px">Carica almeno 2 anni di dati</p>'; return; }
  el.innerHTML = opps.map(c => {
    const cr = c.crescita_pct;
    const col = cr > 50 ? '#10b981' : cr > 20 ? '#0057ff' : '#f59e0b';
    return '<div style="display:flex;align-items:center;gap:12px;padding:11px;border:1px solid var(--border);border-left:3px solid ' + col + ';border-radius:8px;margin-bottom:7px">' +
      '<div style="font-size:20px;font-weight:800;color:' + col + ';min-width:55px;text-align:center">+' + cr + '%</div>' +
      '<div style="flex:1"><div style="font-weight:600;font-size:13px">' + getCpvLabel(c) + '</div>' +
      '<div style="font-size:11px;color:var(--text-muted)">' + c.codice_cpv + ' · ' + formatEuro(c.v_ultimo) + '</div></div>' +
      '<div style="color:#10b981;font-weight:700;font-size:12px">▲ COMPRA</div></div>';
  }).join('');
}

function renderDeclino(data) {
  const el = document.getElementById('declino-list');
  if (!el) return;
  const decl = data.declino || [];
  if (!decl.length) { el.innerHTML = '<p style="color:var(--text-muted);font-size:13px">Nessun declino significativo</p>'; return; }
  el.innerHTML = decl.map(c => {
    const cr = c.crescita_pct;
    return '<div style="display:flex;align-items:center;gap:12px;padding:11px;border:1px solid var(--border);border-left:3px solid #ef4444;border-radius:8px;margin-bottom:7px">' +
      '<div style="font-size:20px;font-weight:800;color:#ef4444;min-width:55px;text-align:center">' + cr + '%</div>' +
      '<div style="flex:1"><div style="font-weight:600;font-size:13px">' + getCpvLabel(c) + '</div>' +
      '<div style="font-size:11px;color:var(--text-muted)">' + c.codice_cpv + ' · ' + formatEuro(c.v_ultimo) + '</div></div>' +
      '<div style="color:#ef4444;font-weight:700;font-size:12px">▼ EVITA</div></div>';
  }).join('');
}

function renderPredizioni(data) {
  const el = document.getElementById('pred-table-body');
  if (!el) return;
  const pred = data.predizioni || [];
  if (!pred.length) { el.innerHTML = '<tr><td colspan="5" style="color:var(--text-muted);padding:20px;text-align:center">Dati insufficienti</td></tr>'; return; }
  el.innerHTML = pred.map(c => {
    const delta = c.v_pred - c.v_ultimo;
    const col = delta > 0 ? '#10b981' : delta < 0 ? '#ef4444' : '#f59e0b';
    const icon = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
    return '<tr><td><code style="font-size:11px">' + c.codice_cpv + '</code></td>' +
      '<td style="font-size:12px">' + getCpvLabel(c) + '</td>' +
      '<td style="text-align:right">' + formatEuro(c.v_ultimo) + '</td>' +
      '<td style="text-align:right"><strong style="color:' + col + '">' + formatEuro(c.v_pred) + '</strong></td>' +
      '<td style="text-align:right;color:' + col + ';font-weight:700">' + icon + ' ' + formatEuro(Math.abs(delta)) + '</td></tr>';
  }).join('');
}

function renderTopCpvTable(data) {
  const el = document.getElementById('cpv-table-body');
  if (!el) return;
  el.innerHTML = getTopCpvRows(data).map(c => {
    const cr = c.crescita_pct;
    const crCol = cr === null ? '#7d8590' : cr > 0 ? '#10b981' : '#ef4444';
    const crStr = cr !== null ? (cr > 0 ? '+' : '') + cr + '%' : '—';
    const prio = c.priorita;
    const prioCol = prio === 'alta' ? '#10b981' : prio === 'media' ? '#f59e0b' : '#7d8590';
    return '<tr><td><code style="font-size:11px">' + (c.codice_cpv||'—') + '</code></td>' +
      '<td style="font-size:12px">' + (c.descrizione_cpv||'—').substring(0,28) + '</td>' +
      '<td style="font-size:11px;color:var(--text-muted)">' + (c.categoria||'—') + '</td>' +
      '<td style="text-align:right;font-size:12px">' + formatEuro(c.v_primo||0) + '</td>' +
      '<td style="text-align:right;font-size:12px">' + formatEuro(c.v_medio||0) + '</td>' +
      '<td style="text-align:right"><strong>' + formatEuro(c.v_ultimo||0) + '</strong></td>' +
      '<td style="text-align:right;color:' + crCol + ';font-weight:700">' + crStr + '</td>' +
      '<td><span style="color:' + prioCol + ';font-size:11px;font-weight:600">' + (prio||'—') + '</span></td></tr>';
  }).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:20px">Nessun dato</td></tr>';
}

function renderTipologiePA(data) {
  const el = document.getElementById('tipologie-body');
  if (!el) return;
  el.innerHTML = (data.topTipologie || []).map((t, i) =>
    '<tr><td><strong>#' + (i+1) + '</strong></td><td style="font-size:12px">' + (t.tipologia_pa||'—').substring(0,35) + '</td>' +
    '<td style="text-align:right"><strong>' + formatEuro(t.v_ultimo||0) + '</strong></td>' +
    '<td style="text-align:right;color:var(--text-muted)">' + formatEuro(t.tot_valore||0) + '</td></tr>'
  ).join('');
}

function renderRegioniFocus(data) {
  const el = document.getElementById('regioni-focus');
  if (!el) return;
  const target = data.regioniTarget || (data.topRegioni||[]).filter(r => r.v_ultimo > 0).slice(0, 5);
  if (!target.length) { el.innerHTML = '<p style="color:var(--text-muted);font-size:13px">Carica più anni per analisi</p>'; return; }
  el.innerHTML = target.map(r => {
    const cr = r.crescita_pct;
    const col = cr > 10 ? '#10b981' : cr > 0 ? '#f59e0b' : '#ef4444';
    const isBase = r.regione_pa === 'LAZIO' || r.regione_pa === 'LIGURIA';
    const icon = r.regione_pa === 'LAZIO' ? '🏛️' : r.regione_pa === 'LIGURIA' ? '⚓' : r.regione_pa === 'LOMBARDIA' ? '🏙️' : '📍';
    return '<div style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--border)' + (isBase ? ';border-left:3px solid var(--accent)' : '') + ';border-radius:8px;margin-bottom:7px">' +
      '<div style="font-size:16px">' + icon + '</div>' +
      '<div style="flex:1"><div style="font-weight:600;font-size:13px">' + r.regione_pa + (isBase ? ' <span style="font-size:10px;color:var(--accent)">●</span>' : '') + '</div>' +
      '<div style="font-size:11px;color:var(--text-muted)">' + (r.tot_ordini||0).toLocaleString('it') + ' ordini</div></div>' +
      '<div style="text-align:right"><div style="font-weight:700;font-size:13px">' + formatEuro(r.v_ultimo||r.tot_valore) + '</div>' +
      '<div style="font-size:12px;color:' + col + ';font-weight:600">' + (cr !== null ? (cr > 0 ? '+' : '') + cr + '%' : '—') + '</div></div></div>';
  }).join('');
}

async function syncAnac() {
  const btn = document.getElementById('btn-sync-anac');
  if (btn) { btn.textContent = '⏳ Scan...'; btn.disabled = true; }
  try {
    const result = await api('POST', '/mepa/scan');
    if (result && result.ok) {
      const imp = (result.results || []).filter(r => r.status === 'importato');
      if (imp.length > 0) { toast('Importati ' + imp.length + ' file MEPA', 'success'); await loadMepa(); }
      else {
        const gia = (result.results || []).filter(r => r.status === 'già importato');
        toast(gia.length > 0 ? gia.length + ' file già presenti — aggiungi nuovi CSV in data/mepa/' : 'Nessun file in data/mepa/', 'info');
        await loadMepa();
      }
    }
  } catch (e) { toast('Errore: ' + e.message, 'error'); }
  if (btn) { btn.textContent = '🔄 Scan MEPA'; btn.disabled = false; }
}

async function importAnacCSV(input) {
  const files = input.files;
  if (!files.length) return;
  const res = document.getElementById('anac-import-result');
  if (res) { res.style.display = 'block'; res.textContent = '⏳ Caricamento ' + files.length + ' file...'; }
  let ok = 0, totRighe = 0, totValore = 0;
  for (const file of Array.from(files)) {
    const fd = new FormData(); fd.append('file', file);
    try {
      const result = await apiForm('POST', '/mepa/upload', fd);
      if (result && result.ok) { ok++; totRighe += result.horygon || 0; totValore += result.valoreHorygon || 0; }
    } catch {}
  }
  if (res) { res.style.background = 'rgba(16,185,129,0.1)'; res.innerHTML = '✅ ' + ok + '/' + files.length + ' file importati · ' + totRighe.toLocaleString('it') + ' righe · ' + formatEuro(totValore); }
  toast(ok + ' file MEPA importati', 'success');
  setTimeout(() => { closeAllModals(); loadMepa(); }, 1500);
}

function checkSyncStatus() { loadMepa(); }

function formatEuro(v) {
  if (!v && v !== 0) return '—';
  const n = parseFloat(v);
  if (isNaN(n)) return '—';
  if (n >= 1000000) return '€' + (n/1000000).toFixed(1) + 'M';
  if (n >= 1000) return '€' + (n/1000).toFixed(0) + 'K';
  return '€' + n.toFixed(0);
}

function destroyChart(id) {
  if (mepaCharts[id]) { mepaCharts[id].destroy(); delete mepaCharts[id]; }
}

function ensureOpportunityCpvShell() {
  if (!document.querySelector('[data-section="opportunita-cpv"]')) {
    const analyticsNav = document.querySelector('[data-section="analytics"]');
    const navItem = document.createElement('a');
    navItem.className = 'nav-item';
    navItem.dataset.section = 'opportunita-cpv';
    navItem.innerHTML = '<span class="nav-icon">+</span> CPV Opportunita';
    navItem.addEventListener('click', e => {
      e.preventDefault();
      navigateTo('opportunita-cpv');
    });
    if (analyticsNav && analyticsNav.parentElement) {
      analyticsNav.parentElement.insertBefore(navItem, analyticsNav);
    }
  }

  if (!document.getElementById('section-opportunita-cpv')) {
    const main = document.getElementById('main-content');
    if (!main) return;
    const section = document.createElement('section');
    section.id = 'section-opportunita-cpv';
    section.className = 'section';
    section.innerHTML = `
      <div class="page-header">
        <h1>CPV Opportunita non attivate</h1>
        <div class="header-actions">
          <span id="opp-cpv-info" style="font-size:12px;color:var(--text-muted)"></span>
          <select id="opp-cpv-limit" onchange="loadOpportunityCpv()" style="background:var(--bg-input);border:1px solid var(--border);border-radius:6px;padding:7px 10px;color:var(--text);font-size:12px">
            <option value="10">Top 10</option>
            <option value="20" selected>Top 20</option>
            <option value="50">Top 50</option>
          </select>
        </div>
      </div>
      <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:20px">
        <div class="kpi-card"><div class="kpi-val" id="opp-cpv-count">-</div><div class="kpi-label">CPV non attivi</div></div>
        <div class="kpi-card"><div class="kpi-val" id="opp-cpv-value">-</div><div class="kpi-label">Valore mercato</div></div>
        <div class="kpi-card"><div class="kpi-val" id="opp-cpv-years">-</div><div class="kpi-label">Anni analizzati</div></div>
        <div class="kpi-card"><div class="kpi-val" id="opp-cpv-rows">-</div><div class="kpi-label">Righe lette</div></div>
      </div>
      <div style="display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:16px">
        <div class="dash-card">
          <h3 style="font-size:14px;font-weight:600;color:var(--text-muted);margin-bottom:16px">Migliori opportunita per score</h3>
          <canvas id="opp-cpv-chart" height="220"></canvas>
        </div>
        <div class="dash-card">
          <h3 style="font-size:14px;font-weight:600;color:#10b981;margin-bottom:16px">Priorita commerciali</h3>
          <div id="opp-cpv-cards"></div>
        </div>
      </div>
      <div class="dash-card">
        <h3 style="font-size:14px;font-weight:600;color:var(--text-muted);margin-bottom:16px">Dettaglio CPV da valutare</h3>
        <div style="overflow-x:auto">
          <table class="data-table">
            <thead><tr><th>#</th><th>CPV</th><th>Descrizione</th><th style="text-align:right">Primo anno</th><th style="text-align:right">Medio</th><th style="text-align:right">Ultimo anno</th><th style="text-align:right">Totale</th><th style="text-align:right">Crescita</th><th>Indicazione</th></tr></thead>
            <tbody id="opp-cpv-body"></tbody>
          </table>
        </div>
      </div>
    `;
    main.appendChild(section);
  }
}

async function loadOpportunityCpv() {
  ensureOpportunityCpvShell();
  const limitEl = document.getElementById('opp-cpv-limit');
  const limit = limitEl ? limitEl.value : '20';
  const data = await api('GET', '/mepa/opportunita-non-attive?limit=' + encodeURIComponent(limit));
  if (!data) return;
  renderOpportunityCpv(data);
}

function renderOpportunityCpv(data) {
  const items = data.items || [];
  const summary = data.summary || {};
  const anni = data.anni || [];
  const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  setText('opp-cpv-count', (summary.totalItems || 0).toLocaleString('it'));
  setText('opp-cpv-value', formatEuro(summary.totalValue || 0));
  setText('opp-cpv-years', anni.length ? anni.join(' - ') : '-');
  setText('opp-cpv-rows', (data.scannedRows || 0).toLocaleString('it'));
  setText('opp-cpv-info', items.length + ' CPV mostrati');

  const cards = document.getElementById('opp-cpv-cards');
  if (cards) {
    cards.innerHTML = items.slice(0, 5).map((item, idx) => {
      const growth = item.crescita_pct === null ? '-' : (item.crescita_pct > 0 ? '+' : '') + item.crescita_pct + '%';
      return '<div style="padding:12px;border:1px solid var(--border);border-left:3px solid #10b981;border-radius:8px;margin-bottom:8px">' +
        '<div style="display:flex;justify-content:space-between;gap:10px"><strong>#' + (idx + 1) + ' ' + item.codice_cpv + '</strong><span style="color:#10b981;font-weight:700">' + growth + '</span></div>' +
        '<div style="font-size:12px;margin-top:5px">' + (item.descrizione_cpv || '').substring(0, 55) + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:5px">' + formatEuro(item.v_ultimo || 0) + ' ultimo anno | ' + (item.ordini_totali || 0).toLocaleString('it') + ' ordini</div>' +
      '</div>';
    }).join('') || '<p style="color:var(--text-muted);font-size:13px">Nessuna opportunita trovata</p>';
  }

  const body = document.getElementById('opp-cpv-body');
  if (body) {
    body.innerHTML = items.map((item, idx) => {
      const growth = item.crescita_pct === null ? '-' : (item.crescita_pct > 0 ? '+' : '') + item.crescita_pct + '%';
      const growthColor = item.crescita_pct === null ? '#7d8590' : item.crescita_pct >= 0 ? '#10b981' : '#ef4444';
      return '<tr>' +
        '<td><strong>#' + (idx + 1) + '</strong></td>' +
        '<td><code style="font-size:11px">' + item.codice_cpv + '</code></td>' +
        '<td style="font-size:12px">' + (item.descrizione_cpv || '').substring(0, 44) + '</td>' +
        '<td style="text-align:right">' + formatEuro(item.v_primo || 0) + '</td>' +
        '<td style="text-align:right">' + formatEuro(item.v_medio || 0) + '</td>' +
        '<td style="text-align:right"><strong>' + formatEuro(item.v_ultimo || 0) + '</strong></td>' +
        '<td style="text-align:right">' + formatEuro(item.valore_totale || 0) + '</td>' +
        '<td style="text-align:right;color:' + growthColor + ';font-weight:700">' + growth + '</td>' +
        '<td style="font-size:12px">' + item.suggerimento + '</td>' +
      '</tr>';
    }).join('') || '<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:20px">Nessun dato</td></tr>';
  }

  destroyChart('opp-cpv-chart');
  const canvas = document.getElementById('opp-cpv-chart');
  if (!canvas || !items.length) return;
  const top = items.slice(0, 12);
  mepaCharts['opp-cpv-chart'] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: top.map(item => (item.descrizione_cpv || item.codice_cpv).substring(0, 28)),
      datasets: [
        { label: 'Primo anno', data: top.map(item => item.v_primo || 0), backgroundColor: 'rgba(0,87,255,0.35)', borderRadius: 4 },
        { label: 'Ultimo anno', data: top.map(item => item.v_ultimo || 0), backgroundColor: '#10b981', borderRadius: 4 },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#7d8590' } }, tooltip: { callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + formatEuro(ctx.parsed.y) } } },
      scales: { x: { ticks: { color: '#7d8590', font: { size: 10 } }, grid: { display: false } }, y: { ticks: { color: '#7d8590', callback: v => formatEuro(v) }, grid: { color: 'rgba(128,128,128,0.15)' } } },
    },
  });
}

ensureOpportunityCpvShell();
window.saveMepaCategory = saveMepaCategory;
window.openMepaCategoryModal = openMepaCategoryModal;
window.previewMepaCpvs = previewMepaCpvs;
window.importMepaCpvs = importMepaCpvs;
window.searchMepaCpv = searchMepaCpv;
window.selectMepaCategory = selectMepaCategory;
window.toggleMepaCategoryState = toggleMepaCategoryState;
window.deleteMepaCategory = deleteMepaCategory;
window.rebuildMepaStats = rebuildMepaStats;
