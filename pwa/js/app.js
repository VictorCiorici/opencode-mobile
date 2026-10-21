/* OpenForge – opencode mobile client */
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const S = {
  projects: [],
  pid: localStorage.getItem("of.pid") || null,
  sessions: [],
  sid: null,
  model: JSON.parse(localStorage.getItem("of.model") || "null"),
  busy: false,
  filesPath: "",
  url: localStorage.getItem("of.set.url") || "",
  genSeq: 0,
  ensureSeq: 0,
};

/* Bridge auth token: injected by the Android host via JS interface, or set
   manually in Settings → Connection for remote daemons. */
function bridgeToken() {
  try {
    const injected = window.OpenForgeBridge && window.OpenForgeBridge.bridgeToken();
    if (injected) return injected;
  } catch {}
  return localStorage.getItem("of.set.token") || "";
}

function getApiBase() {
  return window.OF.apiBase(S.url, location);
}

async function api(path, opts = {}) {
  const base = getApiBase();
  const { headers: extraHeaders = {}, body, ...rest } = opts;
  const headers = { "Content-Type": "application/json", ...extraHeaders };
  const tok = bridgeToken();
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  let r;
  try {
    r = await fetch(base + path, {
      cache: "no-store",
      ...rest,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new Error("Cannot reach the daemon — is it running?");
  }
  const ct = r.headers.get("content-type") || "";
  if (!r.ok) {
    let j = null;
    if (ct.includes("json")) { try { j = await r.json(); } catch {} }
    throw new Error(window.OF.errorMessage(r.status, j));
  }
  if (r.status === 204) return null;
  if (!ct.includes("json")) {
    const text = await r.text();
    if (text.trim().startsWith("<")) {
      throw new Error("Daemon connection error — received HTML instead of JSON");
    }
    try { return JSON.parse(text); } catch { return text; }
  }
  return r.json();
}
const oc = (p, o) => api(`/oc/${S.pid}${p}`, o);
const git = (a, o) => api(`/git/${S.pid}/${a}`, o);

function toast(msg, err = false, ms = 2600) {
  const t = $("#toast");
  t.textContent = cleanToast(msg);
  t.setAttribute("role", err ? "alert" : "status");
  t.className = err ? "err show" : "show";
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), ms);
}

/* Run fn() with the button disabled + spinner; always restores it. */
async function withBusy(btn, fn) {
  if (!btn) return fn();
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add("loading");
  btn.setAttribute("aria-busy", "true");
  try { return await fn(); }
  catch (e) { toast(e && e.message ? e.message : "Something went wrong", true); }
  finally {
    btn.disabled = false;
    btn.classList.remove("loading");
    btn.removeAttribute("aria-busy");
  }
}
/* Click handler that is busy-guarded (double-tap safe, shows spinner). */
function onBusy(sel, fn) {
  const b = $(sel);
  if (b) b.addEventListener("click", (e) => withBusy(b, () => fn(e)));
}

/* In-app confirm dialog (window.confirm is blocked/ugly in WebViews). */
function confirmDialog(message, { okLabel = "Confirm", danger = true } = {}) {
  return new Promise((resolve) => {
    const ov = $("#confirm-overlay");
    $("#confirm-msg").textContent = message;
    const ok = $("#confirm-ok"), cancel = $("#confirm-cancel");
    ok.textContent = okLabel;
    ok.className = danger ? "danger-solid" : "primary";
    const onKey = (e) => { if (e.key === "Escape") done(false); };
    const done = (v) => {
      ov.classList.add("hidden");
      ok.onclick = cancel.onclick = ov.onclick = null;
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    ov.onclick = (e) => { if (e.target === ov) done(false); };
    document.addEventListener("keydown", onKey);
    ov.classList.remove("hidden");
    cancel.focus();
  });
}

/* In-app text prompt (window.prompt is unreliable in Android WebViews). */
function promptDialog(message, value = "") {
  return new Promise((resolve) => {
    const ov = $("#prompt-overlay"), input = $("#prompt-input");
    $("#prompt-msg").textContent = message;
    input.value = value;
    const ok = $("#prompt-ok"), cancel = $("#prompt-cancel");
    const done = (v) => {
      ov.classList.add("hidden");
      ok.onclick = cancel.onclick = ov.onclick = input.onkeydown = null;
      resolve(v);
    };
    ok.onclick = () => done(input.value.trim() || null);
    cancel.onclick = () => done(null);
    ov.onclick = (e) => { if (e.target === ov) done(null); };
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); ok.click(); } if (e.key === "Escape") done(null); };
    ov.classList.remove("hidden");
    input.focus(); input.select();
  });
}

/* Pure helpers live in util.js (window.OF) so they are unit-testable. */
const { esc, hl, md, fmtTok, renderDiffLines, looksLikeDiff, cleanToast } = window.OF;

/* ---------------- navigation ---------------- */

$$("#bottom-nav button").forEach((b) =>
  b.addEventListener("click", () => {
    $$("#bottom-nav button").forEach((x) => { x.classList.remove("active"); x.removeAttribute("aria-current"); });
    b.classList.add("active");
    b.setAttribute("aria-current", "page");
    $$(".view").forEach((v) => v.classList.remove("active"));
    $(`#view-${b.dataset.view}`).classList.add("active");
    if (b.dataset.view === "git") loadGit();
    if (b.dataset.view === "models") loadModels();
    if (b.dataset.view === "files") loadFiles(S.filesPath);
    if (b.dataset.view === "settings") loadAuthStatus();
  })
);

/* ---------------- projects ---------------- */

/* Single place that changes the active project (resets per-project state). */
function switchProject(id) {
  const changed = S.pid !== (id || null);
  S.pid = id || null;
  S.sid = null;
  S.sessions = [];
  localStorage.setItem("of.pid", S.pid || "");
  const sel = $("#project-select");
  if (sel) sel.value = S.pid || "";
  if (changed) { G.diffFile = null; syncEditorToProject(); }
  renderProjectList();
}

async function loadProjects(keep = true) {
  const d = await api("/api/projects");
  S.projects = d.projects || [];
  const sel = $("#project-select");
  sel.innerHTML =
    `<option value="">– select project –</option>` +
    S.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  if (!S.projects.find((p) => p.id === S.pid)) { S.sid = null; if (!keep || S.projects.length) S.pid = null; }
  if (S.pid) sel.value = S.pid;
  renderProjectList();
  updateChatHeader();
}

$("#project-select").addEventListener("change", async (e) => {
  switchProject(e.target.value || null);
  await ensureSession();
  loadModels().catch(() => {});
});

onBusy("#btn-create-project", async () => {
  const name = $("#new-project-name").value.trim();
  if (!name) return toast("Enter a project name", true);
  const branch = $("#new-project-branch").value.trim() || "main";
  try {
    const p = await api("/api/projects", { method: "POST", body: { name, branch } });
    $("#new-project-name").value = "";
    $("#new-project-branch").value = "";
    await loadProjects(false);
    switchProject(p.id);
    toast(`Project “${p.name}” created`);
    ensureSession();
  } catch (e) { toast(e.message, true); }
});

function renderProjectList() {
  const ul = $("#project-list");
  ul.innerHTML = S.projects.length
    ? ""
    : `<li class="empty-state">No projects yet — create, clone or import one above.</li>`;
  for (const p of S.projects) {
    const li = document.createElement("li");
    if (p.id === S.pid) li.classList.add("cur");
    li.innerHTML = `
      <div class="li-main"><strong>${esc(p.name)}</strong>
        <small class="li-sub">${esc(p.path)}</small></div>
      <div class="git-btns">
        <button class="ghost primary-text" aria-label="Open project ${esc(p.name)}">${p.id === S.pid ? "Active" : "Open"}</button>
        <button class="ghost danger" aria-label="Remove project ${esc(p.name)}">✕</button>
      </div>`;
    const [openBtn, delBtn] = li.querySelectorAll("button");
    openBtn.onclick = () => {
      switchProject(p.id);
      ensureSession();
      loadModels().catch(() => {});
      toast(`Opened ${p.name}`);
    };
    delBtn.onclick = () => withBusy(delBtn, async () => {
      if (!(await confirmDialog(`Remove project "${p.name}" from OpenForge? Files on disk are kept.`, { okLabel: "Remove" }))) return;
      await api(`/api/projects/${encodeURIComponent(p.id)}`, { method: "DELETE" });
      if (S.pid === p.id) { switchProject(null); ensureSession(); }
      await loadProjects(false);
      toast("Project removed");
    });
    ul.appendChild(li);
  }
}

/* ---------------- folder browser & project import ---------------- */

let BROWSE_PATH = "";

async function openFolderBrowser(initialPath = "") {
  $("#browser-overlay").classList.remove("hidden");
  BROWSE_PATH = initialPath || BROWSE_PATH || "";
  await loadBrowseDir(BROWSE_PATH);
}

async function loadBrowseDir(path) {
  const ul = $("#browser-list");
  ul.innerHTML = `<li>Loading…</li>`;
  $("#browser-path").textContent = path;
  try {
    const res = await api(`/api/browse?path=${encodeURIComponent(path)}`);
    BROWSE_PATH = res.current || res.path || path;
    $("#browser-path").textContent = BROWSE_PATH;
    ul.innerHTML = "";
    const entries = (res.entries || []).filter((e) => e.is_dir || e.dir);
    if (!entries.length && !res.parent) {
      ul.innerHTML = `<li class="empty-state">No subfolders here</li>`;
    }
    if (res.parent) {
      const up = document.createElement("li");
      up.className = "file-entry";
      up.setAttribute("role", "button"); up.tabIndex = 0;
      up.innerHTML = `<div style="padding:4px 0"><strong>↩ ..</strong></div>`;
      up.onclick = () => loadBrowseDir(res.parent);
      ul.appendChild(up);
    }
    for (const e of entries) {
      const li = document.createElement("li");
      li.className = "file-entry";
      li.setAttribute("role", "button"); li.tabIndex = 0;
      li.innerHTML = `<div style="padding:4px 0"><strong>📁 ${esc(e.name)}</strong></div>`;
      li.onclick = () => loadBrowseDir(e.path || `${BROWSE_PATH}/${e.name}`.replace(/\/{2,}/g, "/"));
      ul.appendChild(li);
    }
  } catch (err) {
    ul.innerHTML = `<li class="error-state">${esc(err.message)}</li>`;
  }
}

$("#btn-import-project").addEventListener("click", () => {
  openFolderBrowser();
});

$("#browser-close").addEventListener("click", () => {
  $("#browser-overlay").classList.add("hidden");
});

onBusy("#browser-select", async () => {
  if (!BROWSE_PATH) return;
  const p = await api("/api/projects/import", {
    method: "POST",
    body: { path: BROWSE_PATH }
  });
  $("#browser-overlay").classList.add("hidden");
  await loadProjects(false);
  switchProject(p.id);
  toast(`Imported “${p.name}”`);
  ensureSession();
});

/* ---------------- chat ---------------- */

async function ensureSession() {
  if (!S.pid) {
    S.sid = null;
    initSSE();
    return renderChat(true);
  }
  const seq = ++S.ensureSeq, pid = S.pid;
  const stale = () => seq !== S.ensureSeq || pid !== S.pid;
  try {
    chatLoading();
    const sessions = await oc("/session");
    if (stale()) return;
    S.sessions = Array.isArray(sessions) ? sessions : [];
    if (!S.sessions.find((s) => s.id === S.sid)) {
      S.sid = S.sessions[0]?.id || null;
    }
    if (!S.sid) {
      const s = await oc("/session", { method: "POST", body: {} });
      if (stale()) return;
      S.sid = s.id;
    }
    await renderChat(true);
    if (stale()) return;
    updateChatHeader();
    initSSE();
  } catch (e) {
    if (stale()) return;
    setConn(false);
    $("#chat-messages").innerHTML = "";
    pushMsg("system error", `<span class="role">error</span>${esc(e.message)}`);
    toast(e.message, true);
  }
}

function chatLoading() {
  $("#chat-messages").innerHTML = `<div class="msg system" aria-live="polite">Loading conversation…</div>`;
}

onBusy("#btn-new-session", async () => {
  if (!S.pid) return toast("Select a project first", true);
  const s = await oc("/session", { method: "POST", body: {} });
  S.sid = s.id;
  $("#btn-unrevert").classList.add("hidden");
  await renderChat(true);
  toast("New session");
});

$("#btn-sessions").addEventListener("click", () => openSessionSheet());

/* ---------------- session manager ---------------- */

async function openSessionSheet() {
  if (!S.pid) { toast("Open a project first", true); return; }
  $("#session-overlay").classList.remove("hidden");
  await loadSessions();
}

async function loadSessions() {
  const ul = $("#session-list");
  ul.innerHTML = `<li class="empty-state">Loading sessions…</li>`;
  try {
    S.sessions = await oc("/session");
    ul.innerHTML = S.sessions.length ? "" : `<li class="empty-state">No sessions yet</li>`;
    for (const ssn of S.sessions) {
      const cur = ssn.id === S.sid;
      const li = document.createElement("li");
      li.className = `session-card ${cur ? "cur" : ""}`;
      li.innerHTML = `
        <div class="session-info">
          <div class="session-title-row">
            <strong class="session-name${cur ? " is-cur" : ""}">${esc(ssn.title || "Untitled")}</strong>
            ${cur ? '<span class="session-badge">Active</span>' : ""}
          </div>
          <small class="session-meta">${esc(ssn.id)} · ${esc(fmtTok((ssn.tokens?.input||0)+(ssn.tokens?.output||0)))} tok</small>
        </div>
        <div class="session-actions">
          <button data-a="open" class="${cur ? "primary" : "ghost"}">${cur ? "✓ Active" : "Open"}</button>
          <button data-a="rename" class="ghost">✎ Rename</button>
          <button data-a="fork" class="ghost">⑂ Fork</button>
          <button data-a="share" class="ghost">🔗 Share</button>
          <button data-a="del" class="ghost danger" aria-label="Delete session">🗑</button>
        </div>`;
      li.querySelectorAll("button").forEach((b) =>
        b.addEventListener("click", () => withBusy(b, async () => {
          const a = b.dataset.a;
          try {
            if (a === "open") { S.sid = ssn.id; $("#session-overlay").classList.add("hidden"); await renderChat(true); initSSE(); toast("Session opened"); }
            else if (a === "rename") {
              const t = await promptDialog("Rename session:", ssn.title || "");
              if (!t) return;
              await oc(`/session/${ssn.id}`, { method: "PATCH", body: { title: t } });
              loadSessions();
            } else if (a === "fork") {
              const r = await oc(`/session/${ssn.id}/fork`, { method: "POST", body: {} });
              S.sid = r.id; await renderChat(true); await loadSessions(); toast("Forked");
            } else if (a === "share") {
              const r = await oc(`/session/${ssn.id}/share`, { method: "POST", body: {} });
              const link = r.shareUrl || r.url || r.id || "";
              try { await navigator.clipboard.writeText(link); toast("Share link copied"); }
              catch { toast(link || "Shared", false, 6000); }
            } else if (a === "del") {
              if (!(await confirmDialog("Delete this session and its history?", { okLabel: "Delete" }))) return;
              await oc(`/session/${ssn.id}`, { method: "DELETE" });
              toast("Deleted");
              if (S.sid === ssn.id) { S.sid = null; await ensureSession(); }
              await loadSessions();
            }
          } catch (e) { toast(e.message, true); }
        })));
      ul.appendChild(li);
    }
  } catch (e) { ul.innerHTML = `<li class="error-state">${esc(e.message)}</li>`; }
}

async function loadTodos() {
  if (!S.sid) { toast("Open a session first", true); return; }
  try {
    const todos = await oc(`/session/${S.sid}/todo`);
    const ul = $("#session-list");
    ul.innerHTML = `<li class="empty-state">Todos for current session</li>`;
    if (!todos || !todos.length) ul.insertAdjacentHTML("beforeend", `<li class="empty-state">No todos yet</li>`);
    for (const t of todos || []) {
      const mark = t.status === "completed" ? "✅" :
                   t.status === "in-progress" ? "🔄" : "⬜";
      ul.insertAdjacentHTML("beforeend",
        `<li>${mark} ${esc(t.content || t.title || "")}</li>`);
    }
  } catch (e) { toast(e.message, true); }
}

$("#session-close").addEventListener("click", () => $("#session-overlay").classList.add("hidden"));
$("#session-refresh").addEventListener("click", loadSessions);
onBusy("#session-new", async () => {
  const s = await oc("/session", { method: "POST", body: {} });
  S.sid = s.id; await renderChat(true); await loadSessions(); toast("New session");
});
$("#session-todo").addEventListener("click", loadTodos);

function updateChatHeader() {
  const m = S.model;
  $("#model-label").textContent = m ? `${m.providerID}/${m.modelID}` : "default";
}

const chatScroll = () => $("#chat-scroll");

function pushMsg(cls, html, id) {
  const wrap = document.createElement("div");
  wrap.className = "msg-wrap";
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  if (id) el.dataset.mid = id;
  el.innerHTML = html;
  wrap.appendChild(el);
  if (id && (cls.includes("user") || cls.includes("assistant"))) {
    const more = document.createElement("button");
    more.className = "msg-more-btn";
    more.textContent = "⋯";
    more.title = "Message options";
    more.setAttribute("aria-label", "Message options");
    more.onclick = (e) => {
      e.stopPropagation();
      openMessageMenu(id, cls);
    };
    wrap.appendChild(more);
  }
  $("#chat-messages").appendChild(wrap);
  chatScroll().scrollTop = chatScroll().scrollHeight;
  return el;
}

function openMessageMenu(mid, role) {
  showActions("Message Options", [
    { label: "↩ Revert conversation to here", primary: true, fn: async () => {
      if (!(await confirmDialog("Revert conversation back to this turn? Later turns will be undone.", { okLabel: "Revert" }))) return;
      try {
        await oc(`/session/${S.sid}/revert`, { method: "POST", body: { messageID: mid } });
        toast("Reverted to checkpoint");
        $("#btn-unrevert").classList.remove("hidden");
        renderChat(true);
      } catch (e) { toast(e.message, true); }
    } },
    { label: "⑂ Fork from here into new session", fn: async () => {
      try {
        const r = await oc(`/session/${S.sid}/fork`, { method: "POST", body: { messageID: mid } });
        S.sid = r.id;
        toast("Forked into new session");
        renderChat(true);
      } catch (e) { toast(e.message, true); }
    } },
    { label: "📋 Copy message text", fn: async () => {
      const msgEl = document.querySelector(`[data-mid="${CSS.escape(String(mid))}"]`);
      if (msgEl) {
        try { await navigator.clipboard.writeText(msgEl.innerText); toast("Copied to clipboard"); }
        catch { toast("Copy not permitted in this context", true); }
      }
    } }
  ]);
}

function partHtml(p) {
  if (p.type === "text" && (p.text || "").trim())
    return md(p.text);
  if (p.type === "reasoning") {
    const t = p.text || "";
    if (!t.trim()) return "";
    const open = localStorage.getItem("of.set.reasoning") === "1" ? " open" : "";
    return `<details class="reasoning"${open}><summary>💭 Reasoning</summary>${esc(t)}</details>`;
  }
  if (p.type === "tool" || p.tool || p.call) {
    const title = p.state?.title || p.title || p.tool || "Tool execution";
    const status = p.state?.status || p.status || "done";
    const output = p.state?.output || p.output || p.result || "";
    const input = p.state?.input || p.input || p.args || "";
    const inStr = typeof input === "object" ? JSON.stringify(input, null, 2) : String(input);
    const outStr = typeof output === "object" ? JSON.stringify(output, null, 2) : String(output);
    const isRunning = status === "running";
    const badge = isRunning ? "⏳ running…" : (status === "error" ? "❌ error" : "✓ done");
    const isDiff = looksLikeDiff(outStr);
    const bodyContent = isDiff ? renderDiffLines(outStr) : esc(outStr || inStr || "(no output)");
    return `<details class="tool-call${isRunning ? " running" : ""}">
      <summary><span>🔧 ${esc(title)}</span> <small style="color:var(--muted)">${esc(badge)}</small></summary>
      <div class="tool-body">${bodyContent}</div>
    </details>`;
  }
  return "";
}

/* context usage from the newest assistant message */
function updateCtxBar(msgs) {
  const el = $("#ctx-inline");
  if (!$("#set-live-ctx")?.checked) { el.textContent = ""; return; }
  const lastA = [...(msgs || [])].reverse().find((m) => m.info?.role === "assistant");
  const t = lastA?.info?.tokens;
  if (!t) { el.textContent = ""; return; }
  const ctx = (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
  const window_ = S.model && /gemini|1m/i.test(S.model.modelID) ? 1000000 : 128000;
  const pct = Math.min(100, Math.round((ctx / window_) * 100));
  const cost = lastA.info.cost ? ` · $${lastA.info.cost.toFixed(3)}` : "";
  el.innerHTML =
    `<span class="${pct > 75 ? "warn" : ""}">${fmtTok(ctx)} ${pct}%</span>${cost} · `;
}

/* ---------------- permissions handling ---------------- */

async function checkPermissions() {
  if (!S.pid || !S.sid) return;
  try {
    const res = await oc(`/session/${S.sid}/permission`).catch(() => []);
    const perms = Array.isArray(res) ? res : (res?.permissions || []);
    renderPermissions(perms);
  } catch {}
}

function renderPermissions(perms) {
  const box = $("#perm-container");
  if (!box) return;
  box.innerHTML = "";
  for (const p of perms) {
    const card = document.createElement("div");
    card.className = "perm-card";
    const desc = p.command || p.path || p.description || p.title || JSON.stringify(p.params || p);
    card.innerHTML = `
      <div class="perm-title"><span>🛡️ Permission Request (${esc(p.type || "action")})</span></div>
      <div class="perm-desc"><code>${esc(desc)}</code></div>
      <div class="perm-btns">
        <button class="primary" data-resp="allow">Allow</button>
        <button class="ghost" data-resp="allow_session">Always for session</button>
        <button class="ghost danger" data-resp="deny">Deny</button>
      </div>`;
    card.querySelectorAll("button").forEach((b) => {
      b.onclick = async () => {
        const resp = b.dataset.resp;
        try {
          await oc(`/session/${S.sid}/permission/${p.id}`, {
            method: "POST",
            body: { response: resp },
          });
          card.remove();
          toast(`Permission: ${resp}`);
        } catch (e) { toast(e.message, true); }
      };
    });
    box.appendChild(card);
  }
}

async function renderChat(full = false) {
  if (full) $("#chat-messages").innerHTML = "";
  if (!S.pid || !S.sid) {
    if (full) {
      $("#perm-container").innerHTML = "";
      pushMsg("system", S.pid ? "No session yet." : "Create or select a project to start chatting.");
    }
    return;
  }
  const rPid = S.pid, rSid = S.sid;
  try {
    checkPermissions();
    const msgs = await oc(`/session/${rSid}/message?limit=50`);
    if (rPid !== S.pid || rSid !== S.sid) return;   // user switched while loading
    if (full) {
      // oldest first so new messages appear at the bottom
      msgs.sort((a, b) =>
        (a.info?.time?.created || 0) - (b.info?.time?.created || 0));
      $("#chat-messages").innerHTML = "";
      if (!msgs.length) pushMsg("system", "Say hello — ask opencode to explore, edit or explain your project.");
      for (const m of msgs) {
        const role = m.info?.role || "system";
        if (m.info?.error && m.info.error.name !== "MessageOutputLengthError") {
          const d = m.info.error.data || {};
          pushMsg("system", `<span class="role">error</span>${esc(d.message || m.info.error.name)}`);
          continue;
        }
        const html = (m.parts || []).map(partHtml).join("");
        if (!html.trim() && !m.info?.tokens) {
          pushMsg("system", "(empty response — the model returned no content)");
          continue;
        }
        const el = pushMsg(role === "user" ? "user" : "assistant",
          html || `<span class="muted">(empty response)</span>`, m.info?.id);
        if (role === "assistant" && m.info?.tokens) {
          const t = m.info.tokens;
          const ctx = (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
          el.insertAdjacentHTML("beforeend",
            `<div class="msg-meta">CTX ${fmtTok(ctx)} · out ${fmtTok(t.output)} · ` +
            `${esc(m.info.modelID || "")}` +
            (m.info.cost ? ` · $${m.info.cost.toFixed(3)}` : "") + `</div>`);
        }
      }
    }
    updateCtxBar(msgs);
    setConn(true);
  } catch (e) {
    setConn(false);
    if (!renderChat._warned || Date.now() - renderChat._warned > 15000) {
      renderChat._warned = Date.now();
      toast(e.message || "Failed to load messages", true);
    }
  }
}

$("#chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#chat-form").requestSubmit(); }
});

$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (S.busy) return stopGeneration();
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  if (!S.pid || !S.sid) { toast("Open a project first", true); return; }
  input.value = "";
  sendPrompt(text);
});

async function sendPrompt(text, retryOf = false) {
  if (S.busy || !S.pid || !S.sid) return;
  S.lastSent = text;
  const genPid = S.pid, genSid = S.sid;   // generation context snapshot
  const gen = ++S.genSeq;

  pushMsg("user", esc(text));
  const live = pushMsg("assistant thinking",
    `<span class="role">assistant</span><span class="thinking">thinking<span class="dots"><i></i><i></i><i></i></span></span> <span class="elapsed"></span>`);
  const elapsedEl = live.querySelector(".elapsed");
  const t0 = Date.now();

  const body = { parts: [{ type: "text", text }] };
  if (S.model) body.model = S.model;
  const chatBody = () => oc(`/session/${genSid}/message?limit=1`);

  try {
    S.busy = true;
    S.abortReq = false;
    updateSendBtn();
    const base = await chatBody();
    const baseId = base[0]?.info?.id;
    await oc(`/session/${genSid}/prompt_async`, { method: "POST", body });

    const paint = (m) => {
      const html = (m.parts || []).map(partHtml).join("");
      live.className = "msg assistant";
      live.innerHTML = `<span class="role">assistant</span>${html || "<span class='thinking'>…</span>"}`;
      if (m.info?.tokens) {
        const t = m.info.tokens;
        const ctx = (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
        live.insertAdjacentHTML("beforeend",
          `<div class="msg-meta">CTX ${fmtTok(ctx)} · out ${fmtTok(t.output)} · ` +
          `${esc(m.info.modelID || "")}` +
          (m.info.cost ? ` · $${m.info.cost.toFixed(3)}` : "") + `</div>`);
      }
      updateCtxBar([m]);
      chatScroll().scrollTop = chatScroll().scrollHeight;
    };

    let warned = false, painted = false, failures = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 800));
      // User switched project/session mid-generation: stop driving a dead context.
      if (S.genSeq !== gen || S.pid !== genPid || S.sid !== genSid) return;
      elapsedEl.textContent = `(${Math.round((Date.now() - t0) / 1000)}s)`;
      let last = null;
      try { last = (await chatBody())[0]; failures = 0; }
      catch (e) {
        if (++failures >= 8) throw new Error("Lost connection to the daemon while waiting for the reply");
      }
      // baseId may be undefined (first message of a fresh session) — that still counts as "new".
      const isNew = !!last && last.info?.id !== baseId && last.info?.role === "assistant";

      if (isNew) { paint(last); painted = true; }
      const done = isNew && (last.info?.time?.completed || last.info?.error);
      if (done) break;

      const waited = Date.now() - t0;
      if (!isNew && waited > 20000 && !warned) {
        warned = true;
        live.innerHTML = `<span class="role">assistant</span><span class="thinking">still waiting for the engine<span class="dots"><i></i><i></i><i></i></span></span> <span class="elapsed">${Math.round(waited / 1000)}s</span>`;
      }
      if (!isNew && waited > 90000) {
        live.className = "msg assistant";
        live.innerHTML = `<span class="role">no response</span>The model never replied.`;
        const btn = document.createElement("button");
        btn.className = "ghost retry-btn";
        btn.textContent = retryOf ? "↻ Try again" : "↻ Retry";
        btn.onclick = () => { live.remove(); sendPrompt(text, true); };
        live.appendChild(btn);
        break;
      }
      if (S.abortReq) { await new Promise((r) => setTimeout(r, 1500)); break; }
    }
    if (painted) updateCtxBar(await chatBody().catch(() => []));
    if (S.genSeq === gen && S.pid === genPid) await renderChat(true);
  } catch (err) {
    if (!live.isConnected) return;
    live.className = "msg assistant";
    live.innerHTML =
      `<span class="role">error</span>${esc(err.message || "Request failed")}`;
    const btn = document.createElement("button");
    btn.className = "ghost retry-btn";
    btn.textContent = retryOf ? "↻ Try again" : "↻ Retry";
    btn.onclick = () => { live.remove(); sendPrompt(text, true); };
    live.appendChild(btn);
    toast(err.message, true);
  } finally {
    S.busy = false;
    updateSendBtn();
    if (chatScroll()) chatScroll().scrollTop = chatScroll().scrollHeight;
  }
}

function updateSendBtn() {
  const b = $("#chat-send");
  b.textContent = S.busy ? "⏹" : "➤";
  b.setAttribute("aria-label", S.busy ? "Stop generating" : "Send message");
  b.classList.toggle("stop", S.busy);
}

async function stopGeneration() {
  S.abortReq = true;
  if (!S.sid) return;
  try {
    await oc(`/session/${S.sid}/abort`, { method: "POST" });
    toast("Generation stopped");
  } catch (e) { toast(e.message, true); }
}

/* model quick-pick: tap the model label to jump to models tab */
const goModels = () => $$('#bottom-nav button[data-view="models"]')[0].click();
$(".sb-right").addEventListener("click", goModels);
$(".sb-right").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goModels(); }
});

/* ---------------- settings & connection profiles ---------------- */

if ("serviceWorker" in navigator) {
  // Relative so it works both under the daemon (/ui/) and any mirrored origin.
  navigator.serviceWorker.register("sw.js").then((reg) => reg.update()).catch(() => {});
  // A new worker took control (cache bumped) → reload once so stale JS/CSS is not kept.
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded || !navigator.serviceWorker.controller) return;
    if (S.busy) return;
    reloaded = true;
    location.reload();
  });
}

let sseSource = null, sseKey = "", sseRetry = null, sseDebounce = null;
function initSSE() {
  const base = getApiBase(), tok = bridgeToken();
  const key = S.pid ? `${base}|${S.pid}|${tok}` : "";
  // Same target and still alive → keep it (was: reopened on every session switch).
  if (key === sseKey && sseSource && sseSource.readyState !== 2) return;
  if (sseSource) { sseSource.close(); sseSource = null; }
  clearTimeout(sseRetry);
  sseKey = key;
  if (!S.pid) return;
  try {
    // EventSource cannot send headers; daemons accept ?token= too.
    const src = new EventSource(window.OF.sseUrl(base, S.pid, tok));
    sseSource = src;
    src.onopen = () => setConn(true);
    src.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === "permission" || data.type === "permission.asked") {
          checkPermissions();
        }
        const sid = data.sessionID || data.sessionId || data.properties?.sessionID;
        if (sid === S.sid && (data.type === "message.updated" || data.type === "session.updated")) {
          clearTimeout(sseDebounce);
          sseDebounce = setTimeout(() => { if (!S.busy) renderChat(false); }, 300);
        }
      } catch {}
    };
    // Transient errors self-heal (daemon sends "retry: 4000"), but a hard
    // failure (HTTP error) leaves the source CLOSED forever — reopen manually.
    src.onerror = () => {
      setConn(false);
      if (src.readyState === 2 && sseSource === src) {
        sseSource = null;
        sseRetry = setTimeout(initSSE, 5000);
      }
    };
  } catch {}
}

function renderProfiles() {
  const box = $("#conn-profiles");
  if (!box) return;
  box.innerHTML = "";
  let profiles = [];
  try { profiles = JSON.parse(localStorage.getItem("of.profiles") || "[]"); } catch {}
  if (!profiles.length) {
    profiles = [
      { name: "Standalone Engine", url: "http://127.0.0.1:8787" },
      { name: "Local Bridge (:8787)", url: "http://127.0.0.1:8787" }
    ];
    localStorage.setItem("of.profiles", JSON.stringify(profiles));
  }
  for (const p of profiles) {
    const chip = document.createElement("span");
    const isCur = (S.url || "http://127.0.0.1:8787") === (p.url || "http://127.0.0.1:8787");
    chip.className = `chip ${isCur ? "cur" : ""}`;
    chip.textContent = p.name;
    chip.onclick = () => {
      S.url = p.url || "http://127.0.0.1:8787";
      $("#set-url").value = S.url;
      localStorage.setItem("of.set.url", S.url);
      renderProfiles();
      toast(`Switched to: ${p.name}`);
      initSSE();
      if (S.pid) ensureSession();
    };
    box.appendChild(chip);
  }
}

function applySettings() {
  document.body.classList.toggle("hide-meta",
    localStorage.getItem("of.set.meta") !== "1");
}

/* Auth status: refreshes engine/credential badges in Settings. Top-level so
   boot() and the nav switch handler can call it (was nested in
   initSettings() → ReferenceError → badges stuck on "not set"). */
async function loadAuthStatus() {
  try {
    const st = await api("/api/auth/status");
    const ocTag = $("#auth-tag-opencode");
    if (ocTag) {
      ocTag.textContent = st.opencode?.configured ? `configured (${st.opencode.preview})` : "not set";
      ocTag.style.background = st.opencode?.configured ? "var(--ok)" : "var(--muted)";
      ocTag.style.color = st.opencode?.configured ? "#04291a" : "#fff";
    }
    const gemTag = $("#auth-tag-gemini");
    if (gemTag) {
      gemTag.textContent = st.gemini?.configured ? `configured (${st.gemini.preview})` : "not set";
      gemTag.style.background = st.gemini?.configured ? "var(--ok)" : "var(--muted)";
      gemTag.style.color = st.gemini?.configured ? "#04291a" : "#fff";
    }
    const ghTag = $("#auth-tag-github");
    if (ghTag) {
      ghTag.textContent = st.github?.configured ? `configured (${st.github.preview})` : "not set";
      ghTag.style.background = st.github?.configured ? "var(--ok)" : "var(--muted)";
      ghTag.style.color = st.github?.configured ? "#04291a" : "#fff";
    }
    const goTag = $("#auth-tag-opencodego");
    if (goTag) {
      goTag.textContent = st["opencode-go"]?.configured ? `configured (${st["opencode-go"].preview})` : "not set";
      goTag.style.background = st["opencode-go"]?.configured ? "var(--ok)" : "var(--muted)";
      goTag.style.color = st["opencode-go"]?.configured ? "#04291a" : "#fff";
    }

    // System & Engine Status Cards
    const daemonTag = $("#status-daemon-tag");
    if (daemonTag) {
      daemonTag.textContent = "● Running (:8787)";
      daemonTag.style.background = "var(--ok)";
      daemonTag.style.color = "#04291a";
    }

    const opencodeTag = $("#status-opencode-tag");
    if (opencodeTag) {
      if (st.opencode_local) {
        opencodeTag.textContent = "● Local CLI Process";
        opencodeTag.style.background = "var(--ok)";
        opencodeTag.style.color = "#04291a";
      } else {
        opencodeTag.textContent = "● Zen Cloud Engine";
        opencodeTag.style.background = "var(--accent)";
        opencodeTag.style.color = "#fff";
      }
    }

    const modelsTag = $("#status-models-tag");
    if (modelsTag) {
      const count = M.all?.length || 0;
      if (count > 0) {
        const src = M.source ? ` (${M.source})` : "";
        modelsTag.textContent = `● ${count} Models Active${src}`;
        modelsTag.style.background = "var(--ok)";
        modelsTag.style.color = "#04291a";
      } else {
        modelsTag.textContent = "● No Models";
        modelsTag.style.background = "var(--muted)";
        modelsTag.style.color = "#fff";
      }
    }

    const zenTag = $("#status-zen-tag");
    if (zenTag) {
      zenTag.textContent = st.opencode?.configured ? `Zen ✓ ${st.opencode.preview}` : "Zen not set";
      zenTag.style.background = st.opencode?.configured ? "var(--ok)" : "var(--muted)";
      zenTag.style.color = st.opencode?.configured ? "#04291a" : "#fff";
    }

    const goStatusTag = $("#status-go-tag");
    if (goStatusTag) {
      const cfg = st["opencode-go"]?.configured;
      goStatusTag.textContent = cfg ? `Go ✓ ${st["opencode-go"].preview}` : "Go not set";
      goStatusTag.style.background = cfg ? "var(--ok)" : "var(--muted)";
      goStatusTag.style.color = cfg ? "#04291a" : "#fff";
    }

    if (st.git_user) {
      if ($("#git-user-name") && st.git_user.name && !$("#git-user-name").value) {
        $("#git-user-name").value = st.git_user.name;
      }
      if ($("#git-user-email") && st.git_user.email && !$("#git-user-email").value) {
        $("#git-user-email").value = st.git_user.email;
      }
    }
  } catch (e) {
    if (!loadAuthStatus._warned || Date.now() - loadAuthStatus._warned > 15000) {
      loadAuthStatus._warned = Date.now();
      toast("Auth status unavailable: " + (e.message || "bridge unreachable"), true);
    }
  }
}

function initSettings() {
  const urlEl = $("#set-url");
  const tokenEl = $("#set-token");
  urlEl.value = S.url;
  if (tokenEl) tokenEl.value = localStorage.getItem("of.set.token") || "";
  renderProfiles();

  const reconnect = () => {
    initSSE();
    if (S.pid) ensureSession();
  };

  urlEl.addEventListener("change", () => {
    S.url = urlEl.value.trim().replace(/\/$/, "");
    localStorage.setItem("of.set.url", S.url);
    renderProfiles();
    toast(S.url ? "Server URL set — reconnecting" : "Using local bridge");
    reconnect();
  });

  $("#btn-save-token")?.addEventListener("click", () => {
    if (!tokenEl) return;
    const tok = tokenEl.value.trim();
    if (tok) localStorage.setItem("of.set.token", tok);
    else localStorage.removeItem("of.set.token");
    toast(tok ? "Bridge token saved ✓" : "Bridge token cleared");
    reconnect();
  });

  $("#btn-save-profile")?.addEventListener("click", async () => {
    const url = $("#set-url").value.trim().replace(/\/$/, "");
    const name = await promptDialog("Profile name (e.g. Home Server, VPS):", url ? url.replace(/https?:\/\//, "") : "Local");
    if (!name) return;
    let profiles = [];
    try { profiles = JSON.parse(localStorage.getItem("of.profiles") || "[]"); } catch {}
    profiles = profiles.filter((p) => p.name !== name);
    profiles.push({ name, url });
    localStorage.setItem("of.profiles", JSON.stringify(profiles));
    S.url = url;
    localStorage.setItem("of.set.url", url);
    renderProfiles();
    toast(`Saved profile “${name}”`);
    reconnect();
  });

  // Clipboard paste helpers
  async function pasteTo(selector) {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        $(selector).value = text.trim();
        toast("Pasted from clipboard ✓");
      } else {
        toast("Clipboard is empty", true);
      }
    } catch {
      toast("Paste manually by tapping in field", true);
    }
  }
  $("#btn-paste-opencode")?.addEventListener("click", () => pasteTo("#key-opencode"));
  $("#btn-paste-opencodego")?.addEventListener("click", () => pasteTo("#key-opencodego"));
  $("#btn-paste-gemini")?.addEventListener("click", () => pasteTo("#key-gemini"));
  $("#btn-paste-github")?.addEventListener("click", () => pasteTo("#key-github"));
  $("#btn-paste-custom")?.addEventListener("click", () => pasteTo("#key-provider-val"));
  $("#btn-paste-clone-url")?.addEventListener("click", () => pasteTo("#clone-project-url"));

  onBusy("#btn-save-opencode-key", async () => {
    const token = $("#key-opencode").value.trim();
    if (!token) return toast("Enter an OpenCode token", true);
    try {
      await api("/api/auth/token", { method: "POST", body: { provider_id: "opencode", token } });
      $("#key-opencode").value = "";
      toast("OpenCode Zen token saved ✓");
      loadAuthStatus();
      loadModels().catch(() => {});   // engine/catalog list may change
    } catch (e) { toast(e.message, true); }
  });

  onBusy("#btn-save-opencodego-key", async () => {
    const token = $("#key-opencodego").value.trim();
    if (!token) return toast("Enter an OpenCode Go key", true);
    try {
      await api("/api/auth/token", { method: "POST", body: { provider_id: "opencode-go", token } });
      $("#key-opencodego").value = "";
      toast("OpenCode Go subscription key saved ✓");
      loadAuthStatus();
      loadModels().catch(() => {});
    } catch (e) { toast(e.message, true); }
  });

  onBusy("#btn-save-gemini-key", async () => {
    const token = $("#key-gemini").value.trim();
    if (!token) return toast("Enter a Gemini API key", true);
    try {
      await api("/api/auth/token", { method: "POST", body: { provider_id: "gemini", token } });
      $("#key-gemini").value = "";
      toast("Gemini API key saved ✓");
      loadAuthStatus();
      loadModels().catch(() => {});
    } catch (e) { toast(e.message, true); }
  });

  onBusy("#btn-save-github-token", async () => {
    const token = $("#key-github").value.trim();
    if (!token) return toast("Enter a GitHub token", true);
    try {
      await api("/api/auth/token", { method: "POST", body: { provider_id: "github", token } });
      $("#key-github").value = "";
      toast("GitHub Personal Access Token saved ✓");
      loadAuthStatus();
    } catch (e) { toast(e.message, true); }
  });

  onBusy("#btn-save-git-identity", async () => {
    const name = $("#git-user-name").value.trim();
    const email = $("#git-user-email").value.trim();
    if (!name && !email) return toast("Enter a name or email", true);
    try {
      await api("/api/git/config", { method: "POST", body: { name, email } });
      toast("Git author details saved ✓");
      loadAuthStatus();
    } catch (e) { toast(e.message, true); }
  });

  onBusy("#btn-save-custom-key", async () => {
    const provider_id = $("#key-provider-select").value;
    const token = $("#key-provider-val").value.trim();
    if (!token) return toast("Enter an API key", true);
    try {
      await api("/api/auth/token", { method: "POST", body: { provider_id, token } });
      $("#key-provider-val").value = "";
      toast(`${provider_id.toUpperCase()} API key saved ✓`);
      loadAuthStatus();
      loadModels().catch(() => {});
    } catch (e) { toast(e.message, true); }
  });

  onBusy("#btn-clone-project", async () => {
    const url = $("#clone-project-url").value.trim();
    if (!url) return toast("Enter a Git repository URL", true);
    const branch = $("#clone-project-branch").value.trim();
    const btn = $("#btn-clone-project");
    btn.textContent = "Cloning repository…";
    try {
      const p = await api("/api/projects/clone", {
        method: "POST",
        body: { url, branch }
      });
      $("#clone-project-url").value = "";
      $("#clone-project-branch").value = "";
      await loadProjects(false);
      switchProject(p.id);
      toast(`Cloned “${p.name}” ✓`);
      ensureSession();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.textContent = "Clone & Open";
    }
  });

  // Default Workspace Directory Management
  api("/api/settings/workspace").then((w) => {
    if ($("#set-workspace-dir") && w.workspace_dir) {
      $("#set-workspace-dir").value = w.workspace_dir;
    }
  }).catch(() => {});

  onBusy("#btn-save-workspace", async () => {
    const path = $("#set-workspace-dir").value.trim();
    if (!path) return toast("Enter a directory path", true);
    try {
      const res = await api("/api/settings/workspace", { method: "POST", body: { path } });
      toast(`Workspace updated: ${res.workspace_dir}`);
    } catch (e) { toast(e.message, true); }
  });

  const map = [
    ["#set-reasoning", "of.set.reasoning"],
    ["#set-meta", "of.set.meta"],
    ["#set-live-ctx", "of.set.live"],
  ];
  for (const [sel, key] of map) {
    const el = $(sel);
    if (!el) continue;
    el.checked = (key === "of.set.live" ? localStorage.getItem(key) !== "0"
      : localStorage.getItem(key) === "1");
    el.addEventListener("change", () => {
      localStorage.setItem(key, el.checked ? "1" : "0");
      applySettings();
      if (key === "of.set.reasoning") renderChat(true).catch(() => {});
      if (key === "of.set.live" && !el.checked) $("#ctx-inline").textContent = "";
    });
  }
  $("#btn-clear-prefs").addEventListener("click", async () => {
    if (!(await confirmDialog("Clear all saved preferences, connection profiles and tokens stored in this app?", { okLabel: "Clear" }))) return;
    Object.keys(localStorage)
      .filter((k) => k.startsWith("of."))
      .forEach((k) => localStorage.removeItem(k));
    toast("Preferences cleared — reloading");
    setTimeout(() => location.reload(), 800);
  });
  api("/api/health").then((h) => {
    $("#about-box").innerHTML =
      `OpenForge v${esc(h.daemon_version || "?")} · bridge <b>${esc(h.bridge)}</b><br>` +
      `opencode ${esc(h.opencode?.version || "?")} — ` +
      `${h.opencode?.healthy ? "healthy ✓" : "<span style='color:var(--err)'>offline</span>"}` +
      (h.opencode?.error
        ? `<br><span style='color:var(--err)'>${esc(h.opencode.error)}</span>`
        : "");
  }).catch(() => { $("#about-box").textContent = "Bridge unreachable — check Connection settings."; });
}

/* ---------------- unrevert & terminal drawer ---------------- */

onBusy("#btn-unrevert", async () => {
  if (!S.sid) return;
  try {
    await oc(`/session/${S.sid}/unrevert`, { method: "POST", body: {} });
    toast("Restored undone turns");
    $("#btn-unrevert").classList.add("hidden");
    renderChat(true);
  } catch (e) { toast(e.message, true); }
});

$("#btn-toggle-term")?.addEventListener("click", () => {
  if (!S.pid) { toast("Open a project first", true); return; }
  $("#term-overlay").classList.toggle("hidden");
  if (!$("#term-overlay").classList.contains("hidden")) $("#term-input").focus();
});

$("#term-close")?.addEventListener("click", () => $("#term-overlay").classList.add("hidden"));
$("#term-clear")?.addEventListener("click", () => { $("#term-output").textContent = ""; });

$("#term-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#term-input");
  const cmd = input.value.trim();
  if (!cmd) return;
  if (!S.pid) { toast("Select a project first", true); return; }
  input.value = "";
  const outBox = $("#term-output");
  const runBtn = $("#term-form button");
  outBox.textContent += `$ ${cmd}\n`;
  outBox.scrollTop = outBox.scrollHeight;
  await withBusy(runBtn, async () => {
    try {
      const res = await api(`/api/terminal/${encodeURIComponent(S.pid)}/exec`, { method: "POST", body: { command: cmd } });
      if (res.stdout) outBox.textContent += res.stdout;
      if (res.stderr) outBox.textContent += `[stderr] ${res.stderr}\n`;
      outBox.textContent += `(exit: ${res.code})\n\n`;
    } catch (err) {
      outBox.textContent += `Error: ${err.message}\n\n`;
    }
    if (outBox.textContent.length > 200000) outBox.textContent = outBox.textContent.slice(-150000);
    outBox.scrollTop = outBox.scrollHeight;
  });
});

/* ---------------- folder browser (import existing project) ----------------
   Single implementation. The daemon returns {current, parent,
   entries:[{name, path, is_dir}]} for /api/browse. */

$("#browser-up").addEventListener("click", () => {
  if (!BROWSE_PATH) return;
  api(`/api/browse?path=${encodeURIComponent(BROWSE_PATH)}`)
    .then((d) => { if (d.parent) loadBrowseDir(d.parent); })
    .catch((e) => toast(e.message, true));
});

/* ---------------- git ---------------- */

const G = { status: null, diffFile: null, diffStaged: false };

function showActions(title, actions) {
  $("#action-title").textContent = title;
  const box = $("#action-buttons");
  box.innerHTML = "";
  for (const a of actions) {
    const b = document.createElement("button");
    b.className = a.danger ? "ghost danger" : (a.primary ? "primary full" : "ghost full");
    b.textContent = a.label;
    b.onclick = () => {
      $("#action-overlay").classList.add("hidden");
      Promise.resolve().then(() => a.fn()).catch((e) => toast(e && e.message ? e.message : "Action failed", true));
    };
    box.appendChild(b);
  }
  $("#action-overlay").classList.remove("hidden");
}

async function loadGit() {
  if (!S.pid) { toast("Open a project first", true); return; }
  try {
    const gpid = S.pid;
    const gl = $("#git-files");
    if (!G.status || !gl.children.length) gl.innerHTML = `<li class="empty-state">Loading…</li>`;
    const st = await git("status");
    if (gpid !== S.pid) return;
    G.status = st;
    $("#git-branch").textContent = G.status.branch || (G.status.is_git ? "(empty repo)" : "not a git repo");
    renderGitFiles();
    if (G.status.is_git) {
      api(`/git/${S.pid}/graph?limit=1`)
        .then((d) => {
          const rem = d.remotes || [];
          if (gpid !== S.pid) return;
          $("#git-remotes").innerHTML =
            rem.length ? rem.map((r) => `⇅ ${esc(r.name)} → ${esc(r.fetch || "")}`).join("<br>") : "";
        }).catch(() => {});
    } else {
      $("#git-remotes").innerHTML = "";
    }
  } catch (e) {
    G.status = { is_git: true, staged: [], unstaged: [], untracked: [], conflicts: [] };
    renderGitFiles();
    $("#git-files").innerHTML = `<li class="error-state">${esc(e.message)}</li>`;
    toast(e.message, true);
  }
}

function fileBadge(f) {
  if (f.x === "?" ) return `<span class="st-badge st-question">new</span>`;
  const c = f.x && f.x !== " " ? f.x : (f.y || "?");
  return `<span class="st-badge st-${/^[A-Za-z]$/.test(c) ? c : "X"}">${esc(c)}</span>`;
}

function allFiles() {
  const s = G.status;
  return [
    ...(s.staged || []).map((f) => ({ ...f, area: "staged" })),
    ...(s.unstaged || []).map((f) => ({ ...f, area: "unstaged" })),
    ...(s.untracked || []).map((f) => ({ ...f, area: "untracked" })),
  ];
}

function renderGitFiles() {
  const ul = $("#git-files");
  ul.innerHTML = "";
  const s = G.status;

  if (s && s.is_git === false) {
    ul.innerHTML = `<li class="empty-state-card">
      <div class="es-title">📁 Not a Git repository</div>
      <div class="es-sub">This project folder does not have Git initialized yet.</div>
      <button id="btn-init-git-now" class="primary full">Initialize Git Repository (git init)</button>
    </li>`;
    const b = $("#btn-init-git-now");
    if (b) {
      b.onclick = () => withBusy(b, async () => {
        await api(`/git/${encodeURIComponent(S.pid)}/init`, { method: "POST" });
        toast("Git repository initialized ✓");
        loadGit();
      });
    }
    return;
  }

  // Render Conflicts if any
  const confWrap = $("#git-conflicts-wrap");
  const confList = $("#git-conflicts-list");
  if (s && s.conflicts && s.conflicts.length) {
    confWrap.classList.remove("hidden");
    confList.innerHTML = "";
    for (const c of s.conflicts) {
      const row = document.createElement("div");
      row.className = "conflict-item";
      row.innerHTML = `<span style="word-break:break-all"><strong style="color:var(--err)">⚡ ${esc(c.path)}</strong></span>
        <div class="git-btns">
          <button data-choice="ours" class="ghost sm">Ours</button>
          <button data-choice="theirs" class="ghost sm">Theirs</button>
          <button data-choice="edit" class="ghost sm">Edit</button>
        </div>`;
      row.querySelectorAll("button").forEach((b) => {
        b.onclick = async () => {
          const choice = b.dataset.choice;
          if (choice === "edit") {
            $$('#bottom-nav button[data-view="files"]')[0].click();
            openEditor(c.path);
          } else {
            if (!(await confirmDialog(`Resolve ${c.path} by taking ${choice.toUpperCase()}? The other side is discarded.`, { okLabel: "Resolve" }))) return;
            await withBusy(b, async () => {
              const r = await api(`/git/${encodeURIComponent(S.pid)}/resolve`, { method: "POST", body: { path: c.path, choice } });
              toast(r.out || "Conflict resolved");
              loadGit();
            });
          }
        };
      });
      confList.appendChild(row);
    }
  } else if (confWrap) {
    confWrap.classList.add("hidden");
  }

  const files = allFiles();
  if (!files.length && (!s?.conflicts || !s.conflicts.length)) {
    ul.innerHTML = `<li class="empty-state">Working tree clean ✓</li>`;
    return;
  }
  for (const f of files) {
    const li = document.createElement("li");
    li.className = "git-file";
    li.innerHTML = `<span class="path-text">${fileBadge(f)} ${esc(f.path)}</span>
      <span class="muted-small">${esc(f.area)}</span>`;
    li.setAttribute("role", "button"); li.tabIndex = 0;
    li.onclick = () => showActions(f.path, [
      { label: "📄 View line-by-line diff", primary: true, fn: () => openDiff(f.path, f.area === "staged") },
      ...(f.area === "untracked" ? [] : [{ label: f.area === "staged" ? "⬆ Unstage file" : "⬇ Stage file",
        fn: async () => {
          await git(f.area === "staged" ? "unstage" : "stage",
            { method: "POST", body: { files: [f.path] } });
          loadGit(); toast(f.area === "staged" ? "Unstaged" : "Staged");
        } }]),
      ...(f.area === "untracked" ? [{ label: "⬇ Stage (track) file",
        fn: async () => { await git("stage", { method: "POST", body: { files: [f.path] } }); loadGit(); } }] : []),
      ...(f.area === "untracked" ? [] : [{ label: "🗑 Discard changes", danger: true, fn: async () => {
          if (!(await confirmDialog(`Discard all changes in ${f.path}? This cannot be undone.`, { okLabel: "Discard" }))) return;
          await git("discard", { method: "POST", body: { ref: f.path } });
          loadGit(); toast("Discarded");
        } }]),
    ]);
    ul.appendChild(li);
  }
}

onBusy("#btn-commit", async () => {
  const msg = $("#commit-msg").value.trim();
  if (!msg) return toast("Enter a commit message", true);
  if (!G.status) return toast("Open the Git tab first", true);
  if (!(G.status.staged || []).length) {
    const all = allFiles().map((f) => f.path);
    if (!all.length) return toast("Nothing to commit", true);
    if (!(await confirmDialog("No staged files — stage ALL changes and commit?", { okLabel: "Stage all & commit", danger: false }))) return;
    await git("stage", { method: "POST", body: { files: all } });
  }
  await git("commit", { method: "POST", body: { message: msg } });
  $("#commit-msg").value = "";
  toast("Committed ✓");
  loadGit();
});

/* ---------- graph + branches ---------- */

async function loadGitGraph() {
  if (!S.pid) return;
  const gpid = S.pid;
  $("#git-graph").innerHTML = `<div class="g-empty">Loading history…</div>`;
  try {
    const d = await git("graph");
    if (gpid !== S.pid) return;
    const chips = $("#branch-chips");
    chips.innerHTML = "";
    for (const name of (d.branches && d.branches.all) || []) {
      // eslint-disable-next-line no-loop-func
      const c = document.createElement("span");
      c.className = "chip" + (name === d.branches.current ? " cur" : "");
      c.textContent = name;
      c.setAttribute("role", "button"); c.tabIndex = 0;
      c.onclick = () => branchActions(name, name === d.branches.current);
      chips.appendChild(c);
    }
    $("#git-remotes").innerHTML = (d.remotes || [])
      .map((r) => `⇅ ${esc(r.name)} → ${esc(r.fetch || "")}`).join("<br>") || "";
    renderCommitGraph(d.commits || []);
  } catch (e) {
    $("#git-graph").innerHTML = `<div class="g-empty err">${esc(e.message)}</div>`;
    toast(e.message, true);
  }
}

/* ---------- rendered commit graph ---------- */

const GCOLORS = ["#4f8cff", "#7c5cff", "#3ecf8e", "#ffb454", "#ff6b6b",
  "#4dd0e1", "#f06292", "#aed581", "#ffd54f"];
const GW = 16, GRH = 34;

function renderCommitGraph(commits) {
  const box = $("#git-graph");
  if (!commits.length) {
    box.innerHTML = `<div class="g-empty">No commits yet</div>`;
    return;
  }
  let lanes = [];           // hash per lane index (null = free)
  const rows = [];

  for (const c of commits) {
    let li = lanes.indexOf(c.hash);
    if (li < 0) {
      li = lanes.indexOf(null);
      if (li < 0) { li = lanes.length; lanes.push(null); }
    }
    const before = lanes.slice();
    const parents = c.parents || [];
    lanes[li] = parents[0] || null;
    for (const p of parents.slice(1)) {
      const ex = lanes.indexOf(p);
      if (ex < 0) {
        const f = lanes.indexOf(null);
        if (f >= 0) lanes[f] = p; else lanes.push(p);
      }
    }
    rows.push({ c, li, before, after: lanes.slice() });
  }

  const maxLanes = Math.max(lanes.length + 1,
    ...rows.map((r) => Math.max(r.li + 1, r.before.length)));
  const width = maxLanes * GW + GW;

  box.innerHTML = "";
  for (const { c, li, before, after } of rows) {
    const row = document.createElement("div");
    row.className = "g-row";

    const idxB = new Map(), idxA = new Map();
    before.forEach((h, i) => h && !idxB.has(h) && idxB.set(h, i));
    after.forEach((h, i) => h && !idxA.has(h) && idxA.set(h, i));
    let segs = "";
    for (const h of new Set([...idxB.keys(), ...idxA.keys()])) {
      const i0 = idxB.get(h), i1 = idxA.get(h);
      const col = GCOLORS[(i1 ?? i0 ?? 0) % GCOLORS.length];
      const colIn = GCOLORS[(i0 ?? 0) % GCOLORS.length];
      const x0 = i0 != null ? i0 * GW + GW / 2 : null;
      const x1 = i1 != null ? i1 * GW + GW / 2 : null;
      if (x0 == null) {
        segs += `<line x1="${x1}" y1="0" x2="${x1}" y2="${GRH / 2}" stroke="${col}" stroke-width="2"/>`;
      } else if (x1 == null) {
        segs += `<line x1="${x0}" y1="${GRH / 2}" x2="${x0}" y2="${GRH}" stroke="${colIn}" stroke-width="2"/>`;
      } else if (i0 === i1) {
        segs += `<line x1="${x0}" y1="0" x2="${x0}" y2="${GRH}" stroke="${col}" stroke-width="2"/>`;
      } else {
        segs += `<path d="M ${x0} 0 C ${x0} ${GRH * 0.5}, ${x1} ${GRH * 0.5}, ${x1} ${GRH}" stroke="${colIn}" fill="none" stroke-width="2"/>`;
      }
    }
    const refHtml = (c.refs || [])
      .map((r) => `<span class="g-ref${/^[0-9a-f]{7,}$/.test(r) ? "" : " br"}">${esc(r)}</span>`).join("");

    row.innerHTML =
      `<svg class="g-svg" width="${width}" height="${GRH}">${segs}` +
      `<circle cx="${li * GW + GW / 2}" cy="${GRH / 2}" r="4.5" fill="${GCOLORS[li % GCOLORS.length]}" stroke="#0b0e14" stroke-width="2"/></svg>` +
      `<div class="g-info"><div class="g-subj">${refHtml}${esc(c.subject)}</div>
         <div class="g-meta">${esc(c.short)} · ${esc(c.author)} · ${esc(c.date)}</div></div>`;
    row.setAttribute("role", "button"); row.tabIndex = 0;
    row.onclick = () => commitActions(c);
    box.appendChild(row);
  }
}

function commitActions(c) {
  showActions(`${c.short} — ${c.subject}`, [
    { label: "⧉ Copy full hash", fn: async () => {
        try { await navigator.clipboard.writeText(c.hash); toast("Hash copied"); }
        catch { toast(c.hash); }
      } },
    { label: "✓ Checkout this commit (detached)", primary: true, fn: async () => {
        if (!(await confirmDialog("Checkout detached HEAD at " + c.short + "? Uncommitted changes may block this.", { okLabel: "Checkout", danger: false }))) return;
        await git("checkout", { method: "POST", body: { ref: c.hash } });
        toast("Checked out " + c.short); loadGit(); loadGitGraph();
      } },
    { label: "⑂ Create branch here", fn: async () => {
        const name = await promptDialog("Branch name:");
        if (!name) return;
        git("branch/create", { method: "POST", body: { name } })
          .then(() => { toast(`Branch "${name}" created`); loadGitGraph(); })
          .catch((e) => toast(e.message, true));
      } },
    { label: "↩ Revert this commit", danger: true, fn: async () => {
        if (!(await confirmDialog(`Revert ${c.short}? A new inverse commit will be created.`, { okLabel: "Revert" }))) return;
        const r = await git("revert", { method: "POST", body: { ref: c.hash } });
        toast(r.out || "Reverted"); loadGit(); loadGitGraph();
      } },
  ]);
}

function branchActions(name, isCurrent) {
  const acts = [];
  if (!isCurrent) {
    acts.push({ label: "✓ Checkout branch", primary: true, fn: async () => {
      try { await git("checkout", { method: "POST", body: { ref: name } });
            toast(`On ${name}`); loadGit(); loadGitGraph(); }
      catch (e) { toast(e.message, true); }
    }});
    acts.push({ label: "⑂ Merge into current branch", fn: async () => {
      if (!(await confirmDialog(`Merge "${name}" into the current branch?`, { okLabel: "Merge", danger: false }))) return;
      try { const r = await git("merge", { method: "POST", body: { ref: name } });
            toast(r.out || "Merged"); loadGit(); loadGitGraph(); }
      catch (e) { toast(e.message, true); }
    }});
  } else {
    acts.push({ label: "✏ Rename branch", primary: true, fn: async () => {
      const nn = await promptDialog(`Rename "${name}" to:`);
      if (!nn) return;
      git("branch/rename", { method: "POST", body: { old: name, new: nn } })
        .then(() => { toast("Renamed"); loadGit(); loadGitGraph(); })
        .catch((e) => toast(e.message, true));
    }});
  }
  acts.push({ label: "🗑 Delete branch", danger: true, fn: async () => {
    if (!(await confirmDialog(`Delete branch "${name}"?`, { okLabel: "Delete" }))) return;
    try { await git("branch/delete", { method: "POST", body: { name, force: false } });
          toast("Deleted"); loadGitGraph(); loadGit(); }
    catch (e) {
      if (await confirmDialog(e.message + "\n\nForce delete this branch? Unmerged commits will be lost.", { okLabel: "Force delete" })) {
        try { await git("branch/delete", { method: "POST", body: { name, force: true } });
              toast("Force deleted"); loadGitGraph(); loadGit(); }
        catch (e2) { toast(e2.message, true); }
      }
    }
  }});
  showActions(name, acts);
}

/* ---------- diff viewer ---------- */

async function openDiff(file, staged) {
  G.diffFile = file; G.diffStaged = staged;
  $("#diff-file-name").textContent = file;
  $("#diff-staged-toggle").checked = staged;
  $("#diff-file-head").classList.remove("hidden");
  $$(".subtab").forEach((x) => x.classList.remove("active"));
  $$('.subtab[data-subtab="diff"]').forEach((x) => x.classList.add("active"));
  $$(".subtab-page").forEach((x) => x.classList.remove("active"));
  $("#git-diff").classList.add("active");
  await refreshDiff();
}

let diffSeq = 0;
async function refreshDiff() {
  if (!S.pid) { $("#git-diff-view").textContent = "Open a project first."; return; }
  const seq = ++diffSeq;
  const view = $("#git-diff-view");
  view.textContent = "Loading diff…";
  try {
    const q = G.diffFile
      ? `?file=${encodeURIComponent(G.diffFile)}&staged=${G.diffStaged}`
      : `?staged=${G.diffStaged}`;
    const d = await git(`diff${q}`);
    if (seq !== diffSeq) return;
    renderDiff(d.diff || "");
  } catch (e) {
    if (seq !== diffSeq) return;
    view.innerHTML = `<span class="error-state">${esc(e.message)}</span>`;
    toast(e.message, true);
  }
}

function renderDiff(text) {
  $("#git-diff-view").innerHTML = text.trim() ? renderDiffLines(text) : `<span class="empty-state">No differences</span>`;
}

$("#diff-close").addEventListener("click", () => {
  G.diffFile = null;
  $("#diff-file-head").classList.add("hidden");
  refreshDiff();
});

$("#diff-staged-toggle").addEventListener("change", (e) => {
  G.diffStaged = e.target.checked;
  refreshDiff();
});
$("#diff-close").setAttribute("aria-label", "Close file diff");

/* ---------- stashes ---------- */

async function loadStashes() {
  if (!S.pid) return;
  const ul = $("#stash-list");
  ul.innerHTML = `<li class="empty-state">Loading…</li>`;
  try {
    const d = await git("stash");
    ul.innerHTML = "";
    const stashes = d.stashes || [];
    if (!stashes.length)
      ul.innerHTML = `<li class="empty-state">No stashes. Use “Stash current changes”.</li>`;
    for (const st of stashes) {
      const li = document.createElement("li");
      li.innerHTML = `<div class="li-main"><small class="hash">#${esc(st.index)}</small> ${esc(st.label)}</div>
        <div class="git-btns">
          <button data-a="pop" class="ghost">Pop</button>
          <button data-a="apply" class="ghost">Apply</button>
          <button data-a="drop" class="ghost danger" aria-label="Drop stash ${esc(st.index)}">🗑</button>
        </div>`;
      li.querySelectorAll("button").forEach((b) =>
        b.addEventListener("click", async () => {
          const a = b.dataset.a;
          if (a === "drop" && !(await confirmDialog(`Drop stash #${st.index}? This cannot be undone.`, { okLabel: "Drop" }))) return;
          await withBusy(b, async () => {
            const r = await git(`stash/${a}`, { method: "POST", body: { index: st.index } });
            toast(r.out || a + " done"); loadStashes(); loadGit();
          });
        }));
      ul.appendChild(li);
    }
  } catch (e) { ul.innerHTML = `<li class="error-state">${esc(e.message)}</li>`; toast(e.message, true); }
}

onBusy("#btn-stash-create", async () => {
  const msg = await promptDialog("Stash message (optional):") || undefined;
  try {
    const r = await git("stash", { method: "POST", body: { message: msg } });
    toast(r.out || "Stashed"); loadStashes(); loadGit();
  } catch (e) { toast(e.message, true); }
});

/* ---------- subtab wiring ---------- */

$$(".subtab").forEach((b) =>
  b.addEventListener("click", () => {
    $$(".subtab").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    $$(".subtab-page").forEach((x) => x.classList.remove("active"));
    $(`#git-${b.dataset.subtab}`).classList.add("active");
    if (b.dataset.subtab === "changes") loadGit();
    if (b.dataset.subtab === "log") loadGitGraph();
    if (b.dataset.subtab === "diff") { G.diffFile = null; $("#diff-file-head").classList.add("hidden"); refreshDiff(); }
    if (b.dataset.subtab === "stashes") loadStashes();
  })
);

$$("#view-git .git-btns button[data-git]").forEach((b) =>
  b.addEventListener("click", async () => {
    const a = b.dataset.git;
    try {
      if (a === "refresh") return loadGit();
      b.disabled = true; b.classList.add("loading");
      const d = await git(a, { method: "POST" });
      toast(d.out || a + " ok");
      loadGit();
    } catch (e) { toast(e.message, true); }
    finally { b.disabled = false; b.classList.remove("loading"); }
  })
);

onBusy("#btn-git-remote", async () => {
  if (!S.pid) { toast("Open a project first", true); return; }
  try {
    const d = await git("graph");
    const rems = d.remotes || [];
    const actions = [
      { label: "+ Add new remote (e.g. origin)", primary: true, fn: async () => {
        const name = await promptDialog("Remote name (e.g. origin):", "origin");
        if (!name) return;
        const url = await promptDialog(`Remote URL for "${name}":`);
        if (!url) return;
        try {
          const r = await api(`/git/${S.pid}/remote/add`, { method: "POST", body: { name, url } });
          toast(r.out || "Remote added");
          loadGit();
        } catch (e) { toast(e.message, true); }
      } },
      { label: "↓ Fetch from remotes", fn: async () => {
        try {
          const r = await api(`/git/${S.pid}/fetch`, { method: "POST", body: {} });
          toast(r.out || "Fetched");
          loadGit(); loadGitGraph();
        } catch (e) { toast(e.message, true); }
      } }
    ];
    for (const r of rems) {
      actions.push({
        label: `✎ Edit "${r.name}" URL (${r.fetch || r.push || ""})`,
        fn: async () => {
          const u = await promptDialog(`New URL for remote "${r.name}":`, r.fetch || r.push || "");
          if (!u) return;
          try {
            await api(`/git/${S.pid}/remote/set-url`, { method: "POST", body: { name: r.name, url: u } });
            toast("Remote URL updated");
            loadGit();
          } catch (e) { toast(e.message, true); }
        }
      });
      actions.push({
        label: `🗑 Remove remote "${r.name}"`,
        danger: true,
        fn: async () => {
          if (!(await confirmDialog(`Remove remote "${r.name}"?`, { okLabel: "Remove" }))) return;
          try {
            await api(`/git/${S.pid}/remote/remove`, { method: "POST", body: { name: r.name } });
            toast("Remote removed");
            loadGit();
          } catch (e) { toast(e.message, true); }
        }
      });
    }
    showActions("Git Remotes Management", actions);
  } catch (e) { toast(e.message, true); }
});

/* ---------------- models & local LAN scanner ---------------- */

const M = { all: [], favorites: [], providers: {} };

// Preset definitions for quick manual addition
const PRESETS = {
  ollama: { provider: "ollama", url: "http://127.0.0.1:11434/v1", model: "qwen2.5-coder:7b", name: "Qwen 2.5 Coder 7B" },
  llamacpp: { provider: "llamacpp", url: "http://127.0.0.1:8080/v1", model: "default", name: "Local GGUF" },
  lmstudio: { provider: "lmstudio", url: "http://127.0.0.1:1234/v1", model: "qwen2.5-coder-32b-instruct", name: "Qwen 2.5 Coder 32B" },
  qwen: { provider: "qwen", url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "qwen-2.5-coder-32b-instruct", name: "Qwen 2.5 Coder 32B (DashScope)" },
  glm: { provider: "glm", url: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-plus", name: "GLM 4 Plus" },
};

$$(".branch-chips .chip[data-preset]").forEach((chip) => {
  chip.onclick = () => {
    const p = PRESETS[chip.dataset.preset];
    if (!p) return;
    $("#m-provider").value = p.provider;
    $("#m-url").value = p.url;
    $("#m-model").value = p.model;
    $("#m-name").value = p.name;
    toast(`Loaded preset: ${p.name}`);
  };
});

async function scanLAN() {
  const statusEl = $("#lan-scan-status");
  const listEl = $("#lan-servers-list");
  statusEl.classList.remove("hidden");
  listEl.innerHTML = "";
  try {
    const res = await api("/api/models/scan-lan", { method: "POST", body: { include_lan: true } });
    statusEl.classList.add("hidden");
    const servers = res.servers || [];
    if (!servers.length) {
      listEl.innerHTML = `<div class="empty-state">No active local AI servers detected on localhost or LAN.</div>`;
      return;
    }
    for (const s of servers) {
      const card = document.createElement("div");
      card.className = "lan-server-card";
      const modelChips = (s.models || []).map((m) =>
        `<span class="lan-model-chip">${esc(m.name || m.id)}${m.size ? ` <small class="muted">(${esc(m.size)})</small>` : ""}</span>`
      ).join("");
      card.innerHTML = `
        <div class="lan-server-head">
          <div>
            <strong class="lan-server-title">${esc(s.name)}</strong>
            <small class="li-sub">${esc(s.base_url)}</small>
          </div>
          <span class="server-badge ${esc(s.type)}">${esc(s.type)}</span>
        </div>
        <div class="lan-models-list">
          ${modelChips || '<span class="muted">(no models loaded)</span>'}
        </div>
        <div class="lan-actions">
          <button class="primary btn-import-server">Import All Models</button>
        </div>`;
      const impBtn = card.querySelector(".btn-import-server");
      impBtn.onclick = () => withBusy(impBtn, async () => {
        try {
          await api("/api/models/register-local", {
            method: "POST",
            body: {
              provider_id: s.type,
              name: s.name,
              base_url: s.base_url,
              models: s.models || [],
            },
          });
          toast(`Imported ${s.models?.length || 0} models from ${s.name}`);
          loadModels();
        } catch (e) { toast(e.message, true); }
      });
      listEl.appendChild(card);
    }
  } catch (err) {
    statusEl.classList.add("hidden");
    toast(err.message, true);
  }
}

onBusy("#btn-scan-lan", scanLAN);

onBusy("#btn-probe-host", async () => {
  const hostVal = $("#lan-custom-host").value.trim().replace(/^https?:\/\//, "").replace(/\/+.*$/, "");
  if (!hostVal) return toast("Enter an IP or host:port", true);
  const parts = hostVal.split(":");
  const host = parts[0];
  const port = parts[1] ? parseInt(parts[1], 10) : 11434;
  try {
    toast(`Probing ${host}:${port}…`);
    const res = await api("/api/models/probe-host", {
      method: "POST",
      body: { host, port, type: port === 1234 ? "lmstudio" : (port === 8080 ? "llamacpp" : "ollama") }
    });
    toast(`Found ${res.type} on ${host}:${port} with ${res.models?.length || 0} models`);
    await api("/api/models/register-local", {
      method: "POST",
      body: { provider_id: res.type, name: res.name, base_url: res.base_url, models: res.models || [] }
    });
    loadModels();
  } catch (err) { toast(err.message, true); }
});

async function loadModels() {
  const pid = encodeURIComponent(S.pid || "global");
  const ul = $("#model-list");
  const seq = ++loadModels.seq || (loadModels.seq = 1);
  ul.innerHTML = `<li class="empty-state">Loading models…</li>`;
  try {
    const [d, f] = await Promise.all([
      api(`/api/models/${pid}`),
      api(`/api/favorites`),
    ]);
    if (seq !== loadModels.seq) return;
    M.favorites = f.favorites || [];
    M.source = d.source || "";
    M.all = [];
    M.providers = {};
    for (const p of d.providers || []) {
      M.providers[p.id] = { name: p.name || p.id, source: p.source || "" };
      for (const mid of Object.keys(p.models || {}))
        M.all.push({ p: p.id, m: mid, name: p.models[mid]?.name || mid, src: p.source || "" });
    }
    renderModels();
  } catch (e) {
    if (seq !== loadModels.seq) return;
    ul.innerHTML = `<li class="error-state">${esc(e.message)}</li>`;
    toast(e.message, true);
  }
}

/* Models are grouped by provider (= subscription: OpenCode Zen, OpenCode
   Go, …) with favorites pulled out into their own section on top. */
function renderModels() {
  const q = $("#model-search").value.trim().toLowerCase();
  const favKeys = new Set(M.favorites);
  const items = M.all.filter((x) =>
    !q || x.name.toLowerCase().includes(q) || x.p.toLowerCase().includes(q) ||
    x.m.toLowerCase().includes(q));

  const ul = $("#model-list");
  ul.innerHTML = "";
  if (!items.length) {
    ul.innerHTML = `<li class="empty-state">${q ? "No models match your filter." : "No models yet — add one above."}</li>`;
    return;
  }

  // group key: provider id; favorites get their own group on top
  const groups = new Map();
  for (const x of items) {
    const g = favKeys.has(`${x.p}/${x.m}`) ? "★ Favorites" : x.p;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(x);
  }
  // keep provider payload order, favorites always first
  const order = [...groups.keys()].sort((a, b) =>
    (a === "★ Favorites" ? -1 : b === "★ Favorites" ? 1 : 0));

  for (const g of order) {
    const list = groups.get(g);
    const head = document.createElement("li");
    head.className = "model-group-head";
    const meta = g === "★ Favorites" ? null : M.providers[g];
    const liveTag = meta && meta.source === "engine"
      ? ' <span class="grp-live">● live</span>' : "";
    head.innerHTML = `<span class="grp-name">${esc(g === "★ Favorites" ? g : (meta?.name || g))}</span>${liveTag}
      <span class="grp-count">${list.length}</span>`;
    ul.appendChild(head);

    for (const x of list) appendModelItem(ul, x, favKeys);
  }
}

function appendModelItem(ul, x, favKeys) {
  const key = `${x.p}/${x.m}`;
  const isFav = favKeys.has(key);
  const isDef = S.model && S.model.providerID === x.p && S.model.modelID === x.m;
  const li = document.createElement("li");
  const liveTag = x.src === "engine"
    ? ' <span class="grp-live">● live</span>' : "";
  li.innerHTML = `<div class="model-item"><strong>${esc(x.name)}${isFav ? '<span class="fav-tag">★</span>' : ""}</strong>
      <small>${esc(x.p)}${liveTag}</small></div>
    <div class="git-btns">
      ${isDef ? '<span class="badge-default">active</span>' : ""}
      <button class="fav-star ${isFav ? "on" : ""}" title="Favorite" aria-label="Toggle favorite ${esc(x.name)}" aria-pressed="${isFav}">${isFav ? "★" : "☆"}</button>
      <button class="ghost accent-sel" aria-label="Use model ${esc(x.name)}">use</button>
      <button class="ghost rm danger" aria-label="Remove model ${esc(x.name)}">✕</button>
    </div>`;
  li.querySelector(".accent-sel").onclick = () => {
    S.model = { providerID: x.p, modelID: x.m };
    localStorage.setItem("of.model", JSON.stringify(S.model));
    updateChatHeader(); renderModels();
    toast(`Model set: ${key}`);
  };
  const favBtn = li.querySelector(".fav-star");
  favBtn.onclick = () => withBusy(favBtn, async () => {
    const r = await api("/api/favorites", { method: "POST", body: { provider_id: x.p, model_id: x.m } });
    M.favorites = r.favorites || [];
    renderModels();
  });
  const rmBtn = li.querySelector(".rm");
  rmBtn.onclick = () => withBusy(rmBtn, async () => {
    if (!(await confirmDialog(`Remove ${x.p}/${x.m} from config?`, { okLabel: "Remove" }))) return;
    await api(`/api/models/${encodeURIComponent(S.pid || "global")}`,
      { method: "DELETE", body: { provider_id: x.p, model_id: x.m } });
    loadModels(); toast("Model removed");
  });
  ul.appendChild(li);
}

$("#model-search").addEventListener("input", renderModels);

onBusy("#btn-add-model", async () => {
  const provider_id = $("#m-provider").value.trim();
  const model_id = $("#m-model").value.trim();
  const base_url = $("#m-url") ? $("#m-url").value.trim() : "";
  const api_key = $("#m-key") ? $("#m-key").value.trim() : "";
  const display_name = $("#m-name").value.trim() || model_id;
  if (!provider_id || !model_id) return toast("Provider and model ids required", true);
  try {
    if (base_url) {
      await api("/api/models/register-local", {
        method: "POST",
        body: {
          provider_id,
          name: provider_id,
          base_url,
          models: [{ id: model_id, name: display_name }],
          api_key,
        },
      });
    } else {
      await api(`/api/models/${encodeURIComponent(S.pid || "global")}`, {
        method: "POST",
        body: {
          provider_id, model_id,
          options: display_name ? { name: display_name } : null,
          set_default: $("#m-default").checked,
        },
      });
    }
    ["#m-provider", "#m-url", "#m-model", "#m-name", "#m-key"].forEach((s) => {
      const el = $(s);
      if (el) el.value = "";
    });
    $("#m-default").checked = false;
    toast(`Model added: ${provider_id}/${model_id}`);
    loadModels();
  } catch (e) { toast(e.message, true); }
});

/* ---------------- files ---------------- */

/* Open file tabs: {pid, rel, name, content, dirty}. Tabs are bound to the project
   they were opened in — only the current project's tabs are shown, and saves go
   to the tab's own project (previously a stale tab could overwrite a file in a
   different project after switching). */
const FTABS = [];
let FACTIVE = null;
const projTabs = () => FTABS.filter((t) => t.pid === S.pid);

function syncEditorToProject() {
  if (!FACTIVE || FACTIVE.pid !== S.pid) FACTIVE = projTabs().slice(-1)[0] || null;
  S.filesPath = "";
  if (FACTIVE) showTab(FACTIVE);
  else { $("#editor-wrap").classList.add("hidden"); renderTabs(); }
  $("#file-list").innerHTML = "";
  $("#files-path").textContent = "/";
}

let filesSeq = 0;
async function loadFiles(path = "") {
  if (!S.pid) { toast("Open a project first", true); return; }
  const seq = ++filesSeq, pid = S.pid;
  const ul = $("#file-list");
  ul.innerHTML = `<li class="empty-state">Loading…</li>`;
  try {
    const d = await api(`/fs/${encodeURIComponent(pid)}/tree?path=${encodeURIComponent(path)}`);
    if (seq !== filesSeq || pid !== S.pid) return;
    S.filesPath = path;
    $("#files-path").textContent = "/" + path;
    ul.innerHTML = "";
    if (path) {
      const up = document.createElement("li");
      up.className = "file-entry"; up.textContent = "↑ ..";
      up.setAttribute("role", "button"); up.tabIndex = 0;
      up.onclick = () => loadFiles(window.OF.parentPath(path));
      ul.appendChild(up);
    }
    const entries = d.entries || [];
    if (!entries.length) ul.insertAdjacentHTML("beforeend", `<li class="empty-state">Empty folder</li>`);
    for (const e of entries) {
      const li = document.createElement("li");
      li.className = "file-entry";
      li.setAttribute("role", "button"); li.tabIndex = 0;
      li.innerHTML = `<span class="path-text">${e.dir ? "📁" : "📄"} ${esc(e.name)}</span>`;
      const child = window.OF.joinPath(path, e.name);
      li.onclick = () => (e.dir ? loadFiles(child) : openEditor(child, e.name));
      ul.appendChild(li);
    }
  } catch (e) {
    if (seq !== filesSeq) return;
    ul.innerHTML = `<li class="error-state">${esc(e.message)}</li>`;
    toast(e.message, true);
  }
}

$("#files-up").addEventListener("click", () =>
  loadFiles(window.OF.parentPath(S.filesPath)));

function renderTabs() {
  const box = $("#file-tabs");
  box.innerHTML = "";
  for (const t of projTabs()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ftab ghost" + (t === FACTIVE ? " on" : "");
    b.textContent = (t.dirty ? "● " : "") + t.name;
    b.setAttribute("aria-label", `Open ${t.rel}${t.dirty ? " (unsaved)" : ""}`);
    b.onclick = () => showTab(t);
    box.appendChild(b);
  }
}

function showTab(t) {
  FACTIVE = t;
  $("#editor-wrap").classList.remove("hidden");
  $("#editor-name").textContent = t.rel;
  $("#editor").value = t.content;
  renderTabs();
}

async function openEditor(rel, name) {
  try {
    const cached = FTABS.find((t) => t.rel === rel && t.pid === S.pid);
    if (cached) { showTab(cached); return; }
    const pid = S.pid;
    const d = await api(`/fs/${encodeURIComponent(pid)}/read?path=${encodeURIComponent(rel)}`);
    if (pid !== S.pid) return;
    const tab = { pid, rel, name: name || rel.split("/").pop(), content: d.content ?? "", dirty: false };
    FTABS.push(tab);
    showTab(tab);
  } catch (e) { toast(e.message, true); }
}

$("#editor").addEventListener("input", () => {
  if (FACTIVE) { FACTIVE.content = $("#editor").value; if (!FACTIVE.dirty) { FACTIVE.dirty = true; renderTabs(); } }
});
onBusy("#editor-save", async () => {
  const tab = FACTIVE;
  if (!tab) return;
  await api(`/fs/${encodeURIComponent(tab.pid)}/write`, {
    method: "POST", body: { path: tab.rel, content: tab.content },
  });
  tab.dirty = false; renderTabs(); toast("Saved");
});
onBusy("#editor-lsp", async () => {
  try {
    const status = await oc("/lsp");
    const list = status.filter((x) => x.status).map((x) =>
      `${x.name}: ${x.status}${x.progress ? " (" + x.progress + ")" : ""}`);
    toast(list.length ? list.join("\n") : "No LSP servers running");
  } catch (e) { toast(e.message, true); }
});

$("#editor-close").addEventListener("click", async () => {
  const tab = FACTIVE;
  if (tab && tab.dirty &&
      !(await confirmDialog(`"${tab.name}" has unsaved changes. Close and lose them?`, { okLabel: "Close anyway" }))) return;
  if (tab) {
    FTABS.splice(FTABS.indexOf(tab), 1);
    FACTIVE = projTabs().slice(-1)[0] || null;
  }
  if (FACTIVE) showTab(FACTIVE); else $("#editor-wrap").classList.add("hidden");
  renderTabs();
});

/* project-wide text search via opencode /find */
let searchTimer = null;
$("#proj-search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2 || !S.pid) { $("#proj-search-results").classList.add("hidden"); return; }
  searchTimer = setTimeout(async () => {
    try {
      const res = await oc(`/find?pattern=${encodeURIComponent(q)}`);
      const ul = $("#proj-search-results");
      ul.classList.remove("hidden");
      const hits = Array.isArray(res) ? res : [];
      ul.innerHTML = hits.length ? "" : `<li class="empty-state">No matches</li>`;
      for (const m of hits.slice(0, 30)) {
        const line = (typeof m.lines === "string" ? m.lines : (m.lines?.text || "")).trim().slice(0, 80);
        ul.insertAdjacentHTML("beforeend",
          `<li class="file-entry" role="button" tabindex="0"><div class="li-main"><strong>${esc(m.path)}</strong>
             <small class="li-sub">:${esc(m.line_number)} ${esc(line)}</small></div></li>`);
        ul.lastChild.onclick = () => { openEditor(m.path); $("#proj-search-results").classList.add("hidden"); };
      }
    } catch (err) { toast(err.message, true); }
  }, 400);
});

/* in-file search: highlight occurrences in the open editor */
$("#file-search").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  const ta = $("#editor");
  if (!q) { ta.style.background = ""; return; }
  const hay = ta.value.toLowerCase();
  if (hay.includes(q)) {
    const i = hay.indexOf(q);
    ta.focus();
    ta.setSelectionRange(i, i + q.length);
    ta.style.background = "rgba(255,180,84,.12)";
  }
});

/* ---------------- health ---------------- */

function setConn(on) {
  const d = $("#conn-dot");
  d.className = `dot ${on ? "on" : "off"}`;
  d.setAttribute("aria-label", on ? "Connected to daemon" : "Disconnected from daemon");
}

setInterval(async () => {
  if (document.hidden) return;   // don't burn battery when backgrounded
  try { await api("/api/health"); setConn(true); } catch { setConn(false); }
}, 10000);

/* ---------------- boot ---------------- */

// Tap on the dim backdrop of any overlay closes it (replaces inline onclick).
$$(".overlay-dismiss").forEach((ov) =>
  ov.addEventListener("click", (e) => {
    if (e.target === ov) ov.classList.add("hidden");
  })
);
$("#action-close")?.addEventListener("click", () =>
  $("#action-overlay").classList.add("hidden"));

/* Copy buttons on rendered code blocks (event delegation: survives re-renders). */
$("#chat-messages").addEventListener("click", async (e) => {
  const btn = e.target.closest(".cb-copy");
  if (!btn) return;
  const code = btn.closest(".codeblock")?.querySelector("code");
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code.textContent);
    btn.textContent = "Copied ✓";
  } catch {
    const r = document.createRange(); r.selectNodeContents(code);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    btn.textContent = "Selected";
  }
  setTimeout(() => { btn.textContent = "Copy"; }, 1500);
});

/* Composer: auto-grow, and keep it above the virtual keyboard. */
const chatInput = $("#chat-input");
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
});
if (window.visualViewport) {
  const vv = window.visualViewport;
  const fit = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty("--kb", kb + "px");
    document.documentElement.style.setProperty("--vvh", vv.height + "px");
    document.body.classList.toggle("kb-open", kb > 120);
    if (kb > 120 && document.activeElement === chatInput) {
      const sc = chatScroll(); if (sc) sc.scrollTop = sc.scrollHeight;
    }
  };
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
}

/* Surface any stray async failure instead of silently swallowing it. */
window.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  const m = e.reason && e.reason.message;
  if (m) toast(m, true);
});

/* ---------------- Android back button ----------------
   MainActivity calls window.OpenForgeBack() and treats `true` as "consumed".
   Synchronous. Priority: confirm dialog → sheets/terminal → diff/editor → tab history. */
const NAV_HISTORY = ["chat"];
function currentView() { return $$("#bottom-nav button.active")[0]?.dataset.view || "chat"; }
$$("#bottom-nav button").forEach((b) => b.addEventListener("click", () => {
  const v = b.dataset.view;
  if (NAV_HISTORY[NAV_HISTORY.length - 1] !== v) {
    const i = NAV_HISTORY.indexOf(v);
    if (i >= 0) NAV_HISTORY.splice(i, 1);
    NAV_HISTORY.push(v);
    if (NAV_HISTORY.length > 12) NAV_HISTORY.shift();
  }
}));
const isOpen = (sel) => { const el = $(sel); return el && !el.classList.contains("hidden"); };

window.OpenForgeBack = function () {
  try {
    if (isOpen("#confirm-overlay")) { $("#confirm-cancel").click(); return true; }
    if (isOpen("#prompt-overlay")) { $("#prompt-cancel").click(); return true; }
    for (const sel of ["#action-overlay", "#session-overlay", "#browser-overlay", "#term-overlay"]) {
      if (isOpen(sel)) { $(sel).classList.add("hidden"); return true; }
    }
    if (currentView() === "git" && $("#git-diff").classList.contains("active")) {
      $$('.subtab[data-subtab="changes"]')[0].click();
      return true;
    }
    if (currentView() === "files" && isOpen("#editor-wrap")) {
      $("#editor-close").click();
      return true;
    }
    if (isOpen("#proj-search-results")) { $("#proj-search-results").classList.add("hidden"); return true; }
    if (NAV_HISTORY.length > 1) {
      NAV_HISTORY.pop();
      const prev = NAV_HISTORY[NAV_HISTORY.length - 1];
      $$('#bottom-nav button[data-view="' + prev + '"]')[0]?.click();
      // the click handler re-pushes; undo that so history keeps shrinking
      while (NAV_HISTORY.length > 1 && NAV_HISTORY[NAV_HISTORY.length - 1] === prev && NAV_HISTORY[NAV_HISTORY.length - 2] === prev) NAV_HISTORY.pop();
      return true;
    }
  } catch {}
  return false;
};

/* Escape closes the topmost sheet (hardware keyboards / desktop). */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !isOpen("#confirm-overlay") && !isOpen("#prompt-overlay")) window.OpenForgeBack();
  // Keyboard activation for role=button list rows.
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.('li[role="button"], div[role="button"], span[role="button"]')) {
    e.preventDefault(); e.target.click();
  }
});

(async function boot() {
  applySettings();
  initSettings();
  loadModels().catch(() => {});
  loadAuthStatus();
  try { await loadProjects(); }
  catch (e) {
    setConn(false);
    $("#project-list").innerHTML = `<li class="error-state">${esc(e.message)}</li>`;
    pushMsg("system error", `<span class="role">offline</span>${esc(e.message)}<br>Check <b>Settings → Connection</b>.`);
    toast(e.message, true);
    return;
  }
  if (S.pid) { ensureSession(); }
  else pushMsg("system", "Welcome to OpenForge 👋\nGo to **Projects** to create your first project.");
})();
