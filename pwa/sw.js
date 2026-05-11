const CACHE = 'bodega-v1';
const STATIC = ['/', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ));
  self.clients.claim();
});

// Red primero para requests de API; caché para assets estáticos
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.url.includes('/api/')) {
    e.respondWith(fetch(request).catch(() => new Response(
      JSON.stringify({ error: 'Sin conexión' }),
      { headers: { 'Content-Type': 'application/json' }, status: 503 }
    )));
    return;
  }
  e.respondWith(
    caches.match(request).then((cached) => cached ?? fetch(request))
  );
});

// Background Sync — reintenta subidas de fotos cuando vuelve la señal (Android)
self.addEventListener('sync', (e) => {
  if (e.tag === 'upload-photos') {
    e.waitUntil(self.clients.matchAll().then((clients) =>
      clients.forEach((c) => c.postMessage({ type: 'SYNC_PHOTOS' }))
    ));
  }
});
