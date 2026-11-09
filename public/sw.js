// Service worker: keeps the app shell so new versions only switch over when the user taps Update.
// Bump VERSION with every release.
const VERSION = 4;
const CACHE = `school-v${VERSION}`;
// Only exact URLs Cloudflare serves without a redirect ("/index.html" redirects to "/").
const SHELL = ['/', '/icon.svg', '/icon-192.png', '/apple-touch-icon.png', '/manifest.webmanifest'];
// Versions 1–2 could break page loads on Safari; version 3 took over from them straight away.
// From version 4, new versions wait for the user to tap Update again.
const REPLACE_BROKEN = false;

// Never store a redirected response: browsers refuse to use one for a page load.
async function cleanCopy(res) {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const url of SHELL) {
      const res = await fetch(url, { cache: 'reload' });
      if (res.ok) await cache.put(url, await cleanCopy(res));
    }
    if (REPLACE_BROKEN) await self.skipWaiting();
  })());
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
  const isPage = e.request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html');
  const key = isPage ? '/' : url.pathname;
  if (!SHELL.includes(key)) return;                                             // e.g. the family page h.html is always fresh
  e.respondWith((async () => {
    try {
      const cached = await (await caches.open(CACHE)).match(key);
      if (cached && !cached.redirected) return cached;
    } catch {}
    return fetch(e.request);   // anything odd: fall back to the network rather than fail
  })());
});
