/**
 * Service Worker - Offline caching for the Comic Creator PWA
 */
const CACHE_NAME = 'comic-creator-v1.6.6';
// Base path derived from the service worker's registered scope so the app works
// under any subpath (e.g. "" when served from root, "/Comiccreator" on GitHub Pages).
const BASE_PATH = new URL(self.registration.scope).pathname.replace(/\/$/, '');
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/utils.js',
  '/js/db.js',
  '/js/api.js',
  '/js/app.js',
  '/js/pages/home.js',
  '/js/pages/characters.js',
  '/js/pages/worlds.js',
  '/js/pages/create.js',
  '/js/pages/library.js',
  '/js/pages/presets.js',
  '/js/pages/settings.js',
  '/version.json',
  '/manifest.json',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// Install: cache all static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS.map((asset) => BASE_PATH + asset));
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch: network-first for API calls, cache-first for static assets
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // API calls: network only (don't cache)
  if (url.hostname === 'nano-gpt.com') return;

  // Static assets: cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).then((response) => {
        // Cache successful responses for same-origin requests
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(() => {
        // Offline fallback for navigation
        if (event.request.mode === 'navigate') {
          return caches.match(BASE_PATH + '/index.html');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});
