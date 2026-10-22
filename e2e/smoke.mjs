// End-to-end smoke test: starts the real daemon with a real opencode engine,
// checks the API contract, then drives the PWA in headless Chrome at phone
// size and fails on any console error, exception or failed request.
//
//   node e2e/smoke.mjs --daemon <daemon binary> --opencode <opencode 1.x binary> --chrome <chrome binary>
//
// No model is called, so it needs no API keys.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: {
    daemon: { type: "string" },
    opencode: { type: "string" },
    chrome: { type: "string" },
    port: { type: "string", default: "18787" },
    shots: { type: "string" },
  },
});
for (const k of ["daemon", "opencode", "chrome"]) {
  if (!opt[k]) { console.error(`missing --${k}`); process.exit(2); }
}

const PORT = +opt.port;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "smoke-" + Math.random().toString(36).slice(2);
const PWA = resolve(dirname(fileURLToPath(import.meta.url)), "../pwa");
const root = mkdtempSync(join(tmpdir(), "of-smoke-"));
for (const d of ["home", "ws", "data"]) mkdirSync(join(root, d));
if (opt.shots) mkdirSync(opt.shots, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const api = async (path, { method = "GET", body, auth = true } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = `Bearer ${TOKEN}`;
  const r = await fetch(BASE + path, { method, headers, body: body && JSON.stringify(body) });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};

const children = [];
const cleanup = () => {
  for (const c of children) {
    try {
      // Kill whole trees: the daemon's engines must not outlive the test.
      if (process.platform === "win32") execFileSync("taskkill", ["/T", "/F", "/PID", String(c.pid)], { stdio: "ignore" });
      else c.kill("SIGKILL");
    } catch {}
  }
  try { rmSync(root, { recursive: true, force: true }); } catch {}
};
process.on("exit", cleanup);

// ------------------------------------------------------------ daemon + API

const env = { ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home") };
const daemon = spawn(resolve(opt.daemon), [
  "-port", String(PORT), "-workspace", join(root, "ws"), "-data", join(root, "data"),
  "-web", PWA, "-token", TOKEN, "-opencode", resolve(opt.opencode), "-dnsproxy-port", "0",
], { env, stdio: ["ignore", "pipe", "pipe"] });
children.push(daemon);
let daemonLog = "";
daemon.stdout.on("data", (b) => (daemonLog += b));
daemon.stderr.on("data", (b) => (daemonLog += b));

let health;
for (let i = 0; i < 100 && !health; i++) {
  try { health = (await api("/api/health", { auth: false })).json; } catch { await sleep(200); }
}
check(!!health, "daemon answers /api/health");
if (!health) { console.error(daemonLog); process.exit(1); }

check((await api("/api/browse", { auth: false })).status === 401, "API reads need the token");
check((await api("/api/browse")).status === 200, "token is accepted");

const created = await api("/api/projects", { method: "POST", body: { name: "smoke", git_init: true } });
check(created.status === 200 && !!created.json?.id, `project created (${created.status})`);
const pid = created.json?.id;

// The engine proxy must return JSON. An incompatible engine (opencode 2.x)
// serves HTML here, which the daemon turns into a 502.
const sessions = await api(`/oc/${pid}/session`);
check(sessions.status === 200 && Array.isArray(sessions.json),
  `engine proxy lists sessions (${sessions.status} ${sessions.text.slice(0, 120)})`);
const session = await api(`/oc/${pid}/session`, { method: "POST", body: {} });
check(session.status === 200 && !!session.json?.id, `engine creates a session (${session.status})`);
check((await api(`/git/${pid}/status`)).status === 200, "git status works");

// ------------------------------------------------------------------ UI

const cdpPort = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(opt.chrome, [
  "--headless=new", `--remote-debugging-port=${cdpPort}`, "--no-first-run",
  "--no-default-browser-check", "--no-sandbox", `--user-data-dir=${join(root, "chrome")}`, "about:blank",
], { stdio: "ignore" });
children.push(chrome);

let wsUrl;
for (let i = 0; i < 75 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl;
  } catch {}
  if (!wsUrl) await sleep(200);
}
check(!!wsUrl, "headless Chrome started");
if (!wsUrl) process.exit(1);

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
const problems = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown")
    problems.push("exception: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
    problems.push("console.error: " + m.params.args.map((a) => a.value ?? a.description).join(" "));
  if (m.method === "Network.responseReceived" && m.params.response.status >= 400)
    problems.push(`HTTP ${m.params.response.status} ${m.params.response.url}`);
  if (m.method === "Page.javascriptDialogOpening") problems.push("dialog: " + m.params.message);
});
const send = (method, params = {}) => new Promise((r) => {
  const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
});
const evalJs = async (expr) =>
  (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async (name) => {
  if (!opt.shots) return;
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(opt.shots, name + ".png"), Buffer.from(r.result.data, "base64"));
};

await send("Runtime.enable"); await send("Network.enable"); await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send("Emulation.setTouchEmulationEnabled", { enabled: true });
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `try{localStorage.setItem("of.set.token", ${JSON.stringify(TOKEN)})}catch(e){}`,
});
await send("Page.navigate", { url: BASE + "/" });
await sleep(3000);
await shot("01-initial");

// With a single project the UI opens it automatically.
const selected = await evalJs(`(() => { const s = document.querySelector('select'); return s ? s.value : ''; })()`);
check(selected === pid, `the only project is opened automatically (got "${selected}")`);

let n = 2;
for (const v of ["chat", "projects", "files", "git", "models", "settings"]) {
  const clicked = await evalJs(`(() => { const b = document.querySelector('[data-view="${v}"]'); if (!b) return false; b.click(); return true; })()`);
  check(clicked, `nav button for ${v}`);
  await sleep(2000);
  await shot(String(n++).padStart(2, "0") + "-" + v);
  const visible = await evalJs(`(() => { const el = document.getElementById('view-${v}'); return !!el && el.offsetParent !== null && el.innerText.trim().length > 0; })()`);
  check(visible, `${v} view renders content`);
}

check((await evalJs(`typeof window.OpenForgeBack`)) === "function", "Android back hook is installed");
check((await evalJs(`document.documentElement.scrollWidth <= window.innerWidth`)) === true, "no horizontal overflow at 390px");
check(problems.length === 0, "no console errors, exceptions or failed requests" +
  (problems.length ? ":\n    " + problems.join("\n    ") : ""));

ws.close();
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed. Daemon log:\n${daemonLog.slice(-4000)}`);
  process.exit(1);
}
console.log("\nsmoke test passed");
process.exit(0);
