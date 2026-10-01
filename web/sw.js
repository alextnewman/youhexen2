const CACHE_PREFIX = 'hexenwail-pwa-';
const CACHE_VERSION = `${CACHE_PREFIX}__HEXENWAIL_BUILD_VERSION__`;
const CORE_ASSETS = [
  './',
  './index.html',
  './app.js',
  './lib/phone-controls.js',
  './manifest.webmanifest',
  './sw.js',
  './icons/icon.v3.svg',
  './icons/icon-180.v2.png',
  './icons/icon-192.v3.png',
  './icons/icon-512.v3.png',
  './hexenwail-nitro.js',
  './hexenwail-nitro.wasm',
];
// The software renderer bundle is deliberately NOT in
// CORE_ASSETS. Two reasons:
//   * install cost: precaching megabytes of .js + .wasm on every fresh
//     install would slow the first paint for users who never select them;
//   * install robustness: cache.addAll() is atomic, so a single 404 on
//     a missing software bundle from a local build would abort
//     the whole SW install and leave the launcher without an offline
//     shell.
// Instead, it is runtime-cached on first use: the fetch handler
// treats requests for these URLs the same way it treats CORE_ASSETS
// (cache-first, populate on network success), which is enough for an
// installed PWA that has once launched one to keep working offline
// afterwards.
const OPTIONAL_ASSETS = [
  './hexenwail.js',
  './hexenwail.wasm',
  './hexenwail.data',
  './hexenwail.worker.js',
  './hexenwail-nitro.data',
  './hexenwail-nitro.worker.js',
];
const CORE_ASSET_URLS = CORE_ASSETS.map((asset) => new URL(asset, self.location).href);
const OPTIONAL_ASSET_URLS = OPTIONAL_ASSETS.map((asset) => new URL(asset, self.location).href);
const INDEX_URL = new URL('./index.html', self.location).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await cache.addAll(CORE_ASSET_URLS.map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(CACHE_VERSION);
        cache.put(INDEX_URL, response.clone());
        return response;
      } catch {
        const cache = await caches.open(CACHE_VERSION);
        return cache.match(INDEX_URL);
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin) {
    return;
  }
  if (!CORE_ASSET_URLS.includes(request.url) && !OPTIONAL_ASSET_URLS.includes(request.url)) {
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }

    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
