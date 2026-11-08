// Service worker: keeps the app shell so new versions only switch over when the user taps Update.
// Bump VERSION with every release.
const VERSION = 1;
const CACHE = `school-v${VERSION}`;
const SHELL = ['/', '/index.html', '/icon.svg', '/icon-192.png', '/apple-touch-icon.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  // Don't skipWaiting: the page shows an Update button and asks us to switch when the user taps it.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'GET_VERSION') e.ports[0]?.postMessage({ version: VERSION });
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // Supabase, CDNs, /api: straight to the network
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  if (!SHELL.includes(path)) return;                                            // e.g. the family page h.html is always fresh
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    return (await cache.match(path)) || fetch(e.request);
  })());
});
