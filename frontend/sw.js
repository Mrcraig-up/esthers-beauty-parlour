// Esthers Beauty Parlour — service worker
// Caches the app shell so the till can open with no connection.
// Never touches /api/* calls — those are handled by the app's own
// offline sales queue in index.html, not by this service worker.

const CACHE_NAME = 'ebp-shell-v3';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './logo-full.png',
  './logo-emblem.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        // Cache each file independently — cache.addAll() aborts the ENTIRE
        // install if even one file 404s, which silently disables offline
        // mode completely. Caching one-by-one means a single missing file
        // (e.g. a renamed icon) can't take the whole app shell down with it.
        return Promise.allSettled(
          SHELL_FILES.map((file) =>
            cache.add(file).catch((err) => console.warn('[sw] failed to cache', file, err))
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Leave every backend call alone — always go straight to the network.
  if (url.pathname.startsWith('/api/')) return;
  if (req.method !== 'GET') return;

  // Page navigations: try the network first for the freshest app shell,
  // fall back to the cached shell the moment the network is unavailable.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Static assets (icons, manifest, fonts): cache-first, refresh in background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok && url.origin === self.location.origin) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
