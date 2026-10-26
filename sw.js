// Placelore service worker: keeps the app itself, map tiles and photos on the device
// so saved places open without signal. Place data lives in IndexedDB (see index.html).
const SHELL = "placelore-shell-v1", TILES = "placelore-tiles-v1", MEDIA = "placelore-media-v1";
const SHELL_URLS = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"];
const TILE_HOSTS = /(^|\.)(tile\.openstreetmap\.org|tile\.opentopomap\.org|server\.arcgisonline\.com|tile\.waymarkedtrails\.org)$/;
const MEDIA_HOSTS = /(^|\.)(upload\.wikimedia\.org|static\.inaturalist\.org|inaturalist-open-data\.s3\.amazonaws\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com)$/;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => Promise.all(SHELL_URLS.map(u =>
    fetch(u, { mode: u.startsWith("/") ? "same-origin" : "no-cors" }).then(r => c.put(u, r)).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("placelore-") && ![SHELL, TILES, MEDIA].includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function cacheFirst(req, name, max) {
  const cache = await caches.open(name);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") {
    cache.put(req, res.clone()).then(async () => {
      if (Math.random() < 0.05) { const keys = await cache.keys(); if (keys.length > max) for (const k of keys.slice(0, keys.length - max)) cache.delete(k); }
    }).catch(() => {});
  }
  return res;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (req.mode === "navigate") {
    // Fresh app when online; the saved copy when not
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(SHELL).then(c => c.put("/", copy)); return res; })
      .catch(() => caches.match("/", { ignoreSearch: true })));
    return;
  }
  if (url.origin === location.origin) {
    if (url.pathname.startsWith("/api/")) return;
    e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req)));
    return;
  }
  if (TILE_HOSTS.test(url.hostname)) { e.respondWith(cacheFirst(req, TILES, 6000)); return; }
  if (MEDIA_HOSTS.test(url.hostname)) { e.respondWith(cacheFirst(req, MEDIA, 3000)); return; }
});
