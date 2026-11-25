// Retires the old offline cache from when the judging app lived at the site root.
// The app now lives at /app/ with its own service worker; this one unregisters itself
// and reloads any open page, so returning visitors get the website (or the app, via its links).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url).catch(() => {});
})()));
