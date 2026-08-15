// DSH phone Service Worker: speeds up PWA warm starts (active under HTTPS secure context).
// Strategy:
//  - /assets/ and other hashed static resources: cache-first + background update
//    (filenames carry content hashes, so they can be cached long-term)
//  - / (index.html): network-first, fall back to cache (so injected page updates
//    reach clients promptly)
//  - dynamic endpoints such as /api and /lan-gate: never cached
const CACHE = 'dsh-shell-v1';
const STATIC_PREFIXES = ['/assets/', '/icon-', '/favicon.', '/apple-touch-icon.', '/manifest.webmanifest'];

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/lan-gate')) return;

  // Pages: network-first, offline fallback to cache
  if (url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || Response.error()))
    );
    return;
  }

  // Static resources: cache-first, background update
  if (STATIC_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    event.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => hit);
        return hit || net;
      })
    );
  }
});
