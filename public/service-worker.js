// Il nome della cache va cambiato a ogni rilascio che tocca il frontend:
// l'handler `activate` cancella tutte le cache con un nome diverso da questo,
// ed e' l'unico modo per far dimenticare al browser gli asset vecchi.
//
// Senza questo passaggio index.html arriva aggiornato (e' network-first) e
// app.js no (e' cache-first sulla URL con il ?v=), quindi il markup nuovo
// chiama funzioni che nello script vecchio non esistono e l'interfaccia si
// rompe in modi che non si spiegano guardando il server, dove il file giusto
// c'e'. E' successo il 12.08.2026 con il picker del cliente in fattura.
const HORYGON_CACHE = 'horygon-crm-shell-v3';
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

  // Codice e fogli di stile: prima la rete, la cache solo come rete di
  // sicurezza per l'uso offline.
  //
  // Con la strategia cache-first bastava dimenticare di cambiare il `?v=` in
  // index.html perche' un rilascio restasse invisibile per sempre: il browser
  // continuava a servire lo script vecchio da una URL identica, mentre
  // index.html arrivava aggiornato. Qui la freschezza non dipende piu' dal
  // ricordarsi di una cosa.
  if (url.pathname.startsWith('/js/') || url.pathname.startsWith('/css/')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(HORYGON_CACHE).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request))
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
