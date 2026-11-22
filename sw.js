self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (new URL(event.request.url).origin === location.origin) {
    event.respondWith(fetch(event.request, { cache: 'no-cache' }));
  }
});
