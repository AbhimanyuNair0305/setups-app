/**
 * Setups service worker.
 *
 * Cloudflare Pages 301-redirects /index.html to /. A cached response that
 * carries the redirected flag is refused by Safari for navigations, with
 * "Response served by service worker has redirections", which blanks the app.
 *
 * So: the shell is keyed on "/" rather than index.html, and every navigation
 * response is rebuilt into a fresh 200 both when stored AND when served.
 * Stripping only on store leaves the door open if something is already cached.
 *
 * Bump CACHE on every deploy.
 */
const CACHE = 'setups-v6';
const SHELL = ['/', 'manifest.json', 'icon-192.png', 'icon-512.png'];

/** Rebuild a response as a plain 200 with no redirect flag attached. */
async function clean(res) {
  const body = await res.clone().blob();
  const h = new Headers();
  h.set('Content-Type', res.headers.get('Content-Type') || 'text/html; charset=utf-8');
  h.set('Cache-Control', 'no-cache');
  return new Response(body, { status: 200, statusText: 'OK', headers: h });
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(SHELL.map(async u => {
      try {
        const r = await fetch(u, { redirect: 'follow', cache: 'reload' });
        if (r && r.ok) await c.put(u, u === '/' ? await clean(r) : r);
      } catch (err) { /* offline at install, fine */ }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  if (e.data === 'reset') {
    caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k))))
      .then(() => self.registration.unregister());
  }
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }

  // Never touch the backend. Stale trade data is worse than none.
  if (url.hostname.endsWith('script.google.com') || url.hostname.endsWith('googleusercontent.com')) return;
  if (url.origin !== location.origin) return;

  // Navigations: network first, always rebuilt as a clean 200.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const net = await fetch('/', { redirect: 'follow', cache: 'no-cache' });
        if (net && net.ok) {
          const fresh = await clean(net);
          const c = await caches.open(CACHE);
          c.put('/', fresh.clone());
          return fresh;
        }
      } catch (err) { /* fall through to cache */ }
      const hit = await caches.match('/', { cacheName: CACHE });
      if (hit) return clean(hit);
      return new Response(
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<body style="background:#1A1A1C;color:#E8E8EA;font:15px -apple-system;padding:40px;text-align:center">' +
        'Setups is offline and nothing is cached yet.</body>',
        { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    })());
    return;
  }

  // Assets: cache first, refill on miss.
  e.respondWith((async () => {
    const hit = await caches.match(req, { cacheName: CACHE });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && res.ok && !res.redirected) {
        const c = await caches.open(CACHE);
        c.put(req, res.clone());
      }
      return res;
    } catch (err) {
      return caches.match('/', { cacheName: CACHE });
    }
  })());
});
