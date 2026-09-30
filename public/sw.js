// Service Worker for CloudCLI PWA
// Cache only manifest (needed for PWA install). HTML and JS are never pre-cached
// so a rebuild + refresh always picks up the latest assets.
const CACHE_NAME = 'claude-ui-v3';
// Hashed /assets/* live in their own bounded cache. Every rebuild produces new
// file names, so without a cap this cache grows forever (old generations are
// never requested again). Entries are evicted oldest-first past the cap.
const ASSET_CACHE_NAME = 'claude-ui-assets-v1';
const ASSET_CACHE_MAX_ENTRIES = 200;
const KNOWN_CACHES = new Set([CACHE_NAME, ASSET_CACHE_NAME]);

async function trimAssetCache() {
  const cache = await caches.open(ASSET_CACHE_NAME);
  const keys = await cache.keys();
  const excess = keys.length - ASSET_CACHE_MAX_ENTRIES;
  if (excess <= 0) return;
  // cache.keys() returns requests in insertion order: drop the oldest.
  await Promise.all(keys.slice(0, excess).map(request => cache.delete(request)));
}

const urlsToCache = [
  '/manifest.json'
];

// Install event
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// Fetch event — network-first for everything except hashed assets
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Never intercept API requests or WebSocket upgrades
  if (url.includes('/api/') || url.includes('/ws')) {
    return;
  }

  // Navigation requests (HTML) — always go to network, no caching
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/manifest.json').then(() =>
        new Response('<h1>Offline</h1><p>Please check your connection.</p>', {
          headers: { 'Content-Type': 'text/html' }
        })
      ))
    );
    return;
  }

  // Hashed assets (JS/CSS in /assets/) — cache-first since filenames change per build
  // (GET only: the Cache API rejects other methods).
  if (url.includes('/assets/') && event.request.method === 'GET') {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          // Only cache successful responses; a cached 404/HTML error for a
          // missing chunk would otherwise be served forever.
          if (response.ok) {
            const clone = response.clone();
            event.waitUntil(
              caches.open(ASSET_CACHE_NAME)
                .then(cache => cache.put(event.request, clone))
                .then(trimAssetCache)
                .catch(() => {})
            );
          }
          return response;
        });
      })
    );
    return;
  }

  // Everything else — network-first
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// Activate event — purge old caches (including the unbounded v2 cache that
// mixed assets from every past build) and trim the asset cache.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames =>
      Promise.all(
        cacheNames
          .filter(name => !KNOWN_CACHES.has(name))
          .map(name => caches.delete(name))
      )
    ).then(trimAssetCache)
  );
  self.clients.claim();
});

// Push notification event
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'CloudCLI', body: event.data.text() };
  }

  const options = {
    body: payload.body || '',
    icon: '/logo-256.png',
    badge: '/logo-128.png',
    data: payload.data || {},
    tag: payload.data?.tag || `${payload.data?.sessionId || 'global'}:${payload.data?.code || 'default'}`,
    renotify: true
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'CloudCLI', options)
  );
});

// Notification click event
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const sessionId = event.notification.data?.sessionId;
  const provider = event.notification.data?.provider || null;
  const urlPath = sessionId ? `/session/${sessionId}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          await client.focus();
          client.postMessage({
            type: 'notification:navigate',
            sessionId: sessionId || null,
            provider,
            urlPath
          });
          return;
        }
      }
      return self.clients.openWindow(urlPath);
    })
  );
});
