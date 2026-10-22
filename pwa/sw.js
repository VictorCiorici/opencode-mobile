/* OpenForge service worker.
   - Network-first for the UI shell (updates apply on next load), cache fallback offline.
   - API / bridge traffic is NEVER touched or cached: only GET requests for files
     inside this worker's own scope (the /ui/ folder) are handled at all.
   - Bump CACHE whenever the shell changes: activate() drops every other cache. */
const CACHE = "openforge-v6";
const SHELL = [
  "./", "index.html", "css/app.css", "js/util.js", "js/app.js",
  "manifest.webmanifest", "icons/icon.svg",
];
const SCOPE_PATH = new URL(self.registration.scope).pathname;   // e.g. "/ui/"
const API_RE = /^\/(api|oc|git|fs|health|projects|browse|terminal)(\/|$)/;   // never cache, even if served from /

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // cache: "reload" bypasses the HTTP cache so a new worker never precaches stale files
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) =>
      // Delete only stale caches, never the freshly installed one.
      Promise.all(ks.map((k) => (k === CACHE ? null : caches.delete(k))))
    ).then(() => self.clients.claim())
  );
});

function isShellRequest(req) {
  if (req.method !== "GET") return false;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return false;
  if (!url.pathname.startsWith(SCOPE_PATH)) return false;       // anything outside /ui/ (API, events...)
  if (API_RE.test(url.pathname.slice(SCOPE_PATH.length - 1))) return false;
  if (API_RE.test(url.pathname)) return false;
  if (req.headers.get("accept") === "text/event-stream") return false;
  if (req.headers.has("authorization")) return false;
  return true;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (!isShellRequest(req)) return;   // let the browser handle it; nothing is cached
  e.respondWith(
    fetch(req, { cache: "no-cache" })
      .then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then((hit) =>
          hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error()))
      )
  );
});
