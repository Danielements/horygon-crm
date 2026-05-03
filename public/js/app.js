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
let isMobileSidebarOpen = false;
let notificationsCache = [];
let tableEnhancementScheduled = false;
let googleMapsPromise = null;
let crmMap = null;
let crmMapMarkers = [];
let preventivoProdottiCache = [];
let ordineProdottiCache = [];
let ordineAnagraficheCache = [];
let fatturaProdottiCache = [];
let fatturaAnagraficheCache = [];
let recordPickerState = null;
let documentRecipientOptions = [];
let FORCE_PASSWORD_CHANGE = false;
let notificationsPollTimer = null;
let serviceWorkerRegistrationPromise = null;
let pushSupport = { configured: false, publicKey: '', activeSubscriptions: 0 };
let openNotificationsOnBoot = new URLSearchParams(window.location.search).get('openNotifications') === '1';

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
  const contentType = res.headers.get('content-type') || '';
  const raw = await res.text();
  let data = {};
  if (raw) {
    if (contentType.includes('application/json')) {
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`Risposta JSON non valida da ${path}`);
      }
    } else {
      const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 180);
      throw new Error(`Risposta non valida da ${path} (${res.status}): ${snippet}`);
    }
  }
  if (!res.ok) throw new Error(data.error || `Errore HTTP ${res.status}`);
  return data;
}

async function apiForm(method, path, formData) {
  const res = await fetch('/api' + path, { method, headers: { 'Authorization': `Bearer ${TOKEN}` }, body: formData });
  if (res.status === 401) { logout(); return null; }
  const contentType = res.headers.get('content-type') || '';
  const raw = await res.text();
  if (!contentType.includes('application/json')) {
    const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 180);
    throw new Error(`Risposta non valida da ${path} (${res.status}): ${snippet}`);
  }
  const data = raw ? JSON.parse(raw) : {};
  if (!res.ok) throw new Error(data.error || `Errore HTTP ${res.status}`);
  return data;
}

function registerPwaSupport() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    serviceWorkerRegistrationPromise = navigator.serviceWorker.register('/service-worker.js').then(reg => {
      navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);
      return reg;
    }).catch(err => {
      console.warn('Service worker non registrato', err);
      return null;
    });
  });
}

function handleServiceWorkerMessage(event) {
  const type = event?.data?.type;
  if (type === 'push-refresh') {
    notificationsCache = [];
    loadNotifications(true).catch(() => {});
    return;
  }
  if (type === 'open-notifications') {
    navigateTo('notifiche');
  }
}

function isStandalonePwa() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isAppleMobile() {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent || '');
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function getServiceWorkerRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  if (serviceWorkerRegistrationPromise) return serviceWorkerRegistrationPromise;
  serviceWorkerRegistrationPromise = navigator.serviceWorker.getRegistration('/service-worker.js');
  return serviceWorkerRegistrationPromise;
}

function updatePushUiState() {
  const button = document.getElementById('btn-push-toggle');
  if (!button) return;
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    button.textContent = 'Push non supportate';
    button.disabled = true;
    return;
  }
  if (!pushSupport.configured || !pushSupport.publicKey) {
    button.textContent = 'Push non configurate';
    button.disabled = true;
    return;
  }
  button.disabled = false;
  if (Notification.permission === 'granted' && pushSupport.activeSubscriptions > 0) {
    button.textContent = 'Push attive';
    button.classList.add('btn-accent');
    button.classList.remove('btn-outline');
    return;
  }
  if (Notification.permission === 'denied') {
    button.textContent = 'Push bloccate';
    button.classList.add('btn-outline');
    button.classList.remove('btn-accent');
    return;
  }
  button.textContent = 'Attiva push PWA';
  button.classList.add('btn-outline');
  button.classList.remove('btn-accent');
}

async function loadPushStatus() {
  if (!TOKEN) return;
  try {
    pushSupport = await api('GET', '/google/push/status') || pushSupport;
  } catch (error) {
    console.warn('Stato push non disponibile', error);
  }
  updatePushUiState();
}

async function syncPushBadgeFromNotifications(rows = []) {
  const unread = (rows || []).filter(row => !row.letta).length;
  try {
    if ('setAppBadge' in navigator) {
      if (unread > 0) await navigator.setAppBadge(unread);
      else if ('clearAppBadge' in navigator) await navigator.clearAppBadge();
    }
  } catch {}
}

async function ensurePushSubscription() {
  if (!pushSupport.configured || !pushSupport.publicKey) return false;
  const reg = await getServiceWorkerRegistration();
  if (!reg) return false;
  let subscription = await reg.pushManager.getSubscription();
  if (!subscription) {
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(pushSupport.publicKey)
    });
  }
  await api('POST', '/google/push/subscription', { subscription: subscription.toJSON() });
  await loadPushStatus();
  return true;
}

async function enablePushNotifications() {
  if (isAppleMobile() && !isStandalonePwa()) {
    toast('Su iPhone aggiungi prima la web app alla Home per usare le push', 'info');
    return;
  }
  if (!('Notification' in window) || !('PushManager' in window)) {
    toast('Questo browser non supporta le push PWA', 'error');
    return;
  }
  if (!pushSupport.configured || !pushSupport.publicKey) {
    toast('Push non ancora configurate sul server', 'error');
    return;
  }
  if (Notification.permission === 'denied') {
    toast('Permesso notifiche negato nel browser', 'error');
    return;
  }
  const permission = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission();
  if (permission !== 'granted') {
    toast('Permesso notifiche non concesso', 'info');
    updatePushUiState();
    return;
  }
  const ok = await ensurePushSubscription();
  if (!ok) {
    toast('Registrazione push non riuscita', 'error');
    return;
  }
  toast('Push PWA attivate', 'success');
}

async function togglePushNotifications() {
  if (Notification.permission === 'granted' && pushSupport.activeSubscriptions > 0) {
    toast('Le push sono già attive su questo dispositivo', 'info');
    return;
  }
  await enablePushNotifications();
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
  ensureAccountingSections();
  organizeNavigationLayout();
  ensureAuditNavLink();
  ensureSystemLogNavLink();
  configureMobileBottomNav();
  organizeDashboardLayout();
  if (!TOKEN) { showScreen('login-screen'); document.getElementById('setup-link').style.display = 'block'; return; }
  try {
    const me = await api('GET', '/auth/me');
    if (!me) return;
    USER = me;
    FORCE_PASSWORD_CHANGE = !!me.force_password_change;
    // Applica tema
    document.body.className = `theme-${USER.tema || 'dark'}`;
    document.getElementById('btn-tema').textContent = USER.tema === 'light' ? '🌙' : '☀️';
    // UI utente
    document.getElementById('user-name').textContent = USER.nome;
    document.getElementById('user-role').textContent = RUOLI_LABEL?.[USER.ruolo_id] || '';
    document.getElementById('user-avatar').textContent = USER.nome[0].toUpperCase();
    const automationNavIcon = document.querySelector('.nav-item[data-section="automazioni"] .nav-icon');
    if (automationNavIcon) automationNavIcon.innerHTML = '&#9889;';
    // Google status
    document.getElementById('btn-google').textContent = USER.hasGoogle ? '✅' : '🔗';
    // Permessi
    PERMS = {};
    (USER.permessi || []).forEach(p => { PERMS[p.sezione] = p; });
    ensureSystemLogNavLink();
    applyNavigationPermissions();
    showScreen('app');
    navigateTo('dashboard');
    await loadPushStatus();
    if (Notification.permission === 'granted') ensurePushSubscription().catch(() => {});
    if (openNotificationsOnBoot) {
      navigateTo('notifiche');
      openNotificationsOnBoot = false;
      history.replaceState({}, '', '/');
    }
    startNotificationsPolling();
    if (FORCE_PASSWORD_CHANGE) setTimeout(() => promptForcedPasswordChange(), 120);
  } catch {
    localStorage.removeItem('horygon_token');
    TOKEN = null;
    USER = null;
    showScreen('login-screen');
    document.getElementById('setup-link').style.display = 'block';
  }
}

const NAV_PERMISSION_MAP = {
  clienti: 'clienti',
  fornitori: 'fornitori',
  contatti: 'contatti',
  prodotti: 'prodotti',
  magazzino: 'magazzino',
  preventivi: 'ordini',
  ordini: 'ordini',
  ddt: 'ddt',
  container: 'container',
  fatture: 'fatture',
  'fatture-attive': 'fatture',
  'fatture-passive': 'fatture',
  'fatture-fuori-campo': 'fatture',
  cig: 'cig',
  mepa: 'mepa',
  rdo: 'mepa',
  notifiche: 'attivita',
    analytics: 'analytics',
    attivita: 'attivita',
    automazioni: 'settings',
    documenti: 'documenti',
    statistics: 'statistics',
    settings: 'settings',
    mappa: 'mappa',
    utenti: 'utenti',
    'audit-log': 'utenti',
    'system-log': 'settings'
};

function canReadSection(section) {
  if (USER?.ruolo_id === 4) return true;
  return !!PERMS?.[section]?.can_read;
}

function canEditSection(section) {
  if (USER?.ruolo_id === 4) return true;
  return !!PERMS?.[section]?.can_edit;
}

function applyNavigationPermissions() {
  document.querySelectorAll('.nav-item[data-section]').forEach(item => {
    const section = item.dataset.section;
    if (section === 'system-log') {
      item.style.display = USER?.ruolo_id === 4 ? 'flex' : 'none';
      return;
    }
    const permSection = NAV_PERMISSION_MAP[section];
    if (!permSection || section === 'dashboard') {
      item.style.display = 'flex';
      return;
    }
    item.style.display = canReadSection(permSection) ? 'flex' : 'none';
  });
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
function logout() {
  if (notificationsPollTimer) clearInterval(notificationsPollTimer);
  notificationsPollTimer = null;
  localStorage.removeItem('horygon_token');
  TOKEN = null;
  USER = null;
  FORCE_PASSWORD_CHANGE = false;
  showScreen('login-screen');
}
function connectGoogle() { window.location = '/api/auth/google'; }

function promptForcedPasswordChange() {
  const note = document.getElementById('pwd-force-note');
  const currentGroup = document.getElementById('pwd-current-group');
  const cancelBtn = document.getElementById('pwd-cancel-btn');
  if (note) note.style.display = FORCE_PASSWORD_CHANGE ? 'block' : 'none';
  if (currentGroup) currentGroup.style.display = FORCE_PASSWORD_CHANGE ? 'none' : 'block';
  if (cancelBtn) cancelBtn.style.display = FORCE_PASSWORD_CHANGE ? 'none' : 'inline-flex';
  openModal('modal-password');
}

async function changeMyPassword() {
  const current_password = document.getElementById('pwd-current')?.value || '';
  const new_password = document.getElementById('pwd-new')?.value || '';
  const confirm = document.getElementById('pwd-confirm')?.value || '';
  if ((!FORCE_PASSWORD_CHANGE && !current_password) || !new_password) {
    toast(FORCE_PASSWORD_CHANGE ? 'Compila la nuova password' : 'Compila password attuale e nuova password', 'error');
    return;
  }
  if (new_password !== confirm) {
    toast('La conferma password non coincide', 'error');
    return;
  }
  try {
    await api('POST', '/auth/change-password', { current_password, new_password });
    ['pwd-current','pwd-new','pwd-confirm'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    FORCE_PASSWORD_CHANGE = false;
    if (USER) USER.force_password_change = false;
    closeAllModals();
    toast('Password aggiornata', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

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
    if (el) el.style.display = s === id ? (s === 'app' ? '' : 'flex') : 'none';
  });
  if (id !== 'app') closeMobileSidebar();
}

function bindNavItem(item) {
  item.addEventListener('click', e => {
    e.preventDefault();
    const s = item.dataset.section;
    if (s) navigateTo(s);
  });
  return item;
}

function createNavItem(section, label, icon, id = '') {
  const a = document.createElement('a');
  a.className = 'nav-item';
  a.dataset.section = section;
  if (id) a.id = id;
  a.href = '#';
  a.innerHTML = `<span class="nav-icon">${icon}</span> ${label}`;
  return bindNavItem(a);
}

function ensureAccountingSections() {
  const base = document.getElementById('section-fatture');
  if (!base || base.dataset.accountingSplit === '1') return;
  const main = document.querySelector('#main-content');
  if (!main) return;
  base.id = 'section-fatture-attive';
  const title = base.querySelector('.page-header h1');
  if (title) title.textContent = 'Fatture attive';
  const headerActions = base.querySelector('.header-actions');
  const filter = document.getElementById('filter-tipo-fattura');
  if (filter) filter.remove();
  const tbody = document.getElementById('fatture-body');
  if (tbody) tbody.id = 'fatture-attive-body';
  const theadRow = base.querySelector('thead tr');
  if (theadRow && !theadRow.dataset.ivaAdded) {
    const statoTh = theadRow.children[5];
    const ivaTh = document.createElement('th');
    ivaTh.textContent = 'IVA';
    theadRow.insertBefore(ivaTh, statoTh);
    theadRow.dataset.ivaAdded = '1';
  }
  base.dataset.accountingSplit = '1';

  const passive = base.cloneNode(true);
  passive.id = 'section-fatture-passive';
  passive.classList.remove('active');
  const passiveTitle = passive.querySelector('.page-header h1');
  if (passiveTitle) passiveTitle.textContent = 'Fatture passive';
  const passiveBody = passive.querySelector('#fatture-attive-body');
  if (passiveBody) passiveBody.id = 'fatture-passive-body';
  const passiveHeaderActions = passive.querySelector('.header-actions');
  if (passiveHeaderActions) {
    const createBtn = [...passiveHeaderActions.querySelectorAll('button')].find(btn => btn.textContent.includes('Nuova Fattura'));
    if (createBtn) createBtn.remove();
  }

  const fuoriCampo = base.cloneNode(true);
  fuoriCampo.id = 'section-fatture-fuori-campo';
  fuoriCampo.classList.remove('active');
  const fuoriTitle = fuoriCampo.querySelector('.page-header h1');
  if (fuoriTitle) fuoriTitle.textContent = 'Fatture fuori campo IVA';
  const fuoriBody = fuoriCampo.querySelector('#fatture-attive-body');
  if (fuoriBody) fuoriBody.id = 'fatture-fuori-campo-body';
  const fuoriActions = fuoriCampo.querySelector('.header-actions');
  if (fuoriActions) {
    [...fuoriActions.querySelectorAll('button')].forEach(btn => {
      if (btn.textContent.includes('Nuova Fattura')) btn.remove();
    });
  }

  main.insertBefore(passive, base.nextSibling);
  main.insertBefore(fuoriCampo, passive.nextSibling);
}

function organizeNavigationLayout() {
  const nav = document.querySelector('#sidebar nav');
  if (!nav || nav.dataset.organized === '1') return;
  const itemMap = Object.fromEntries([...nav.querySelectorAll('.nav-item[data-section]')].map(item => [item.dataset.section, item]));
  if (itemMap.analytics) itemMap.analytics.innerHTML = '<span class="nav-icon">📊</span> Analisi API MEPA';
  const getItem = (section, label, icon, id = '') => itemMap[section] || createNavItem(section, label, icon, id);
  const groups = [
    { label: '', sections: ['dashboard'] },
    { label: 'Operativo', sections: ['attivita', 'notifiche'] },
    { label: 'Anagrafiche', sections: ['clienti', 'fornitori', 'contatti', 'mappa'] },
    { label: 'Logistica', sections: ['prodotti', 'magazzino', 'preventivi', 'ordini', 'ddt', 'container', 'documenti'] },
    { label: 'Contabilita', sections: ['fatture-attive', 'fatture-passive', 'fatture-fuori-campo'] },
    { label: 'Statistica', sections: ['mepa', 'rdo', 'analytics'] },
    { label: 'Amministrazione', sections: ['utenti', 'audit-log', 'system-log', 'automazioni'] }
  ];
  nav.innerHTML = '';
  groups.forEach(group => {
    if (group.label) {
      const label = document.createElement('div');
      label.className = 'nav-group-label';
      label.textContent = group.label;
      nav.appendChild(label);
    }
    group.sections.forEach(section => {
      const item = section === 'dashboard' ? getItem('dashboard', 'Dashboard', '◈')
        : section === 'attivita' ? getItem('attivita', 'Attività CRM', '📅')
        : section === 'notifiche' ? getItem('notifiche', 'Notifiche', '🔔')
        : section === 'clienti' ? getItem('clienti', 'Clienti', '👥')
        : section === 'fornitori' ? getItem('fornitori', 'Fornitori', '🏭')
        : section === 'contatti' ? getItem('contatti', 'Contatti', '📇')
        : section === 'mappa' ? getItem('mappa', 'Mappa CRM', '🗺️')
        : section === 'prodotti' ? getItem('prodotti', 'Prodotti', '📦')
        : section === 'magazzino' ? getItem('magazzino', 'Magazzino', '🏪')
        : section === 'preventivi' ? getItem('preventivi', 'Preventivi', '🧮')
        : section === 'ordini' ? getItem('ordini', 'Ordini', '📋')
        : section === 'ddt' ? getItem('ddt', 'DDT', '🚚')
        : section === 'container' ? getItem('container', 'Container CN', '🚢')
        : section === 'documenti' ? getItem('documenti', 'Documenti', '📁')
        : section === 'fatture-attive' ? getItem('fatture-attive', 'Fatture attive', '🧾')
        : section === 'fatture-passive' ? getItem('fatture-passive', 'Fatture passive', '🧾')
        : section === 'fatture-fuori-campo' ? getItem('fatture-fuori-campo', 'Fuori campo IVA', '🧾')
        : section === 'cig' ? getItem('cig', 'Stagionalità CIG', '📉')
        : section === 'mepa' ? getItem('mepa', 'Abilitazioni CPV MEPA', '📊')
        : section === 'rdo' ? getItem('rdo', 'RdO', '📝')
        : section === 'analytics' ? getItem('analytics', 'Analisi API MEPA', '📊')
        : section === 'statistics' ? getItem('statistics', 'Statistiche', '📈')
        : section === 'utenti' ? getItem('utenti', 'Utenti', '⚙️', 'nav-utenti')
        : section === 'automazioni' ? getItem('automazioni', 'Automazioni', '⚡')
        : null;
      if (item) {
        nav.appendChild(item);
      }
    });
  });
  nav.dataset.organized = '1';
}

function ensureAuditNavLink() {
  const nav = document.querySelector('#sidebar nav');
  if (!nav || nav.querySelector('.nav-item[data-section="audit-log"]')) return;
  const utenti = nav.querySelector('.nav-item[data-section="utenti"]');
  const item = createNavItem('audit-log', 'Log Attivita', '🕘');
  if (utenti?.parentNode) utenti.parentNode.insertBefore(item, utenti);
  else nav.appendChild(item);
}

function ensureSystemLogNavLink() {
  const nav = document.querySelector('#sidebar nav');
  if (!nav || USER?.ruolo_id !== 4 || nav.querySelector('.nav-item[data-section="system-log"]')) return;
  const audit = nav.querySelector('.nav-item[data-section="audit-log"]');
  const item = createNavItem('system-log', 'System Log', '🧯');
  if (audit?.parentNode) audit.parentNode.insertBefore(item, audit.nextSibling);
  else nav.appendChild(item);
}

function configureMobileBottomNav() {
  const nav = document.getElementById('mobile-bottom-nav');
  if (!nav) return;
  nav.innerHTML = `
    <button class="mobile-tab active" data-section="dashboard" onclick="navigateTo('dashboard')"><span>⌂</span><small>Home</small></button>
    <button class="mobile-tab" data-section="clienti" onclick="navigateTo('clienti')"><span>👥</span><small>Anagr.</small></button>
    <button class="mobile-tab" data-section="ordini" onclick="navigateTo('ordini')"><span>📋</span><small>Logistica</small></button>
    <button class="mobile-tab" data-section="fatture-attive" onclick="navigateTo('fatture-attive')"><span>🧾</span><small>Contab.</small></button>
    <button class="mobile-tab" data-section="automazioni" onclick="navigateTo('automazioni')"><span>⚡</span><small>Auto.</small></button>
  `;
}

function startNotificationsPolling() {
  if (notificationsPollTimer) clearInterval(notificationsPollTimer);
  notificationsPollTimer = setInterval(() => {
    if (!TOKEN || document.hidden) return;
    loadNotifications(true).catch(() => {});
  }, 60000);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && TOKEN) loadNotifications(true).catch(() => {});
});

function organizeDashboardLayout() {
  const section = document.getElementById('section-dashboard');
  if (!section || section.dataset.organized === '1') return;
  const header = section.querySelector('.page-header');
  const calendar = document.getElementById('calendar-container');
  const kpis = section.querySelector('.kpi-grid');
  const focus = document.getElementById('dashboard-focus-cards');
  const quick = section.querySelector('.app-quick-actions');
  if (!header || !calendar || !kpis || !focus || !quick) return;
  const cockpit = document.createElement('div');
  cockpit.className = 'dashboard-cockpit';
  header.insertAdjacentElement('afterend', cockpit);
  cockpit.appendChild(calendar);
  section.appendChild(kpis);
  section.appendChild(focus);
  section.appendChild(quick);
  section.dataset.organized = '1';
}

function ensureAnagraficaLogisticaFields() {
  if (document.getElementById('anag-tipologia-cliente')) return;
  const note = document.getElementById('anag-note');
  if (!note || !note.parentElement) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="form-group">
      <label>Tipologia cliente</label>
      <select id="anag-tipologia-cliente" onchange="toggleAnagraficaPaFields()">
        <option value="privato">Privato</option>
        <option value="pa">PA</option>
      </select>
    </div>
    <div id="anag-pa-flags" style="display:none;margin-bottom:14px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input)">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Canali PA</div>
      <label style="display:inline-flex;align-items:center;gap:6px;margin-right:14px"><input type="checkbox" id="anag-pa-mepa"> MEPA</label>
      <label style="display:inline-flex;align-items:center;gap:6px;margin-right:14px"><input type="checkbox" id="anag-pa-sda"> SDA</label>
      <label style="display:inline-flex;align-items:center;gap:6px"><input type="checkbox" id="anag-pa-rdo"> RdO</label>
    </div>`;
  note.parentElement.insertAdjacentElement('beforebegin', wrap);
}

function toggleAnagraficaPaFields() {
  const tipo = document.getElementById('anag-tipologia-cliente')?.value || 'privato';
  const box = document.getElementById('anag-pa-flags');
  if (box) box.style.display = tipo === 'pa' ? 'block' : 'none';
}

// ═══════════════════════════════
// NAVIGAZIONE
// ═══════════════════════════════
document.querySelectorAll('.nav-item').forEach(a => {
  a.addEventListener('click', e => { e.preventDefault(); const s = a.dataset.section; if (s) navigateTo(s); });
});

function navigateTo(section) {
  if (FORCE_PASSWORD_CHANGE && section !== 'dashboard') {
    toast('Devi cambiare la password temporanea prima di continuare', 'error');
    promptForcedPasswordChange();
    section = 'dashboard';
  }
  const permSection = NAV_PERMISSION_MAP[section];
  if (permSection && !canReadSection(permSection)) {
    toast('Non hai accesso a questa sezione', 'error');
    section = 'dashboard';
  }
  closeDashboardNotifications();
  document.querySelectorAll('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.section === section));
  document.querySelectorAll('.mobile-tab').forEach(a => a.classList.toggle('active', a.dataset.section === section));
  document.querySelectorAll('.section').forEach(s => s.classList.toggle('active', s.id === `section-${section}`));
  const mobileTitle = document.getElementById('mobile-topbar-title');
  if (mobileTitle) {
    const titleMap = {
      dashboard: 'Home',
      attivita: 'Attivita',
      clienti: 'Clienti',
      fornitori: 'Fornitori',
      contatti: 'Contatti',
      prodotti: 'Prodotti',
      magazzino: 'Magazzino',
      preventivi: 'Preventivi',
      ordini: 'Ordini',
      ddt: 'DDT',
      container: 'Container',
      fatture: 'Fatture attive',
      'fatture-attive': 'Fatture attive',
      'fatture-passive': 'Fatture passive',
      'fatture-fuori-campo': 'Fuori campo IVA',
      mepa: 'CPV MEPA',
      analytics: 'Analisi',
      notifiche: 'Notifiche',
      automazioni: 'Automazioni',
      cig: 'Stagionalita CIG',
      documenti: 'Documenti',
      settings: 'Impostazioni',
      'audit-log': 'Log Attivita',
      'system-log': 'System Log',
      statistics: 'Statistiche',
      mappa: 'Mappa CRM',
      utenti: 'Utenti'
    };
    mobileTitle.textContent = titleMap[section] || 'Horygon CRM';
  }
  document.getElementById('main-content').scrollTop = 0;
  closeMobileSidebar();
  const map = {
    dashboard: loadDashboard, clienti: () => loadAnagrafiche('cliente'),
    fornitori: () => loadAnagrafiche('fornitore'), contatti: loadContacts, prodotti: loadProdotti,
    magazzino: loadMagazzino, preventivi: loadPreventivi, ordini: loadOrdini, ddt: loadDdt,
    container: loadContainer,
    fatture: () => loadFattureBySection('fatture-attive'),
    'fatture-attive': () => loadFattureBySection('fatture-attive'),
    'fatture-passive': () => loadFattureBySection('fatture-passive'),
    'fatture-fuori-campo': () => loadFattureBySection('fatture-fuori-campo'),
    attivita: loadAttivita, documenti: loadDocumenti,
    statistics: loadStatistics, settings: loadSettingsPage,
    'audit-log': loadAuditLog,
    'system-log': loadSystemLog,
    automazioni: loadAutomationPage,
    mappa: loadMappa, utenti: loadUtenti, mepa: loadMepa, rdo: loadRdoPage, 'opportunita-cpv': loadOpportunityCpv, cig: loadCIG, analytics: loadAnalytics,
    notifiche: loadNotificationsPage,
  };
  if (map[section]) map[section]();
  scheduleResponsiveEnhancement();
}

function isMobileViewport() {
  return window.innerWidth <= 980;
}

function syncMobileLayoutState() {
  const app = document.getElementById('app');
  if (!app) return;
  const mobile = isMobileViewport();
  document.body.classList.toggle('is-mobile', mobile);
  if (!mobile) {
    isMobileSidebarOpen = false;
    app.classList.remove('sidebar-open');
  }
}

function toggleMobileSidebar() {
  if (!isMobileViewport()) return;
  const app = document.getElementById('app');
  if (!app) return;
  isMobileSidebarOpen = !isMobileSidebarOpen;
  app.classList.toggle('sidebar-open', isMobileSidebarOpen);
}

function closeMobileSidebar() {
  const app = document.getElementById('app');
  if (!app) return;
  isMobileSidebarOpen = false;
  app.classList.remove('sidebar-open');
}
// ═══════════════════════════════
// DASHBOARD
// ═══════════════════════════════
async function loadDashboard() {
  const [ordini, prodotti, clienti, container, notifications] = await Promise.all([
    api('GET', '/ordini'), api('GET', '/prodotti'),
    api('GET', '/anagrafiche?tipo=cliente'), api('GET', '/container'),
    api('GET', '/google/notifications')
  ]);
  const openOrders = (ordini || []).filter(o => !['consegnato', 'annullato'].includes(String(o.stato || '').toLowerCase()));
  notificationsCache = notifications || [];
  document.getElementById('kpi-ordini').textContent = openOrders.length || 0;
  document.getElementById('kpi-prodotti').textContent = prodotti?.length || 0;
  document.getElementById('kpi-clienti').textContent = (clienti || []).filter(c => c.tipologia_cliente === 'pa').length || 0;
  document.getElementById('kpi-container').textContent = container?.filter(c => c.stato === 'in_transito').length || 0;
  renderDashboardFocusCards({ ordini: ordini || [], clienti: clienti || [], container: container || [], notifications: notificationsCache });
  loadCalendar();
  loadNotifications(false);
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
  if (isMobileViewport()) renderMobileAgendaView();
  else if (calView === 'month') renderMonthView();
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

function pad2(v) { return String(v).padStart(2, '0'); }
function fmt(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function toDateTimeLocalValue(d) { return `${fmt(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function normalizeLocalDateTime(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return `${value}:00`;
  return value;
}

function parseCalendarEventDate(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, day] = value.split('-').map(Number);
    return new Date(y, m - 1, day, 12, 0, 0);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getCalendarEventStart(evento) {
  return parseCalendarEventDate(evento?.start?.dateTime || evento?.start?.date);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeMailBody(value) {
  return String(value || '')
    .replace(/body\{[\s\S]*?(?=COMUNICAZIONE|Categorie di riferimento:|Identificativo Numerico Gara:)/i, '')
    .replace(/@[a-z-]+[^{]*\{[\s\S]*?\}/gi, ' ')
    .replace(/[A-Za-z0-9_-]+\{[^}]+\}/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(COMUNICAZIONE\s+RDO)/i, '\n$1\n')
    .replace(/(Categorie di riferimento:|Identificativo Numerico Gara:|Nome Gara:|Data pubblicazione:|Data ultima per la presentazione delle offerte:|Data termine richiesta chiarimenti:)/gi, '\n$1 ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function compactText(value, max = 180) {
  const text = normalizeMailBody(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max).trim()}…`;
}

function formatDateTimeIt(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatDateIt(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString('it-IT');
}

function formatCurrencyIt(value) {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (Number.isNaN(num)) return '—';
  return num.toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
}

function renderSummaryCards(targetId, items = []) {
  const box = document.getElementById(targetId);
  if (!box) return;
  box.innerHTML = items.map(item => `
    <div class="summary-card ${item.tone ? `tone-${item.tone}` : ''}">
      <div class="summary-card-top">
        <span class="summary-card-icon">${item.icon || '•'}</span>
        <span class="summary-card-label">${escapeHtml(item.label || '')}</span>
      </div>
      <div class="summary-card-value">${escapeHtml(item.value ?? '0')}</div>
      ${item.meta ? `<div class="summary-card-meta">${escapeHtml(item.meta)}</div>` : ''}
    </div>
  `).join('');
}

function renderDashboardFocusCards({ ordini = [], clienti = [], container = [], notifications = [] }) {
  const openOrders = ordini.filter(o => !['consegnato', 'annullato'].includes(String(o.stato || '').toLowerCase())).length;
  const mepaClients = clienti.filter(c => !!c.pa_mepa).length;
  const highAlerts = notifications.filter(n => !n.letta && n.livello_urgenza === 'alta').length;
  renderSummaryCards('dashboard-focus-cards', [
    { icon: '📦', label: 'Ordini da seguire', value: openOrders, meta: 'Lavorazione e consegne in corso', tone: 'primary' },
    { icon: '🏛️', label: 'Clienti MEPA', value: mepaClients, meta: 'PA già pronte per opportunità', tone: 'cyan' },
    { icon: '🚚', label: 'Logistica attiva', value: container.filter(c => c.stato === 'in_transito').length, meta: 'Container ancora in transito', tone: 'warning' },
    { icon: '🔔', label: 'Alert urgenti', value: highAlerts, meta: highAlerts ? 'Da leggere subito' : 'Situazione sotto controllo', tone: highAlerts ? 'danger' : 'success' }
  ]);
}

function renderAnagraficheMobileCards(targetId, rows = [], tipo = 'cliente') {
  const box = document.getElementById(targetId);
  if (!box) return;
  if (!rows.length) {
    box.innerHTML = '<div class="notification-empty">Nessun elemento trovato.</div>';
    return;
  }
  box.innerHTML = rows.map(a => {
    const channels = tipo === 'cliente' && a.tipologia_cliente === 'pa'
      ? [a.pa_mepa && 'MEPA', a.pa_sda && 'SDA', a.pa_rdo && 'RdO'].filter(Boolean)
      : [];
    return `
      <article class="mobile-record-card">
        <div class="mobile-record-head">
          <div>
            <h3>${escapeHtml(a.ragione_sociale || 'Anagrafica')}</h3>
            <div class="mobile-record-subtitle">${escapeHtml(a.citta || 'Località non indicata')}</div>
          </div>
          <span class="badge ${a.tipologia_cliente === 'pa' ? 'badge-pa' : ''}">${escapeHtml(a.tipologia_cliente || tipo)}</span>
        </div>
        <div class="mobile-record-meta">
          <span><strong>P.IVA</strong> ${escapeHtml(a.piva || '—')}</span>
          <span><strong>Tel</strong> ${escapeHtml(a.telefono || '—')}</span>
          <span><strong>Email</strong> ${escapeHtml(a.email || '—')}</span>
        </div>
        ${channels.length ? `<div class="mobile-record-tags">${channels.map(tag => `<span class="record-tag">${tag}</span>`).join('')}</div>` : ''}
        <div class="mobile-record-actions">
          <button class="btn btn-outline btn-sm" onclick="editAnagrafica(${a.id})">Apri scheda</button>
          ${a.email ? `<a class="btn btn-outline btn-sm" href="mailto:${escapeHtml(a.email)}">Email</a>` : ''}
          ${a.telefono ? `<a class="btn btn-outline btn-sm" href="tel:${escapeHtml(a.telefono)}">Chiama</a>` : ''}
        </div>
      </article>
    `;
  }).join('');
}

function renderOrdiniMobileCards(rows = []) {
  const box = document.getElementById('ordini-mobile-list');
  if (!box) return;
  if (!rows.length) {
    box.innerHTML = '<div class="notification-empty">Nessun ordine trovato.</div>';
    return;
  }
  box.innerHTML = rows.map(o => `
    <article class="mobile-record-card">
      <div class="mobile-record-head">
        <div>
          <h3>${escapeHtml(o.codice_ordine || 'Ordine')}</h3>
          <div class="mobile-record-subtitle">${escapeHtml(o.ragione_sociale || 'Cliente/Fornitore non assegnato')}</div>
        </div>
        <span class="badge badge-${o.tipo === 'vendita' ? 'cliente' : 'fornitore'}">${escapeHtml(o.tipo || 'ordine')}</span>
      </div>
      <div class="mobile-record-meta">
        <span><strong>Data</strong> ${formatDateIt(o.data_ordine)}</span>
        <span><strong>Totale</strong> ${formatCurrencyIt(o.totale)}</span>
        <span><strong>Stato</strong> ${escapeHtml(String(o.stato || '-').replace(/_/g, ' '))}</span>
      </div>
      ${renderDocumentSendMeta(o)}
      <div class="mobile-record-actions">
        <button class="btn btn-outline btn-sm" onclick="openApiPdf('/ordini/${o.id}/pdf')">PDF</button>
        <button class="btn btn-outline btn-sm" onclick="openSendDocumentModal('ordine',${o.id})">Invia</button>
        <button class="btn btn-outline btn-sm" onclick="creaDdtDaOrdine(${o.id})">Crea DDT</button>
        <button class="btn btn-danger btn-sm" onclick="deleteOrdine(${o.id})">Elimina</button>
        ${renderDocumentLogButton('ordine', o.id, 'mobile')}
        ${renderStateBadge(o.stato)}
        <select class="notification-urgency-select order-state-select" onchange="cambiaStatoOrdine(${o.id},this.value)">
          ${['ricevuto','confermato','in_lavorazione','spedito','consegnato','annullato'].map(s => `<option value="${s}"${o.stato === s ? ' selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
    </article>
  `).join('');
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
      const start = getCalendarEventStart(e);
      return start && fmt(start) === dayStr;
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
        const es = getCalendarEventStart(e);
        return es && !!e.start?.dateTime && fmt(es) === dayStr && es.getHours() === h;
      });
      html += `<div class="cal-week-cell" onclick="calDayClick('${dayStr}T${String(h).padStart(2,'0')}:00')">
        ${slotEvents.map(e => `<div class="cal-event" onclick="editEvento(event,'${e.id}')">${e.summary||''}</div>`).join('')}
      </div>`;
    }
  }
  html += '</div>';
  document.getElementById('cal-body').innerHTML = html;
}

function renderMobileAgendaView() {
  const body = document.getElementById('cal-body');
  if (!body) return;
  const today = new Date();
  const upcoming = (calEvents || [])
    .map(evento => ({
      ...evento,
      startDate: getCalendarEventStart(evento),
      allDay: !!evento?.start?.date
    }))
    .filter(evento => evento.startDate)
    .filter(evento => {
      const diff = evento.startDate.getTime() - today.getTime();
      return diff >= -86400000 * 2 && diff <= 86400000 * 21;
    })
    .sort((a, b) => a.startDate - b.startDate);

  if (!upcoming.length) {
    body.innerHTML = `
      <div class="cal-agenda-empty">
        <div style="font-size:28px">📭</div>
        <div>Nessun evento nelle prossime settimane</div>
        <button class="btn btn-accent btn-sm" onclick="openModal('modal-evento')">Nuovo evento</button>
      </div>`;
    return;
  }

  body.innerHTML = `<div class="cal-agenda-list">
    ${upcoming.map(evento => {
      const start = evento.startDate;
      const dayLabel = start.toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'short' });
      const timeLabel = evento.allDay ? 'Tutto il giorno' : start.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
      return `
        <button class="cal-agenda-item" onclick="editEvento(event,'${evento.id}')">
          <div class="cal-agenda-day">${escapeHtml(dayLabel)}</div>
          <div class="cal-agenda-content">
            <strong>${escapeHtml(evento.summary || '(senza titolo)')}</strong>
            <div class="cal-agenda-meta">${escapeHtml(timeLabel)}</div>
            ${evento.description ? `<div class="cal-agenda-desc">${escapeHtml(String(evento.description).slice(0, 140))}</div>` : ''}
          </div>
        </button>`;
    }).join('')}
  </div>`;
}
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
    document.getElementById('evento-end').value = toDateTimeLocalValue(end);
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
    const start = parseCalendarEventDate(ev.start?.dateTime);
    const end = parseCalendarEventDate(ev.end?.dateTime);
    document.getElementById('evento-start').value = start ? toDateTimeLocalValue(start) : '';
    document.getElementById('evento-end').value = end ? toDateTimeLocalValue(end) : '';
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
  const tipologia = document.getElementById('anag-tipologia-cliente');
  if (tipologia) tipologia.value = 'privato';
  ['anag-pa-mepa','anag-pa-sda','anag-pa-rdo'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.checked = false;
  });
  toggleAnagraficaPaFields();
  openModal('modal-anagrafica');
}

async function loadAnagrafiche(tipo) {
  const q = document.getElementById(`search-${tipo === 'cliente' ? 'clienti' : 'fornitori'}`)?.value || '';
  const rows = await api('GET', `/anagrafiche?tipo=${tipo}&q=${encodeURIComponent(q)}`);
  const tbody = document.getElementById(`${tipo === 'cliente' ? 'clienti' : 'fornitori'}-body`);
  tbody.innerHTML = (rows || []).map(a => `
    <tr>
      <td><strong>${a.ragione_sociale}</strong>${a.tipo === 'cliente' ? `<div style="font-size:11px;color:var(--text-muted)">Tipologia: ${a.tipologia_cliente || 'privato'}${a.tipologia_cliente === 'pa' ? ` | ${[a.pa_mepa ? 'MEPA' : '', a.pa_sda ? 'SDA' : '', a.pa_rdo ? 'RdO' : ''].filter(Boolean).join(', ') || 'nessun canale'}` : ''}</div>` : ''}</td>
      <td>${a.citta || '—'}</td>
      <td>${a.piva || '—'}</td>
      <td>${a.telefono || '—'}</td>
      <td>${a.email || '—'}</td>
      <td><button class="btn btn-outline btn-sm" onclick="editAnagrafica(${a.id})">Modifica</button></td>
    </tr>`).join('');
  if (tipo === 'cliente') {
    renderSummaryCards('clienti-summary', [
      { icon: '👥', label: 'Clienti trovati', value: rows?.length || 0, meta: q ? `Filtro: ${q}` : 'Vista completa', tone: 'primary' },
      { icon: '🏛️', label: 'Pubbliche Amministrazioni', value: (rows || []).filter(a => a.tipologia_cliente === 'pa').length, meta: 'Schede PA attive', tone: 'cyan' },
      { icon: '🛒', label: 'Canale MEPA', value: (rows || []).filter(a => !!a.pa_mepa).length, meta: 'Clienti con flag MEPA', tone: 'warning' },
      { icon: '✉️', label: 'Contattabili', value: (rows || []).filter(a => !!a.email || !!a.telefono).length, meta: 'Email o telefono presenti', tone: 'success' }
    ]);
    renderAnagraficheMobileCards('clienti-mobile-list', rows || [], 'cliente');
  }
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
  const tipologia = document.getElementById('anag-tipologia-cliente');
  if (tipologia) tipologia.value = a.tipologia_cliente || 'privato';
  document.getElementById('anag-pa-mepa').checked = !!a.pa_mepa;
  document.getElementById('anag-pa-sda').checked = !!a.pa_sda;
  document.getElementById('anag-pa-rdo').checked = !!a.pa_rdo;
  toggleAnagraficaPaFields();
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
    tipologia_cliente: document.getElementById('anag-tipologia-cliente')?.value || 'privato',
    pa_mepa: document.getElementById('anag-pa-mepa')?.checked ? 1 : 0,
    pa_sda: document.getElementById('anag-pa-sda')?.checked ? 1 : 0,
    pa_rdo: document.getElementById('anag-pa-rdo')?.checked ? 1 : 0,
    canale_cliente: document.getElementById('anag-tipologia-cliente')?.value === 'pa' ? 'mepa' : 'privato',
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
      <td>${p.categoria_nome || '—'}<div style="font-size:11px;color:var(--text-muted)">${p.cpv_mepa ? escapeHtml(formatCpvDisplay(p.cpv_mepa)) : 'CPV non assegnato'}</div></td>
      <td><strong style="color:${(p.giacenza||0) > 0 ? 'var(--success)' : 'var(--danger)'}">${p.giacenza || 0}</strong></td>
      <td>${listino ? '€ ' + listino.prezzo.toFixed(2) : '—'}</td>
      <td>${margine}</td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="editProdotto(${p.id})">Modifica</button>
        <button class="btn btn-outline btn-sm" onclick="getQR(${p.id})">QR</button>
        <button class="btn btn-danger btn-sm" onclick="eliminaProdotto(${p.id}, '${String(p.nome || '').replace(/'/g, "\\'")}')">Elimina</button>
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
  document.getElementById('prod-cpv-mepa').value = p.cpv_mepa || '';
  document.getElementById('prod-cpv-mepa-label').value = p.cpv_mepa_entry ? getRecordLabel('mepa-cpv', p.cpv_mepa_entry) : (p.cpv_mepa ? formatCpvDisplay(p.cpv_mepa) : '');
  ['prod-upload-foto','prod-upload-fatture','prod-upload-bolle','prod-upload-certificati'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  renderProdottoStoredFiles(p.media || []);
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

function renderProdottoStoredFiles(media = []) {
  const box = document.getElementById('prod-media-links');
  if (!box) return;
  if (!media.length) {
    box.innerHTML = '<div style="color:var(--text-muted);font-size:12px">Nessun file salvato.</div>';
    return;
  }
  const labels = {
    immagine: 'Foto',
    pdf: 'Documento',
    certificazione: 'Certificato',
    scheda_tecnica: 'Scheda tecnica'
  };
  box.innerHTML = media.map(file => `
    <div class="saved-file-link">
      <div>
        <strong>${labels[file.tipo] || file.tipo || 'File'}</strong><br>
        <a href="${file.path}" target="_blank">${escapeHtml(file.nome_file || 'Apri file')}</a>
      </div>
      <span style="color:var(--text-muted);font-size:11px">${escapeHtml(file.tipo || '')}</span>
    </div>
  `).join('');
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
    cpv_mepa: document.getElementById('prod-cpv-mepa').value || null,
    unita_misura: document.getElementById('prod-um').value,
    peso_kg: parseFloat(document.getElementById('prod-peso').value) || null,
    attivo: 1,
  };
  try {
    let prodottoId = id;
    if (id) await api('PUT', `/prodotti/${id}`, body);
    else {
      const created = await api('POST', '/prodotti', body);
      prodottoId = created?.id;
    }
    await uploadProdottoFiles(prodottoId || id);
    closeAllModals(); toast('Prodotto salvato', 'success'); loadProdotti();
  } catch (e) { toast(e.message, 'error'); }
}

async function uploadProdottoFiles(prodottoId) {
  if (!prodottoId || typeof uploadFotoProdotto !== 'function') return;
  const foto = document.getElementById('prod-upload-foto')?.files;
  const fatture = document.getElementById('prod-upload-fatture')?.files;
  const bolle = document.getElementById('prod-upload-bolle')?.files;
  const certificati = document.getElementById('prod-upload-certificati')?.files;
  if (foto?.length) await uploadFotoProdotto(prodottoId, foto, 'immagine');
  if (fatture?.length) await uploadFotoProdotto(prodottoId, fatture, 'pdf');
  if (bolle?.length) await uploadFotoProdotto(prodottoId, bolle, 'pdf');
  if (certificati?.length) await uploadFotoProdotto(prodottoId, certificati, 'certificazione');
}

function nuovoProdotto() {
  document.getElementById('prod-id').value = '';
  document.getElementById('prod-codice').value = '';
  document.getElementById('prod-barcode').value = '';
  document.getElementById('prod-nome').value = '';
  document.getElementById('prod-desc').value = '';
  document.getElementById('prod-um').value = 'pz';
  document.getElementById('prod-peso').value = '';
  document.getElementById('prod-cpv-mepa').value = '';
  document.getElementById('prod-cpv-mepa-label').value = '';
  document.getElementById('prod-tabs').style.display = 'none';
  ['prod-upload-foto','prod-upload-fatture','prod-upload-bolle','prod-upload-certificati'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  renderProdottoStoredFiles([]);
  loadCategorie();
  openModal('modal-prodotto');
}

async function eliminaProdotto(id, nome) {
  if (!confirm(`Archiviare il prodotto "${nome}"? Lo storico resta salvato, ma non comparira piu in magazzino.`)) return;
  try {
    await api('DELETE', `/prodotti/${id}`);
    toast('Prodotto archiviato', 'success');
    loadProdotti();
    loadMagazzino();
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
function escapeAttr(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getRecordLabel(entity, row) {
  if (entity === 'prodotti') return [row.codice_interno, row.nome].filter(Boolean).join(' - ');
  if (entity === 'anagrafiche') return row.ragione_sociale || row.nome || row.email || '';
  if (entity === 'mepa-cpv') return [formatCpvDisplay(row.codice_cpv || ''), row.desc || row.descrizione, row.categoria].filter(Boolean).join(' - ');
  return row.nome || row.ragione_sociale || row.codice_interno || row.id;
}

async function openRecordPicker(entity, options = {}) {
  const rows = entity === 'prodotti'
    ? await api('GET', '/prodotti')
    : entity === 'mepa-cpv'
      ? await api('GET', '/mepa/cpv-catalog?attivo=1')
      : await api('GET', `/anagrafiche${options.filterTipo ? `?tipo=${encodeURIComponent(options.filterTipo)}` : ''}`);
  recordPickerState = { entity, rows: rows || [], options };
  const head = document.getElementById('record-picker-head');
  const search = document.getElementById('record-picker-search');
  if (search) search.value = '';
  if (head) {
    head.innerHTML = entity === 'prodotti'
      ? '<th>Codice</th><th>Nome</th><th>Categoria</th><th></th>'
      : entity === 'mepa-cpv'
        ? '<th>CPV</th><th>Descrizione</th><th>Categoria</th><th></th>'
        : '<th>Ragione sociale</th><th>Tipo</th><th>P.IVA</th><th></th>';
  }
  renderRecordPickerRows(recordPickerState.rows);
  openModal('modal-record-picker');
}

function filterRecordPicker() {
  if (!recordPickerState) return;
  const q = (document.getElementById('record-picker-search')?.value || '').trim().toLowerCase();
  const filtered = !q ? recordPickerState.rows : recordPickerState.rows.filter(row => JSON.stringify(row).toLowerCase().includes(q));
  renderRecordPickerRows(filtered);
}

function renderRecordPickerRows(rows = []) {
  const body = document.getElementById('record-picker-body');
  if (!body || !recordPickerState) return;
  body.innerHTML = rows.map(row => recordPickerState.entity === 'prodotti'
    ? `<tr>
        <td>${escapeHtml(row.codice_interno || '-')}</td>
        <td>${escapeHtml(row.nome || '-')}</td>
        <td>${escapeHtml(row.categoria || row.categoria_nome || '-')}</td>
        <td><button type="button" class="btn btn-outline btn-sm" onclick="selectRecordPicker(${row.id})">Seleziona</button></td>
      </tr>`
    : recordPickerState.entity === 'mepa-cpv'
      ? `<tr>
          <td><code>${escapeHtml(formatCpvDisplay(row.codice_cpv || '-'))}</code></td>
          <td>${escapeHtml(row.desc || row.descrizione || '-')}</td>
          <td>${escapeHtml(row.categoria || '-')}</td>
          <td><button type="button" class="btn btn-outline btn-sm" onclick="selectRecordPicker('${escapeAttr(row.codice_cpv || '')}')">Seleziona</button></td>
        </tr>`
    : `<tr>
        <td>${escapeHtml(row.ragione_sociale || row.nome || '-')}</td>
        <td>${escapeHtml(row.tipo || '-')}</td>
        <td>${escapeHtml(row.piva || '-')}</td>
        <td><button type="button" class="btn btn-outline btn-sm" onclick="selectRecordPicker(${row.id})">Seleziona</button></td>
      </tr>`
  ).join('') || '<tr><td colspan="4" style="color:var(--text-muted)">Nessun record trovato.</td></tr>';
}

function selectRecordPicker(id) {
  if (!recordPickerState) return;
  const row = recordPickerState.rows.find(item => recordPickerState.entity === 'mepa-cpv'
    ? String(item.codice_cpv) === String(id)
    : String(item.id) === String(id));
  if (!row) return;
  const { targetId, labelId, onSelect } = recordPickerState.options || {};
  if (targetId) {
    const target = document.getElementById(targetId);
    if (target) target.value = recordPickerState.entity === 'mepa-cpv' ? (row.codice_cpv || '') : row.id;
  }
  if (labelId) {
    const label = document.getElementById(labelId);
    if (label) label.value = getRecordLabel(recordPickerState.entity, row);
  }
  if (targetId === 'fatt-anagrafica') {
    if (document.getElementById('fatt-piva') && !document.getElementById('fatt-piva').value) document.getElementById('fatt-piva').value = row.piva || '';
    if (document.getElementById('fatt-cf') && !document.getElementById('fatt-cf').value) document.getElementById('fatt-cf').value = row.cf || '';
  }
  if (typeof onSelect === 'function') onSelect(row);
  const picker = document.getElementById('modal-record-picker');
  if (picker) picker.style.display = 'none';
  recordPickerState = null;
}

function getProductOptions(cache, selectedId) {
  return `<option value="">Seleziona...</option>${(cache || []).map(p => `<option value="${p.id}"${String(selectedId || '') === String(p.id) ? ' selected' : ''}>${escapeHtml(p.codice_interno || '')} - ${escapeHtml(p.nome || '')}</option>`).join('')}`;
}

function calcolaTotaleRiga({ quantita, prezzo_unitario, sconto = 0, aliquota_iva = 0 }) {
  const qty = parseFloat(quantita || 0) || 0;
  const price = parseFloat(prezzo_unitario || 0) || 0;
  const discount = parseFloat(sconto || 0) || 0;
  const imponibile = Math.max(0, qty * price - discount);
  const importo_iva = imponibile * ((parseFloat(aliquota_iva || 0) || 0) / 100);
  return { imponibile, importo_iva, totale_riga: imponibile + importo_iva };
}

function buildDocumentoRigaHtml(prefix, cache, data = {}) {
  const selectedProduct = (cache || []).find(p => String(p.id) === String(data.prodotto_id || ''));
  return `
    <div class="${prefix}-riga dynamic-line-card">
      <div class="form-row">
        <div class="form-group">
          <label>Articolo</label>
          <select class="${prefix}-prodotto" style="display:none">${getProductOptions(cache, data.prodotto_id)}</select>
          <div class="picker-input-row">
            <input type="text" class="${prefix}-prodotto-label" value="${escapeAttr(selectedProduct ? getRecordLabel('prodotti', selectedProduct) : '')}" readonly placeholder="Seleziona articolo">
            <button type="button" class="btn btn-outline btn-sm" onclick="openProductPickerForRow(this,'${prefix}')">Scegli</button>
          </div>
        </div>
        <div class="form-group"><label>Descrizione</label><input type="text" class="${prefix}-descrizione" value="${escapeAttr(data.descrizione)}"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Quantita</label><input type="number" step="0.01" class="${prefix}-quantita" value="${escapeAttr(data.quantita ?? 1)}" oninput="ricalcolaRigheDocumento('${prefix}')"></div>
        <div class="form-group"><label>Prezzo unitario</label><input type="number" step="0.01" class="${prefix}-prezzo" value="${escapeAttr(data.prezzo_unitario ?? 0)}" oninput="ricalcolaRigheDocumento('${prefix}')"></div>
        <div class="form-group"><label>Sconto</label><input type="number" step="0.01" class="${prefix}-sconto" value="${escapeAttr(data.sconto ?? 0)}" oninput="ricalcolaRigheDocumento('${prefix}')"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Aliquota IVA</label><input type="number" step="0.01" class="${prefix}-aliquota" value="${escapeAttr(data.aliquota_iva ?? 22)}" oninput="ricalcolaRigheDocumento('${prefix}')"></div>
        <div class="form-group"><label>Natura IVA</label><input type="text" class="${prefix}-natura" value="${escapeAttr(data.natura_iva)}"></div>
        <div class="form-group"><label>Totale riga</label><input type="number" step="0.01" class="${prefix}-totale" value="${escapeAttr(data.totale_riga ?? 0)}" readonly></div>
      </div>
      <div style="display:flex;justify-content:flex-end"><button type="button" class="btn btn-danger btn-sm" onclick="this.closest('.dynamic-line-card').remove(); ricalcolaRigheDocumento('${prefix}')">Rimuovi</button></div>
    </div>
  `;
}

function openProductPickerForRow(button, prefix) {
  const row = button.closest(`.${prefix}-riga`);
  if (!row) return;
  const tempId = `picker-target-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const tempLabelId = `picker-label-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const hidden = row.querySelector(`.${prefix}-prodotto`);
  const label = row.querySelector(`.${prefix}-prodotto-label`);
  hidden.id = tempId;
  label.id = tempLabelId;
  openRecordPicker('prodotti', {
    targetId: tempId,
    labelId: tempLabelId,
    onSelect: (product) => {
      hidden.value = product.id;
      label.value = getRecordLabel('prodotti', product);
      const desc = row.querySelector(`.${prefix}-descrizione`);
      if (desc && !desc.value) desc.value = product.nome || product.descrizione || '';
    }
  });
}

function buildVatSummaryRowHtml(data = {}) {
  return `
    <div class="iva-riga dynamic-line-card">
      <div class="form-row">
        <div class="form-group"><label>Aliquota IVA</label><input type="number" step="0.01" class="iva-aliquota" value="${escapeAttr(data.aliquota_iva ?? 22)}"></div>
        <div class="form-group"><label>Natura IVA</label><input type="text" class="iva-natura" value="${escapeAttr(data.natura_iva)}"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Imponibile</label><input type="number" step="0.01" class="iva-imponibile" value="${escapeAttr(data.imponibile ?? 0)}"></div>
        <div class="form-group"><label>Imposta</label><input type="number" step="0.01" class="iva-imposta" value="${escapeAttr(data.imposta ?? data.importo_iva ?? 0)}"></div>
        <div class="form-group"><label>Riferimento</label><input type="text" class="iva-riferimento" value="${escapeAttr(data.riferimento_normativo)}"></div>
      </div>
      <div style="display:flex;justify-content:flex-end"><button type="button" class="btn btn-danger btn-sm" onclick="this.closest('.dynamic-line-card').remove()">Rimuovi</button></div>
    </div>
  `;
}

function ricalcolaRigheDocumento(prefix) {
  const wrap = document.getElementById(`${prefix}-righe`);
  if (!wrap) return;
  let imponibileTot = 0;
  let ivaTot = 0;
  [...wrap.querySelectorAll(`.${prefix}-riga`)].forEach(row => {
    const calc = calcolaTotaleRiga({
      quantita: row.querySelector(`.${prefix}-quantita`)?.value,
      prezzo_unitario: row.querySelector(`.${prefix}-prezzo`)?.value,
      sconto: row.querySelector(`.${prefix}-sconto`)?.value,
      aliquota_iva: row.querySelector(`.${prefix}-aliquota`)?.value
    });
    const totalInput = row.querySelector(`.${prefix}-totale`);
    if (totalInput) totalInput.value = calc.totale_riga.toFixed(2);
    imponibileTot += calc.imponibile;
    ivaTot += calc.importo_iva;
  });
  const map = prefix === 'prev'
    ? { imponibile: 'prev-imponibile', iva: 'prev-iva', totale: 'prev-totale' }
    : prefix === 'ord'
      ? { imponibile: 'ord-imponibile', iva: 'ord-iva', totale: 'ord-totale' }
      : { imponibile: 'fatt-imponibile', iva: 'fatt-iva', totale: 'fatt-totale' };
  const imponibile = document.getElementById(map.imponibile);
  const iva = document.getElementById(map.iva);
  const totale = document.getElementById(map.totale);
  if (imponibile) imponibile.value = imponibileTot.toFixed(2);
  if (iva) iva.value = ivaTot.toFixed(2);
  if (totale) totale.value = (imponibileTot + ivaTot).toFixed(2);
}

function collectDocumentoRighe(prefix) {
  const wrap = document.getElementById(`${prefix}-righe`);
  if (!wrap) return [];
  return [...wrap.querySelectorAll(`.${prefix}-riga`)].map(row => {
    const quantita = parseFloat(row.querySelector(`.${prefix}-quantita`)?.value || 0) || 0;
    const prezzo_unitario = parseFloat(row.querySelector(`.${prefix}-prezzo`)?.value || 0) || 0;
    const sconto = parseFloat(row.querySelector(`.${prefix}-sconto`)?.value || 0) || 0;
    const aliquota_iva = parseFloat(row.querySelector(`.${prefix}-aliquota`)?.value || 0) || 0;
    const calc = calcolaTotaleRiga({ quantita, prezzo_unitario, sconto, aliquota_iva });
    return {
      prodotto_id: row.querySelector(`.${prefix}-prodotto`)?.value || null,
      descrizione: row.querySelector(`.${prefix}-descrizione`)?.value || '',
      quantita,
      prezzo_unitario,
      sconto,
      imponibile: calc.imponibile,
      aliquota_iva,
      natura_iva: row.querySelector(`.${prefix}-natura`)?.value || null,
      importo_iva: calc.importo_iva,
      totale_riga: calc.totale_riga
    };
  }).filter(r => r.descrizione || r.prodotto_id);
}

function collectVatSummaryRows() {
  const wrap = document.getElementById('fatt-riepilogo-iva');
  if (!wrap) return [];
  return [...wrap.querySelectorAll('.iva-riga')].map(row => ({
    aliquota_iva: parseFloat(row.querySelector('.iva-aliquota')?.value || 0) || 0,
    natura_iva: row.querySelector('.iva-natura')?.value || null,
    imponibile: parseFloat(row.querySelector('.iva-imponibile')?.value || 0) || 0,
    imposta: parseFloat(row.querySelector('.iva-imposta')?.value || 0) || 0,
    riferimento_normativo: row.querySelector('.iva-riferimento')?.value || null
  })).filter(r => r.imponibile || r.imposta || r.natura_iva || r.riferimento_normativo);
}

function aggiungiRigaPreventivo(data = {}) {
  const wrap = document.getElementById('prev-righe');
  if (!wrap) return;
  wrap.insertAdjacentHTML('beforeend', buildDocumentoRigaHtml('prev', preventivoProdottiCache, data));
  ricalcolaRigheDocumento('prev');
}

function aggiungiRigaOrdine(data = {}) {
  const wrap = document.getElementById('ord-righe');
  if (!wrap) return;
  wrap.insertAdjacentHTML('beforeend', buildDocumentoRigaHtml('ord', ordineProdottiCache, data));
  ricalcolaRigheDocumento('ord');
}

function aggiungiRigaFattura(data = {}) {
  const wrap = document.getElementById('fatt-righe');
  if (!wrap) return;
  wrap.insertAdjacentHTML('beforeend', buildDocumentoRigaHtml('fatt', fatturaProdottiCache, data));
  ricalcolaRigheDocumento('fatt');
}

function aggiungiRiepilogoIva(data = {}) {
  const wrap = document.getElementById('fatt-riepilogo-iva');
  if (!wrap) return;
  wrap.insertAdjacentHTML('beforeend', buildVatSummaryRowHtml(data));
}

async function preparePreventivoModal(id = null) {
  const [anag, prodotti] = await Promise.all([api('GET', '/anagrafiche?tipo=cliente'), api('GET', '/prodotti')]);
  preventivoProdottiCache = prodotti || [];
  document.getElementById('prev-righe').innerHTML = '';
  const deleteBtn = document.getElementById('btn-del-preventivo');
  if (!id) {
    document.getElementById('prev-id').value = '';
    document.getElementById('prev-codice').value = `PREV-${new Date().toISOString().slice(0,10).replaceAll('-', '')}-${Math.floor(Math.random() * 1000)}`;
    document.getElementById('prev-stato').value = 'bozza';
    document.getElementById('prev-anagrafica').value = '';
    document.getElementById('prev-anagrafica-label').value = '';
    document.getElementById('prev-valuta').value = 'EUR';
    document.getElementById('prev-data').value = new Date().toISOString().slice(0,10);
    document.getElementById('prev-scadenza').value = '';
    document.getElementById('prev-imponibile').value = '';
    document.getElementById('prev-iva').value = '';
    document.getElementById('prev-totale').value = '';
    document.getElementById('prev-note').value = '';
    if (deleteBtn) deleteBtn.style.display = 'none';
    aggiungiRigaPreventivo();
    return;
  }
  const p = await api('GET', `/preventivi/${id}`);
  document.getElementById('prev-id').value = p.id;
  document.getElementById('prev-codice').value = p.codice_preventivo || '';
  document.getElementById('prev-stato').value = p.stato || 'bozza';
  document.getElementById('prev-anagrafica').value = p.anagrafica_id || '';
  document.getElementById('prev-anagrafica-label').value = ((anag || []).find(a => String(a.id) === String(p.anagrafica_id || ''))?.ragione_sociale) || p.ragione_sociale || '';
  document.getElementById('prev-valuta').value = p.valuta || 'EUR';
  document.getElementById('prev-data').value = p.data_preventivo || '';
  document.getElementById('prev-scadenza').value = p.data_scadenza || '';
  document.getElementById('prev-imponibile').value = p.imponibile ?? '';
  document.getElementById('prev-iva').value = p.iva ?? '';
  document.getElementById('prev-totale').value = p.totale ?? '';
  document.getElementById('prev-note').value = p.note || '';
  if (deleteBtn) deleteBtn.style.display = 'inline-flex';
  (p.righe?.length ? p.righe : [{}]).forEach(aggiungiRigaPreventivo);
  ricalcolaRigheDocumento('prev');
}

async function prepareFatturaModal(id = null) {
  const [anag, prodotti] = await Promise.all([api('GET', '/anagrafiche'), api('GET', '/prodotti')]);
  fatturaProdottiCache = prodotti || [];
  fatturaAnagraficheCache = anag || [];
  document.getElementById('fatt-righe').innerHTML = '';
  document.getElementById('fatt-riepilogo-iva').innerHTML = '';
  if (!id) {
    document.getElementById('fatt-id').value = '';
    document.getElementById('fatt-numero').value = '';
    document.getElementById('fatt-tipo').value = 'emessa';
    document.getElementById('fatt-tipo-documento').value = 'fattura';
    document.getElementById('fatt-anagrafica').value = '';
    document.getElementById('fatt-anagrafica-label').value = '';
    document.getElementById('fatt-valuta').value = 'EUR';
    document.getElementById('fatt-stato-pagamento').value = 'da_pagare';
    document.getElementById('fatt-data').value = new Date().toISOString().slice(0,10);
    document.getElementById('fatt-data-ricezione').value = '';
    document.getElementById('fatt-scadenza').value = '';
    document.getElementById('fatt-piva').value = '';
    document.getElementById('fatt-cf').value = '';
    document.getElementById('fatt-sdi').value = '';
    document.getElementById('fatt-imponibile').value = '';
    document.getElementById('fatt-iva').value = '';
    document.getElementById('fatt-totale').value = '';
    document.getElementById('fatt-note').value = '';
    aggiungiRigaFattura();
    aggiungiRiepilogoIva();
    return;
  }
  const f = await api('GET', `/fatture/${id}`);
  document.getElementById('fatt-id').value = f.id;
  document.getElementById('fatt-numero').value = f.numero || '';
  document.getElementById('fatt-tipo').value = f.tipo || 'emessa';
  document.getElementById('fatt-tipo-documento').value = f.tipo_documento || 'fattura';
  document.getElementById('fatt-anagrafica').value = f.anagrafica_id || '';
  document.getElementById('fatt-anagrafica-label').value = (fatturaAnagraficheCache.find(a => String(a.id) === String(f.anagrafica_id || ''))?.ragione_sociale) || f.ragione_sociale || '';
  document.getElementById('fatt-valuta').value = f.valuta || 'EUR';
  document.getElementById('fatt-stato-pagamento').value = f.stato_pagamento || 'da_pagare';
  document.getElementById('fatt-data').value = f.data || '';
  document.getElementById('fatt-data-ricezione').value = f.data_ricezione || '';
  document.getElementById('fatt-scadenza').value = f.scadenza || '';
  document.getElementById('fatt-piva').value = f.partita_iva || '';
  document.getElementById('fatt-cf').value = f.codice_fiscale || '';
  document.getElementById('fatt-sdi').value = f.sdi_id || '';
  document.getElementById('fatt-imponibile').value = f.imponibile ?? '';
  document.getElementById('fatt-iva').value = f.iva ?? '';
  document.getElementById('fatt-totale').value = f.totale ?? '';
  document.getElementById('fatt-note').value = f.note || '';
  (f.righe?.length ? f.righe : [{}]).forEach(aggiungiRigaFattura);
  (f.riepilogo_iva?.length ? f.riepilogo_iva : [{}]).forEach(aggiungiRiepilogoIva);
  ricalcolaRigheDocumento('fatt');
}

async function loadPreventivi() {
  const stato = document.getElementById('filter-stato-preventivo')?.value || '';
  const rows = await api('GET', `/preventivi${stato ? `?stato=${encodeURIComponent(stato)}` : ''}`);
  const body = document.getElementById('preventivi-body');
  if (body) {
    body.innerHTML = (rows || []).map(p => `
      <tr><td><strong>${p.codice_preventivo}</strong></td>
      <td>${p.ragione_sociale || '—'}</td><td>${p.data_preventivo || '—'}</td>
      <td>${p.data_scadenza || '—'}</td>
      <td>${p.totale ? 'EUR ' + Number(p.totale).toFixed(2) : '—'}</td>
      <td>${renderStateBadge(p.stato)}</td>
      <td><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-outline btn-sm" onclick="modificaPreventivo(${p.id})">Apri</button><button class="btn btn-outline btn-sm" onclick="openApiPdf('/preventivi/${p.id}/pdf')">PDF</button><button class="btn btn-outline btn-sm" onclick="openSendDocumentModal('preventivo',${p.id})">Invia</button><select class="btn btn-outline btn-sm" onchange="cambiaStatoPreventivo(${p.id},this.value)">
        ${['bozza','inviato','accettato','rifiutato','scaduto'].map(s=>`<option value="${s}"${p.stato===s?' selected':''}>${s}</option>`).join('')}
      </select></div></td></tr>`).join('');
  }
  renderSummaryCards('preventivi-summary', [
    { icon: '🧮', label: 'Preventivi', value: rows?.length || 0, meta: stato ? `Filtro: ${stato}` : 'Tutti gli stati', tone: 'primary' },
    { icon: '📤', label: 'Inviati', value: (rows || []).filter(p => p.stato === 'inviato').length, meta: 'In attesa di risposta', tone: 'cyan' },
    { icon: '✅', label: 'Accettati', value: (rows || []).filter(p => p.stato === 'accettato').length, meta: 'Pronti per ordine', tone: 'success' },
    { icon: '⏳', label: 'Bozze', value: (rows || []).filter(p => p.stato === 'bozza').length, meta: 'Da completare', tone: 'warning' }
  ]);
  renderPreventiviMobileCards(rows || []);
  const anag = await api('GET', '/anagrafiche?tipo=cliente');
  const sel = document.getElementById('prev-anagrafica');
  if (sel) sel.innerHTML = '<option value="">Seleziona...</option>' + (anag || []).map(a => `<option value="${a.id}">${a.ragione_sociale}</option>`).join('');
}

function renderPreventiviMobileCards(rows) {
  const wrap = document.getElementById('preventivi-mobile-list');
  if (!wrap) return;
  wrap.innerHTML = (rows || []).map(p => `
    <article class="mobile-record-card">
      <div class="mobile-record-header">
        <div>
          <strong>${p.codice_preventivo}</strong>
          <div class="mobile-record-subtitle">${p.ragione_sociale || 'Cliente non associato'}</div>
        </div>
        ${renderStateBadge(p.stato)}
      </div>
      <div class="mobile-record-grid">
        <div><span>Data</span><strong>${p.data_preventivo || '—'}</strong></div>
        <div><span>Scadenza</span><strong>${p.data_scadenza || '—'}</strong></div>
        <div><span>Totale</span><strong>${p.totale ? 'EUR ' + Number(p.totale).toFixed(2) : '—'}</strong></div>
      </div>
      <div class="mobile-record-actions">
        <button class="btn btn-outline btn-sm" onclick="modificaPreventivo(${p.id})">Apri</button>
        <button class="btn btn-outline btn-sm" onclick="openApiPdf('/preventivi/${p.id}/pdf')">PDF</button>
        <button class="btn btn-outline btn-sm" onclick="openSendDocumentModal('preventivo',${p.id})">Invia</button>
        <button class="btn btn-danger btn-sm" onclick="deletePreventivo(${p.id})">Elimina</button>
        <select class="order-state-select" onchange="cambiaStatoPreventivo(${p.id},this.value)">
          ${['bozza','inviato','accettato','rifiutato','scaduto'].map(s=>`<option value="${s}"${p.stato===s?' selected':''}>${s}</option>`).join('')}
        </select>
      </div>
    </article>
  `).join('');
}

async function salvaPreventivo() {
  const id = document.getElementById('prev-id')?.value;
  const body = {
    codice_preventivo: document.getElementById('prev-codice').value,
    stato: document.getElementById('prev-stato').value,
    anagrafica_id: document.getElementById('prev-anagrafica').value || null,
    data_preventivo: document.getElementById('prev-data').value,
    data_scadenza: document.getElementById('prev-scadenza').value,
    totale: parseFloat(document.getElementById('prev-totale').value) || null,
    note: document.getElementById('prev-note').value
  };
  try {
    if (id) await api('PUT', `/preventivi/${id}`, body);
    else await api('POST', '/preventivi', body);
    closeAllModals();
    toast('Preventivo salvato', 'success');
    loadPreventivi();
  } catch (e) { toast(e.message, 'error'); }
}

async function deletePreventivo(id = null) {
  const targetId = id || document.getElementById('prev-id')?.value;
  if (!targetId || !confirm('Eliminare questo preventivo?')) return;
  try {
    await api('DELETE', `/preventivi/${targetId}`);
    closeAllModals();
    toast('Preventivo eliminato', 'success');
    loadPreventivi();
  } catch (e) { toast(e.message, 'error'); }
}

async function cambiaStatoPreventivo(id, stato) {
  await api('PATCH', `/preventivi/${id}/stato`, { stato });
  loadPreventivi();
}

async function prepareOrdineModal(context = null) {
  const [anag, prodotti] = await Promise.all([api('GET', '/anagrafiche'), api('GET', '/prodotti')]);
  ordineAnagraficheCache = anag || [];
  ordineProdottiCache = prodotti || [];
  document.getElementById('ord-righe').innerHTML = '';
  document.getElementById('ord-id').value = '';
  document.getElementById('ord-preventivo-id').value = '';
  document.getElementById('ord-preventivo-label').value = '';
  document.getElementById('ord-anagrafica').value = '';
  document.getElementById('ord-anagrafica-label').value = '';
  document.getElementById('ord-codice').value = `ORD-${new Date().toISOString().slice(0,10).replaceAll('-', '')}-${Math.floor(Math.random() * 1000)}`;
  document.getElementById('ord-tipo').value = 'vendita';
  document.getElementById('ord-canale').value = 'diretto';
  document.getElementById('ord-data').value = new Date().toISOString().slice(0,10);
  document.getElementById('ord-consegna').value = '';
  document.getElementById('ord-imponibile').value = '';
  document.getElementById('ord-iva').value = '';
  document.getElementById('ord-totale').value = '';
  document.getElementById('ord-note').value = '';

  if (context?.fromPreventivoId) {
    const p = await api('GET', `/preventivi/${context.fromPreventivoId}`);
    document.getElementById('ord-preventivo-id').value = p.id;
    document.getElementById('ord-preventivo-label').value = p.codice_preventivo || '';
    document.getElementById('ord-codice').value = `ORD-${String(p.codice_preventivo || p.id).replace(/[^A-Za-z0-9-]/g, '').slice(-20)}`;
    document.getElementById('ord-anagrafica').value = p.anagrafica_id || '';
    document.getElementById('ord-anagrafica-label').value = p.ragione_sociale || '';
    document.getElementById('ord-data').value = p.data_preventivo || new Date().toISOString().slice(0,10);
    document.getElementById('ord-consegna').value = p.data_scadenza || '';
    document.getElementById('ord-imponibile').value = p.imponibile ?? '';
    document.getElementById('ord-iva').value = p.iva ?? '';
    document.getElementById('ord-totale').value = p.totale ?? '';
    document.getElementById('ord-note').value = p.note || '';
    (p.righe?.length ? p.righe : [{}]).forEach(aggiungiRigaOrdine);
    ricalcolaRigheDocumento('ord');
    return;
  }

  aggiungiRigaOrdine();
}

async function loadOrdini() {
  const tipo = document.getElementById('filter-tipo-ordine')?.value || '';
  const rows = await api('GET', `/ordini?tipo=${tipo}`);
  document.getElementById('ordini-body').innerHTML = (rows||[]).map(o => `
    <tr><td><strong>${o.codice_ordine}</strong></td>
    <td><span class="badge badge-${o.tipo==='vendita'?'cliente':'fornitore'}">${o.tipo}</span></td>
    <td>${o.ragione_sociale||'—'}</td><td>${o.data_ordine||'—'}</td>
    <td>${o.totale ? '€ '+o.totale.toFixed(2) : '—'}</td>
    <td>${renderStateBadge(o.stato)}</td>
      <td><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start"><button class="btn btn-outline btn-sm" onclick="openApiPdf('/ordini/${o.id}/pdf')">PDF</button><button class="btn btn-outline btn-sm" onclick="openSendDocumentModal('ordine',${o.id})">Invia</button><button class="btn btn-outline btn-sm" onclick="creaDdtDaOrdine(${o.id})">Crea DDT</button><button class="btn btn-danger btn-sm" onclick="deleteOrdine(${o.id})">Elimina</button>${renderDocumentLogButton('ordine', o.id, 'desk')}<select class="btn btn-outline btn-sm" onchange="cambiaStatoOrdine(${o.id},this.value)">
      ${['ricevuto','confermato','in_lavorazione','spedito','consegnato','annullato'].map(s=>`<option value="${s}"${o.stato===s?' selected':''}>${s}</option>`).join('')}
    </select>${renderDocumentSendMeta(o)}</div></td></tr>`).join('');
  renderSummaryCards('ordini-summary', [
    { icon: '📦', label: 'Ordini visibili', value: rows?.length || 0, meta: tipo ? `Filtro: ${tipo}` : 'Vendita e acquisto', tone: 'primary' },
    { icon: '🟢', label: 'Vendite', value: (rows || []).filter(o => o.tipo === 'vendita').length, meta: 'Ordini lato cliente', tone: 'success' },
    { icon: '🏭', label: 'Acquisti', value: (rows || []).filter(o => o.tipo === 'acquisto').length, meta: 'Ordini lato fornitore', tone: 'cyan' },
    { icon: '🚚', label: 'Da chiudere', value: (rows || []).filter(o => !['consegnato', 'annullato'].includes(String(o.stato || '').toLowerCase())).length, meta: 'Ordini ancora attivi', tone: 'warning' }
  ]);
  renderOrdiniMobileCards(rows || []);
}

async function cambiaStatoOrdine(id, stato) { await api('PATCH', `/ordini/${id}/stato`, { stato }); loadOrdini(); }

async function deleteOrdine(id) {
  if (!confirm('Eliminare questo ordine?')) return;
  try {
    await api('DELETE', `/ordini/${id}`);
    toast('Ordine eliminato', 'success');
    loadOrdini();
  } catch (e) { toast(e.message, 'error'); }
}

async function creaDdtDaOrdine(id) {
  try {
    const result = await api('POST', `/ordini/${id}/convert-to-ddt`, {});
    toast(`DDT creato: ${result?.numero_ddt || result?.ddt_id}`, 'success');
    loadDdt();
    loadOrdini();
  } catch (e) { toast(e.message, 'error'); }
}

async function salvaOrdine() {
  const body = {
    preventivo_id: document.getElementById('ord-preventivo-id').value || null,
    codice_ordine: document.getElementById('ord-codice').value,
    tipo: document.getElementById('ord-tipo').value,
    anagrafica_id: document.getElementById('ord-anagrafica').value || null,
    canale: document.getElementById('ord-canale').value,
    data_ordine: document.getElementById('ord-data').value,
    data_consegna_prevista: document.getElementById('ord-consegna').value,
    imponibile: parseFloat(document.getElementById('ord-imponibile').value) || 0,
    iva: parseFloat(document.getElementById('ord-iva').value) || 0,
    totale: parseFloat(document.getElementById('ord-totale').value) || null,
    note: document.getElementById('ord-note').value,
    righe: collectDocumentoRighe('ord')
  };
  try { await api('POST', '/ordini', body); closeAllModals(); toast('Ordine salvato', 'success'); loadOrdini(); loadPreventivi(); }
  catch (e) { toast(e.message, 'error'); }
}

async function creaOrdineDaPreventivo(id) {
  await openModal('modal-ordine', { fromPreventivoId: id });
}

// ═══════════════════════════════
// DDT
// ═══════════════════════════════
let ddtProdottiCache = [];

function ensureDdtModal() {
  if (document.getElementById('modal-ddt')) return;
  const modal = document.createElement('div');
  modal.id = 'modal-ddt';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-box doc-theme-box doc-theme-ddt">
      <div class="modal-title">DDT</div>
      <div class="form-section-card">
        <div class="section-card-title">Anagrafica e dati testata</div>
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
      </div>
      <div class="form-section-card">
        <div class="section-card-title">Trasporto e resa</div>
        <div class="form-row">
          <div class="form-group"><label>Causale</label><input type="text" id="ddt-causale" placeholder="Vendita, reso, trasferimento..."></div>
          <div class="form-group"><label>Porto</label><select id="ddt-porto"><option value="">Non indicato</option><option value="Porto Franco">Porto Franco</option><option value="Porto Assegnato">Porto Assegnato</option><option value="Franco destino">Franco destino</option><option value="Franco partenza">Franco partenza</option></select></div>
          <div class="form-group"><label>Resa</label><input type="text" id="ddt-resa" placeholder="Es. DAP, EXW, franco magazzino"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Colli</label><input type="number" min="0" id="ddt-colli"></div>
          <div class="form-group"><label>Peso totale kg</label><input type="number" min="0" step="0.01" id="ddt-peso"></div>
          <div class="form-group"><label>Aspetto beni</label><input type="text" id="ddt-aspetto" placeholder="Cartoni, pallet, sfuso..."></div>
        </div>
        <div class="form-group"><label style="display:flex;align-items:center;gap:8px;flex-direction:row"><input type="checkbox" id="ddt-spedizione"> Associa spedizione</label></div>
        <div class="form-row">
          <div class="form-group"><label>Corriere</label><select id="ddt-corriere"><option value="">Seleziona...</option><option value="dhl">DHL</option><option value="fedex">FedEx</option><option value="sda">SDA</option><option value="mailboxes">Mail Boxes</option><option value="gls">GLS</option><option value="brt">BRT</option><option value="altro">Altro</option></select></div>
          <div class="form-group"><label>Tracking</label><input type="text" id="ddt-tracking"></div>
          <div class="form-group"><label>Data/ora trasporto</label><input type="datetime-local" id="ddt-data-trasporto"></div>
        </div>
      </div>
      <div class="form-section-card">
        <div class="section-card-title section-card-title-between"><span>Articoli</span><button type="button" class="btn btn-outline btn-sm" onclick="aggiungiRigaDdt()">+ Aggiungi articolo</button></div>
        <div id="ddt-righe"></div>
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
  ['ddt-vettore','ddt-tracking','ddt-note','ddt-note-spedizione','ddt-causale','ddt-resa','ddt-colli','ddt-peso','ddt-aspetto','ddt-data-trasporto'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('ddt-tipo').value = 'uscita';
  document.getElementById('ddt-porto').value = '';
  document.getElementById('ddt-spedizione').checked = false;
  document.getElementById('ddt-corriere').value = '';
  const [anag, prodotti, fatture] = await Promise.all([api('GET', '/anagrafiche'), api('GET', '/prodotti'), api('GET', '/fatture')]);
  ddtProdottiCache = prodotti || [];
  document.getElementById('ddt-destinatario').innerHTML = '<option value="">Seleziona...</option>' + (anag||[]).map(a=>`<option value="${a.id}">${a.ragione_sociale}</option>`).join('');
  document.getElementById('ddt-fattura').innerHTML = '<option value="">Nessuna</option>' + (fatture||[]).map(f=>`<option value="${f.id}">${f.numero} - ${f.ragione_sociale || ''}</option>`).join('');
  document.getElementById('ddt-righe').innerHTML = '';
  aggiungiRigaDdt();
}

function aggiungiRigaDdt() {
  const wrap = document.getElementById('ddt-righe');
  if (!wrap) return;
  const row = document.createElement('div');
  row.className = 'form-row ddt-riga';
  row.style.alignItems = 'end';
  row.style.marginBottom = '8px';
  row.innerHTML = `
    <div class="form-group"><label>Prodotto</label><select class="ddt-riga-prodotto">
      <option value="">Seleziona...</option>${ddtProdottiCache.map(p=>`<option value="${p.id}" data-giacenza="${p.giacenza || 0}">${p.codice_interno} - ${p.nome} (${p.giacenza || 0})</option>`).join('')}
    </select></div>
    <div class="form-group"><label>Quantita</label><input class="ddt-riga-quantita" type="number" min="1"></div>
    <div class="form-group"><label>Lotto</label><input class="ddt-riga-lotto" type="text"></div>
    <button type="button" class="btn btn-danger btn-sm" onclick="this.closest('.ddt-riga').remove()">Rimuovi</button>`;
  wrap.appendChild(row);
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
    <td><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start"><button class="btn btn-outline btn-sm" onclick="openApiPdf('/ddt/${d.id}/pdf')">PDF</button><button class="btn btn-outline btn-sm" onclick="openSendDocumentModal('ddt',${d.id})">Invia</button><button class="btn btn-danger btn-sm" onclick="deleteDdt(${d.id})">Elimina</button>${renderDocumentLogButton('ddt', d.id, 'desk')}${renderDocumentSendMeta(d)}</div></td></tr>`).join('');
}

async function deleteDdt(id) {
  if (!confirm('Eliminare questo DDT?')) return;
  try {
    await api('DELETE', `/ddt/${id}`);
    toast('DDT eliminato', 'success');
    loadDdt();
    loadMagazzino();
  } catch (e) { toast(e.message, 'error'); }
}

async function openApiPdf(path) {
  const res = await fetch('/api' + path, { headers: { 'Authorization': `Bearer ${TOKEN}` } });
  if (!res.ok) { toast('PDF non disponibile', 'error'); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function getDocumentKindLabel(kind) {
  if (kind === 'preventivo') return 'Preventivo';
  if (kind === 'ordine') return 'Ordine';
  if (kind === 'ddt') return 'DDT';
  return 'Documento';
}

function getStateBadgeClass(state = '') {
  const key = String(state || '').trim().toLowerCase().replace(/\s+/g, '_');
  const map = {
    aperta: 'badge-state-open',
    in_corso: 'badge-state-progress',
    completata: 'badge-state-success',
    annullata: 'badge-state-danger',
    bozza: 'badge-state-draft',
    inviato: 'badge-state-info',
    accettato: 'badge-state-success',
    rifiutato: 'badge-state-danger',
    scaduto: 'badge-state-danger',
    ricevuto: 'badge-state-open',
    confermato: 'badge-state-info',
    in_lavorazione: 'badge-state-progress',
    spedito: 'badge-state-shipping',
    consegnato: 'badge-state-success',
    in_preparazione: 'badge-state-draft',
    pronta_al_ritiro: 'badge-state-warning',
    ritirata: 'badge-state-info',
    in_transito: 'badge-state-shipping',
    arrivata_al_porto: 'badge-state-info',
    in_dogana: 'badge-state-warning',
    sdoganata: 'badge-state-success',
    in_consegna: 'badge-state-shipping',
    bloccata: 'badge-state-danger',
    chiusa: 'badge-state-success'
  };
  return map[key] || 'badge-state-neutral';
}

function renderStateBadge(state, fallback = '-') {
  const label = state || fallback;
  return `<span class="badge ${getStateBadgeClass(state)}">${escapeHtml(String(label).replace(/_/g, ' '))}</span>`;
}

function renderDocumentSendMeta(row = {}) {
  const count = Number(row.sent_count || 0);
  const last = row.last_sent_at ? formatDocumentLogDate(row.last_sent_at) : '';
  return `<div class="doc-send-meta">
    <span class="doc-send-chip">${count ? `${count} invii` : 'Mai inviato'}</span>
    ${last ? `<span class="doc-send-chip">${escapeHtml(last)}</span>` : ''}
  </div>`;
}

function formatDocumentLogDate(value) {
  if (!value) return '-';
  const d = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return escapeHtml(String(value));
  return d.toLocaleString('it-IT');
}

function getDocumentLogActionLabel(event) {
  if (event.action === 'documento_inviato') {
    const to = event.details?.to ? ` a ${event.details.to}` : '';
    return `Inviato${to}`;
  }
  if (event.action === 'documento_stato') {
    return `Stato: ${event.details?.from || '-'} -> ${event.details?.to || '-'}`;
  }
  return event.action || 'Evento';
}

function renderDocumentLogButton(kind, id, variant = 'desk') {
  const panelId = `doc-log-${kind}-${id}-${variant}`;
  return `<div class="doc-log-wrap">
    <button class="btn btn-outline btn-sm doc-log-trigger" onclick="toggleDocumentLog('${kind}',${id},'${variant}')">i</button>
    <div id="${panelId}" class="doc-log-panel" style="display:none"></div>
  </div>`;
}

async function toggleDocumentLog(kind, id, variant = 'desk') {
  const panel = document.getElementById(`doc-log-${kind}-${id}-${variant}`);
  if (!panel) return;
  const isHidden = panel.style.display === 'none' || !panel.style.display;
  if (!isHidden) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  if (panel.dataset.loaded === '1') return;
  panel.innerHTML = '<div class="doc-log-loading">Caricamento log...</div>';
  try {
    const data = await api('GET', `/documenti/${kind}/${id}/log`);
    const events = data?.events || [];
    panel.innerHTML = `
      <div class="doc-log-summary">
        <strong>Invii:</strong> ${data?.sent_count || 0}
        <span>${data?.last_sent_at ? `Ultimo: ${formatDocumentLogDate(data.last_sent_at)}` : 'Mai inviato'}</span>
      </div>
      <div class="doc-log-events">
        ${events.length ? events.map(event => `
          <div class="doc-log-event">
            <div class="doc-log-event-title">${escapeHtml(getDocumentLogActionLabel(event))}</div>
            <div class="doc-log-event-meta">${escapeHtml(event.user || 'Sistema')} • ${escapeHtml(formatDocumentLogDate(event.created_at))}</div>
          </div>
        `).join('') : '<div class="doc-log-empty">Nessun log disponibile</div>'}
      </div>
    `;
    panel.dataset.loaded = '1';
  } catch (e) {
    panel.innerHTML = `<div class="doc-log-empty" style="color:var(--danger)">${escapeHtml(e.message || 'Errore caricamento log')}</div>`;
  }
}

function applyDocumentRecipientSelection() {
  const select = document.getElementById('send-doc-recipient-select');
  const emailInput = document.getElementById('send-doc-email');
  if (!select || !emailInput) return;
  emailInput.value = select.value || emailInput.value || '';
}

async function openSendDocumentModal(kind, id) {
  try {
    const data = await api('GET', `/documenti/${kind}/${id}/recipients`);
    if (!data?.document) throw new Error('Documento non trovato');
    const label = `${getDocumentKindLabel(kind)} ${data.document.codice || `#${id}`}`;
    document.getElementById('send-doc-kind').value = kind;
    document.getElementById('send-doc-id').value = id;
    document.getElementById('send-doc-label').value = label;
    document.getElementById('send-doc-subject').value = `${label} - Horygon`;
    document.getElementById('send-doc-body').value = [
      `Buongiorno,`,
      ``,
      `in allegato trovi ${kind === 'ddt' ? 'il' : 'il'} ${getDocumentKindLabel(kind).toLowerCase()} ${data.document.codice || `#${id}`}.`,
      ``,
      `Restiamo a disposizione per qualsiasi chiarimento.`,
      ``,
      `Horygon S.r.l.`
    ].join('\n');
    documentRecipientOptions = data.emails || [];
    const select = document.getElementById('send-doc-recipient-select');
    select.innerHTML = '<option value="">Seleziona...</option>' + documentRecipientOptions
      .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
      .join('');
    document.getElementById('send-doc-email').value = data.document.email || '';
    openModal('modal-send-document');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function sendDocumentEmail() {
  const kind = document.getElementById('send-doc-kind').value;
  const id = document.getElementById('send-doc-id').value;
  const to = document.getElementById('send-doc-email').value.trim();
  const subject = document.getElementById('send-doc-subject').value.trim();
  const text = document.getElementById('send-doc-body').value.trim();
  if (!to || !subject || !text) {
    toast('Compila destinatario, oggetto e messaggio', 'error');
    return;
  }
  try {
    await api('POST', '/documenti/send', { kind, id, to, subject, text });
    closeAllModals();
    toast('Documento inviato via email', 'success');
    if (kind === 'preventivo') loadPreventivi();
    if (kind === 'ordine') loadOrdini();
    if (kind === 'ddt') loadDdt();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function salvaDdt() {
  const righe = [...document.querySelectorAll('.ddt-riga')].map(row => ({
    prodotto_id: row.querySelector('.ddt-riga-prodotto')?.value || null,
    quantita: parseInt(row.querySelector('.ddt-riga-quantita')?.value) || null,
    lotto: row.querySelector('.ddt-riga-lotto')?.value || null,
  })).filter(r => r.prodotto_id && r.quantita);
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
    causale: document.getElementById('ddt-causale').value || null,
    porto: document.getElementById('ddt-porto').value || null,
    resa: document.getElementById('ddt-resa').value || null,
    colli: parseInt(document.getElementById('ddt-colli').value) || null,
    peso_totale: parseFloat(document.getElementById('ddt-peso').value) || null,
    aspetto_beni: document.getElementById('ddt-aspetto').value || null,
    data_ora_trasporto: document.getElementById('ddt-data-trasporto').value || null,
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

async function cambiaStatoFattura(id, stato) {
  await api('PATCH', `/fatture/${id}/stato`, { stato });
  const active = document.querySelector('.section.active')?.id?.replace('section-', '') || 'fatture-attive';
  if (['fatture-attive', 'fatture-passive', 'fatture-fuori-campo'].includes(active)) {
    loadFattureBySection(active);
  }
}

function formatIvaValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  if (n === 0) return 'Fuori campo';
  return `EUR ${n.toFixed(2)}`;
}

function renderFattureRows(targetId, rows) {
  const body = document.getElementById(targetId);
  if (!body) return;
  body.innerHTML = (rows||[]).map(f=>`
    <tr><td><strong>${f.numero}</strong></td>
    <td><span class="badge badge-${f.tipo==='ricevuta'?'fornitore':'cliente'}">${f.tipo}</span></td>
    <td>${f.ragione_sociale||'-'}</td><td>${f.data||'-'}</td>
    <td>${f.totale ? 'EUR '+Number(f.totale).toFixed(2) : '-'}</td>
    <td>${formatIvaValue(f.iva)}</td>
    <td><span class="badge badge-${f.stato}">${f.stato}</span></td>
    <td><select class="btn btn-outline btn-sm" onchange="cambiaStatoFattura(${f.id},this.value)">
      ${['ricevuta','pagata','scaduta','annullata'].map(s=>`<option value="${s}"${f.stato===s?' selected':''}>${s}</option>`).join('')}
    </select></td></tr>`).join('');
}

async function loadFattureBySection(section) {
  ensureAccountingSections();
  if (section === 'fatture-passive') {
    const rows = await api('GET', '/fatture?tipo=ricevuta');
    renderFattureRows('fatture-passive-body', rows || []);
    return;
  }
  if (section === 'fatture-fuori-campo') {
    const rows = await api('GET', '/fatture');
    renderFattureRows('fatture-fuori-campo-body', (rows || []).filter(f => !f.iva || Number(f.iva) === 0));
    return;
  }
  const rows = await api('GET', '/fatture?tipo=emessa');
  renderFattureRows('fatture-attive-body', rows || []);
}

async function loadFatture() {
  return loadFattureBySection('fatture-attive');
}

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
  const [rows, meta] = await Promise.all([
    api('GET', '/attivita'),
    api('GET', '/attivita/meta')
  ]);
  const todayKey = new Date().toDateString();
  renderSummaryCards('attivita-summary', [
    { icon: '📋', label: 'Totali', value: rows?.length || 0, meta: 'Storico attività CRM', tone: 'primary' },
    { icon: '⏳', label: 'Aperte', value: (rows || []).filter(a => ['aperta', 'in_corso'].includes(String(a.stato || '').toLowerCase())).length, meta: 'Da seguire oggi', tone: 'warning' },
    { icon: '🗓️', label: 'Oggi', value: (rows || []).filter(a => a.data_ora && new Date(a.data_ora).toDateString() === todayKey).length, meta: 'Attività con data odierna', tone: 'cyan' },
    { icon: '☁️', label: 'Sync Google', value: (rows || []).filter(a => !!a.google_event_id).length, meta: 'Eventi agganciati al calendario', tone: 'success' }
  ]);
  document.getElementById('attivita-list').innerHTML = (rows || []).map(a => {
    const noteFull = normalizeMailBody(a.note || '');
    const notePreview = compactText(noteFull, 220);
    const mine = Number(a.assegnato_a || 0) === Number(USER?.id || 0);
    const assignedLabel = mine
      ? 'Assegnata a te'
      : (a.assegnato_nome ? `Assegnata a ${escapeHtml(a.assegnato_nome)}` : '');
    return `
    <div class="attivita-item ${mine ? 'is-mine' : ''}">
      <div class="att-icon att-${a.tipo}">${ICONE[a.tipo] || '◎'}</div>
      <div style="min-width:0;flex:1">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
          <div>
            <strong>${escapeHtml(a.oggetto || a.tipo)}</strong>
            ${mine ? `<div style="margin-top:6px"><span class="attivita-assigned-pill">Assegnata a te</span></div>` : ''}
            ${a.ragione_sociale ? `<span style="color:var(--text-muted)"> — ${escapeHtml(a.ragione_sociale)}</span>` : ''}
          </div>
          ${renderStateBadge(a.stato || 'aperta')}
        </div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px">
          ${a.data_ora ? new Date(a.data_ora).toLocaleString('it-IT') : ''}
          ${a.durata_minuti ? ` · ${a.durata_minuti} min` : ''}
          ${assignedLabel ? ` · ${assignedLabel}` : ''}
          ${a.google_event_id ? ' · <span style="color:var(--accent)">Google Cal</span>' : ''}
        </div>
        ${noteFull ? `
          <details style="margin-top:8px">
            <summary style="cursor:pointer;color:var(--text-muted);font-size:13px">${escapeHtml(notePreview)}</summary>
            <div style="font-size:13px;margin-top:8px;color:var(--text-muted);white-space:pre-wrap;line-height:1.45">${escapeHtml(noteFull)}</div>
          </details>` : ''}
      </div>
    </div>`;
  }).join('') || '<p style="color:var(--text-muted)">Nessuna attività</p>';
  const anag = meta?.anagrafiche || [];
  const utenti = meta?.utenti || [];
  document.getElementById('att-anagrafica').innerHTML = '<option value="">Seleziona...</option>' + anag.map(a => `<option value="${a.id}">${escapeHtml(a.ragione_sociale)}</option>`).join('');
  document.getElementById('att-assegnato').innerHTML = '<option value="">Nessuno</option>' + utenti.map(u => `<option value="${u.id}">${escapeHtml(u.nome)}</option>`).join('');
}

async function openAttivitaModal() {
  await loadAttivita();
  document.getElementById('att-tipo').value = 'nota';
  document.getElementById('att-anagrafica').value = '';
  document.getElementById('att-assegnato').value = '';
  document.getElementById('att-stato').value = 'aperta';
  document.getElementById('att-oggetto').value = '';
  document.getElementById('att-data').value = '';
  document.getElementById('att-durata').value = 30;
  document.getElementById('att-note').value = '';
  document.getElementById('att-promemoria').value = '';
  document.getElementById('att-sync-google').checked = false;
  openModal('modal-attivita');
}

async function salvaAttivita() {
  const body = {
    tipo: document.getElementById('att-tipo').value,
    anagrafica_id: document.getElementById('att-anagrafica').value || null,
    assegnato_a: document.getElementById('att-assegnato').value || null,
    stato: document.getElementById('att-stato').value || 'aperta',
    data_ora: document.getElementById('att-data').value,
    durata_minuti: parseInt(document.getElementById('att-durata').value)||null,
    oggetto: document.getElementById('att-oggetto').value,
    note: document.getElementById('att-note').value,
    promemoria_il: document.getElementById('att-promemoria').value || null,
  };
  try {
    await api('POST', '/attivita', body);
    if (document.getElementById('att-sync-google').checked && USER.hasGoogle) {
      const start = body.data_ora ? new Date(body.data_ora) : new Date();
      const end = new Date(start.getTime() + (body.durata_minuti || 60) * 60000);
      const ev = {
        title: body.oggetto || body.tipo,
        description: body.note || '',
        start: toDateTimeLocalValue(start),
        end: toDateTimeLocalValue(end),
        allDay: false
      };
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
    const mepa = document.getElementById('mepa-mail-list');
    if (mepa) mepa.innerHTML = '<p style="color:var(--text-muted)">Connetti Google per leggere le mail MEPA.</p>';
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
  loadMepaMailList();
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

async function syncMepaMail() {
  try {
    const r = await api('POST', '/google/gmail/mepa/sync');
    toast(`Mail MEPA sincronizzate: ${r?.inserted || 0} nuove`, 'success');
    loadMepaMailList();
    loadNotifications();
  } catch (e) { toast(e.message, 'error'); }
}

let CONTATTI_META = { anagrafiche: [], utenti: [] };

async function loadContacts() {
  const box = document.getElementById('contacts-body');
  if (!box) return;
  const q = document.getElementById('search-contatti')?.value || '';
  box.innerHTML = '<tr><td colspan="7" style="color:var(--text-muted);text-align:center;padding:20px">Caricamento contatti...</td></tr>';
  try {
    const [rows, meta] = await Promise.all([
      api('GET', `/contatti?q=${encodeURIComponent(q)}`),
      api('GET', '/contatti/meta')
    ]);
    CONTATTI_META = meta || { anagrafiche: [], utenti: [] };
    box.innerHTML = (rows || []).length
      ? rows.map(c => `<tr>
          <td>
            <div style="display:flex;align-items:center;gap:10px">
              ${renderContactAvatar(c)}
              <div>
                <strong>${escapeHtml([c.nome, c.cognome].filter(Boolean).join(' ') || '-')}</strong>
                <div style="font-size:12px;color:var(--text-muted)">${escapeHtml(c.linked_user_nome || '')}</div>
              </div>
            </div>
          </td>
          <td>${escapeHtml(c.organizzazione || '-')}</td>
          <td>${escapeHtml(c.ruolo || '-')}</td>
          <td>${escapeHtml(c.email || '-')}</td>
          <td>${escapeHtml(c.telefono || '-')}</td>
          <td>${c.google_resource_name ? '<span style="color:var(--success)">Sincronizzato</span>' : '<span style="color:var(--text-muted)">Locale</span>'}</td>
          <td>
            <button class="btn btn-outline btn-sm" onclick="editContatto(${c.id})">Modifica</button>
            <button class="btn btn-outline btn-sm" onclick="syncContattoToGoogle(${c.id})">Google</button>
          </td>
        </tr>`).join('')
      : '<tr><td colspan="7" style="color:var(--text-muted);text-align:center;padding:20px">Nessun contatto disponibile.</td></tr>';
  } catch (e) {
    box.innerHTML = `<tr><td colspan="7" style="color:var(--danger);text-align:center;padding:20px">${escapeHtml(e.message)}</td></tr>`;
  }
}

function getContactInitials(c) {
  const parts = [c.nome, c.cognome].filter(Boolean).join(' ').trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map(p => p[0]?.toUpperCase() || '').join('') || 'CT';
}

function renderContactAvatar(c) {
  if (c.avatar_path) {
    return `<img src="${c.avatar_path}" alt="${escapeHtml([c.nome, c.cognome].filter(Boolean).join(' '))}" style="width:42px;height:42px;border-radius:50%;object-fit:cover;border:1px solid var(--border)">`;
  }
  return `<div style="width:42px;height:42px;border-radius:50%;background:#dbeafe;color:#1d4ed8;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:1px solid #bfdbfe">${escapeHtml(getContactInitials(c))}</div>`;
}

function setContattoAvatarPreview(src, fallback = 'N/A') {
  const box = document.getElementById('contatto-avatar-preview');
  if (!box) return;
  if (src) {
    box.innerHTML = `<img src="${src}" alt="Avatar contatto" style="width:100%;height:100%;object-fit:cover">`;
  } else {
    box.textContent = fallback;
  }
}

async function syncContactsToGoogle() {
  try {
    const result = await api('POST', '/google/contacts/sync');
    toast(`Contatti sincronizzati: ${result?.created || 0} creati, ${result?.updated || 0} aggiornati`, 'success');
    loadContacts();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function populateContattiMeta() {
  document.getElementById('contatto-anagrafica').innerHTML =
    '<option value="">Nessuna</option>' +
    (CONTATTI_META.anagrafiche || []).map(a => `<option value="${a.id}">${escapeHtml(a.ragione_sociale)}</option>`).join('');
  document.getElementById('contatto-utente').innerHTML =
    '<option value="">Nessuno</option>' +
    (CONTATTI_META.utenti || []).map(u => `<option value="${u.id}">${escapeHtml(u.nome)}</option>`).join('');
}

async function openContattoModal() {
  if (!CONTATTI_META.anagrafiche?.length && !CONTATTI_META.utenti?.length) {
    CONTATTI_META = await api('GET', '/contatti/meta') || { anagrafiche: [], utenti: [] };
  }
  populateContattiMeta();
  document.getElementById('contatto-id').value = '';
  document.getElementById('contatto-nome').value = '';
  document.getElementById('contatto-cognome').value = '';
  document.getElementById('contatto-ruolo').value = '';
  document.getElementById('contatto-email').value = '';
  document.getElementById('contatto-telefono').value = '';
  document.getElementById('contatto-anagrafica').value = '';
  document.getElementById('contatto-utente').value = '';
  document.getElementById('contatto-note').value = '';
  document.getElementById('contatto-esterno').checked = false;
  document.getElementById('contatto-avatar').value = '';
  setContattoAvatarPreview('', 'N/A');
  openModal('modal-contatto');
}

async function editContatto(id) {
  if (!CONTATTI_META.anagrafiche?.length && !CONTATTI_META.utenti?.length) {
    CONTATTI_META = await api('GET', '/contatti/meta') || { anagrafiche: [], utenti: [] };
  }
  populateContattiMeta();
  const c = await api('GET', `/contatti/${id}`);
  document.getElementById('contatto-id').value = c.id;
  document.getElementById('contatto-nome').value = c.nome || '';
  document.getElementById('contatto-cognome').value = c.cognome || '';
  document.getElementById('contatto-ruolo').value = c.ruolo || '';
  document.getElementById('contatto-email').value = c.email || '';
  document.getElementById('contatto-telefono').value = c.telefono || '';
  document.getElementById('contatto-anagrafica').value = c.anagrafica_id || '';
  document.getElementById('contatto-utente').value = c.linked_user_id || '';
  document.getElementById('contatto-note').value = c.note || '';
  document.getElementById('contatto-esterno').checked = !!c.visibile_esterno;
  document.getElementById('contatto-avatar').value = '';
  setContattoAvatarPreview(c.avatar_path || '', getContactInitials(c));
  openModal('modal-contatto');
}

async function salvaContatto() {
  const id = document.getElementById('contatto-id').value;
  const body = {
    nome: document.getElementById('contatto-nome').value,
    cognome: document.getElementById('contatto-cognome').value,
    ruolo: document.getElementById('contatto-ruolo').value,
    email: document.getElementById('contatto-email').value,
    telefono: document.getElementById('contatto-telefono').value,
    anagrafica_id: document.getElementById('contatto-anagrafica').value || null,
    linked_user_id: document.getElementById('contatto-utente').value || null,
    note: document.getElementById('contatto-note').value,
    visibile_esterno: document.getElementById('contatto-esterno').checked ? 1 : 0
  };
  try {
    const saved = id ? await api('PUT', `/contatti/${id}`, body) : await api('POST', '/contatti', body);
    const contattoId = id || saved?.id;
    const avatar = document.getElementById('contatto-avatar')?.files?.[0];
    if (contattoId && avatar) {
      const fd = new FormData();
      fd.append('avatar', avatar);
      await apiForm('POST', `/contatti/${contattoId}/avatar`, fd);
    }
    closeAllModals();
    toast('Contatto salvato', 'success');
    loadContacts();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function syncContattoToGoogle(id) {
  if (!USER?.hasGoogle) {
    toast('Connetti Google per sincronizzare il contatto', 'error');
    return;
  }
  try {
    const result = await api('POST', `/contatti/${id}/sync-google`);
    toast(result?.skipped ? 'Contatto già collegato a Google' : 'Contatto sincronizzato su Google', 'success');
    loadContacts();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function loadMepaMailList() {
  const box = document.getElementById('mepa-mail-list');
  if (!box || !USER?.hasGoogle) return;
  box.innerHTML = '<p style="color:var(--text-muted)">Caricamento comunicazioni...</p>';
  const rows = await api('GET', '/google/gmail/mepa/messages');
  box.innerHTML = (rows||[]).length ? `<table class="data-table">
    <thead><tr><th>Ente</th><th>Gara</th><th>Categoria</th><th>Pubblicazione</th><th>Scadenza</th><th>Stato</th><th>Azioni</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td>${r.ente || '-'}</td>
      <td><strong>${r.gara_id || '-'}</strong><div style="font-size:12px;color:var(--text-muted)">${r.nome_gara || r.oggetto || ''}</div></td>
      <td>${r.categoria || '-'}</td>
      <td>${r.data_pubblicazione || '-'}</td>
      <td style="color:${getDeadlineColor(r.scadenza_offerte)}">${r.scadenza_offerte || '-'}</td>
      <td>
        <select onchange="updateMepaMailStatus(${r.id}, this.value)" class="btn btn-outline btn-sm">
          ${['nuova','in_valutazione','offerta_in_preparazione','offerta_inviata','archiviata','scaduta','eliminata'].map(s => `<option value="${s}"${r.stato===s?' selected':''}>${s}</option>`).join('')}
        </select>
      </td>
      <td>
        <button class="btn btn-danger btn-sm" onclick="removeMepaMail(${r.id})">Escludi</button>
      </td>
    </tr>`).join('')}</tbody></table>`
    : '<p style="color:var(--text-muted)">Nessuna comunicazione MEPA acquisita.</p>';
}

async function loadRdoPage() {
  const wrap = document.getElementById('rdo-table-wrap');
  if (!wrap) return;
  const importSelect = document.getElementById('rdo-import-select');
  const q = document.getElementById('rdo-search')?.value?.trim() || '';
  const soloMatch = document.getElementById('rdo-only-matched')?.checked ? '1' : '0';
  const importId = importSelect?.value ? `&import_id=${encodeURIComponent(importSelect.value)}` : '';
  wrap.innerHTML = '<p style="color:var(--text-muted)">Analisi RdO in corso...</p>';
  try {
    const data = await api('GET', `/rdo/matches?q=${encodeURIComponent(q)}&solo_match=${soloMatch}${importId}`);
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    set('rdo-total', (data?.total || 0).toLocaleString('it'));
    set('rdo-matched', (data?.matched || 0).toLocaleString('it'));
    set('rdo-unmatched', (data?.unmatched || 0).toLocaleString('it'));
    set('rdo-visible', ((data?.results || []).length).toLocaleString('it'));

    if (importSelect) {
      const imports = data?.imports || [];
      importSelect.innerHTML = imports.length
        ? imports.map(item => {
            const selected = Number(item.id) === Number(data?.selectedImportId) ? 'selected' : '';
            const label = `${item.file_name} · ${item.sheet_name || 'Foglio'} · ${item.row_count || 0} righe`;
            return `<option value="${item.id}" ${selected}>${escapeHtml(label)}</option>`;
          }).join('')
        : '<option value="">Nessun file</option>';
    }

    const rows = data?.results || [];
    if (!data?.selectedImportId) {
      wrap.innerHTML = '<p style="color:var(--text-muted)">Carica prima un file XLS/XLSX con la tabella RdO.</p>';
      return;
    }

    if (!rows.length) {
      wrap.innerHTML = '<p style="color:var(--text-muted)">Nessuna riga compatibile con i filtri attuali.</p>';
      return;
    }

    const categoriaMap = new Map();
    rows.forEach(r => {
      const key = String(r.categoria || 'Senza categoria').trim() || 'Senza categoria';
      if (!categoriaMap.has(key)) categoriaMap.set(key, { count: 0, matched: 0 });
      const item = categoriaMap.get(key);
      item.count += 1;
      if (r.match_count) item.matched += 1;
    });
    const categorie = [...categoriaMap.entries()]
      .map(([categoria, stats]) => ({ categoria, ...stats }))
      .sort((a, b) => b.count - a.count);

    wrap.innerHTML = `
      <div class="rdo-layout-grid">
        <div class="table-wrapper rdo-side-table">
          <table class="data-table">
            <thead>
              <tr>
                <th>Categoria RdO</th>
                <th>Righe</th>
                <th>Con match</th>
              </tr>
            </thead>
            <tbody>
              ${categorie.map(item => `
                <tr>
                  <td>
                    <div class="rdo-category-cell">
                      <strong>${escapeHtml(item.categoria)}</strong>
                    </div>
                  </td>
                  <td><span class="rdo-pill rdo-pill-neutral">${item.count}</span></td>
                  <td><span class="rdo-pill ${item.matched ? 'rdo-pill-success' : 'rdo-pill-neutral'}">${item.matched}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div class="table-wrapper rdo-main-table">
          <table class="data-table rdo-results-table">
            <thead>
              <tr>
                <th style="width:72px">Riga</th>
                <th>Dettaglio RdO</th>
                <th>Categoria e match</th>
                <th>CPV trovati</th>
                <th style="width:120px">Scadenza</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(r => {
                const categorieTrovate = [...new Set((r.cpv_matches || []).map(m => m.categoria_catalogo).filter(Boolean))];
                const cpvMatches = r.cpv_matches || [];
                const cpvTrovati = cpvMatches.map(m => ({
                  codice: m.codice_cpv_display || m.codice_cpv,
                  score: m.score,
                  descrizione: m.descrizione_cpv || ''
                }));
                const topCpv = cpvTrovati.slice(0, 3);
                return `
                  <tr>
                    <td>
                      <div class="rdo-row-index">
                        <strong>#${escapeHtml(r.row_index || '-')}</strong>
                      </div>
                    </td>
                    <td>
                      <div class="rdo-detail-cell">
                        <div class="rdo-ente">${escapeHtml(r.ente || 'Ente non indicato')}</div>
                        <div class="rdo-gara">${escapeHtml(r.gara || 'Oggetto non indicato')}</div>
                      </div>
                    </td>
                    <td>
                      <div class="rdo-match-cell">
                        <div class="rdo-category-main">${escapeHtml((r.categoria || 'Senza categoria').substring(0, 180))}</div>
                        <div class="rdo-pill-row">
                          <span class="rdo-pill ${cpvMatches.length ? 'rdo-pill-success' : 'rdo-pill-neutral'}">${cpvMatches.length} match</span>
                          <span class="rdo-pill rdo-pill-neutral">${categorieTrovate.length} categorie</span>
                        </div>
                        <div class="rdo-category-list">
                          ${categorieTrovate.length ? categorieTrovate.map(item => `<span class="rdo-tag">${escapeHtml(item)}</span>`).join('') : '<span style="color:var(--text-muted)">Nessuna categoria trovata</span>'}
                        </div>
                      </div>
                    </td>
                    <td>
                      <div class="rdo-cpv-list">
                        ${topCpv.length ? topCpv.map(item => `
                          <div class="rdo-cpv-item">
                            <div><code>${escapeHtml(item.codice)}</code> <span class="rdo-score">score ${escapeHtml(item.score)}</span></div>
                            ${item.descrizione ? `<div class="rdo-cpv-desc">${escapeHtml(item.descrizione)}</div>` : ''}
                          </div>
                        `).join('') : '<span style="color:var(--text-muted)">Nessun CPV</span>'}
                        ${cpvTrovati.length > 3 ? `<div class="rdo-more">+${cpvTrovati.length - 3} altri match</div>` : ''}
                      </div>
                    </td>
                    <td>
                      <span class="rdo-deadline" style="color:${getDeadlineColor(r.scadenza)}">${escapeHtml(r.scadenza || '-')}</span>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  } catch (e) {
    wrap.innerHTML = `<p style="color:var(--danger)">${escapeHtml(e.message || 'Errore RdO')}</p>`;
  }
}

async function uploadRdoFile(files) {
  const file = files?.[0];
  if (!file) return;
  const input = document.getElementById('rdo-upload-input');
  const wrap = document.getElementById('rdo-table-wrap');
  if (wrap) wrap.innerHTML = '<p style="color:var(--text-muted)">Upload file RdO in corso...</p>';
  try {
    const form = new FormData();
    form.append('file', file);
    const data = await apiForm('POST', '/rdo/upload', form);
    if (!data?.ok) throw new Error(data?.error || 'Upload non riuscito');
    toast(`File importato: ${file.name}`, 'success');
    await loadRdoPage();
  } catch (e) {
    toast(e.message || 'Errore upload file RdO', 'error');
    if (wrap) wrap.innerHTML = `<p style="color:var(--danger)">${escapeHtml(e.message || 'Errore upload file RdO')}</p>`;
  } finally {
    if (input) input.value = '';
  }
}

function getDeadlineColor(value) {
  if (!value) return 'var(--text)';
  const m = String(value).match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
  const d = m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] || '9'), Number(m[5] || '0'), 0) : new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return 'var(--text)';
  const diff = Math.ceil((d.getTime() - Date.now()) / 86400000);
  if (diff <= 1) return 'var(--danger)';
  if (diff <= 3) return '#d97706';
  return 'var(--success)';
}

async function updateMepaMailStatus(id, stato) {
  try {
    const body = { stato };
    if (stato === 'eliminata') body.sync_attiva = 0;
    await api('PATCH', `/google/gmail/mepa/messages/${id}`, body);
    toast('Stato aggiornato', 'success');
    loadMepaMailList();
    loadNotifications();
  } catch (e) { toast(e.message, 'error'); }
}

async function removeMepaMail(id) {
  if (!confirm('Escludere questa mail dalle sincronizzazioni future?')) return;
  await updateMepaMailStatus(id, 'eliminata');
}

function getNotificationUrgencyMeta(level = 'media') {
  const key = ['alta', 'media', 'bassa'].includes(level) ? level : 'media';
  return {
    alta: { label: 'Alta', icon: '▲', cls: 'urgency-alta' },
    media: { label: 'Media', icon: '●', cls: 'urgency-media' },
    bassa: { label: 'Bassa', icon: '■', cls: 'urgency-bassa' }
  }[key];
}

function formatNotificationTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function notificationStateLabel(row) {
  if (row?.eliminata) return 'Archiviata';
  return row?.letta ? 'Letta' : 'Da leggere';
}

function filterNotifications(rows = []) {
  const urgency = document.getElementById('notif-filter-urgency')?.value || '';
  const state = document.getElementById('notif-filter-state')?.value || '';
  return rows.filter(row => {
    if (urgency && row.livello_urgenza !== urgency) return false;
    if (state === 'aperte' && row.letta) return false;
    if (state === 'lette' && !row.letta) return false;
    return true;
  });
}

function renderNotificationList(rows, { compact = false, targetId, emptyText }) {
  const target = document.getElementById(targetId);
  if (!target) return;
  if (!rows?.length) {
    target.innerHTML = `<div class="notification-empty">${emptyText}</div>`;
    return;
  }
  if (compact) {
    target.innerHTML = `<div class="notification-list compact">
      ${rows.map(row => {
        const urgency = getNotificationUrgencyMeta(row.livello_urgenza);
        return `
          <article class="notification-card compact ${row.letta ? 'is-read' : 'is-open'}">
            <div class="notification-card-top compact">
              <span class="notification-urgency ${urgency.cls}">${urgency.icon} ${urgency.label}</span>
              <span class="notification-state">${notificationStateLabel(row)}</span>
            </div>
            <h3>${escapeHtml(row.titolo || 'Notifica')}</h3>
            <p class="notification-message compact">${escapeHtml(compactText(row.messaggio || '', 88))}</p>
            <div class="notification-submeta compact">
              <span>${formatNotificationTimestamp(row.creato_il)}</span>
              ${row.entita_tipo ? `<span>${escapeHtml(row.entita_tipo)}</span>` : ''}
            </div>
          </article>
        `;
      }).join('')}
    </div>`;
    return;
  }
  target.innerHTML = `<div class="notification-list ${compact ? 'compact' : ''}">
    ${rows.map(row => {
      const urgency = getNotificationUrgencyMeta(row.livello_urgenza);
      const state = notificationStateLabel(row);
      const message = compact ? compactText(row.messaggio || '', 140) : (row.messaggio || '');
      return `
        <article class="notification-card ${compact ? 'compact' : ''} ${row.letta ? 'is-read' : 'is-open'}">
          <div class="notification-card-top">
            <div class="notification-meta">
              <span class="notification-urgency ${urgency.cls}">${urgency.icon} ${urgency.label}</span>
              ${row.pinned ? '<span class="notification-pin">In evidenza</span>' : ''}
              <span class="notification-type">${escapeHtml(row.tipo || 'info')}</span>
            </div>
            <div class="notification-state">${state}</div>
          </div>
          <div class="notification-title-row">
            <h3>${escapeHtml(row.titolo || 'Notifica')}</h3>
            <button class="btn btn-sm ${row.pinned ? 'btn-danger' : 'btn-outline'}" onclick="toggleNotificationPinned(${row.id}, ${row.pinned ? 1 : 0})" title="Metti in evidenza">${row.pinned ? '★' : '☆'}</button>
          </div>
          <p class="notification-message">${escapeHtml(message)}</p>
          <div class="notification-footer">
            <div class="notification-submeta">
              <span>${formatNotificationTimestamp(row.creato_il)}</span>
              ${row.entita_tipo ? `<span>${escapeHtml(row.entita_tipo)}</span>` : ''}
            </div>
            <div class="notification-actions">
              <button class="btn btn-outline btn-sm" onclick="markNotificationRead(${row.id}, ${row.letta ? 0 : 1})">${row.letta ? 'Segna da leggere' : 'Segna letta'}</button>
              ${compact ? '' : `
                <select class="notification-urgency-select" onchange="setNotificationUrgency(${row.id}, this.value)">
                  <option value="alta" ${row.livello_urgenza === 'alta' ? 'selected' : ''}>Alta</option>
                  <option value="media" ${(!row.livello_urgenza || row.livello_urgenza === 'media') ? 'selected' : ''}>Media</option>
                  <option value="bassa" ${row.livello_urgenza === 'bassa' ? 'selected' : ''}>Bassa</option>
                </select>
              `}
              <button class="btn btn-danger btn-sm" onclick="deleteNotification(${row.id})">Elimina</button>
            </div>
          </div>
        </article>
      `;
    }).join('')}
  </div>`;
}

function updateNotificationKpi(rows = []) {
  const total = rows.length;
  const open = rows.filter(row => !row.letta).length;
  const high = rows.filter(row => row.livello_urgenza === 'alta').length;
  const pinned = rows.filter(row => !!row.pinned).length;
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  set('notif-total', total);
  set('notif-open', open);
  set('notif-high', high);
  set('notif-pinned', pinned);
}

function updateDashboardNotificationBell(rows = []) {
  const countEl = document.getElementById('dashboard-bell-count');
  if (countEl) {
    const unread = rows.filter(row => !row.letta).length;
    countEl.textContent = unread;
    countEl.style.display = unread ? 'inline-flex' : 'none';
  }
}

function toggleDashboardNotifications(event) {
  event?.stopPropagation?.();
  const dropdown = document.getElementById('dashboard-bell-dropdown');
  const button = document.getElementById('dashboard-bell-btn');
  if (!dropdown || !button) return;
  const open = dropdown.classList.toggle('open');
  button.classList.toggle('is-open', open);
}

function closeDashboardNotifications() {
  const dropdown = document.getElementById('dashboard-bell-dropdown');
  const button = document.getElementById('dashboard-bell-btn');
  if (dropdown) dropdown.classList.remove('open');
  if (button) button.classList.remove('is-open');
}

document.addEventListener('click', (event) => {
  const wrap = document.querySelector('.dashboard-bell-wrap');
  if (!wrap) return;
  if (!wrap.contains(event.target)) closeDashboardNotifications();
});

async function fetchNotifications(force = false) {
  if (!force && notificationsCache.length) return notificationsCache;
  notificationsCache = await api('GET', '/google/notifications') || [];
  return notificationsCache;
}

async function loadNotifications(force = true) {
  const rows = await fetchNotifications(force);
  const compactRows = (rows || []).slice(0, 6);
  renderNotificationList(compactRows, {
    compact: true,
    targetId: 'dashboard-bell-list',
    emptyText: 'Nessuna notifica in evidenza.'
  });
  updateDashboardNotificationBell(rows || []);
  syncPushBadgeFromNotifications(rows || []).catch(() => {});
  if (document.getElementById('section-notifiche')?.classList.contains('active')) {
    loadNotificationsPage(rows);
  }
}

async function loadNotificationsPage(prefetchedRows) {
  const rows = Array.isArray(prefetchedRows) ? prefetchedRows : await fetchNotifications(true);
  const filtered = filterNotifications(rows);
  updateNotificationKpi(rows);
  renderNotificationList(filtered, {
    compact: false,
    targetId: 'notifications-page-list',
    emptyText: 'Nessuna notifica per i filtri selezionati.'
  });
}

async function refreshNotificationViews() {
  notificationsCache = [];
  await loadNotifications(true);
}

async function markNotificationRead(id, letta = 1) {
  await api('PATCH', `/google/notifications/${id}`, { letta: letta ? 1 : 0 });
  await refreshNotificationViews();
}

async function toggleNotificationPinned(id, pinned) {
  await api('PATCH', `/google/notifications/${id}`, { pinned: pinned ? 0 : 1 });
  await refreshNotificationViews();
}

async function setNotificationUrgency(id, livello_urgenza) {
  await api('PATCH', `/google/notifications/${id}`, { livello_urgenza });
  await refreshNotificationViews();
}

async function deleteNotification(id) {
  if (!confirm('Eliminare questa notifica?')) return;
  await api('PATCH', `/google/notifications/${id}`, { eliminata: 1 });
  await refreshNotificationViews();
}

async function markAllNotificationsRead() {
  const rows = await fetchNotifications();
  const unread = rows.filter(row => !row.letta);
  if (!unread.length) {
    toast('Tutte le notifiche sono gia lette', 'info');
    return;
  }
  await Promise.all(unread.map(row => api('PATCH', `/google/notifications/${row.id}`, { letta: 1 })));
  toast('Notifiche aggiornate', 'success');
  await refreshNotificationViews();
}

const AUTOMATION_SETTING_DEFS = [
  {
    key: 'automation.email_users_activity_assignments',
    label: 'Email utenti su nuove assegnazioni attività',
    description: 'Quando assegniamo o riassegniamo un’attività, l’utente incaricato riceve anche una mail oltre alla notifica in-app.',
    group: 'attivita',
    audience: 'Utenti interni'
  },
  {
    key: 'automation.email_users_activity_updates',
    label: 'Email utenti su aggiornamenti attività',
    description: 'Invia una mail agli utenti coinvolti quando cambiano stato, data o altri campi importanti dell’attività.',
    group: 'attivita',
    audience: 'Utenti interni'
  },
  {
    key: 'automation.email_clients_activity_updates',
    label: 'Email clienti su aggiornamenti attività',
    description: 'Manda una comunicazione esterna al cliente quando cambia stato o data di un’attività collegata.',
    group: 'attivita',
    audience: 'Clienti'
  },
  {
    key: 'automation.email_users_order_status',
    label: 'Email utenti su cambio stato ordini',
    description: 'Ogni variazione di stato ordine viene riepilogata anche via mail agli utenti attivi.',
    group: 'ordini',
    audience: 'Utenti interni'
  },
  {
    key: 'automation.email_clients_order_status',
    label: 'Email clienti su cambio stato ordini',
    description: 'Informa automaticamente il cliente quando lo stato del suo ordine viene aggiornato nel CRM.',
    group: 'ordini',
    audience: 'Clienti'
  }
];

let automationSettingsCache = {};

function getAutomationSettingValue(key, fallback = '0') {
  return automationSettingsCache[key] ?? fallback;
}

function summarizeAutomationSettings() {
  const defs = AUTOMATION_SETTING_DEFS;
  const enabled = defs.filter(def => getAutomationSettingValue(def.key) === '1');
  const internal = enabled.filter(def => def.audience === 'Utenti interni').length;
  const clients = enabled.filter(def => def.audience === 'Clienti').length;
  return { total: defs.length, enabled: enabled.length, internal, clients };
}

function renderAutomationSummary() {
  const target = document.getElementById('automation-summary');
  if (!target) return;
  const summary = summarizeAutomationSettings();
  target.innerHTML = `
    <div class="summary-card tone-primary">
      <div class="summary-card-top"><span class="summary-card-icon">⚙</span><span>Regole disponibili</span></div>
      <div class="summary-card-value">${summary.total}</div>
      <div class="summary-card-meta">Automazioni CRM pronte da gestire</div>
    </div>
    <div class="summary-card tone-success">
      <div class="summary-card-top"><span class="summary-card-icon">✅</span><span>Automazioni attive</span></div>
      <div class="summary-card-value">${summary.enabled}</div>
      <div class="summary-card-meta">Flussi email attualmente accesi</div>
    </div>
    <div class="summary-card tone-warning">
      <div class="summary-card-top"><span class="summary-card-icon">👥</span><span>Utenti interni</span></div>
      <div class="summary-card-value">${summary.internal}</div>
      <div class="summary-card-meta">Regole attive verso il team</div>
    </div>
    <div class="summary-card tone-primary">
      <div class="summary-card-top"><span class="summary-card-icon">📨</span><span>Clienti</span></div>
      <div class="summary-card-value">${summary.clients}</div>
      <div class="summary-card-meta">Regole attive verso l’esterno</div>
    </div>
  `;
}

function renderAutomationSections() {
  const target = document.getElementById('automation-sections');
  if (!target) return;
  const grouped = AUTOMATION_SETTING_DEFS.reduce((acc, def) => {
    acc[def.group] ||= [];
    acc[def.group].push(def);
    return acc;
  }, {});
  const groupTitles = {
    attivita: 'Attività CRM',
    ordini: 'Ordini'
  };
  target.innerHTML = Object.entries(grouped).map(([group, defs]) => `
    <div class="dash-card automation-card-group">
      <div class="automation-group-header">
        <div>
          <h3>${groupTitles[group] || group}</h3>
          <p>Gestiamo in modo separato automazioni interne ed eventuali comunicazioni verso i clienti.</p>
        </div>
      </div>
      <div class="automation-option-list">
        ${defs.map(def => `
          <label class="automation-option">
            <div class="automation-option-copy">
              <div class="automation-option-top">
                <strong>${def.label}</strong>
                <span class="automation-badge">${def.audience}</span>
              </div>
              <p>${def.description}</p>
            </div>
            <span class="automation-switch">
              <input type="checkbox" data-automation-key="${def.key}" ${getAutomationSettingValue(def.key) === '1' ? 'checked' : ''}>
              <span class="automation-switch-slider"></span>
            </span>
          </label>
        `).join('')}
      </div>
    </div>
  `).join('');
}

async function loadAutomationPage() {
  const rows = await api('GET', '/google/settings');
  automationSettingsCache = {};
  (rows || []).forEach(row => {
    automationSettingsCache[row.key] = String(row.value ?? '');
  });
  renderAutomationSummary();
  renderAutomationSections();
}

async function saveAutomationSettings() {
  const toggles = [...document.querySelectorAll('[data-automation-key]')];
  if (!toggles.length) {
    toast('Nessuna automazione da salvare', 'info');
    return;
  }
  const items = toggles.map(input => ({
    key: input.dataset.automationKey,
    type: 'boolean',
    value: input.checked ? '1' : '0'
  }));
  await api('PUT', '/google/settings', { items });
  items.forEach(item => { automationSettingsCache[item.key] = item.value; });
  renderAutomationSummary();
  toast('Automazioni aggiornate', 'success');
}

async function loadStatistics() {
  const stats = await api('GET', '/system/stats/overview');
  const cpv = await api('GET', '/mepa/cpv-operativi');
  document.getElementById('stat-mail-ricevute').textContent = stats?.kpi?.mailRicevute || 0;
  document.getElementById('stat-mail-nuove').textContent = stats?.kpi?.mailNuove || 0;
  document.getElementById('stat-scadenze').textContent = stats?.kpi?.scadenze || 0;
  document.getElementById('stat-notifiche').textContent = stats?.kpi?.notificheDaLeggere || 0;
  document.getElementById('stats-recenti').innerHTML = (stats?.recenti || []).length
    ? (stats.recenti || []).map(r => `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
        <strong>${r.tipo}</strong> - ${r.titolo || '-'}
        <div style="font-size:12px;color:var(--text-muted)">${r.data || ''} ${r.stato ? `| ${r.stato}` : ''}</div>
      </div>`).join('')
    : '<p style="color:var(--text-muted)">Nessun evento recente.</p>';
  document.getElementById('stats-cpv-operativi').innerHTML = (cpv || []).map(c => `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
        <div>
          <strong>${c.codice_cpv}</strong> - ${c.desc || ''}
          <div style="font-size:12px;color:var(--text-muted)">Mercato: EUR ${(c.valore_mercato || 0).toLocaleString('it-IT')}</div>
        </div>
        <span class="badge">${c.stato_operativo}</span>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:6px">
        Prodotto: ${c.prodotti_count ? 'si' : 'no'} | Scorta: ${c.giacenza_totale || 0}
        ${c.prodotti_count ? `| ${c.prodotti.map(p => `${p.codice_interno} (${p.giacenza || 0})`).join(', ')}` : '| da attivare/acquistare'}
      </div>
    </div>`).join('') || '<p style="color:var(--text-muted)">Nessun CPV attivo trovato.</p>';
}

async function loadSettingsPage() {
  const rows = await api('GET', '/system/settings');
  const box = document.getElementById('settings-list');
  box.innerHTML = (rows || []).map(r => `<div style="display:grid;grid-template-columns:220px 1fr;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">
      <div><strong>${r.key}</strong><div style="font-size:12px;color:var(--text-muted)">${r.type}</div></div>
      <input type="text" data-setting-key="${r.key}" data-setting-type="${r.type}" value="${String(r.value || '').replace(/"/g, '&quot;')}">
    </div>`).join('');
}

async function saveSettingsPage() {
  const items = [...document.querySelectorAll('[data-setting-key]')].map(el => ({
    key: el.dataset.settingKey,
    type: el.dataset.settingType || 'string',
    value: el.value
  }));
  await api('PUT', '/system/settings', { items });
  toast('Impostazioni salvate', 'success');
}

function formatAuditDetails(value) {
  if (!value) return '—';
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object') return escapeHtml(String(value));
    return Object.entries(parsed)
      .slice(0, 6)
      .map(([k, v]) => `<div><strong>${escapeHtml(k)}:</strong> ${escapeHtml(Array.isArray(v) ? v.join(', ') : String(v ?? '—'))}</div>`)
      .join('');
  } catch {
    return escapeHtml(String(value));
  }
}

async function loadAuditLog() {
  const userSelect = document.getElementById('audit-user-filter');
  if (userSelect && !userSelect.dataset.loaded) {
    const users = await api('GET', '/utenti');
    userSelect.innerHTML = `<option value="">Tutti gli utenti</option>` + (users || [])
      .map(u => `<option value="${u.id}">${escapeHtml(u.nome)}${u.email ? ` (${escapeHtml(u.email)})` : ''}</option>`)
      .join('');
    userSelect.dataset.loaded = '1';
  }

  const params = new URLSearchParams();
  const utenteId = userSelect?.value || '';
  const azione = document.getElementById('audit-action-filter')?.value?.trim() || '';
  const q = document.getElementById('audit-search')?.value?.trim() || '';
  if (utenteId) params.set('utente_id', utenteId);
  if (azione) params.set('azione', azione);
  if (q) params.set('q', q);
  params.set('limit', '250');

  const data = await api('GET', `/audit?${params.toString()}`);
  const rows = data?.rows || [];
  const stats = data?.stats || {};

  const summary = document.getElementById('audit-summary');
  if (summary) {
    summary.innerHTML = `
      <div class="summary-card"><strong>${stats.totale || 0}</strong><span>Eventi trovati</span></div>
      <div class="summary-card"><strong>${stats.utenti_coinvolti || 0}</strong><span>Utenti coinvolti</span></div>
      <div class="summary-card"><strong>${stats.azioni_distinte || 0}</strong><span>Azioni distinte</span></div>
      <div class="summary-card"><strong>${stats.entita_distinte || 0}</strong><span>Tipi entità</span></div>
    `;
  }

  const body = document.getElementById('audit-body');
  if (!body) return;
  body.innerHTML = rows.length ? rows.map(row => `
    <tr>
      <td>${escapeHtml(String(row.creato_il || '—').replace('T', ' ').slice(0, 19))}</td>
      <td>
        <strong>${escapeHtml(row.utente_nome || 'Sistema')}</strong>
        <div style="font-size:12px;color:var(--text-muted)">${escapeHtml(row.utente_email || '')}</div>
      </td>
      <td><span class="status-chip status-chip-info">${escapeHtml(row.azione || '—')}</span></td>
      <td>
        <strong>${escapeHtml(row.entita_tipo || '—')}</strong>
        <div style="font-size:12px;color:var(--text-muted)">ID: ${escapeHtml(row.entita_id ?? '—')}</div>
      </td>
      <td style="font-size:12px;line-height:1.5">${formatAuditDetails(row.dettagli)}</td>
    </tr>
  `).join('') : `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:26px">Nessun evento trovato con questi filtri.</td></tr>`;
}

function formatSystemLogDetails(row) {
  const parts = [];
  if (row.messaggio) parts.push(`<div><strong>Messaggio:</strong> ${escapeHtml(row.messaggio)}</div>`);
  if (row.status_code) parts.push(`<div><strong>HTTP:</strong> ${escapeHtml(String(row.status_code))}</div>`);
  if (row.stack) parts.push(`<details><summary>Stack trace</summary><pre style="white-space:pre-wrap;font-size:11px;margin-top:8px">${escapeHtml(String(row.stack))}</pre></details>`);
  if (row.dettagli) {
    try {
      const parsed = JSON.parse(row.dettagli);
      parts.push(`<div style="margin-top:6px">${Object.entries(parsed || {}).slice(0, 8).map(([k, v]) => `<div><strong>${escapeHtml(k)}:</strong> ${escapeHtml(typeof v === 'string' ? v : JSON.stringify(v))}</div>`).join('')}</div>`);
    } catch {
      parts.push(`<div>${escapeHtml(String(row.dettagli))}</div>`);
    }
  }
  return parts.join('');
}

async function loadSystemLog() {
  const level = document.getElementById('system-log-level')?.value || '';
  const origin = document.getElementById('system-log-origin')?.value?.trim() || '';
  const q = document.getElementById('system-log-search')?.value?.trim() || '';
  const params = new URLSearchParams();
  if (level) params.set('level', level);
  if (origin) params.set('origin', origin);
  if (q) params.set('q', q);
  params.set('limit', '250');
  const data = await api('GET', `/system-log?${params.toString()}`);
  const rows = data?.rows || [];
  const stats = data?.stats || {};
  const summary = document.getElementById('system-log-summary');
  if (summary) {
    summary.innerHTML = `
      <div class="summary-card"><strong>${stats.totale || 0}</strong><span>Eventi</span></div>
      <div class="summary-card"><strong>${stats.errori || 0}</strong><span>Error</span></div>
      <div class="summary-card"><strong>${stats.warning || 0}</strong><span>Warn</span></div>
      <div class="summary-card"><strong>${stats.origini || 0}</strong><span>Origini</span></div>
    `;
  }
  const body = document.getElementById('system-log-body');
  if (!body) return;
  body.innerHTML = rows.length ? rows.map(row => `
    <tr>
      <td>${escapeHtml(String(row.creato_il || '—').replace('T', ' ').slice(0, 19))}</td>
      <td><span class="status-chip ${row.livello === 'error' ? 'status-chip-danger' : row.livello === 'warn' ? 'status-chip-warning' : 'status-chip-info'}">${escapeHtml(row.livello || 'info')}</span></td>
      <td>${escapeHtml(row.origine || 'app')}</td>
      <td><div style="font-size:12px"><strong>${escapeHtml(row.metodo || '-')}</strong> ${escapeHtml(row.route || '-')}</div></td>
      <td><strong>${escapeHtml(row.utente_nome || 'Sistema')}</strong><div style="font-size:12px;color:var(--text-muted)">${escapeHtml(row.utente_email || '')}</div></td>
      <td style="font-size:12px;line-height:1.5">${formatSystemLogDetails(row)}</td>
    </tr>
  `).join('') : `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:26px">Nessun errore di sistema trovato.</td></tr>`;
}

async function clearSystemLog() {
  if (!confirm('Svuotare il system log?')) return;
  await api('DELETE', '/system-log');
  toast('System log svuotato', 'success');
  loadSystemLog();
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

function slugifyTableName(value = 'tabella') {
  return String(value || 'tabella')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'tabella';
}

function escapeCsvValue(value) {
  const text = String(value ?? '').replace(/\r?\n/g, ' ').trim();
  if (/[",;\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function getTableCellExportText(cell) {
  if (!cell) return '';
  const select = cell.querySelector('select');
  if (select) return select.options[select.selectedIndex]?.textContent?.trim() || '';
  return cell.innerText.replace(/\s+/g, ' ').trim();
}

function getTableRows(table, mode = 'visible') {
  return [...table.querySelectorAll('tbody tr')].filter(row => row.querySelectorAll('td').length > 0)
    .filter(row => mode === 'all' || row.style.display !== 'none');
}

function getTableHeaders(table) {
  return [...table.querySelectorAll('thead tr:first-child th')].map(th => th.textContent.trim() || 'Colonna');
}

function buildTableExportMatrix(table, mode = 'visible') {
  const headers = getTableHeaders(table);
  const rows = getTableRows(table, mode).map(row => [...row.querySelectorAll('td')].map(getTableCellExportText));
  return { headers, rows };
}

function downloadBlob(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function exportTableCsv(table, mode = 'visible') {
  const { headers, rows } = buildTableExportMatrix(table, mode);
  const csv = [headers.map(escapeCsvValue).join(';')]
    .concat(rows.map(row => row.map(escapeCsvValue).join(';')))
    .join('\n');
  const name = `${table.dataset.exportName || 'tabella'}-${mode === 'visible' ? 'visibile' : 'completa'}.csv`;
  downloadBlob(name, '\uFEFF' + csv, 'text/csv;charset=utf-8;');
}

function exportTableExcel(table, mode = 'visible') {
  const { headers, rows } = buildTableExportMatrix(table, mode);
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><table border="1"><thead><tr>${
    headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')
  }</tr></thead><tbody>${
    rows.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
  }</tbody></table></body></html>`;
  const name = `${table.dataset.exportName || 'tabella'}-${mode === 'visible' ? 'visibile' : 'completa'}.xls`;
  downloadBlob(name, html, 'application/vnd.ms-excel;charset=utf-8;');
}

function applyTableColumnFilters(table) {
  const values = [...table.querySelectorAll('.table-filter-input')].map(input => (input.value || '').trim().toLowerCase());
  table.querySelectorAll('tbody tr').forEach(row => {
    const cells = [...row.querySelectorAll('td')];
    const match = values.every((value, idx) => {
      if (!value) return true;
      const cellText = getTableCellExportText(cells[idx]).toLowerCase();
      return cellText.includes(value);
    });
    row.style.display = match ? '' : 'none';
  });
}

function ensureTableToolbar(table) {
  if (table.dataset.toolsEnhanced === '1') return;
  const wrapper = table.closest('.table-wrapper');
  if (!wrapper) return;
  const title = table.closest('.section')?.querySelector('.page-header h1')?.textContent?.trim()
    || table.dataset.exportName
    || 'Tabella';
  table.dataset.exportName = slugifyTableName(title);

  const toolbar = document.createElement('div');
  toolbar.className = 'table-tools-bar';
  toolbar.innerHTML = `
    <div class="table-tools-title">
      <strong>${escapeHtml(title)}</strong>
      <span>Filtra per colonna ed esporta i risultati</span>
    </div>
    <div class="table-tools-actions">
      <button class="btn btn-outline btn-sm" type="button" data-export="csv-visible">CSV visibile</button>
      <button class="btn btn-outline btn-sm" type="button" data-export="csv-all">CSV completo</button>
      <button class="btn btn-outline btn-sm" type="button" data-export="xls-visible">Excel visibile</button>
      <button class="btn btn-outline btn-sm" type="button" data-export="xls-all">Excel completo</button>
    </div>
  `;
  toolbar.querySelectorAll('[data-export]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.export || '';
      if (action === 'csv-visible') exportTableCsv(table, 'visible');
      if (action === 'csv-all') exportTableCsv(table, 'all');
      if (action === 'xls-visible') exportTableExcel(table, 'visible');
      if (action === 'xls-all') exportTableExcel(table, 'all');
    });
  });
  wrapper.parentNode.insertBefore(toolbar, wrapper);
  table.dataset.toolsEnhanced = '1';
}

function ensureTableFilterRow(table) {
  const thead = table.querySelector('thead');
  const headerRow = table.querySelector('thead tr:first-child');
  if (!thead || !headerRow) return;
  let filterRow = table.querySelector('thead tr.table-filter-row');
  if (!filterRow) {
    filterRow = document.createElement('tr');
    filterRow.className = 'table-filter-row';
    [...headerRow.children].forEach((th, index) => {
      const cell = document.createElement('th');
      const label = (th.textContent || '').trim();
      const filterable = label && !/azioni|^$/.test(label.toLowerCase());
      cell.innerHTML = filterable
        ? `<input class="table-filter-input" type="text" placeholder="Filtra ${escapeHtml(label)}" data-col="${index}">`
        : '<span class="table-filter-placeholder">—</span>';
      filterRow.appendChild(cell);
    });
    thead.appendChild(filterRow);
  }
  filterRow.querySelectorAll('.table-filter-input').forEach(input => {
    if (input.dataset.bound === '1') return;
    input.addEventListener('input', () => applyTableColumnFilters(table));
    input.dataset.bound = '1';
  });
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
function getMarkerColor(type) {
  if (type === 'fornitore') return '#f59e0b';
  if (type === 'pa') return '#0ea5e9';
  if (type === 'consegna') return '#ef4444';
  return '#10b981';
}

function buildMarkerIcon(type) {
  return {
    path: window.google.maps.SymbolPath.CIRCLE,
    fillColor: getMarkerColor(type),
    fillOpacity: 0.95,
    strokeColor: '#ffffff',
    strokeOpacity: 1,
    strokeWeight: 2,
    scale: 8
  };
}

async function ensureGoogleMapsLoaded() {
  if (window.google?.maps) return window.google.maps;
  if (googleMapsPromise) return googleMapsPromise;
  googleMapsPromise = (async () => {
    const cfg = await api('GET', '/system/public-config');
    const key = cfg?.googleMapsApiKey;
    if (!key) throw new Error('Chiave Google Maps non configurata');
    await new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-google-maps="1"]');
      if (existing) {
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', reject, { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}`;
      script.async = true;
      script.defer = true;
      script.dataset.googleMaps = '1';
      script.onload = resolve;
      script.onerror = () => reject(new Error('Google Maps non caricato'));
      document.head.appendChild(script);
    });
    return window.google.maps;
  })();
  return googleMapsPromise;
}

function renderMappaSummary(points, stats = {}) {
  const el = document.getElementById('mappa-summary');
  if (!el) return;
  const clienti = points.filter(p => p.marker_type === 'cliente').length;
  const fornitori = points.filter(p => p.marker_type === 'fornitore').length;
  const pa = points.filter(p => p.marker_type === 'pa').length;
  const consegne = points.filter(p => p.marker_type === 'consegna').length;
  el.innerHTML = `
    <div class="summary-card"><div class="summary-label">Punti visibili</div><div class="summary-value">${points.length}</div><div class="summary-meta">Totale CRM: ${stats.totale || points.length}</div></div>
    <div class="summary-card"><div class="summary-label">Clienti / Fornitori</div><div class="summary-value">${clienti} / ${fornitori}</div><div class="summary-meta">Anagrafiche geolocalizzate</div></div>
    <div class="summary-card"><div class="summary-label">Pubbliche amministrazioni</div><div class="summary-value">${pa}</div><div class="summary-meta">PA con coordinate</div></div>
    <div class="summary-card"><div class="summary-label">Consegne DDT</div><div class="summary-value">${consegne}</div><div class="summary-meta">Punti spedizione</div></div>
  `;
}

function renderMappaFallback(points) {
  const c = document.getElementById('mappa-container');
  if (!c) return;
  c.innerHTML = `
    <div class="crm-map-shell">
      <div class="crm-map-fallback">
        <div class="crm-map-info">
          <strong>Mappa interattiva non disponibile</strong>
          <span>Mostro comunque tutti gli indirizzi geolocalizzati del CRM con link diretto a Google Maps.</span>
        </div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Tipo</th>
                <th>Indirizzo</th>
                <th>Coordinate</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${points.map(p => `
                <tr>
                  <td>${p.title || '—'}</td>
                  <td>${p.marker_type || p.category || '—'}</td>
                  <td>${p.address || '—'}</td>
                  <td>${p.lat}, ${p.lng}</td>
                  <td><a href="https://maps.google.com/?q=${p.lat},${p.lng}" target="_blank" rel="noopener" style="color:var(--accent)">Apri mappa</a></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

async function renderGoogleMap(points) {
  const maps = await ensureGoogleMapsLoaded();
  const c = document.getElementById('mappa-container');
  if (!c) return;
  c.innerHTML = `
    <div class="crm-map-shell">
      <div id="crm-google-map"></div>
      <div class="crm-map-info">
        <strong>${points.length} punti visualizzati</strong>
        <span>Colori marker: clienti verde, fornitori arancio, PA blu, consegne rosso.</span>
      </div>
    </div>
  `;
  const center = { lat: Number(points[0].lat), lng: Number(points[0].lng) };
  crmMap = new maps.Map(document.getElementById('crm-google-map'), {
    center,
    zoom: 6,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: true
  });
  const bounds = new maps.LatLngBounds();
  crmMapMarkers.forEach(marker => marker.setMap(null));
  crmMapMarkers = [];
  const info = new maps.InfoWindow();
  points.forEach(point => {
    const position = { lat: Number(point.lat), lng: Number(point.lng) };
    const marker = new maps.Marker({
      position,
      map: crmMap,
      title: point.title || '',
      icon: buildMarkerIcon(point.marker_type)
    });
    marker.addListener('click', () => {
      info.setContent(`
        <div style="min-width:220px;max-width:280px;padding:4px 2px">
          <div style="font-weight:700;margin-bottom:6px">${point.title || 'Punto CRM'}</div>
          <div style="font-size:12px;color:#475569;margin-bottom:6px">${point.address || 'Indirizzo non disponibile'}</div>
          <div style="font-size:12px;color:#64748b;margin-bottom:8px">Tipo: ${point.marker_type || point.category || '—'}</div>
          <a href="https://maps.google.com/?q=${point.lat},${point.lng}" target="_blank" rel="noopener" style="color:#32477c;font-weight:600;text-decoration:none">Apri in Google Maps</a>
        </div>
      `);
      info.open({ anchor: marker, map: crmMap });
    });
    crmMapMarkers.push(marker);
    bounds.extend(position);
  });
  if (points.length > 1) crmMap.fitBounds(bounds, 56);
  else crmMap.setZoom(12);
}

async function loadMappa() {
  const data = await api('GET', '/anagrafiche/mappa/crm');
  const c = document.getElementById('mappa-container');
  if (!c) return;
  const typeFilter = document.getElementById('mappa-filter-type')?.value || '';
  const q = (document.getElementById('mappa-search')?.value || '').trim().toLowerCase();
  const allPoints = Array.isArray(data?.points) ? data.points : [];
  const points = allPoints.filter(point => {
    const typeOk = !typeFilter || point.marker_type === typeFilter;
    const haystack = [point.title, point.address, point.citta, point.provincia, point.category, point.marker_type]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const textOk = !q || haystack.includes(q);
    return typeOk && textOk;
  });
  renderMappaSummary(points, data?.stats || {});
  if (!points.length) {
    c.innerHTML = '<div class="crm-map-shell"><div class="crm-map-empty">Nessun punto corrisponde ai filtri selezionati.</div></div>';
    return;
  }
  try {
    await renderGoogleMap(points);
  } catch (err) {
    console.warn('Google Maps fallback', err);
    renderMappaFallback(points);
  }
}

const RUOLI_NOMI = {1:'readonly',2:'commerciale',3:'admin',4:'superadmin',5:'amministrazione',6:'logistica',7:'commercialista_esterno'};
const RUOLI_LABEL = {1:'Read Only',2:'Commerciale',3:'Admin',4:'SuperAdmin',5:'Amministrazione',6:'Logistica',7:'Commercialista esterno'};
const SEZIONI = ['clienti','fornitori','contatti','prodotti','magazzino','preventivi','ordini','ddt','container','fatture-attive','fatture-passive','fatture-fuori-campo','attivita','documenti','mepa','cig','analytics','statistics','settings','mappa','utenti','system-log'];
const SEZIONI_LABEL = {
  clienti: 'Clienti',
  fornitori: 'Fornitori',
  contatti: 'Contatti',
  prodotti: 'Prodotti',
  magazzino: 'Magazzino',
  preventivi: 'Preventivi',
  ordini: 'Ordini',
  ddt: 'DDT',
  container: 'Container',
  'fatture-attive': 'Fatture attive',
  'fatture-passive': 'Fatture passive',
  'fatture-fuori-campo': 'Fuori campo IVA',
  attivita: 'Attività CRM',
  documenti: 'Documenti',
  mepa: 'Abilitazioni CPV MEPA',
  cig: 'Stagionalità CIG',
  analytics: 'Analisi API MEPA',
  statistics: 'Statistics',
  settings: 'Impostazioni',
  mappa: 'Mappa CRM',
  utenti: 'Utenti',
  'system-log': 'System Log'
};
async function loadUtenti() {
  const [rows, roles] = await Promise.all([
    api('GET', '/utenti'),
    api('GET', '/utenti/ruoli')
  ]);
  document.getElementById('utenti-body').innerHTML = (rows||[]).map(u=>`
    <tr><td>${u.nome}</td><td>${u.email}</td>
    <td><span class="badge badge-${RUOLI_NOMI[u.ruolo_id]||''}">${u.ruolo_nome||'—'}</span></td>
    <td>${u.tema==='light'?'☀️ Chiaro':'🌙 Scuro'}</td>
    <td>${u.attivo?'✅':'❌'}</td>
    <td>
      <button class="btn btn-outline btn-sm" onclick="editUtente(${u.id})">Modifica</button>
      <button class="btn btn-outline btn-sm" onclick="mostraBigliettoUtente(${u.id})">Biglietto</button>
    </td></tr>`).join('');
  const roleOptions = (roles || []).sort((a,b) => a.id - b.id).map(r => `<option value="${r.id}">${RUOLI_LABEL[r.id] || r.nome}</option>`).join('');
  document.getElementById('utente-ruolo').innerHTML = roleOptions;
  document.getElementById('sel-ruolo-perm').innerHTML = roleOptions;
  if (!document.getElementById('sel-ruolo-perm').value) document.getElementById('sel-ruolo-perm').value = '1';
  loadPermessi(document.getElementById('sel-ruolo-perm').value);
  const page = document.getElementById('section-utenti');
  const addBtn = page?.querySelector('.page-header .btn.btn-accent');
  if (addBtn) addBtn.style.display = USER?.ruolo_id === 4 || PERMS?.utenti?.can_admin ? 'inline-flex' : 'none';
}

async function editUtente(id) {
  const rows = await api('GET', '/utenti');
  const u = rows?.find(x => x.id === id);
  if (!u) return;
  document.getElementById('utente-id').value = u.id;
  document.getElementById('utente-nome').value = u.nome;
  document.getElementById('utente-email').value = u.email;
  document.getElementById('utente-telefono').value = u.telefono || '';
  document.getElementById('utente-qualifica').value = u.qualifica || '';
  document.getElementById('utente-reparto').value = u.reparto || '';
  document.getElementById('utente-linkedin').value = u.linkedin || '';
  document.getElementById('utente-note-biglietto').value = u.note_biglietto || '';
  document.getElementById('utente-password').value = '';
  document.getElementById('utente-force-password-change').checked = !!u.force_password_change;
  document.getElementById('utente-send-credentials-email').checked = false;
  document.getElementById('utente-ruolo').value = u.ruolo_id;
  document.getElementById('utente-tema').value = u.tema || 'dark';
  document.getElementById('utente-attivo').value = u.attivo;
  openModal('modal-utente');
}

function nuovoUtente() {
  ['id','nome','email','telefono','qualifica','reparto','linkedin','note-biglietto','password'].forEach(k => {
    const el = document.getElementById(`utente-${k}`);
    if (el) el.value = '';
  });
  document.getElementById('utente-ruolo').value = '1';
  document.getElementById('utente-tema').value = 'dark';
  document.getElementById('utente-attivo').value = '1';
  document.getElementById('utente-force-password-change').checked = true;
  document.getElementById('utente-send-credentials-email').checked = false;
  openModal('modal-utente');
}

async function salvaUtente() {
  const id = document.getElementById('utente-id').value;
  const body = {
    nome: document.getElementById('utente-nome').value,
    email: document.getElementById('utente-email').value,
    telefono: document.getElementById('utente-telefono').value,
    qualifica: document.getElementById('utente-qualifica').value,
    reparto: document.getElementById('utente-reparto').value,
    linkedin: document.getElementById('utente-linkedin').value,
    note_biglietto: document.getElementById('utente-note-biglietto').value,
    password: document.getElementById('utente-password').value,
    force_password_change: document.getElementById('utente-force-password-change').checked ? 1 : 0,
    send_credentials_email: document.getElementById('utente-send-credentials-email').checked ? 1 : 0,
    ruolo_id: parseInt(document.getElementById('utente-ruolo').value),
    tema: document.getElementById('utente-tema').value,
    attivo: parseInt(document.getElementById('utente-attivo').value)
  };
  if (!body.password) delete body.password;
  try {
    const result = id ? await api('PUT', `/utenti/${id}`, body) : await api('POST', '/utenti', body);
    closeAllModals();
    if (result?.email_sent) toast('Utente salvato e credenziali inviate', 'success');
    else if (result?.email_error) toast('Utente salvato, ma invio email fallito: ' + result.email_error, 'error');
    else toast('Utente salvato', 'success');
    loadUtenti();
  } catch (e) { toast(e.message, 'error'); }
}

async function mostraBigliettoUtente(id) {
  const u = await api('GET', `/utenti/${id}/biglietto`);
  if (!u) return;
  const win = window.open('', '_blank', 'width=440,height=620');
  win.document.write(`<html><head><title>Biglietto ${u.nome}</title></head>
    <body style="margin:0;background:#e5e7eb;font-family:Georgia,serif;color:#111827">
      <div style="width:360px;margin:34px auto;background:#fff;border-radius:22px;padding:28px;box-shadow:0 24px 70px rgba(17,24,39,.22);border:1px solid #d1d5db">
        <div style="font-size:12px;letter-spacing:.24em;text-transform:uppercase;color:#6b7280">Horygon</div>
        <h1 style="margin:10px 0 4px;font-size:30px;line-height:1">${u.nome || ''}</h1>
        <div style="font-size:14px;color:#374151;margin-bottom:18px">${u.qualifica || u.ruolo_nome || ''}</div>
        <div style="display:flex;gap:20px;align-items:center">
          <img src="${u.qr}" style="width:132px;height:132px">
          <div style="font-size:13px;line-height:1.7">
            <div>${u.email || ''}</div>
            <div>${u.telefono || ''}</div>
            <div>${u.linkedin || ''}</div>
          </div>
        </div>
        <p style="font-size:12px;color:#6b7280;margin-top:18px">${u.note_biglietto || 'Scansiona il QR per salvare il contatto.'}</p>
      </div>
      <div style="text-align:center"><button onclick="window.print()" style="padding:10px 18px;border-radius:999px;border:0;background:#111827;color:white;cursor:pointer">Stampa</button></div>
    </body></html>`);
}

async function loadPermessi(ruoloId) {
  const help = document.getElementById('perm-role-help');
  if (help) {
    help.textContent = String(ruoloId) === '4'
      ? 'SuperAdmin ha accesso totale. La matrice è mostrata a scopo documentale.'
      : `Configura cosa può vedere o modificare il ruolo ${RUOLI_LABEL[ruoloId] || ruoloId}.`;
  }
  const perms = await api('GET', `/utenti/permessi/${ruoloId}`);
  const permMap = {};
  (perms||[]).forEach(p => permMap[p.sezione] = p);
  document.getElementById('perm-table').innerHTML = `
    <thead><tr><th>Pagina / Sezione</th><th>Vede</th><th>Modifica</th><th>Elimina</th><th>Admin</th></tr></thead>
    <tbody>${SEZIONI.map(s => {
      const p = permMap[s] || {};
      const disabled = String(ruoloId) === '4' ? 'disabled' : '';
      return `<tr><td>${SEZIONI_LABEL[s] || s}</td>
        <td><input type="checkbox" data-s="${s}" data-a="read" ${p.can_read?'checked':''} ${disabled}></td>
        <td><input type="checkbox" data-s="${s}" data-a="edit" ${p.can_edit?'checked':''} ${disabled}></td>
        <td><input type="checkbox" data-s="${s}" data-a="delete" ${p.can_delete?'checked':''} ${disabled}></td>
        <td><input type="checkbox" data-s="${s}" data-a="admin" ${p.can_admin?'checked':''} ${disabled}></td></tr>`;
    }).join('')}</tbody>`;
  const saveBtn = document.getElementById('btn-save-perms');
  if (saveBtn) saveBtn.style.display = String(ruoloId) === '4' ? 'none' : 'inline-flex';
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
async function openModal(id, context = null) {
  if (id === 'modal-ddt') await preparaDdtModal(context);
  if (id === 'modal-preventivo') await preparePreventivoModal(context);
  if (id === 'modal-ordine') await prepareOrdineModal(context);
  if (id === 'modal-fattura') await prepareFatturaModal(context);
  document.getElementById('overlay').style.display = 'block';
  document.getElementById(id).style.display = 'block';
}
function closeAllModals() {
  document.getElementById('overlay').style.display = 'none';
  document.querySelectorAll('.modal').forEach(m => { m.style.display = 'none'; });
}

function enhanceResponsiveTables() {
  document.querySelectorAll('.data-table').forEach(table => {
    ensureTableToolbar(table);
    ensureTableFilterRow(table);
    const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
    table.querySelectorAll('tbody tr').forEach(row => {
      [...row.children].forEach((cell, index) => {
        if (cell.tagName === 'TD') cell.setAttribute('data-label', headers[index] || '');
      });
    });
    applyTableColumnFilters(table);
  });
}

function scheduleResponsiveEnhancement() {
  if (tableEnhancementScheduled) return;
  tableEnhancementScheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    tableEnhancementScheduled = false;
    enhanceResponsiveTables();
  }));
}

window.addEventListener('resize', syncMobileLayoutState);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeMobileSidebar();
  }
});
const mainContentObserverTarget = document.getElementById('main-content');
if (mainContentObserverTarget) {
  const tableObserver = new MutationObserver(() => scheduleResponsiveEnhancement());
  tableObserver.observe(mainContentObserverTarget, { childList: true, subtree: true });
}

// Enter login
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('login-screen').style.display !== 'none') doLogin();
});

async function loadAttivita() {
  const [rows, meta] = await Promise.all([
    api('GET', '/attivita'),
    api('GET', '/attivita/meta')
  ]);
  const todayKey = new Date().toDateString();
  renderSummaryCards('attivita-summary', [
    { icon: '📋', label: 'Totali', value: rows?.length || 0, meta: 'Storico attività CRM', tone: 'primary' },
    { icon: '⏳', label: 'Aperte', value: (rows || []).filter(a => ['aperta', 'in_corso'].includes(String(a.stato || '').toLowerCase())).length, meta: 'Da seguire oggi', tone: 'warning' },
    { icon: '🗓️', label: 'Oggi', value: (rows || []).filter(a => a.data_ora && new Date(a.data_ora).toDateString() === todayKey).length, meta: 'Attività con data odierna', tone: 'cyan' },
    { icon: '☁️', label: 'Sync Google', value: (rows || []).filter(a => !!a.google_event_id).length, meta: 'Eventi agganciati al calendario', tone: 'success' }
  ]);
  document.getElementById('attivita-list').innerHTML = (rows || []).map(a => {
    const noteFull = normalizeMailBody(a.note || '');
    const notePreview = compactText(noteFull, 220);
    const mine = Number(a.assegnato_a || 0) === Number(USER?.id || 0);
    const assignedLabel = mine
      ? 'Assegnata a te'
      : (a.assegnato_nome ? `Assegnata a ${escapeHtml(a.assegnato_nome)}` : '');
    return `
    <div class="attivita-item ${mine ? 'is-mine' : ''}">
      <div class="att-icon att-${a.tipo}">${ICONE[a.tipo] || '◎'}</div>
      <div style="min-width:0;flex:1">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
          <div>
            <strong>${escapeHtml(a.oggetto || a.tipo)}</strong>
            ${mine ? `<div style="margin-top:6px"><span class="attivita-assigned-pill">Assegnata a te</span></div>` : ''}
            ${a.ragione_sociale ? `<span style="color:var(--text-muted)"> — ${escapeHtml(a.ragione_sociale)}</span>` : ''}
          </div>
          ${renderStateBadge(a.stato || 'aperta')}
        </div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px">
          ${a.data_ora ? new Date(a.data_ora).toLocaleString('it-IT') : ''}
          ${a.durata_minuti ? ` · ${a.durata_minuti} min` : ''}
          ${assignedLabel ? ` · ${assignedLabel}` : ''}
          ${a.google_event_id ? ' · <span style="color:var(--accent)">Google Cal</span>' : ''}
          ${a.stato_origine === 'mepa_mail' ? ' · <span style="color:#d97706">Mail MEPA</span>' : ''}
        </div>
        ${noteFull ? `
          <details style="margin-top:8px">
            <summary style="cursor:pointer;color:var(--text-muted);font-size:13px">${escapeHtml(notePreview)}</summary>
            <div style="font-size:13px;margin-top:8px;color:var(--text-muted);white-space:pre-wrap;line-height:1.45">${escapeHtml(noteFull)}</div>
          </details>` : ''}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap">
          <button class="btn btn-outline btn-sm" onclick="editAttivita(${a.id})">Modifica</button>
          <button class="btn btn-danger btn-sm" onclick="deleteAttivita(${a.id})">Elimina</button>
        </div>
      </div>
    </div>`;
  }).join('') || '<p style="color:var(--text-muted)">Nessuna attività</p>';
  const anag = meta?.anagrafiche || [];
  const utenti = meta?.utenti || [];
  document.getElementById('att-anagrafica').innerHTML = '<option value="">Seleziona...</option>' + anag.map(a => `<option value="${a.id}">${escapeHtml(a.ragione_sociale)}</option>`).join('');
  document.getElementById('att-assegnato').innerHTML = '<option value="">Nessuno</option>' + utenti.map(u => `<option value="${u.id}">${escapeHtml(u.nome)}</option>`).join('');
}

async function openAttivitaModal() {
  await loadAttivita();
  document.getElementById('att-id').value = '';
  document.getElementById('att-tipo').value = 'nota';
  document.getElementById('att-anagrafica').value = '';
  document.getElementById('att-assegnato').value = '';
  document.getElementById('att-stato').value = 'aperta';
  document.getElementById('att-oggetto').value = '';
  document.getElementById('att-data').value = '';
  document.getElementById('att-durata').value = 30;
  document.getElementById('att-note').value = '';
  document.getElementById('att-promemoria').value = '';
  document.getElementById('att-sync-google').checked = false;
  document.getElementById('btn-del-attivita').style.display = 'none';
  openModal('modal-attivita');
}

async function editAttivita(id) {
  const rows = await api('GET', '/attivita');
  const a = (rows || []).find(item => Number(item.id) === Number(id));
  if (!a) {
    toast('Attività non trovata', 'error');
    return;
  }
  await loadAttivita();
  document.getElementById('att-id').value = a.id;
  document.getElementById('att-tipo').value = a.tipo || 'nota';
  document.getElementById('att-anagrafica').value = a.anagrafica_id || '';
  document.getElementById('att-assegnato').value = a.assegnato_a || '';
  document.getElementById('att-stato').value = a.stato || 'aperta';
  document.getElementById('att-oggetto').value = a.oggetto || '';
  document.getElementById('att-data').value = a.data_ora ? String(a.data_ora).replace(' ', 'T').slice(0, 16) : '';
  document.getElementById('att-durata').value = a.durata_minuti || 30;
  document.getElementById('att-note').value = a.note || '';
  document.getElementById('att-promemoria').value = a.promemoria_il ? String(a.promemoria_il).replace(' ', 'T').slice(0, 16) : '';
  document.getElementById('att-sync-google').checked = !!a.google_event_id;
  document.getElementById('btn-del-attivita').style.display = 'inline-flex';
  openModal('modal-attivita');
}

function buildGoogleEventFromActivity(body) {
  const start = body.data_ora ? new Date(body.data_ora) : new Date();
  const end = new Date(start.getTime() + (body.durata_minuti || 60) * 60000);
  return {
    title: body.oggetto || body.tipo || 'Attività CRM',
    description: body.note || '',
    start: normalizeLocalDateTime(toDateTimeLocalValue(start)),
    end: normalizeLocalDateTime(toDateTimeLocalValue(end)),
    allDay: false
  };
}

async function salvaAttivita() {
  const id = document.getElementById('att-id').value;
  const body = {
    tipo: document.getElementById('att-tipo').value,
    anagrafica_id: document.getElementById('att-anagrafica').value || null,
    assegnato_a: document.getElementById('att-assegnato').value || null,
    stato: document.getElementById('att-stato').value || 'aperta',
    data_ora: document.getElementById('att-data').value,
    durata_minuti: parseInt(document.getElementById('att-durata').value) || null,
    oggetto: document.getElementById('att-oggetto').value,
    note: document.getElementById('att-note').value,
    promemoria_il: document.getElementById('att-promemoria').value || null,
  };
  try {
    let savedId = id || null;
    if (document.getElementById('att-sync-google').checked && USER.hasGoogle) {
      body.sync_google = 1;
      body.google_event = buildGoogleEventFromActivity(body);
    }
    if (id) {
      await api('PUT', `/attivita/${id}`, body);
    } else {
      const created = await api('POST', '/attivita', body);
      savedId = created?.id || null;
      if (body.assegnato_a && created?.assignmentEmailResult && created.assignmentEmailResult.sent !== true) {
        toast('Attività salvata, ma email assegnazione non inviata', 'warning');
      }
    }
    if (body.sync_google && USER.hasGoogle && (savedId || id)) {
      await api('POST', `/attivita/${savedId || id}/google-sync`, body.google_event);
    }
    closeAllModals();
    toast('Attività salvata', 'success');
    loadAttivita();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteAttivita(id = null) {
  const targetId = id || document.getElementById('att-id').value;
  if (!targetId || !confirm('Eliminare questa attività?')) return;
  try {
    await api('DELETE', `/attivita/${targetId}`);
    closeAllModals();
    toast('Attività eliminata', 'success');
    loadAttivita();
  } catch (e) { toast(e.message, 'error'); }
}

async function loadPreventivi() {
  const stato = document.getElementById('filter-stato-preventivo')?.value || '';
  const rows = await api('GET', `/preventivi${stato ? `?stato=${encodeURIComponent(stato)}` : ''}`);
  const body = document.getElementById('preventivi-body');
  if (body) {
    body.innerHTML = (rows || []).map(p => `
      <tr><td><strong>${p.codice_preventivo}</strong></td>
      <td>${p.ragione_sociale || '-'}</td><td>${p.data_preventivo || '-'}</td>
      <td>${p.data_scadenza || '-'}</td>
      <td>${p.totale ? `${p.valuta || 'EUR'} ${Number(p.totale).toFixed(2)}` : '-'}</td>
      <td>${renderStateBadge(p.stato)}</td>
      <td><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start"><button class="btn btn-outline btn-sm" onclick="modificaPreventivo(${p.id})">Apri</button><button class="btn btn-outline btn-sm" onclick="openApiPdf('/preventivi/${p.id}/pdf')">PDF</button><button class="btn btn-outline btn-sm" onclick="openSendDocumentModal('preventivo',${p.id})">Invia</button><button class="btn btn-outline btn-sm" onclick="creaOrdineDaPreventivo(${p.id})">Crea ordine</button><button class="btn btn-danger btn-sm" onclick="deletePreventivo(${p.id})">Elimina</button>${renderDocumentLogButton('preventivo', p.id, 'desk')}<select class="btn btn-outline btn-sm" onchange="cambiaStatoPreventivo(${p.id},this.value)">
        ${['bozza','inviato','accettato','rifiutato','scaduto'].map(s=>`<option value="${s}"${p.stato===s?' selected':''}>${s}</option>`).join('')}
      </select>${renderDocumentSendMeta(p)}</div></td></tr>`).join('');
  }
  renderSummaryCards('preventivi-summary', [
    { icon: 'P', label: 'Preventivi', value: rows?.length || 0, meta: stato ? `Filtro: ${stato}` : 'Tutti gli stati', tone: 'primary' },
    { icon: 'I', label: 'Inviati', value: (rows || []).filter(p => p.stato === 'inviato').length, meta: 'In attesa di risposta', tone: 'cyan' },
    { icon: 'A', label: 'Accettati', value: (rows || []).filter(p => p.stato === 'accettato').length, meta: 'Pronti per ordine', tone: 'success' },
    { icon: 'B', label: 'Bozze', value: (rows || []).filter(p => p.stato === 'bozza').length, meta: 'Da completare', tone: 'warning' }
  ]);
  renderPreventiviMobileCards(rows || []);
}

function renderPreventiviMobileCards(rows) {
  const wrap = document.getElementById('preventivi-mobile-list');
  if (!wrap) return;
  wrap.innerHTML = (rows || []).map(p => `
    <article class="mobile-record-card">
      <div class="mobile-record-header">
        <div>
          <strong>${p.codice_preventivo}</strong>
          <div class="mobile-record-subtitle">${p.ragione_sociale || 'Cliente non associato'}</div>
        </div>
        ${renderStateBadge(p.stato)}
      </div>
      <div class="mobile-record-grid">
        <div><span>Data</span><strong>${p.data_preventivo || '-'}</strong></div>
        <div><span>Scadenza</span><strong>${p.data_scadenza || '-'}</strong></div>
        <div><span>Totale</span><strong>${p.totale ? `${p.valuta || 'EUR'} ${Number(p.totale).toFixed(2)}` : '-'}</strong></div>
      </div>
      ${renderDocumentSendMeta(p)}
      <div class="mobile-record-actions">
        <button class="btn btn-outline btn-sm" onclick="modificaPreventivo(${p.id})">Apri</button>
        <button class="btn btn-outline btn-sm" onclick="openApiPdf('/preventivi/${p.id}/pdf')">PDF</button>
        <button class="btn btn-outline btn-sm" onclick="openSendDocumentModal('preventivo',${p.id})">Invia</button>
        <button class="btn btn-outline btn-sm" onclick="creaOrdineDaPreventivo(${p.id})">Crea ordine</button>
        ${renderDocumentLogButton('preventivo', p.id, 'mobile')}
        <select class="order-state-select" onchange="cambiaStatoPreventivo(${p.id},this.value)">
          ${['bozza','inviato','accettato','rifiutato','scaduto'].map(s=>`<option value="${s}"${p.stato===s?' selected':''}>${s}</option>`).join('')}
        </select>
      </div>
    </article>
  `).join('');
}

async function salvaPreventivo() {
  const id = document.getElementById('prev-id')?.value;
  const body = {
    codice_preventivo: document.getElementById('prev-codice').value,
    stato: document.getElementById('prev-stato').value,
    anagrafica_id: document.getElementById('prev-anagrafica').value || null,
    valuta: document.getElementById('prev-valuta').value || 'EUR',
    data_preventivo: document.getElementById('prev-data').value,
    data_scadenza: document.getElementById('prev-scadenza').value,
    imponibile: parseFloat(document.getElementById('prev-imponibile').value) || 0,
    iva: parseFloat(document.getElementById('prev-iva').value) || 0,
    totale: parseFloat(document.getElementById('prev-totale').value) || 0,
    note: document.getElementById('prev-note').value,
    righe: collectDocumentoRighe('prev')
  };
  try {
    if (id) await api('PUT', `/preventivi/${id}`, body);
    else await api('POST', '/preventivi', body);
    closeAllModals();
    toast('Preventivo salvato', 'success');
    loadPreventivi();
  } catch (e) { toast(e.message, 'error'); }
}

async function modificaPreventivo(id) {
  await openModal('modal-preventivo', id);
}

async function salvaFattura() {
  const id = document.getElementById('fatt-id')?.value;
  const tipo = document.getElementById('fatt-tipo').value;
  const body = {
    numero: document.getElementById('fatt-numero').value,
    tipo,
    direzione: tipo === 'emessa' ? 'attiva' : 'passiva',
    tipo_documento: document.getElementById('fatt-tipo-documento').value,
    anagrafica_id: document.getElementById('fatt-anagrafica').value || null,
    valuta: document.getElementById('fatt-valuta').value || 'EUR',
    stato_pagamento: document.getElementById('fatt-stato-pagamento').value,
    data: document.getElementById('fatt-data').value,
    data_ricezione: document.getElementById('fatt-data-ricezione').value || null,
    scadenza: document.getElementById('fatt-scadenza').value || null,
    partita_iva: document.getElementById('fatt-piva').value || null,
    codice_fiscale: document.getElementById('fatt-cf').value || null,
    sdi_id: document.getElementById('fatt-sdi').value || null,
    imponibile: parseFloat(document.getElementById('fatt-imponibile').value) || 0,
    iva: parseFloat(document.getElementById('fatt-iva').value) || 0,
    totale: parseFloat(document.getElementById('fatt-totale').value) || 0,
    note: document.getElementById('fatt-note').value || '',
    righe: collectDocumentoRighe('fatt'),
    riepilogo_iva: collectVatSummaryRows()
  };
  try {
    if (id) await api('PUT', `/fatture/${id}`, body);
    else await api('POST', '/fatture', body);
    closeAllModals();
    toast('Fattura salvata', 'success');
    const active = document.querySelector('.section.active')?.id?.replace('section-', '') || 'fatture-attive';
    loadFattureBySection(active);
  } catch (e) { toast(e.message, 'error'); }
}

async function importFattureSpreadsheet(input) {
  const file = input.files?.[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await apiForm('POST', '/fatture/import/spreadsheet', fd);
    const target = document.getElementById('fatture-sheet-result');
    if (target) target.innerHTML = `Importate: <strong>${res.imported?.length || 0}</strong> · Saltate: <strong>${res.skipped?.length || 0}</strong> · Totale righe: <strong>${res.totale || 0}</strong>`;
    toast('Import fatture completato', 'success');
    loadFattureBySection(document.querySelector('.section.active')?.id?.replace('section-', '') || 'fatture-attive');
  } catch (e) { toast(e.message, 'error'); }
}

init();
syncMobileLayoutState();
scheduleResponsiveEnhancement();
registerPwaSupport();
window.addEventListener('load', () => {
  organizeNavigationLayout();
  configureMobileBottomNav();
  organizeDashboardLayout();
  syncMobileLayoutState();
});
