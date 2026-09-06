const CACHE = 'dlbtrust-mobile-v2';
const PRECACHE = [
  '/dapp/mobile.html',
  '/dapp/mobile-manifest.json',
  '/dapp/js/qrcode.min.js',
  '/dapp/js/html5-qrcode.min.js',
  '/dapp/icons/icon.svg'
];
const CACHEABLE = new Set(PRECACHE);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Only the mobile PWA shell is served offline-first. Every other request under
// /dapp (dashboards, shared libs, APIs) always goes to the network so a deploy
// is visible immediately; the cache is used purely as an offline fallback.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !CACHEABLE.has(url.pathname)) return;
  event.respondWith(
    fetch(event.request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then(c => c.put(event.request, copy)).catch(() => {});
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});
