// Service worker: makes the app itself available offline.
// Files are answered from the cache at once and refreshed in the background,
// so a new version published to the site is picked up on the launch after next.
// Only the app's own code is cached here. The database and attachments are
// stored separately and never pass through this file.
const CACHE = 'craglog-app-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './strings.js',
  './zip.js',
  './db-worker.js',
  './manifest.webmanifest',
  './lib/sqlite/index.mjs',
  './lib/sqlite/sqlite3.wasm',
  './lib/sqlite/sqlite3-opfs-async-proxy.js',
  './fonts/plex-hebrew-400.woff2',
  './fonts/plex-hebrew-600.woff2',
  './fonts/plex-latin-400.woff2',
  './fonts/plex-latin-600.woff2',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = req.mode === 'navigate' ? './index.html' : req;
    const cached = await cache.match(key, { ignoreSearch: true });
    const refresh = fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok && res.type === 'basic') cache.put(key, res.clone());
        return res;
      });
    if (cached) {
      event.waitUntil(refresh.catch(() => {}));
      return cached;
    }
    return refresh;
  })());
});
