// Service worker Hub.
// - Données (planning, alternance, entraînement, changements) : réseau d'abord, cache si hors-ligne.
// - Coquille (HTML/JS/CSS/icônes) : « stale-while-revalidate » — on sert la copie en cache
//   tout de suite et on la remplace en arrière-plan. Un déploiement arrive donc tout seul au
//   chargement suivant, sans avoir à changer CACHE. Ne bumper CACHE que pour purger l'ancien cache.
const CACHE = "hub-v20";
const SHELL = [
  ".", "index.html", "styles.css", "app.js", "lib/cheat-stats.js", "config.js", "manifest.json",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
];
const DATA = ["planning.json", "alternance.json", "training.json", "changes.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// Ne met en cache que les réponses complètes et réussies (pas d'erreur 404/500 figée).
function store(req, res) {
  if (res.ok && res.type === "basic") {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy));
  }
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // On ne gère que notre propre origine (Supabase / fonts passent directement au réseau).
  if (url.origin !== location.origin) return;

  if (DATA.some((f) => url.pathname.endsWith(f))) {
    e.respondWith(fetch(req).then((res) => store(req, res)).catch(() => caches.match(req)));
    return;
  }

  // Coquille : cache tout de suite, mise à jour en arrière-plan.
  e.respondWith(
    caches.match(req).then((hit) => {
      // no-cache : revalide auprès du serveur (GitHub Pages met max-age=600 sur les fichiers).
      const net = fetch(url.href, { cache: "no-cache" }).then((res) => store(req, res));
      if (hit) {
        e.waitUntil(net.catch(() => {}));
        return hit;
      }
      return net.catch(() => caches.match("index.html"));
    })
  );
});
