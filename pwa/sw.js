// DSH phone Service Worker: pure network pass-through (stability first).
// Earlier versions cached /assets/ for faster warm starts, but that risks
// cache-mixing with DSH's module rev mechanism. DSH is a local service
// (inside the Tailscale tunnel), so pass-through has no performance cost.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
// No fetch interception: every request goes straight to the network, which
// eliminates stale cached builds entirely.
