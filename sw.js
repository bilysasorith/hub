// Service worker Hub : coquille en cache-first, planning en network-first.
const CACHE = "hub-v7";
const SHELL = [
  ".", "index.html", "styles.css", "app.js", "config.js", "manifest.json",
  "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // On ne gère que notre propre origine (Supabase / fonts passent directement au réseau).
  if (url.origin !== location.origin) return;

  // planning.json / training.json : réseau d'abord, cache si hors-ligne.
  if (url.pathname.endsWith("planning.json") || url.pathname.endsWith("training.json")) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Coquille : cache d'abord, réseau en secours.
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match("index.html")))
  );
});
