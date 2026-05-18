const CACHE = 'bodega-v3';
const STATIC = [
  '/',
  '/manifest.json',
  '/icons/icon.svg',
  '/js/api.js',
  '/js/compress.js',
  '/js/db.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)));
  // No skipWaiting here — let the update banner trigger it
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
  // Notify all clients that a new version is active
  self.clients.matchAll({ type: 'window' }).then((clients) =>
    clients.forEach((c) => c.postMessage({ type: 'SW_ACTIVATED' }))
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  // Never cache Supabase storage (signed URLs with tokens)
  if (url.hostname.includes('supabase')) return;

  // Network-first for API calls
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(request).catch(() =>
        new Response(
          JSON.stringify({ error: 'Sin conexión' }),
          { headers: { 'Content-Type': 'application/json' }, status: 503 }
        )
      )
    );
    return;
  }

  // Stale-while-revalidate for static assets
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const fetchPromise = fetch(request).then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      }).catch(() => null);

      return cached ?? fetchPromise;
    })
  );
});

// Handle message from the page
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// Background Sync — reintenta subidas de fotos cuando vuelve la señal
self.addEventListener('sync', (e) => {
  if (e.tag === 'upload-photos') {
    e.waitUntil(
      self.clients.matchAll({ type: 'window' }).then((clients) =>
        clients.forEach((c) => c.postMessage({ type: 'SYNC_PHOTOS' }))
      )
    );
  }
});
