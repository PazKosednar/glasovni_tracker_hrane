// Preprost service worker: lastne datoteke shrani za offline, API klici gredo vedno na splet.
const CACHE = 'kalko-v3';
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icons/icon-180.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Lastne datoteke: najprej splet (sveže posodobitve), ob napaki iz predpomnilnika
  if (url.origin === location.origin) {
    e.respondWith(fetch(e.request).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res;
    }).catch(() => caches.match(e.request)));
    return;
  }
  // Knjižnice s CDN (skener, AI SDK): iz predpomnilnika, če obstajajo
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res;
    })));
  }
});
