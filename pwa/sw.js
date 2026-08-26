/* OpenForge service worker — network-first with offline shell fallback */
const CACHE = "openforge-v2";
const SHELL = [
  "/ui/", "/ui/index.html", "/ui/css/app.css", "/ui/js/app.js",
  "/ui/manifest.webmanifest", "/ui/icons/icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) =>
      Promise.all(ks.map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // NEVER cache API, git, fs, oc, or event requests
  if (
    url.pathname.startsWith("/api") ||
    url.pathname.startsWith("/oc") ||
    url.pathname.startsWith("/git") ||
    url.pathname.startsWith("/fs")
  ) {
    return;
  }
  // Network-first for UI shell assets so updates are immediate on reload
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("/ui/index.html")))
  );
});
