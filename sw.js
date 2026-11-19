/* Aculife-IB Portal – service worker. Makes the portal installable as an app.
   Always uses the live portal (network first); never stores data or API answers. */
const CACHE = 'aculife-ib-v1';
const SHELL = ['/', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return; // live only
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put('/', c)); return r; })
      .catch(() => caches.match('/').then(r => r || new Response('<h3 style="font-family:sans-serif">Aculife-IB: no internet connection. Please reconnect and try again.</h3>', { headers: { 'Content-Type': 'text/html' } }))));
    return;
  }
  if (SHELL.includes(url.pathname)) e.respondWith(caches.match(req).then(r => r || fetch(req)));
});
