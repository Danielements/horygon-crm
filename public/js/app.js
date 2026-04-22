// ═══════════════════════════════
// STATE
// ═══════════════════════════════
let TOKEN = localStorage.getItem('horygon_token');
let USER = null;
let PERMS = {};
let calDate = new Date();
let calView = 'month';
let calEvents = [];
let currentEventId = null;

// Redirect da Google OAuth
const urlToken = new URLSearchParams(window.location.search).get('token');
if (urlToken) { localStorage.setItem('horygon_token', urlToken); TOKEN = urlToken; history.replaceState({}, '', '/'); }

// ═══════════════════════════════
// API
// ═══════════════════════════════
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    cache: 'no-store'
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  if (res.status === 401) { logout(); return null; }
  if (res.status === 304 || res.status === 204) return {};
  try {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Errore');
    return data;
  } catch (e) {
    if (!res.ok) throw e;
    return {};
  }
}

async function apiForm(method, path, formData) {
  const res = await fetch('/api' + path, { method, headers: { 'Authorization': `Bearer ${TOKEN}` }, body: formData });
  if (res.status === 401) { logout(); return null; }
  return res.json();
}

// ═══════════════════════════════
// TOAST
// ═══════════════════════════════
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span> ${msg}`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ═══════════════════════════════
// AUTH
// ═══════════════════════════════
async function init() {
  if (!TOKEN) { showScreen('login-screen'); document.getElementById('setup-link').style.display = 'block'; return; }
  try {
    const me = await api('GET', '/auth/me');
    if (!me) return;
    USER = me;
    // Applica tema
    document.body.className = `theme-${USER.tema || 'dark'}`;
    document.getElementById('btn-tema').textContent = USER.tema === 'light' ? '🌙' : '☀️';
    // UI utente
    document.getElementById('user-name').textContent = USER.nome;
    document.getElementById('user-role').textContent = ['','Read Only','Editor','Can Delete','Superuser'][USER.ruolo_id] || '';
    document.getElementById('user-avatar').textContent = USER.nome[0].toUpperCase();
    // Google status
    document.getElementById('btn-google').textContent = USER.hasGoogle ? '✅' : '🔗';
    // Permessi
    PERMS = {};
    (USER.permessi || []).forEach(p => { PERMS[p.sezione] = p; });
    // Mostra sezione utenti solo a superuser
    if (USER.ruolo_id === 4) document.getElementById('nav-utenti').style.display = 'flex';
    showScreen('app');
    navigateTo('dashboard');
  } catch { logout(); }
}

async function doLogin() {
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  try {
    const data = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    }).then(r => r.json());
    if (!data.token) throw new Error(data.error || 'Errore');
    localStorage.setItem('horygon_token', data.token);
    TOKEN = data.token;
    await init();
  } catch (e) { document.getElementById('login-error').textContent = e.message; }
}

async function doSetup() {
  const nome = document.getElementById('setup-nome').value;
  const email = document.getElementById('setup-email').value;
  const password = document.getElementById('setup-password').value;
  try {
    await fetch('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome, email, password }) });
    toast('Admin creato! Accedi ora.', 'success');
    showScreen('login-screen');
  } catch (e) { document.getElementById('setup-error').textContent = e.message; }
}

function showSetup() { showScreen('setup-screen'); }
function showLogin() { showScreen('login-screen'); }
function logout() { localStorage.removeItem('horygon_token'); TOKEN = null; USER = null; showScreen('login-screen'); }
function connectGoogle() { window.location = '/api/auth/google'; }

async function toggleTema() {
  const newTema = USER.tema === 'dark' ? 'light' : 'dark';
  try {
    const data = await api('POST', '/auth/tema', { tema: newTema });
    localStorage.setItem('horygon_token', data.token);
    TOKEN = data.token;
    USER.tema = newTema;
    document.body.className = `theme-${newTema}`;
    document.getElementById('btn-tema').textContent = newTema === 'light' ? '🌙' : '☀️';
  } catch {}
}

function showScreen(id) {
  ['login-screen','setup-screen','app'].forEach(s => {
    const el = document.getElementById(s);
    if (el) el.style.display = s === id ? 'flex' : 'none';
  });
}

function ensureAnagraficaLogisticaFields() {
  if (document.getElementById('anag-canale-cliente')) return;
  const note = document.getElementById('anag-note');
  if (!note || !note.parentElement) return;
  const wrap = document.createElement('div');
  wrap.className = 'form-group';
  wrap.innerHTML = `<label>Canale cliente</label>
    <select id="anag-canale-cliente">
      <option value="privato">Privato / Diretto</option>
      <option value="mepa">MEPA</option>
    </select>`;
  note.parentElement.insertAdjacentElement('beforebegin', wrap);
}

// ═══════════════════════════════
// NAVIGAZIONE
// ═══════════════════════════════
document.querySelectorAll('.nav-item').forEach(a => {
  a.addEventListener('click', e => { e.preventDefault(); const s = a.dataset.section; if (s) navigateTo(s); });
});

function navigateTo(section) {
  document.querySelectorAll('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.section === section));
  document.querySelectorAll('.section').forEach(s => s.classList.toggle('active', s.id === `section-${section}`));
  document.getElementById('main-content').scrollTop = 0;
  const map = {
    dashboard: loadDashboard, clienti: () => loadAnagrafiche('cliente'),
    fornitori: () => loadAnagrafiche('fornitore'), prodotti: loadProdotti,
    magazzino: loadMagazzino, ordini: loadOrdini, ddt: loadDdt,
    container: loadContainer, fatture: loadFatture,
    attivita: loadAttivita, documenti: loadDocumenti,
    mappa: loadMappa, utenti: loadUtenti, mepa: loadMepa, 'opportunita-cpv': loadOpportunityCpv, cig: loadCIG, analytics: loadAnalytics,
  };
  if (map[section]) map[section]();
}
// ═══════════════════════════════
// DASHBOARD
// ═══════════════════════════════
async function loadDashboard() {
  const [ordini, prodotti, pa, container] = await Promise.all([
    api('GET', '/ordini?stato=ricevuto'), api('GET', '/prodotti'),
    api('GET', '/anagrafiche?tipo=pa'), api('GET', '/container'),
  ]);
  document.getElementById('kpi-ordini').textContent = ordini?.length || 0;
  document.getElementById('kpi-prodotti').textContent = prodotti?.length || 0;
  document.getElementById('kpi-clienti').textContent = pa?.length || 0;
  document.getElementById('kpi-container').textContent = container?.filter(c => c.stato === 'in_transito').length || 0;
  loadCalendar();
}

// ═══════════════════════════════
// GOOGLE CALENDAR
// ═══════════════════════════════
async function loadCalendar() {
  if (!USER?.hasGoogle) {
    document.getElementById('cal-no-google').style.display = 'block';
    document.getElementById('cal-body').style.display = 'none';
    return;
  }
  document.getElementById('cal-no-google').style.display = 'none';
  document.getElementById('cal-body').style.display = 'block';
  try {
    calEvents = await api('GET', '/google/calendar/events') || [];
    renderCalendar();
  } catch { calEvents = []; renderCalendar(); }
}

function renderCalendar() {
  updateCalTitle();
  if (calView === 'month') renderMonthView();
  else renderWeekView();
}

function updateCalTitle() {
  const months = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
  if (calView === 'month') document.getElementById('cal-title').textContent = `${months[calDate.getMonth()]} ${calDate.getFullYear()}`;
  else {
    const start = getWeekStart(calDate);
    const end = new Date(start); end.setDate(end.getDate() + 6);
    document.getElementById('cal-title').textContent = `${start.getDate()} ${months[start.getMonth()]} – ${end.getDate()} ${months[end.getMonth()]} ${end.getFullYear()}`;
  }
}

function getWeekStart(d) {
  const day = d.getDay(); const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.getFullYear(), d.getMonth(), diff);
}

function renderMonthView() {
  const year = calDate.getFullYear(), month = calDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startDow = (firstDay.getDay() + 6) % 7;
  const days = ['Lun','Mar','Mer','Gio','Ven','Sab','Dom'];
  let html = `<div class="cal-grid">${days.map(d => `<div class="cal-day-label">${d}</div>`).join('')}`;
  const today = new Date();
  // Giorni mese precedente
  for (let i = 0; i < startDow; i++) {
    const d = new Date(year, month, -startDow + i + 1);
    html += `<div class="cal-day other-month" onclick="calDayClick('${fmt(d)}')"><div class="cal-day-num">${d.getDate()}</div></div>`;
  }
  // Giorni mese corrente
  for (let d = 1; d <= lastDay.getDate(); d++) {
    const date = new Date(year, month, d);
    const isToday = date.toDateString() === today.toDateString();
    const dayStr = fmt(date);
    const dayEvents = calEvents.filter(e => {
      const es = e.start?.dateTime ? e.start.dateTime.substring(0,10) : e.start?.date;
      return es === dayStr;
    });
    let evHtml = dayEvents.slice(0,3).map(e => {
      const color = e.colorId ? '' : '';
      return `<div class="cal-event" onclick="editEvento(event,'${e.id}')" title="${e.summary||''}">${e.summary||'(senza titolo)'}</div>`;
    }).join('');
    if (dayEvents.length > 3) evHtml += `<div class="cal-more">+${dayEvents.length-3} altri</div>`;
    html += `<div class="cal-day${isToday?' today':''}" onclick="calDayClick('${dayStr}')">
      <div class="cal-day-num">${d}</div>${evHtml}</div>`;
  }
  // Giorni mese successivo
  const total = startDow + lastDay.getDate();
  const remaining = 7 - (total % 7);
  if (remaining < 7) for (let i = 1; i <= remaining; i++) {
    html += `<div class="cal-day other-month"><div class="cal-day-num">${i}</div></div>`;
  }
  html += '</div>';
  document.getElementById('cal-body').innerHTML = html;
}

function renderWeekView() {
  const start = getWeekStart(calDate);
  const days = ['Lun','Mar','Mer','Gio','Ven','Sab','Dom'];
  let html = `<div class="cal-week"><div class="cal-week-day"></div>`;
  for (let i = 0; i < 7; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    html += `<div class="cal-week-day">${days[i]}<br><strong>${d.getDate()}</strong></div>`;
  }
  for (let h = 7; h < 22; h++) {
    html += `<div class="cal-time-slot">${h}:00</div>`;
    for (let i = 0; i < 7; i++) {
      const d = new Date(start); d.setDate(d.getDate() + i);
      const dayStr = fmt(d);
      const slotEvents = calEvents.filter(e => {
        if (!e.start?.dateTime) return false;
        const es = new Date(e.start.dateTime);
        return fmt(es) === dayStr && es.getHours() === h;
      });
      html += `<div class="cal-week-cell" onclick="calDayClick('${dayStr}T${String(h).padStart(2,'0')}:00')">
        ${slotEvents.map(e => `<div class="cal-event" onclick="editEvento(event,'${e.id}')">${e.summary||''}</div>`).join('')}
      </div>`;
    }
  }
  html += '</div>';
  document.getElementById('cal-body').innerHTML = html;
}

function fmt(d) { return d.toISOString().substring(0,10); }
function calPrev() { if (calView==='month') calDate.setMonth(calDate.getMonth()-1); else calDate.setDate(calDate.getDate()-7); loadCalendar(); }
function calNext() { if (calView==='month') calDate.setMonth(calDate.getMonth()+1); else calDate.setDate(calDate.getDate()+7); loadCalendar(); }
function calToday() { calDate = new Date(); loadCalendar(); }
function calSetView(v) { calView = v; document.querySelectorAll('.cal-view-btn').forEach(b => b.classList.toggle('active', b.textContent.toLowerCase().includes(v==='month'?'mese':'settimana'))); renderCalendar(); }

function calDayClick(dateStr) {
  currentEventId = null;
  document.getElementById('evento-id').value = '';
  document.getElementById('evento-title').value = '';
  document.getElementById('evento-desc').value = '';
  document.getElementById('btn-del-evento').style.display = 'none';
  // Pre-popola data
  if (dateStr.includes('T')) {
    document.getElementById('evento-start').value = dateStr;
    const end = new Date(dateStr); end.setHours(end.getHours()+1);
    document.getElementById('evento-end').value = end.toISOString().substring(0,16);
    document.getElementById('evento-allday').checked = false;
  } else {
    document.getElementById('evento-start').value = dateStr + 'T09:00';
    document.getElementById('evento-end').value = dateStr + 'T10:00';
  }
  openModal('modal-evento');
}

function editEvento(e, eventId) {
  e.stopPropagation();
  const ev = calEvents.find(x => x.id === eventId);
  if (!ev) return;
  currentEventId = eventId;
  document.getElementById('evento-id').value = eventId;
  document.getElementById('evento-title').value = ev.summary || '';
  document.getElementById('evento-desc').value = ev.description || '';
  document.getElementById('btn-del-evento').style.display = 'inline-flex';
  const allDay = !!ev.start?.date;
  document.getElementById('evento-allday').checked = allDay;
  if (allDay) {
    document.getElementById('evento-start').value = ev.start.date;
    document.getElementById('evento-end').value = ev.end?.date || ev.start.date;
  } else {
    document.getElementById('evento-start').value = ev.start?.dateTime?.substring(0,16) || '';
    document.getElementById('evento-end').value = ev.end?.dateTime?.substring(0,16) || '';
  }
  openModal('modal-evento');
}

async function salvaEvento() {
  const id = document.getElementById('evento-id').value;
  const body = {
    title: document.getElementById('evento-title').value,
    start: document.getElementById('evento-start').value,
    end: document.getElementById('evento-end').value || document.getElementById('evento-start').value,
    description: document.getElementById('evento-desc').value,
    allDay: document.getElementById('evento-allday').checked,
  };
  try {
    if (id) await api('PUT', `/google/calendar/events/${id}`, body);
    else await api('POST', '/google/calendar/events', body);
    closeAllModals();
    toast('Evento salvato', 'success');
    await loadCalendar();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteEvento() {
  const id = document.getElementById('evento-id').value;
  if (!id || !confirm('Eliminare questo evento da Google Calendar?')) return;
  try {
    await api('DELETE', `/google/calendar/events/${id}`);
    closeAllModals();
    toast('Evento eliminato', 'success');
    await loadCalendar();
  } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════
// ANAGRAFICHE
// ═══════════════════════════════
function openModalAnagrafica(tipo) {
  ensureAnagraficaLogisticaFields();
  document.getElementById('anag-id').value = '';
  document.getElementById('anag-tipo').value = tipo;
  document.getElementById('modal-anag-title').textContent = tipo === 'cliente' ? '👥 Cliente' : tipo === 'fornitore' ? '🏭 Fornitore' : '🏛️ PA';
  ['ragione','piva','cf','indirizzo','cap','citta','prov','email','tel','lat','lng','note'].forEach(f => {
    const el = document.getElementById(`anag-${f}`);
    if (el) el.value = f === 'paese' ? 'IT' : '';
  });
  const canale = document.getElementById('anag-canale-cliente');
  if (canale) canale.value = tipo === 'pa' ? 'mepa' : 'privato';
  openModal('modal-anagrafica');
}

async function loadAnagrafiche(tipo) {
  const q = document.getElementById(`search-${tipo === 'cliente' ? 'clienti' : 'fornitori'}`)?.value || '';
  const rows = await api('GET', `/anagrafiche?tipo=${tipo}&q=${encodeURIComponent(q)}`);
  const tbody = document.getElementById(`${tipo === 'cliente' ? 'clienti' : 'fornitori'}-body`);
  tbody.innerHTML = (rows || []).map(a => `
    <tr>
      <td><strong>${a.ragione_sociale}</strong>${a.tipo === 'cliente' ? `<div style="font-size:11px;color:var(--text-muted)">Canale: ${a.canale_cliente || 'privato'}</div>` : ''}</td>
      <td>${a.citta || '—'}</td>
      <td>${a.piva || '—'}</td>
      <td>${a.telefono || '—'}</td>
      <td>${a.email || '—'}</td>
      <td><button class="btn btn-outline btn-sm" onclick="editAnagrafica(${a.id})">Modifica</button></td>
    </tr>`).join('');
}

async function editAnagrafica(id) {
  ensureAnagraficaLogisticaFields();
  const a = await api('GET', `/anagrafiche/${id}`);
  document.getElementById('anag-id').value = a.id;
  document.getElementById('anag-tipo').value = a.tipo;
  document.getElementById('modal-anag-title').textContent = a.tipo === 'cliente' ? '👥 Cliente' : a.tipo === 'fornitore' ? '🏭 Fornitore' : '🏛️ PA';
  document.getElementById('anag-ragione').value = a.ragione_sociale;
  document.getElementById('anag-piva').value = a.piva || '';
  document.getElementById('anag-cf').value = a.cf || '';
  document.getElementById('anag-indirizzo').value = a.indirizzo || '';
  document.getElementById('anag-cap').value = a.cap || '';
  document.getElementById('anag-citta').value = a.citta || '';
  document.getElementById('anag-prov').value = a.provincia || '';
  document.getElementById('anag-email').value = a.email || '';
  document.getElementById('anag-tel').value = a.telefono || '';
  document.getElementById('anag-lat').value = a.lat || '';
  document.getElementById('anag-lng').value = a.lng || '';
  document.getElementById('anag-note').value = a.note || '';
  const canale = document.getElementById('anag-canale-cliente');
  if (canale) canale.value = a.canale_cliente || 'privato';
  openModal('modal-anagrafica');
}

async function salvaAnagrafica() {
  const id = document.getElementById('anag-id')?.value;
  const tipo = document.getElementById('anag-tipo')?.value || 'cliente';
  const body = {
    tipo,
    ragione_sociale: document.getElementById('anag-ragione')?.value || null,
    piva:     document.getElementById('anag-piva')?.value   || null,
    cf:       document.getElementById('anag-cf')?.value     || null,
    indirizzo:document.getElementById('anag-indirizzo')?.value || null,
    cap:      document.getElementById('anag-cap')?.value    || null,
    citta:    document.getElementById('anag-citta')?.value  || null,
    provincia:document.getElementById('anag-prov')?.value   || null,
    paese:    document.getElementById('anag-paese')?.value  || 'IT',
    email:    document.getElementById('anag-email')?.value  || null,
    telefono: document.getElementById('anag-tel')?.value    || null,
    lat:      parseFloat(document.getElementById('anag-lat')?.value) || null,
    lng:      parseFloat(document.getElementById('anag-lng')?.value) || null,
    note:     document.getElementById('anag-note')?.value   || null,
    canale_cliente: document.getElementById('anag-canale-cliente')?.value || 'privato',
    attivo: 1,
  };
  try {
    if (id) await api('PUT', `/anagrafiche/${id}`, body);
    else await api('POST', '/anagrafiche', body);
    closeAllModals(); toast('Salvato', 'success');
    const tipo2 = body.tipo;
    if (tipo2 === 'cliente' || tipo2 === 'pa') loadAnagrafiche('cliente');
    else loadAnagrafiche('fornitore');
  } catch (e) { toast(e.message, 'error'); }
}


// ═══════════════════════════════
// PRODOTTI
// ═══════════════════════════════
async function loadProdotti() {
  const q = document.getElementById('search-prod')?.value || '';
  const rows = await api('GET', `/prodotti?q=${encodeURIComponent(q)}`);
  document.getElementById('prod-body').innerHTML = (rows || []).map(p => {
    const listino = p.listini?.find(l => l.canale === 'mepa') || p.listini?.[0];
    const fornitore = p.fornitori?.[0];
    const margine = listino?.prezzo && fornitore?.prezzo_acquisto
      ? (((listino.prezzo - fornitore.prezzo_acquisto) / listino.prezzo) * 100).toFixed(1) + '%' : '—';
    return `<tr>
      <td><code>${p.codice_interno}</code></td>
      <td>${p.nome}<div style="font-size:11px;color:var(--text-muted)">${p.fatture_count || 0} fatture | ${p.ddt_count || 0} DDT</div></td>
      <td>${p.categoria_nome || '—'}</td>
      <td><strong style="color:${(p.giacenza||0) > 0 ? 'var(--success)' : 'var(--danger)'}">${p.giacenza || 0}</strong></td>
      <td>${listino ? '€ ' + listino.prezzo.toFixed(2) : '—'}</td>
      <td>${margine}</td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="editProdotto(${p.id})">Modifica</button>
        <button class="btn btn-outline btn-sm" onclick="getQR(${p.id})">QR</button>
      </td>
    </tr>`;
  }).join('');
}

async function editProdotto(id) {
  const p = await api('GET', `/prodotti/${id}`);
  document.getElementById('prod-id').value = p.id;
  document.getElementById('prod-codice').value = p.codice_interno;
  document.getElementById('prod-barcode').value = p.barcode || '';
  document.getElementById('prod-nome').value = p.nome;
  document.getElementById('prod-desc').value = p.descrizione || '';
  document.getElementById('prod-um').value = p.unita_misura || 'pz';
  document.getElementById('prod-peso').value = p.peso_kg || '';
  await loadCategorie();
  document.getElementById('prod-categoria').value = p.categoria_id || '';
  // Tab fornitori
  const fHtml = (p.fornitori||[]).length ? (p.fornitori||[]).map(f =>
    `<div style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:8px">
      <strong>${f.ragione_sociale}</strong> — ${f.codice_fornitore||'—'}
      <span style="float:right;color:var(--text-muted)">${f.prezzo_acquisto||'—'} ${f.valuta||'CNY'}</span>
    </div>`).join('') : '<p style="color:var(--text-muted)">Nessun fornitore associato</p>';
  document.getElementById('prod-tab-fornitori').innerHTML = fHtml;
  // Tab fatture
  const fatHtml = (p.fatture||[]).length ? (p.fatture||[]).map(f =>
    `<div style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:8px">
      Fattura <strong>${f.numero}</strong> — €${f.totale||0}
    </div>`).join('') : '<p style="color:var(--text-muted)">Nessuna fattura associata</p>';
  document.getElementById('prod-tab-fatture').innerHTML = fatHtml;
  const mediaHtml = renderProdottoMediaPanel(p);
  const listHtml = [
    mediaHtml,
    (p.listini||[]).length ? '<h4 style="font-size:12px;margin:8px 0">Listini</h4>' + (p.listini||[]).map(l =>
      `<div style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;font-size:12px">${l.canale || '-'} | EUR ${l.prezzo || 0} | CPV ${l.cpv || '-'}</div>`
    ).join('') : '<p style="color:var(--text-muted);font-size:13px">Nessun listino</p>',
    (p.ddt||[]).length ? '<h4 style="font-size:12px;margin:12px 0 8px">DDT collegati</h4>' + (p.ddt||[]).map(d =>
      `<div style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;font-size:12px">DDT <strong>${d.numero_ddt}</strong> ${d.tipo || ''} | q.ta ${d.quantita || '-'} | ${d.corriere || d.vettore || ''}</div>`
    ).join('') : '<p style="color:var(--text-muted);font-size:13px">Nessun DDT collegato</p>',
    (p.movimenti||[]).length ? '<h4 style="font-size:12px;margin:12px 0 8px">Ultimi movimenti</h4>' + (p.movimenti||[]).slice(0, 8).map(m =>
      `<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">${m.data || ''} | ${m.tipo} | q.ta ${m.quantita} | ${m.riferimento_tipo || 'manuale'} ${m.note ? '- ' + m.note : ''}</div>`
    ).join('') : ''
  ].join('');
  document.getElementById('prod-tab-listini').innerHTML = listHtml;
  document.getElementById('prod-tabs').style.display = 'block';
  openModal('modal-prodotto');
}

function renderProdottoMediaPanel(p) {
  const media = p.media || [];
  const immagini = media.filter(m => m.tipo === 'immagine');
  const docs = media.filter(m => m.tipo !== 'immagine');
  const canUpload = typeof uploadFotoProdotto === 'function';
  return `<h4 style="font-size:12px;margin:8px 0">Foto e schede tecniche</h4>
    <div style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:10px">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        ${immagini.map(m => `<div style="width:76px;height:76px;border:1px solid var(--border);border-radius:6px;overflow:hidden;background:var(--bg-input)">
          <img src="${m.path}" alt="${m.nome_file || 'foto prodotto'}" style="width:100%;height:100%;object-fit:cover">
        </div>`).join('')}
        ${canUpload ? `<label class="btn btn-outline btn-sm" style="height:76px;display:flex;align-items:center;cursor:pointer">
          Carica foto
          <input type="file" accept="image/*" multiple style="display:none" onchange="uploadFotoProdotto(${p.id},this.files,'immagine').then(()=>editProdotto(${p.id}))">
        </label>` : ''}
      </div>
      ${docs.length ? docs.map(m => `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 0;border-top:1px solid var(--border);font-size:12px">
        <a href="${m.path}" target="_blank" style="color:var(--accent)">${m.nome_file || 'Documento'}</a>
      </div>`).join('') : '<div style="color:var(--text-muted);font-size:12px;margin-bottom:6px">Nessuna scheda tecnica allegata</div>'}
      ${canUpload ? `<label class="btn btn-outline btn-sm" style="cursor:pointer;margin-top:6px">
        Allega scheda tecnica
        <input type="file" accept=".pdf,.doc,.docx,.xls,.xlsx" multiple style="display:none" onchange="uploadFotoProdotto(${p.id},this.files,'scheda_tecnica').then(()=>editProdotto(${p.id}))">
      </label>` : ''}
    </div>`;
}

function showProdTab(tab) {
  ['fornitori','fatture','listini'].forEach(t => {
    document.getElementById(`prod-tab-${t}`).style.display = t === tab ? 'block' : 'none';
  });
  document.querySelectorAll('.prod-tab').forEach((b,i) => {
    b.classList.toggle('active', ['fornitori','fatture','listini'][i] === tab);
  });
}

async function salvaProdotto() {
  const id = document.getElementById('prod-id').value;
  const body = {
    codice_interno: document.getElementById('prod-codice').value,
    barcode: document.getElementById('prod-barcode').value,
    nome: document.getElementById('prod-nome').value,
    descrizione: document.getElementById('prod-desc').value,
    categoria_id: document.getElementById('prod-categoria').value || null,
    unita_misura: document.getElementById('prod-um').value,
    peso_kg: parseFloat(document.getElementById('prod-peso').value) || null,
    attivo: 1,
  };
  try {
    if (id) await api('PUT', `/prodotti/${id}`, body);
    else await api('POST', '/prodotti', body);
    closeAllModals(); toast('Prodotto salvato', 'success'); loadProdotti();
  } catch (e) { toast(e.message, 'error'); }
}

async function loadCategorie() {
  const sel = document.getElementById('prod-categoria');
  if (sel.options.length > 1) return;
  const cats = [{id:1,nome:'Pulizia'},{id:2,nome:'Cancelleria'},{id:3,nome:'Elettrico'},{id:4,nome:'Ufficio'},{id:5,nome:'Altro'}];
  sel.innerHTML = '<option value="">Seleziona...</option>' + cats.map(c => `<option value="${c.id}">${c.nome}</option>`).join('');
}

async function getQR(id) {
  const data = await api('GET', `/etichetta/${id}/qr`);
  if (!data) return;
  const win = window.open('', '_blank', 'width=400,height=450');
  win.document.write(`<html><body style="background:#f4f6f9;font-family:Inter,sans-serif;padding:30px;text-align:center">
    <h3>${data.codice}</h3><img src="${data.qr}" style="width:200px"><br>
    <p>${data.nome}</p><a href="/api/etichetta/${id}/pdf">📥 PDF etichetta</a>
  </body></html>`);
}

// ═══════════════════════════════
// MAGAZZINO
// ═══════════════════════════════
async function loadMagazzino() {
  const rows = await api('GET', '/prodotti/magazzino/giacenze');
  document.getElementById('mag-body').innerHTML = (rows||[]).map(p => `
    <tr><td><code>${p.codice_interno}</code></td><td>${p.nome}</td><td>${p.categoria||'—'}</td>
    <td><strong style="color:${p.giacenza>0?'var(--success)':'var(--danger)'}">${p.giacenza}</strong></td></tr>`).join('');
  const sel = document.getElementById('mov-prodotto');
  sel.innerHTML = '<option value="">Seleziona...</option>' + (rows||[]).map(p => `<option value="${p.id}">${p.codice_interno} — ${p.nome}</option>`).join('');
}

async function salvaMovimento() {
  try {
    await api('POST', '/magazzino', { prodotto_id: document.getElementById('mov-prodotto').value, tipo: document.getElementById('mov-tipo').value, quantita: parseInt(document.getElementById('mov-quantita').value), note: document.getElementById('mov-note').value });
    closeAllModals(); toast('Movimento registrato', 'success'); loadMagazzino();
  } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════
// ORDINI
// ═══════════════════════════════
async function loadOrdini() {
  const tipo = document.getElementById('filter-tipo-ordine')?.value || '';
  const rows = await api('GET', `/ordini?tipo=${tipo}`);
  document.getElementById('ordini-body').innerHTML = (rows||[]).map(o => `
    <tr><td><strong>${o.codice_ordine}</strong></td>
    <td><span class="badge badge-${o.tipo==='vendita'?'cliente':'fornitore'}">${o.tipo}</span></td>
    <td>${o.ragione_sociale||'—'}</td><td>${o.data_ordine||'—'}</td>
    <td>${o.totale ? '€ '+o.totale.toFixed(2) : '—'}</td>
    <td><span class="badge badge-${o.stato}">${o.stato}</span></td>
    <td><select class="btn btn-outline btn-sm" onchange="cambiaStatoOrdine(${o.id},this.value)">
      ${['ricevuto','confermato','in_lavorazione','spedito','consegnato','annullato'].map(s=>`<option value="${s}"${o.stato===s?' selected':''}>${s}</option>`).join('')}
    </select></td></tr>`).join('');
  const anag = await api('GET', '/anagrafiche');
  const sel = document.getElementById('ord-anagrafica');
  sel.innerHTML = '<option value="">Seleziona...</option>' + (anag||[]).map(a=>`<option value="${a.id}">${a.ragione_sociale}</option>`).join('');
}

async function cambiaStatoOrdine(id, stato) { await api('PATCH', `/ordini/${id}/stato`, { stato }); }

async function salvaOrdine() {
  const body = {
    codice_ordine: document.getElementById('ord-codice').value,
    tipo: document.getElementById('ord-tipo').value,
    anagrafica_id: document.getElementById('ord-anagrafica').value || null,
    canale: document.getElementById('ord-canale').value,
    data_ordine: document.getElementById('ord-data').value,
    data_consegna_prevista: document.getElementById('ord-consegna').value,
    totale: parseFloat(document.getElementById('ord-totale').value) || null,
    note: document.getElementById('ord-note').value,
  };
  try { await api('POST', '/ordini', body); closeAllModals(); toast('Ordine salvato', 'success'); loadOrdini(); }
  catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════
// DDT
// ═══════════════════════════════
// ═══════════════════════════════
// CONTAINER
// ═══════════════════════════════
function ensureDdtModal() {
  if (document.getElementById('modal-ddt')) return;
  const modal = document.createElement('div');
  modal.id = 'modal-ddt';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-title">DDT</div>
      <div class="form-row">
        <div class="form-group"><label>Numero DDT</label><input type="text" id="ddt-numero" placeholder="auto se vuoto"></div>
        <div class="form-group"><label>Tipo</label><select id="ddt-tipo"><option value="uscita">Uscita</option><option value="entrata">Entrata</option></select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Data</label><input type="date" id="ddt-data"></div>
        <div class="form-group"><label>Destinatario / mittente</label><select id="ddt-destinatario"><option value="">Seleziona...</option></select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Fattura associata (opzionale)</label><select id="ddt-fattura"><option value="">Nessuna</option></select></div>
        <div class="form-group"><label>Vettore / note corriere</label><input type="text" id="ddt-vettore"></div>
      </div>
      <div class="form-group"><label style="display:flex;align-items:center;gap:8px;flex-direction:row"><input type="checkbox" id="ddt-spedizione"> Associa spedizione</label></div>
      <div class="form-row">
        <div class="form-group"><label>Corriere</label><select id="ddt-corriere"><option value="">Seleziona...</option><option value="dhl">DHL</option><option value="fedex">FedEx</option><option value="sda">SDA</option><option value="mailboxes">Mail Boxes</option><option value="gls">GLS</option><option value="brt">BRT</option><option value="altro">Altro</option></select></div>
        <div class="form-group"><label>Tracking</label><input type="text" id="ddt-tracking"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Prodotto (opzionale)</label><select id="ddt-prodotto"><option value="">Nessuno</option></select></div>
        <div class="form-group"><label>Quantita</label><input type="number" min="1" id="ddt-quantita"></div>
        <div class="form-group"><label>Lotto</label><input type="text" id="ddt-lotto"></div>
      </div>
      <div class="form-group"><label>Note</label><textarea id="ddt-note" rows="3" style="width:100%;background:var(--bg-input);border:1px solid var(--border);color:var(--text);padding:8px;border-radius:6px;font-family:inherit;font-size:14px"></textarea></div>
      <div class="form-group"><label>Note spedizione</label><input type="text" id="ddt-note-spedizione"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeAllModals()">Annulla</button>
        <button class="btn btn-accent" onclick="salvaDdt()">Salva DDT</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

async function preparaDdtModal() {
  ensureDdtModal();
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('ddt-data').value = today;
  document.getElementById('ddt-numero').value = 'DDT-' + today.replaceAll('-', '') + '-' + Math.floor(Math.random() * 1000);
  ['ddt-vettore','ddt-tracking','ddt-quantita','ddt-lotto','ddt-note','ddt-note-spedizione'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('ddt-tipo').value = 'uscita';
  document.getElementById('ddt-spedizione').checked = false;
  document.getElementById('ddt-corriere').value = '';
  const [anag, prodotti, fatture] = await Promise.all([api('GET', '/anagrafiche'), api('GET', '/prodotti'), api('GET', '/fatture')]);
  document.getElementById('ddt-destinatario').innerHTML = '<option value="">Seleziona...</option>' + (anag||[]).map(a=>`<option value="${a.id}">${a.ragione_sociale}</option>`).join('');
  document.getElementById('ddt-prodotto').innerHTML = '<option value="">Nessuno</option>' + (prodotti||[]).map(p=>`<option value="${p.id}">${p.codice_interno} - ${p.nome}</option>`).join('');
  document.getElementById('ddt-fattura').innerHTML = '<option value="">Nessuna</option>' + (fatture||[]).map(f=>`<option value="${f.id}">${f.numero} - ${f.ragione_sociale || ''}</option>`).join('');
}

async function loadDdt() {
  ensureDdtModal();
  const rows = await api('GET', '/ddt');
  const table = document.querySelector('#ddt-body')?.closest('table');
  const head = table?.querySelector('thead tr');
  if (head) head.innerHTML = '<th>Numero</th><th>Tipo</th><th>Destinatario</th><th>Data</th><th>Fattura</th><th>Spedizione</th><th>Righe</th><th>Azioni</th>';
  document.getElementById('ddt-body').innerHTML = (rows||[]).map(d=>`
    <tr><td><strong>${d.numero_ddt}</strong></td>
    <td><span class="badge badge-${d.tipo==='uscita'?'cliente':'fornitore'}">${d.tipo}</span></td>
    <td>${d.destinatario_nome||'-'}</td><td>${d.data||'-'}</td>
    <td>${d.fattura_numero || '-'}</td>
    <td>${d.spedizione_attiva ? `${d.corriere || '-'} ${d.numero_spedizione || ''}` : '-'}</td>
    <td>${d.righe_count || 0}</td>
    <td><button class="btn btn-outline btn-sm" onclick="openApiPdf('/ddt/${d.id}/pdf')">PDF</button></td></tr>`).join('');
}

async function openApiPdf(path) {
  const res = await fetch('/api' + path, { headers: { 'Authorization': `Bearer ${TOKEN}` } });
  if (!res.ok) { toast('PDF non disponibile', 'error'); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function salvaDdt() {
  const prodottoId = document.getElementById('ddt-prodotto').value;
  const quantita = parseInt(document.getElementById('ddt-quantita').value) || null;
  const righe = prodottoId && quantita ? [{ prodotto_id: prodottoId, quantita, lotto: document.getElementById('ddt-lotto').value || null }] : [];
  const body = {
    numero_ddt: document.getElementById('ddt-numero').value,
    tipo: document.getElementById('ddt-tipo').value,
    data: document.getElementById('ddt-data').value,
    destinatario_id: document.getElementById('ddt-destinatario').value || null,
    fattura_id: document.getElementById('ddt-fattura').value || null,
    vettore: document.getElementById('ddt-vettore').value || null,
    spedizione_attiva: document.getElementById('ddt-spedizione').checked ? 1 : 0,
    corriere: document.getElementById('ddt-corriere').value || null,
    numero_spedizione: document.getElementById('ddt-tracking').value || null,
    note: document.getElementById('ddt-note').value || null,
    note_spedizione: document.getElementById('ddt-note-spedizione').value || null,
    righe,
  };
  try {
    await api('POST', '/ddt', body);
    closeAllModals(); toast('DDT salvato', 'success'); loadDdt(); loadMagazzino();
  } catch (e) { toast(e.message, 'error'); }
}

async function loadContainer() {
  const rows = await api('GET', '/container');
  document.getElementById('container-body').innerHTML = (rows||[]).map(c=>{
    const tot = ((c.costo_trasporto||0)+(c.costo_dogana||0)+(c.costo_altri||0)).toFixed(2);
    return `<tr><td><strong>${c.numero_bl||'—'}</strong></td><td>${c.fornitore_nome||'—'}</td>
    <td>${c.data_partenza||'—'}</td><td>${c.data_arrivo_prevista||'—'}</td>
    <td><span class="badge badge-${c.stato}">${c.stato.replace(/_/g,' ')}</span></td>
    <td>€ ${tot}</td>
    <td><select class="btn btn-outline btn-sm" onchange="cambiaStatoContainer(${c.id},this.value)">
      ${['in_preparazione','in_transito','in_dogana','consegnato','annullato'].map(s=>`<option value="${s}"${c.stato===s?' selected':''}>${s.replace(/_/g,' ')}</option>`).join('')}
    </select></td></tr>`;
  }).join('');
}

async function cambiaStatoContainer(id, stato) { await api('PATCH', `/container/${id}/stato`, { stato }); loadContainer(); }

// ═══════════════════════════════
// FATTURE
// ═══════════════════════════════
async function loadFatture() {
  const tipo = document.getElementById('filter-tipo-fattura')?.value || '';
  const rows = await api('GET', `/fatture?tipo=${tipo}`);
  document.getElementById('fatture-body').innerHTML = (rows||[]).map(f=>`
    <tr><td><strong>${f.numero}</strong></td>
    <td><span class="badge badge-${f.tipo==='ricevuta'?'fornitore':'cliente'}">${f.tipo}</span></td>
    <td>${f.ragione_sociale||'—'}</td><td>${f.data||'—'}</td>
    <td>${f.totale ? '€ '+f.totale.toFixed(2) : '—'}</td>
    <td><span class="badge badge-${f.stato}">${f.stato}</span></td>
    <td><select class="btn btn-outline btn-sm" onchange="cambiaStatoFattura(${f.id},this.value)">
      ${['ricevuta','pagata','scaduta','annullata'].map(s=>`<option value="${s}"${f.stato===s?' selected':''}>${s}</option>`).join('')}
    </select></td></tr>`).join('');
}

async function cambiaStatoFattura(id, stato) { await api('PATCH', `/fatture/${id}/stato`, { stato }); }

async function importXML(input) {
  const file = input.files[0]; if (!file) return;
  const fd = new FormData(); fd.append('file', file);
  try {
    const res = await apiForm('POST', '/fatture/import/xml', fd);
    if (res?.parsed) {
      document.getElementById('xml-preview').style.display = 'block';
      document.getElementById('xml-data').innerHTML = `
        <b>Numero:</b> ${res.parsed.numero||'—'}<br>
        <b>Data:</b> ${res.parsed.data||'—'}<br>
        <b>Totale:</b> € ${res.parsed.totale||0}<br>
        <b>Fornitore P.IVA:</b> ${res.parsed.fornitore_piva||'—'}<br>
        <b>Righe:</b> ${res.parsed.righe?.length||0}`;
      toast('Fattura importata', 'success');
      loadFatture();
    }
  } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════
// ATTIVITA
// ═══════════════════════════════
const ICONE = { telefonata:'📞', appuntamento:'📅', email:'✉️', visita:'🤝', nota:'📝' };
async function loadAttivita() {
  const rows = await api('GET', '/attivita');
  document.getElementById('attivita-list').innerHTML = (rows||[]).map(a=>`
    <div class="attivita-item">
      <div class="att-icon att-${a.tipo}">${ICONE[a.tipo]||'◎'}</div>
      <div>
        <strong>${a.oggetto||a.tipo}</strong>
        ${a.ragione_sociale ? `<span style="color:var(--text-muted)"> — ${a.ragione_sociale}</span>` : ''}
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px">
          ${a.data_ora ? new Date(a.data_ora).toLocaleString('it') : ''}
          ${a.durata_minuti ? ` · ${a.durata_minuti} min` : ''}
          ${a.google_event_id ? ' · <span style="color:var(--accent)">📅 Google Cal</span>' : ''}
        </div>
        ${a.note ? `<div style="font-size:13px;margin-top:6px;color:var(--text-muted)">${a.note}</div>` : ''}
      </div>
    </div>`).join('') || '<p style="color:var(--text-muted)">Nessuna attività</p>';
  const anag = await api('GET', '/anagrafiche');
  const sel = document.getElementById('att-anagrafica');
  sel.innerHTML = '<option value="">Seleziona...</option>' + (anag||[]).map(a=>`<option value="${a.id}">${a.ragione_sociale}</option>`).join('');
}

async function salvaAttivita() {
  const body = {
    tipo: document.getElementById('att-tipo').value,
    anagrafica_id: document.getElementById('att-anagrafica').value || null,
    data_ora: document.getElementById('att-data').value,
    durata_minuti: parseInt(document.getElementById('att-durata').value)||null,
    oggetto: document.getElementById('att-oggetto').value,
    note: document.getElementById('att-note').value,
    promemoria_il: document.getElementById('att-promemoria').value || null,
  };
  try {
    const r = await api('POST', '/attivita', body);
    if (document.getElementById('att-sync-google').checked && USER.hasGoogle) {
      const ev = { summary: body.oggetto||body.tipo, description: body.note||'', start: { dateTime: new Date(body.data_ora).toISOString(), timeZone: 'Europe/Rome' }, end: { dateTime: new Date(new Date(body.data_ora).getTime()+(body.durata_minuti||60)*60000).toISOString(), timeZone: 'Europe/Rome' } };
      await api('POST', '/google/calendar/events', ev);
    }
    closeAllModals(); toast('Attività salvata', 'success'); loadAttivita();
  } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════
// DOCUMENTI DRIVE
// ═══════════════════════════════
async function loadDocumenti() {
  if (!USER?.hasGoogle) {
    document.getElementById('drive-files').innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)"><div style="font-size:40px">📁</div><p>Connetti Google per accedere ai documenti</p><button class="btn btn-accent" style="margin-top:16px" onclick="connectGoogle()">Connetti Google</button></div>';
    return;
  }
  document.getElementById('drive-files').innerHTML = '<p style="color:var(--text-muted)">Caricamento...</p>';
  const res = await api('GET', '/google/drive/files');
  if (res?.error) { document.getElementById('drive-files').innerHTML = `<p style="color:var(--danger)">${res.error}</p>`; return; }
  const files = res?.files || [];
  document.getElementById('drive-files').innerHTML = files.length ?
    files.map(f => `
      <div class="drive-file">
        <button class="drive-file-del" onclick="deleteDriveFile('${f.id}',this)">✕</button>
        <div class="drive-file-icon">${driveIcon(f.mimeType)}</div>
        <a href="${f.webViewLink}" target="_blank" style="text-decoration:none">
          <div class="drive-file-name">${f.name}</div>
        </a>
        <div class="drive-file-size">${formatSize(f.size)}</div>
      </div>`).join('') :
    '<p style="color:var(--text-muted);padding:20px">Nessun file nella cartella documenti_crm</p>';

  // Drag & drop
  const zone = document.getElementById('upload-zone');
  zone.ondragover = e => { e.preventDefault(); zone.classList.add('dragover'); };
  zone.ondragleave = () => zone.classList.remove('dragover');
  zone.ondrop = e => { e.preventDefault(); zone.classList.remove('dragover'); uploadDriveFiles(e.dataTransfer.files); };
}

async function uploadDriveFiles(files) {
  for (const file of Array.from(files)) {
    const fd = new FormData(); fd.append('file', file);
    try {
      await apiForm('POST', '/google/drive/upload', fd);
      toast(`${file.name} caricato`, 'success');
    } catch (e) { toast(e.message, 'error'); }
  }
  loadDocumenti();
}

async function deleteDriveFile(fileId, btn) {
  if (!confirm('Eliminare questo file da Google Drive?')) return;
  try { await api('DELETE', `/google/drive/files/${fileId}`); toast('File eliminato', 'success'); loadDocumenti(); }
  catch (e) { toast(e.message, 'error'); }
}

function driveIcon(mime) {
  if (mime?.includes('pdf')) return '📄';
  if (mime?.includes('image')) return '🖼️';
  if (mime?.includes('spreadsheet') || mime?.includes('excel')) return '📊';
  if (mime?.includes('presentation')) return '📊';
  if (mime?.includes('document') || mime?.includes('word')) return '📝';
  if (mime?.includes('folder')) return '📁';
  return '📎';
}

function formatSize(bytes) {
  if (!bytes) return '';
  const b = parseInt(bytes);
  if (b < 1024) return b + ' B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  return (b/(1024*1024)).toFixed(1) + ' MB';
}

// ═══════════════════════════════
// MAPPA PA
// ═══════════════════════════════
async function loadMappa() {
  const pa = await api('GET', '/anagrafiche/pa/mappa');
  const c = document.getElementById('mappa-container');
  if (!pa?.length) { c.innerHTML = '<p style="padding:40px;color:var(--text-muted)">Nessuna PA con coordinate. Aggiungi lat/lng nelle anagrafiche PA.</p>'; return; }
  c.innerHTML = `<div style="padding:20px"><table class="data-table"><thead><tr><th>PA</th><th>Città</th><th>Categoria</th><th>Coordinate</th><th></th></tr></thead><tbody>
    ${pa.map(p=>`<tr><td>${p.ragione_sociale}</td><td>${p.citta||'—'}</td><td>${p.categoria_pa||'—'}</td>
    <td style="font-size:11px;color:var(--text-muted)">${p.lat}, ${p.lng}</td>
    <td><a href="https://maps.google.com/?q=${p.lat},${p.lng}" target="_blank" style="color:var(--accent)">Apri mappa →</a></td></tr>`).join('')}
    </tbody></table></div>`;
}

// ═══════════════════════════════
// UTENTI
// ═══════════════════════════════
const RUOLI_NOMI = {1:'readonly',2:'editor',3:'candelete',4:'superuser'};
async function loadUtenti() {
  const rows = await api('GET', '/utenti');
  document.getElementById('utenti-body').innerHTML = (rows||[]).map(u=>`
    <tr><td>${u.nome}</td><td>${u.email}</td>
    <td><span class="badge badge-${RUOLI_NOMI[u.ruolo_id]||''}">${u.ruolo_nome||'—'}</span></td>
    <td>${u.tema==='light'?'☀️ Chiaro':'🌙 Scuro'}</td>
    <td>${u.attivo?'✅':'❌'}</td>
    <td><button class="btn btn-outline btn-sm" onclick="editUtente(${u.id})">Modifica</button></td></tr>`).join('');
  loadPermessi(document.getElementById('sel-ruolo-perm').value);
}

async function editUtente(id) {
  const rows = await api('GET', '/utenti');
  const u = rows?.find(x => x.id === id);
  if (!u) return;
  document.getElementById('utente-id').value = u.id;
  document.getElementById('utente-nome').value = u.nome;
  document.getElementById('utente-email').value = u.email;
  document.getElementById('utente-password').value = '';
  document.getElementById('utente-ruolo').value = u.ruolo_id;
  document.getElementById('utente-tema').value = u.tema || 'dark';
  document.getElementById('utente-attivo').value = u.attivo;
  openModal('modal-utente');
}

async function salvaUtente() {
  const id = document.getElementById('utente-id').value;
  const body = { nome: document.getElementById('utente-nome').value, email: document.getElementById('utente-email').value, password: document.getElementById('utente-password').value, ruolo_id: parseInt(document.getElementById('utente-ruolo').value), tema: document.getElementById('utente-tema').value, attivo: parseInt(document.getElementById('utente-attivo').value) };
  if (!body.password) delete body.password;
  try {
    if (id) await api('PUT', `/utenti/${id}`, body);
    else await api('POST', '/utenti', body);
    closeAllModals(); toast('Utente salvato', 'success'); loadUtenti();
  } catch (e) { toast(e.message, 'error'); }
}

const SEZIONI = ['clienti','fornitori','prodotti','magazzino','ordini','ddt','container','fatture','attivita','documenti'];
async function loadPermessi(ruoloId) {
  const perms = await api('GET', `/utenti/permessi/${ruoloId}`);
  const permMap = {};
  (perms||[]).forEach(p => permMap[p.sezione] = p);
  document.getElementById('perm-table').innerHTML = `
    <thead><tr><th>Sezione</th><th>Leggi</th><th>Modifica</th><th>Elimina</th><th>Admin</th></tr></thead>
    <tbody>${SEZIONI.map(s => {
      const p = permMap[s] || {};
      return `<tr><td>${s}</td>
        <td><input type="checkbox" data-s="${s}" data-a="read" ${p.can_read?'checked':''}></td>
        <td><input type="checkbox" data-s="${s}" data-a="edit" ${p.can_edit?'checked':''}></td>
        <td><input type="checkbox" data-s="${s}" data-a="delete" ${p.can_delete?'checked':''}></td>
        <td><input type="checkbox" data-s="${s}" data-a="admin" ${p.can_admin?'checked':''}></td></tr>`;
    }).join('')}</tbody>`;
}

async function salvaPermessi() {
  const ruoloId = document.getElementById('sel-ruolo-perm').value;
  const permessi = SEZIONI.map(s => ({
    sezione: s,
    can_read: document.querySelector(`[data-s="${s}"][data-a="read"]`)?.checked ? 1 : 0,
    can_edit: document.querySelector(`[data-s="${s}"][data-a="edit"]`)?.checked ? 1 : 0,
    can_delete: document.querySelector(`[data-s="${s}"][data-a="delete"]`)?.checked ? 1 : 0,
    can_admin: document.querySelector(`[data-s="${s}"][data-a="admin"]`)?.checked ? 1 : 0,
  }));
  try { await api('PUT', `/utenti/permessi/${ruoloId}`, { permessi }); toast('Permessi salvati', 'success'); }
  catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════
// MODAL UTILS
// ═══════════════════════════════
async function openModal(id) {
  if (id === 'modal-ddt') await preparaDdtModal();
  document.getElementById('overlay').style.display = 'block';
  document.getElementById(id).style.display = 'block';
}
function closeAllModals() {
  document.getElementById('overlay').style.display = 'none';
  document.querySelectorAll('.modal').forEach(m => { m.style.display = 'none'; });
}

// Enter login
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('login-screen').style.display !== 'none') doLogin();
});

init();
