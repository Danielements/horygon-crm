const HORYGON_CACHE = 'horygon-crm-shell-v2';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/manifest.webmanifest',
  '/icons/logo-horygon.svg',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/app-icon.svg',
  '/icons/app-icon-maskable.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(HORYGON_CACHE).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== HORYGON_CACHE).map(key => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/uploads/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const clone = response.clone();
          caches.open(HORYGON_CACHE).then(cache => cache.put('/index.html', clone));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (!response || response.status !== 200 || response.type !== 'basic') return response;
        const clone = response.clone();
        caches.open(HORYGON_CACHE).then(cache => cache.put(request, clone));
        return response;
      });
    })
  );
});

async function applyBadgeCount(value) {
  const count = Number(value || 0);
  try {
    if (self.navigator && 'setAppBadge' in self.navigator) {
      if (count > 0) await self.navigator.setAppBadge(count);
      else if ('clearAppBadge' in self.navigator) await self.navigator.clearAppBadge();
    }
  } catch {}
}

self.addEventListener('push', event => {
  const payload = (() => {
    try {
      return event.data ? event.data.json() : {};
    } catch {
      return { title: 'Nuova notifica Horygon', body: event.data?.text?.() || '' };
    }
  })();

  event.waitUntil((async () => {
    await applyBadgeCount(payload?.data?.unreadCount || 0);
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clientsList.forEach(client => client.postMessage({ type: 'push-refresh', payload }));
    await self.registration.showNotification(payload.title || 'Nuova notifica Horygon', {
      body: payload.body || '',
      icon: payload.icon || '/icons/icon-192.png',
      badge: payload.badge || '/icons/icon-192.png',
      tag: payload.tag || 'horygon-notification',
      data: payload.data || { url: '/?openNotifications=1' },
      renotify: true
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || '/?openNotifications=1';
  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsList) {
      if ('focus' in client) {
        client.postMessage({ type: 'open-notifications' });
        await client.focus();
        return;
      }
    }
    await self.clients.openWindow(targetUrl);
  })());
});
