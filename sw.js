self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (new URL(event.request.url).origin !== location.origin) return;
  const cachedCopy = () => fetch(event.request);
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then((response) => (response.ok ? response : cachedCopy()))
      .catch(cachedCopy));
});
