/* OpenForge service worker — caches the UI shell for offline launch. */
const CACHE = "openforge-v1";
const SHELL = [
  "/ui/", "/ui/index.html", "/ui/css/app.css", "/ui/js/app.js",
  "/ui/manifest.webmanifest", "/ui/icons/icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) =>
    Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // never cache the live API
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/oc")) return;
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match("/ui/index.html"))
    )
  );
});
