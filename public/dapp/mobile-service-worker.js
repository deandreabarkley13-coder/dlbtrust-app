const CACHE = 'dlbtrust-mobile-v1';
const PRECACHE = [
  '/dapp/mobile.html',
  '/dapp/mobile-manifest.json',
  '/dapp/js/qrcode.min.js',
  '/dapp/js/html5-qrcode.min.js',
  '/dapp/icons/icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return; // network only for API
  event.respondWith(
    caches.match(event.request).then(cached =>
      cached || fetch(event.request).then(response => {
        const copy = response.clone();
        if (response.ok) caches.open(CACHE).then(c => c.put(event.request, copy)).catch(() => {});
        return response;
      }).catch(() => cached)
    )
  );
});
