// Offline cache for the app shell. API calls always go to the network.
// Bump VERSION when you change any file so devices pick up the update.
const VERSION = 'spotlight-v23';
const SHELL = ['./', 'index.html', 'app.js', 'styles.css', 'config.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'fonts/Roboto-Variable.ttf', 'hex.svg'];

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's HTTP cache so an update never re-caches stale files
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.includes('/api/')) return; // never cache data
  if (url.origin !== location.origin) return;

  // Stale-while-revalidate: answer from cache instantly (works offline), refresh in the background.
  const key = req.mode === 'navigate' ? 'index.html' : req;
  e.respondWith(caches.open(VERSION).then(async cache => {
    const cached = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });
    const network = fetch(req).then(res => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  }));
});
