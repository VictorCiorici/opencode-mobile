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
  if (S.url && S.url.startsWith("http")) return S.url;
  // If served from local file asset or webview domain, route to localhost:8787
  if (location.protocol === "file:" || location.hostname === "appassets.androidplatform.net" || !location.port) {
    return "http://127.0.0.1:8787";
  }
  return "";
}

async function api(path, opts = {}) {
  const base = getApiBase();
  const { headers: extraHeaders = {}, body, ...rest } = opts;
  const headers = { "Content-Type": "application/json", ...extraHeaders };
  const tok = bridgeToken();
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  const r = await fetch(base + path, {
    ...rest,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = r.headers.get("content-type") || "";
  if (!r.ok) {
    let msg = `${r.status}`;
    if (ct.includes("json")) {
      try { const j = await r.json(); msg = j.detail || j.error || msg; } catch {}
    }
    throw new Error(msg);
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
  t.textContent = msg;
  t.className = err ? "err show" : "show";
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), ms);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------- syntax highlighting ---------------- */

const KW = {
  js: "const|let|var|function|return|if|else|for|while|class|new|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|switch|case|break|continue|null|undefined|true|false|this|extends|super",
  ts: "const|let|var|function|return|if|else|for|while|class|new|import|from|export|default|async|await|interface|type|enum|implements|public|private|readonly|try|catch|throw|null|undefined|true|false|this|string|number|boolean|any",
  py: "def|return|if|elif|else|for|while|import|from|as|class|try|except|raise|with|lambda|None|True|False|and|or|not|in|is|pass|yield|async|await|global|assert|del|self",
  sh: "echo|cd|ls|cat|grep|sed|awk|curl|wget|git|sudo|apt|pip|npm|export|source|if|then|fi|for|do|done|while|case|esac|function|return|local|set",
  sql: "SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|DROP|ALTER|JOIN|LEFT|RIGHT|INNER|ON|GROUP|ORDER|BY|LIMIT|AND|OR|NOT|NULL|AS|DISTINCT",
  go: "func|package|import|var|const|type|struct|interface|go|defer|chan|select|range|map|nil|true|false|if|else|for|return|switch|case|break",
  rust: "fn|let|mut|const|struct|enum|impl|trait|pub|use|mod|match|if|else|loop|while|for|in|return|Some|None|Ok|Err|self|Self|where|dyn|move",
};

function langKey(lang) {
  const l = (lang || "").toLowerCase();
  if (["py", "python"].includes(l)) return "py";
  if (["js", "javascript", "jsx", "mjs", "node"].includes(l)) return "js";
  if (["ts", "typescript", "tsx"].includes(l)) return "ts";
  if (["sh", "bash", "shell", "zsh", "console", "terminal"].includes(l)) return "sh";
  if (l === "sql") return "sql";
  if (l === "go") return "go";
  if (l === "rust" || l === "rs") return "rust";
  return null;
}

function hl(src, lang) {
  const key = langKey(lang);
  const kwSet = new Set(key ? KW[key].split("|") : []);
  const re =
    /(\/\/[^\n]*|#[^\n]*|--[^\n]*)|(\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)|([\s\S])/g;
  let out = "", m;
  while ((m = re.exec(src))) {
    const [tok, lineC, blockC, str, num, word] = m;
    let cls = "";
    if (lineC) {
      if (tok.startsWith("#") && !["py", "sh", null, undefined].includes(key)) { out += esc(tok); continue; }
      cls = "c";
    }
    else if (blockC) cls = "c";
    else if (num) cls = "n";
    else if (word) cls = kwSet.has(word) || (key === "sql" && kwSet.has(word.toUpperCase())) ? "k" : "";
    out += cls ? `<span class="tk-${cls}">${esc(tok)}</span>` : esc(tok);
  }
  return out;
}

/* markdown: fenced code w/ highlighting, inline code, bold */
function md(text) {
  let out = esc(text || "");
  out = out.replace(/```(\w*)\n?([\s\S]*?)```/g,
    (_, lang, code) => `<pre><code>${hl(code.replace(/\n$/, ""), lang)}</code></pre>`);
  out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  return out;
}

/* ---------------- navigation ---------------- */

$$("#bottom-nav button").forEach((b) =>
  b.addEventListener("click", () => {
    $$("#bottom-nav button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    $$(".view").forEach((v) => v.classList.remove("active"));
    $(`#view-${b.dataset.view}`).classList.add("active");
    if (b.dataset.view === "git") loadGit();
    if (b.dataset.view === "models") loadModels();
    if (b.dataset.view === "files") loadFiles(S.filesPath);
  })
);

/* ---------------- projects ---------------- */

async function loadProjects(keep = true) {
  const d = await api("/api/projects");
  S.projects = d.projects;
  const sel = $("#project-select");
  sel.innerHTML =
    `<option value="">– select project –</option>` +
    S.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  if (!S.projects.find((p) => p.id === S.pid)) { S.sid = null; S.pid = keep ? S.pid : null; }
  if (S.pid) sel.value = S.pid;
  renderProjectList();
  updateChatHeader();
}

$("#project-select").addEventListener("change", async (e) => {
  S.pid = e.target.value || null;
  S.sid = null;
  localStorage.setItem("of.pid", S.pid || "");
  renderProjectList();
  await ensureSession();
  loadModels().catch(() => {});
});

$("#btn-create-project").addEventListener("click", async () => {
  const name = $("#new-project-name").value.trim();
  if (!name) return toast("Enter a project name", true);
  const branch = $("#new-project-branch").value.trim() || "main";
  try {
    const p = await api("/api/projects", { method: "POST", body: { name, branch } });
    $("#new-project-name").value = "";
    $("#new-project-branch").value = "";
    await loadProjects(false);
    S.pid = p.id;
    localStorage.setItem("of.pid", p.id);
    $("#project-select").value = p.id;
    renderProjectList();
    toast(`Project “${p.name}” created`);
  } catch (e) { toast(e.message, true); }
});

function renderProjectList() {
  const ul = $("#project-list");
  ul.innerHTML = S.projects.length
    ? ""
    : `<li>No projects yet — create one above.</li>`;
  for (const p of S.projects) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div><strong>${esc(p.name)}</strong>
        <small style="display:block;color:var(--muted);font-size:12px">${esc(p.path)}</small></div>
      <div class="git-btns">
        <button class="ghost primary-text">Open</button>
        <button class="ghost">✕</button>
      </div>`;
    const [openBtn, delBtn] = li.querySelectorAll("button");
    openBtn.onclick = () => {
      S.pid = p.id; S.sid = null;
      localStorage.setItem("of.pid", p.id);
      $("#project-select").value = p.id;
      renderProjectList();
      ensureSession();
      toast(`Opened ${p.name}`);
    };
    delBtn.onclick = async () => {
      if (!confirm(`Remove project "${p.name}" from OpenForge? (files are kept)`)) return;
      await api(`/api/projects/${p.id}`, { method: "DELETE" });
      if (S.pid === p.id) { S.pid = null; S.sid = null; }
      loadProjects();
    };
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
      ul.innerHTML = `<li style="color:var(--muted);padding:8px">No subfolders here</li>`;
    }
    if (res.parent) {
      const up = document.createElement("li");
      up.className = "file-entry";
      up.style.cursor = "pointer";
      up.innerHTML = `<div style="padding:4px 0"><strong>↩ ..</strong></div>`;
      up.onclick = () => loadBrowseDir(res.parent);
      ul.appendChild(up);
    }
    for (const e of entries) {
      const li = document.createElement("li");
      li.className = "file-entry";
      li.style.cursor = "pointer";
      li.innerHTML = `<div style="padding:4px 0"><strong>📁 ${esc(e.name)}</strong></div>`;
      li.onclick = () => loadBrowseDir(e.path || `${BROWSE_PATH}/${e.name}`.replace(/\/+/, "/"));
      ul.appendChild(li);
    }
  } catch (err) {
    ul.innerHTML = `<li style="color:var(--err);padding:8px">${esc(err.message)}</li>`;
  }
}

$("#btn-import-project").addEventListener("click", () => {
  openFolderBrowser();
});

$("#browser-close").addEventListener("click", () => {
  $("#browser-overlay").classList.add("hidden");
});

$("#browser-select").addEventListener("click", async () => {
  if (!BROWSE_PATH) return;
  try {
    const p = await api("/api/projects/import", {
      method: "POST",
      body: { path: BROWSE_PATH }
    });
    $("#browser-overlay").classList.add("hidden");
    await loadProjects(false);
    S.pid = p.id;
    localStorage.setItem("of.pid", p.id);
    $("#project-select").value = p.id;
    renderProjectList();
    toast(`Imported “${p.name}”`);
    ensureSession();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------------- chat ---------------- */

async function ensureSession() {
  if (!S.pid) return;
  try {
    S.sessions = await oc("/session");
    if (!S.sessions.find((s) => s.id === S.sid)) {
      S.sid = S.sessions[0]?.id || null;
    }
    if (!S.sid) {
      const s = await oc("/session", { method: "POST", body: {} });
      S.sid = s.id;
    }
    await renderChat(true);
    updateChatHeader();
    initSSE();
  } catch (e) { setConn(false); toast(e.message, true); }
}

$("#btn-new-session").addEventListener("click", async () => {
  if (!S.pid) return toast("Select a project first", true);
  try {
    const s = await oc("/session", { method: "POST", body: {} });
    S.sid = s.id;
    renderChat(true);
    toast("New session");
  } catch (e) { toast(e.message, true); }
});

$("#btn-sessions").addEventListener("click", () => openSessionSheet());

/* ---------------- session manager ---------------- */

async function openSessionSheet() {
  if (!S.pid) { toast("Open a project first", true); return; }
  $("#session-overlay").classList.remove("hidden");
  await loadSessions();
}

async function loadSessions() {
  try {
    S.sessions = await oc("/session");
    const ul = $("#session-list");
    ul.innerHTML = "";
    for (const ssn of S.sessions) {
      const cur = ssn.id === S.sid;
      const li = document.createElement("li");
      li.className = `session-card ${cur ? "cur" : ""}`;
      li.innerHTML = `
        <div class="session-info">
          <div class="session-title-row">
            <strong class="session-name" style="${cur ? "color:var(--accent)" : ""}">${esc(ssn.title || "Untitled")}</strong>
            ${cur ? '<span class="session-badge">Active</span>' : ""}
          </div>
          <small class="session-meta">${esc(ssn.id)} · ${esc((ssn.tokens?.input||0)+(ssn.tokens?.output||0))} tok</small>
        </div>
        <div class="session-actions">
          <button data-a="open" class="${cur ? "primary" : "ghost"}">${cur ? "✓ Active" : "Open"}</button>
          <button data-a="rename" class="ghost">✎ Rename</button>
          <button data-a="fork" class="ghost">⑂ Fork</button>
          <button data-a="share" class="ghost">🔗 Share</button>
          <button data-a="del" class="ghost danger">🗑</button>
        </div>`;
      li.querySelectorAll("button").forEach((b) =>
        b.addEventListener("click", async () => {
          const a = b.dataset.a;
          try {
            if (a === "open") { S.sid = ssn.id; await renderChat(true); $("#session-overlay").classList.add("hidden"); toast("Session opened"); }
            else if (a === "rename") {
              const t = prompt("Rename session:", ssn.title || "");
              if (!t) return;
              await oc(`/session/${ssn.id}`, { method: "PATCH", body: { title: t } });
              loadSessions();
            } else if (a === "fork") {
              const r = await oc(`/session/${ssn.id}/fork`, { method: "POST", body: {} });
              S.sid = r.id; await loadSessions(); toast("Forked");
            } else if (a === "share") {
              const r = await oc(`/session/${ssn.id}/share`, { method: "POST", body: {} });
              await navigator.clipboard.writeText(r.shareUrl || r.id).catch(() => {});
              toast("Share link copied");
            } else if (a === "del") {
              if (!confirm("Delete this session?")) return;
              await oc(`/session/${ssn.id}`, { method: "DELETE" });
              if (S.sid === ssn.id) S.sid = null;
              loadSessions(); toast("Deleted");
            }
          } catch (e) { toast(e.message, true); }
        }));
      ul.appendChild(li);
    }
  } catch (e) { toast(e.message, true); }
}

async function loadTodos() {
  if (!S.sid) { toast("Open a session first", true); return; }
  try {
    const todos = await oc(`/session/${S.sid}/todo`);
    const ul = $("#session-list");
    ul.innerHTML = `<li style="color:var(--muted);font-size:12px">Todos for current session</li>`;
    if (!todos.length) ul.insertAdjacentHTML("beforeend", `<li>No todos yet</li>`);
    for (const t of todos) {
      const mark = t.status === "completed" ? "✅" :
                   t.status === "in-progress" ? "🔄" : "⬜";
      ul.insertAdjacentHTML("beforeend",
        `<li>${mark} ${esc(t.content || t.title || "")}</li>`);
    }
  } catch (e) { toast(e.message, true); }
}

$("#session-close").addEventListener("click", () => $("#session-overlay").classList.add("hidden"));
$("#session-refresh").addEventListener("click", loadSessions);
$("#session-new").addEventListener("click", async () => {
  try {
    const s = await oc("/session", { method: "POST", body: {} });
    S.sid = s.id; await renderChat(true); await loadSessions(); toast("New session");
  } catch (e) { toast(e.message, true); }
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
      if (!confirm("Revert conversation back to this turn? Future turns will be undone.")) return;
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
      const msgEl = document.querySelector(`[data-mid="${mid}"]`);
      if (msgEl) {
        await navigator.clipboard.writeText(msgEl.innerText).catch(() => {});
        toast("Copied to clipboard");
      }
    } }
  ]);
}

function renderDiffLines(text) {
  return (text || "").split("\n").map((l) => {
    const e = esc(l);
    if (l.startsWith("@@")) return `<span class="dl dl-hunk">${e}</span>`;
    if (l.startsWith("+")) return `<span class="dl dl-add">${e}</span>`;
    if (l.startsWith("-")) return `<span class="dl dl-del">${e}</span>`;
    return `<span class="dl dl-ctx">${e}</span>`;
  }).join("\n");
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
    const isDiff = outStr.includes("@@") && (outStr.includes("\n+") || outStr.includes("\n-"));
    const bodyContent = isDiff ? renderDiffLines(outStr) : esc(outStr || inStr || "(no output)");
    return `<details class="tool-call${isRunning ? " running" : ""}">
      <summary><span>🔧 ${esc(title)}</span> <small style="color:var(--muted)">${esc(badge)}</small></summary>
      <div class="tool-body">${bodyContent}</div>
    </details>`;
  }
  return "";
}

function fmtTok(n) {
  if (n == null) return "–";
  if (n >= 1_000_000) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
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
    if (full) pushMsg("system", "Create or select a project to start chatting.");
    return;
  }
  try {
    checkPermissions();
    const msgs = await oc(`/session/${S.sid}/message?limit=50`);
    if (full) {
      // oldest first so new messages appear at the bottom
      msgs.sort((a, b) =>
        (a.info?.time?.created || 0) - (b.info?.time?.created || 0));
      $("#chat-messages").innerHTML = "";
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
          html || `<span style="color:var(--muted)">(empty response)</span>`, m.info?.id);
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

    let warned = false, painted = false;
    for (;;) {
      await new Promise((r) => setTimeout(r, 800));
      // User switched project/session mid-generation: stop driving a dead context.
      if (S.genSeq !== gen || S.pid !== genPid || S.sid !== genSid) return;
      elapsedEl.textContent = `(${Math.round((Date.now() - t0) / 1000)}s)`;
      let last = null;
      try { last = (await chatBody())[0]; } catch {}
      const isNew = last && baseId && last.info?.id !== baseId;

      if (isNew && last.info?.role === "assistant") {
        paint(last); painted = true;
      }
      const done = isNew && last.info?.role === "assistant" &&
        (last.info?.time?.completed || last.info?.error);
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
        btn.className = "ghost"; btn.style.marginTop = "8px";
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
    btn.className = "ghost"; btn.style.marginTop = "8px";
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
  b.classList.toggle("stop", S.busy);
}

async function stopGeneration() {
  S.abortReq = true;
  try {
    await oc(`/session/${S.sid}/abort`, { method: "POST" });
    toast("Generation stopped");
  } catch (e) { toast(e.message, true); }
}

/* model quick-pick: tap the model label to jump to models tab */
$(".sb-right").addEventListener("click", () =>
  $$('#bottom-nav button[data-view="models"]')[0].click()
);

/* ---------------- settings & connection profiles ---------------- */

if ("serviceWorker" in navigator) {
  // Relative so it works both under the daemon (/ui/) and any mirrored origin.
  navigator.serviceWorker.register("sw.js").then((reg) => reg.update()).catch(() => {});
}

let sseSource = null;
function initSSE() {
  if (sseSource) { sseSource.close(); sseSource = null; }
  if (!S.pid) return;
  try {
    const base = getApiBase();
    let url = `${base}/oc/${S.pid}/event`;
    const tok = bridgeToken();
    // EventSource cannot send headers; daemons accept ?token= too.
    if (tok) url += `?token=${encodeURIComponent(tok)}`;
    sseSource = new EventSource(url);
    sseSource.onopen = () => setConn(true);
    sseSource.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === "permission" || data.type === "permission.asked") {
          checkPermissions();
        }
        if (data.sessionID === S.sid || data.sessionId === S.sid) {
          if (data.type === "message.updated" || data.type === "session.updated") {
            if (!S.busy) renderChat(false);
          }
        }
      } catch {}
    };
    // Deliberately do not close on error: EventSource retries automatically
    // (our daemon emits "retry: 4000"), so the connection self-heals.
    sseSource.onerror = () => setConn(false);
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

  $("#btn-save-profile")?.addEventListener("click", () => {
    const url = $("#set-url").value.trim().replace(/\/$/, "");
    const name = prompt("Profile name (e.g. Home Server, VPS):", url ? url.replace(/https?:\/\//, "") : "Local");
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
    initSSE();
  });

  // Auth Status & API Key Management
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
        zenTag.textContent = st.opencode?.configured ? `configured (${st.opencode.preview})` : "not set";
        zenTag.style.background = st.opencode?.configured ? "var(--ok)" : "var(--muted)";
        zenTag.style.color = st.opencode?.configured ? "#04291a" : "#fff";
      }

      const goStatusTag = $("#status-go-tag");
      if (goStatusTag) {
        const cfg = st["opencode-go"]?.configured;
        goStatusTag.textContent = cfg ? `configured (${st["opencode-go"].preview})` : "not set";
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

  $("#btn-save-opencode-key")?.addEventListener("click", async () => {
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

  $("#btn-save-opencodego-key")?.addEventListener("click", async () => {
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

  $("#btn-save-gemini-key")?.addEventListener("click", async () => {
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

  $("#btn-save-github-token")?.addEventListener("click", async () => {
    const token = $("#key-github").value.trim();
    if (!token) return toast("Enter a GitHub token", true);
    try {
      await api("/api/auth/token", { method: "POST", body: { provider_id: "github", token } });
      $("#key-github").value = "";
      toast("GitHub Personal Access Token saved ✓");
      loadAuthStatus();
    } catch (e) { toast(e.message, true); }
  });

  $("#btn-save-git-identity")?.addEventListener("click", async () => {
    const name = $("#git-user-name").value.trim();
    const email = $("#git-user-email").value.trim();
    if (!name && !email) return toast("Enter a name or email", true);
    try {
      await api("/api/git/config", { method: "POST", body: { name, email } });
      toast("Git author details saved ✓");
      loadAuthStatus();
    } catch (e) { toast(e.message, true); }
  });

  $("#btn-save-custom-key")?.addEventListener("click", async () => {
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

  $("#btn-clone-project")?.addEventListener("click", async () => {
    const url = $("#clone-project-url").value.trim();
    if (!url) return toast("Enter a Git repository URL", true);
    const branch = $("#clone-project-branch").value.trim();
    const btn = $("#btn-clone-project");
    btn.disabled = true;
    btn.textContent = "Cloning repository…";
    try {
      const p = await api("/api/projects/clone", {
        method: "POST",
        body: { url, branch }
      });
      $("#clone-project-url").value = "";
      $("#clone-project-branch").value = "";
      await loadProjects(false);
      S.pid = p.id;
      localStorage.setItem("of.pid", p.id);
      $("#project-select").value = p.id;
      renderProjectList();
      toast(`Cloned “${p.name}” ✓`);
      ensureSession();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Clone & Open";
    }
  });

  // Default Workspace Directory Management
  api("/api/settings/workspace").then((w) => {
    if ($("#set-workspace-dir") && w.workspace_dir) {
      $("#set-workspace-dir").value = w.workspace_dir;
    }
  }).catch(() => {});

  $("#btn-save-workspace")?.addEventListener("click", async () => {
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
  $("#btn-clear-prefs").addEventListener("click", () => {
    Object.keys(localStorage)
      .filter((k) => k.startsWith("of."))
      .forEach((k) => localStorage.removeItem(k));
    toast("Preferences cleared — reloading");
    setTimeout(() => location.reload(), 800);
  });
  api("/api/health").then((h) => {
    $("#about-box").innerHTML =
      `OpenForge v0.3 · bridge <b>${h.bridge}</b><br>` +
      `opencode ${esc(h.opencode?.version || "?")} — ` +
      `${h.opencode?.healthy ? "healthy ✓" : "<span style='color:var(--err)'>offline</span>"}`;
  }).catch(() => { $("#about-box").textContent = "Bridge unreachable"; });
}

/* ---------------- unrevert & terminal drawer ---------------- */

$("#btn-unrevert")?.addEventListener("click", async () => {
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
  $("#term-input").focus();
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
  outBox.textContent += `$ ${cmd}\n`;
  outBox.scrollTop = outBox.scrollHeight;
  try {
    const res = await api(`/api/terminal/${S.pid}/exec`, { method: "POST", body: { command: cmd } });
    if (res.stdout) outBox.textContent += res.stdout;
    if (res.stderr) outBox.textContent += `[stderr] ${res.stderr}\n`;
    outBox.textContent += `(exit: ${res.code})\n\n`;
  } catch (err) {
    outBox.textContent += `Error: ${err.message}\n\n`;
  }
  outBox.scrollTop = outBox.scrollHeight;
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
    b.style.marginBottom = "8px";
    b.textContent = a.label;
    b.onclick = () => { $("#action-overlay").classList.add("hidden"); a.fn(); };
    box.appendChild(b);
  }
  $("#action-overlay").classList.remove("hidden");
}

async function loadGit() {
  if (!S.pid) { toast("Open a project first", true); return; }
  try {
    G.status = await git("status");
    $("#git-branch").textContent = G.status.branch || (G.status.is_git ? "(empty repo)" : "not a git repo");
    renderGitFiles();
    if (G.status.is_git) {
      api(`/git/${S.pid}/graph?limit=1`)
        .then((d) => {
          const rem = d.remotes || [];
          $("#git-remotes").innerHTML =
            rem.length ? rem.map((r) => `⇅ ${esc(r.name)} → ${esc(r.fetch || "")}`).join("<br>") : "";
        }).catch(() => {});
    } else {
      $("#git-remotes").innerHTML = "";
    }
  } catch (e) {
    G.status = { is_git: false, staged: [], unstaged: [], untracked: [], conflicts: [] };
    renderGitFiles();
    toast(e.message, true);
  }
}

function fileBadge(f) {
  if (f.x === "?" ) return `<span class="st-badge st-question">new</span>`;
  const c = f.x !== " " ? f.x : f.y;
  return `<span class="st-badge st-${esc(c)}">${esc(c)}</span>`;
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
    ul.innerHTML = `<li style="flex-direction:column;align-items:stretch;gap:12px;text-align:center;padding:20px 14px">
      <div style="font-weight:700;font-size:15px">📁 Not a Git repository</div>
      <div style="color:var(--muted);font-size:13px">This project folder does not have Git initialized yet.</div>
      <button id="btn-init-git-now" class="primary full" style="margin-top:6px">Initialize Git Repository (git init)</button>
    </li>`;
    const b = $("#btn-init-git-now");
    if (b) {
      b.onclick = async () => {
        try {
          await api(`/git/${S.pid}/init`, { method: "POST" });
          toast("Git repository initialized ✓");
          loadGit();
        } catch (err) { toast(err.message, true); }
      };
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
          <button data-choice="ours" class="ghost" style="padding:4px 8px;font-size:11px">Ours</button>
          <button data-choice="theirs" class="ghost" style="padding:4px 8px;font-size:11px">Theirs</button>
          <button data-choice="edit" class="ghost" style="padding:4px 8px;font-size:11px">Edit</button>
        </div>`;
      row.querySelectorAll("button").forEach((b) => {
        b.onclick = async () => {
          const choice = b.dataset.choice;
          if (choice === "edit") {
            $$('#bottom-nav button[data-view="files"]')[0].click();
            openEditor(c.path);
          } else {
            try {
              const r = await api(`/git/${S.pid}/resolve`, { method: "POST", body: { path: c.path, choice } });
              toast(r.out || "Conflict resolved");
              loadGit();
            } catch (err) { toast(err.message, true); }
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
    ul.innerHTML = `<li>Working tree clean ✓</li>`;
    return;
  }
  for (const f of files) {
    const li = document.createElement("li");
    li.className = "git-file";
    li.innerHTML = `<span style="word-break:break-all">${fileBadge(f)} ${esc(f.path)}</span>
      <span class="muted-small">${f.area}</span>`;
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
      { label: "🗑 Discard changes", danger: true, fn: async () => {
          if (!confirm(`Discard all changes in ${f.path}? This cannot be undone.`)) return;
          try { await git("discard", { method: "POST", body: { ref: f.path } });
                loadGit(); toast("Discarded"); }
          catch (e) { toast(e.message, true); }
        } },
    ]);
    ul.appendChild(li);
  }
}

$("#btn-commit").addEventListener("click", async () => {
  const msg = $("#commit-msg").value.trim();
  if (!msg) return toast("Enter a commit message", true);
  try {
    if (!G.status.staged.length &&
        !confirm("No staged files — stage ALL changes and commit?")) return;
    await git("commit", { method: "POST", body: { message: msg } });
    $("#commit-msg").value = "";
    toast("Committed ✓");
    loadGit();
  } catch (e) { toast(e.message, true); }
});

/* ---------- graph + branches ---------- */

async function loadGitGraph() {
  if (!S.pid) return;
  try {
    const d = await git("graph");
    const chips = $("#branch-chips");
    chips.innerHTML = "";
    for (const name of d.branches.all) {
      const c = document.createElement("span");
      c.className = "chip" + (name === d.branches.current ? " cur" : "");
      c.textContent = name;
      c.onclick = () => branchActions(name, name === d.branches.current);
      chips.appendChild(c);
    }
    $("#git-remotes").innerHTML = (d.remotes || [])
      .map((r) => `⇅ ${esc(r.name)} → ${esc(r.fetch || "")}`).join("<br>") || "";
    renderCommitGraph(d.commits || []);
  } catch (e) { toast(e.message, true); }
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
    lanes[li] = c.parents[0] || null;
    for (const p of c.parents.slice(1)) {
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
         <div class="g-meta">${c.short} · ${esc(c.author)} · ${esc(c.date)}</div></div>`;
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
        if (!confirm("Checkout detached HEAD at " + c.short + "?")) return;
        try { await git("checkout", { method: "POST", body: { ref: c.hash } });
              toast("Checked out " + c.short); loadGit(); }
        catch (e) { toast(e.message, true); }
      } },
    { label: "⑂ Create branch here", fn: () => {
        const name = prompt("Branch name:");
        if (!name) return;
        git("branch/create", { method: "POST", body: { name } })
          .then(() => { toast(`Branch "${name}" created`); loadGitGraph(); })
          .catch((e) => toast(e.message, true));
      } },
    { label: "↩ Revert this commit", danger: true, fn: async () => {
        if (!confirm(`Revert ${c.short}? A new inverse commit will be created.`)) return;
        try { const r = await git("revert", { method: "POST", body: { ref: c.hash } });
              toast(r.out || "Reverted"); loadGit(); loadGitGraph(); }
        catch (e) { toast(e.message, true); }
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
      try { const r = await git("merge", { method: "POST", body: { ref: name } });
            toast(r.out || "Merged"); loadGit(); loadGitGraph(); }
      catch (e) { toast(e.message, true); }
    }});
  } else {
    acts.push({ label: "✏ Rename branch", primary: true, fn: () => {
      const nn = prompt(`Rename "${name}" to:`);
      if (!nn) return;
      git("branch/rename", { method: "POST", body: { old: name, new: nn } })
        .then(() => { toast("Renamed"); loadGit(); loadGitGraph(); })
        .catch((e) => toast(e.message, true));
    }});
  }
  acts.push({ label: "🗑 Delete branch", danger: true, fn: async () => {
    if (!confirm(`Delete branch "${name}"?`)) return;
    try { await git("branch/delete", { method: "POST", body: { name, force: false } });
          toast("Deleted"); loadGitGraph(); loadGit(); }
    catch (e) {
      if (confirm(e.message + "\n\nForce delete?")) {
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
  S.activeView = $$('#bottom-nav button.active')[0].dataset.view;
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

async function refreshDiff() {
  let text;
  if (G.diffFile) {
    const d = await api(`/git/${S.pid}/diff/file?path=${encodeURIComponent(G.diffFile)}&staged=${G.diffStaged}`);
    text = d.diff;
  } else {
    const d = await git("diff");
    text = d.diff;
  }
  renderDiff(text || "(no diff)");
}

function renderDiff(text) {
  $("#git-diff-view").innerHTML = text.split("\n").map((l) => {
    const e = esc(l);
    if (l.startsWith("@@")) return `<span class="dl dl-hunk">${e}</span>`;
    if (l.startsWith("+")) return `<span class="dl dl-add">${e}</span>`;
    if (l.startsWith("-")) return `<span class="dl dl-del">${e}</span>`;
    return `<span class="dl dl-ctx">${e}</span>`;
  }).join("\n");
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

/* ---------- stashes ---------- */

async function loadStashes() {
  if (!S.pid) return;
  const ul = $("#stash-list");
  try {
    const d = await git("stash");
    ul.innerHTML = "";
    if (!d.stashes.length)
      ul.innerHTML = `<li>No stashes. Use “Stash current changes”.</li>`;
    for (const st of d.stashes) {
      const li = document.createElement("li");
      li.innerHTML = `<div><small class="hash">#${st.index}</small> ${esc(st.label)}</div>
        <div class="git-btns">
          <button data-a="pop" class="ghost">Pop</button>
          <button data-a="apply" class="ghost">Apply</button>
          <button data-a="drop" class="ghost">🗑</button>
        </div>`;
      li.querySelectorAll("button").forEach((b) =>
        b.addEventListener("click", async () => {
          const a = b.dataset.a;
          if (a === "drop" && !confirm(`Drop stash #${st.index}?`)) return;
          try {
            const r = await git(`stash/${a}`, { method: "POST", body: { index: st.index } });
            toast(r.out || a + " done"); loadStashes(); loadGit();
          } catch (e) { toast(e.message, true); }
        }));
      ul.appendChild(li);
    }
  } catch (e) { toast(e.message, true); }
}

$("#btn-stash-create").addEventListener("click", async () => {
  const msg = prompt("Stash message (optional):") || undefined;
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
      b.disabled = true;
      const d = await git(a, { method: "POST" });
      toast(d.out || a + " ok");
      loadGit();
    } catch (e) { toast(e.message, true); }
    finally { b.disabled = false; }
  })
);

$("#btn-git-remote")?.addEventListener("click", async () => {
  if (!S.pid) { toast("Open a project first", true); return; }
  try {
    const d = await git("graph");
    const rems = d.remotes || [];
    const actions = [
      { label: "+ Add new remote (e.g. origin)", primary: true, fn: async () => {
        const name = prompt("Remote name (e.g. origin):", "origin");
        if (!name) return;
        const url = prompt(`Remote URL for "${name}":`);
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
          const u = prompt(`New URL for remote "${r.name}":`, r.fetch || r.push || "");
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
          if (!confirm(`Remove remote "${r.name}"?`)) return;
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

const M = { all: [], favorites: [] };

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
      listEl.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:6px 0">No active local AI servers detected on localhost or LAN.</div>`;
      return;
    }
    for (const s of servers) {
      const card = document.createElement("div");
      card.className = "lan-server-card";
      const modelChips = (s.models || []).map((m) =>
        `<span class="lan-model-chip">${esc(m.name || m.id)}${m.size ? ` <small style="color:var(--muted)">(${m.size})</small>` : ""}</span>`
      ).join("");
      card.innerHTML = `
        <div class="lan-server-head">
          <div>
            <strong class="lan-server-title">${esc(s.name)}</strong>
            <small style="display:block;color:var(--muted);font-size:11px">${esc(s.base_url)}</small>
          </div>
          <span class="server-badge ${esc(s.type)}">${esc(s.type)}</span>
        </div>
        <div class="lan-models-list">
          ${modelChips || '<span style="color:var(--muted);font-size:11px">(no models loaded)</span>'}
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:6px">
          <button class="primary btn-import-server" style="font-size:12px;padding:4px 10px">Import All Models</button>
        </div>`;
      card.querySelector(".btn-import-server").onclick = async () => {
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
      };
      listEl.appendChild(card);
    }
  } catch (err) {
    statusEl.classList.add("hidden");
    toast(err.message, true);
  }
}

$("#btn-scan-lan")?.addEventListener("click", scanLAN);

$("#btn-probe-host")?.addEventListener("click", async () => {
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
    toast(`Found ${res.type} on ${host}:${port} with ${res.models?.length || 0} models!`);
    await api("/api/models/register-local", {
      method: "POST",
      body: { provider_id: res.type, name: res.name, base_url: res.base_url, models: res.models || [] }
    });
    loadModels();
  } catch (err) { toast(err.message, true); }
});

async function loadModels() {
  const pid = S.pid || "global";
  const ul = $("#model-list");
  ul.innerHTML = `<li>Loading…</li>`;
  try {
    const [d, f] = await Promise.all([
      api(`/api/models/${pid}`),
      api(`/api/favorites`),
    ]);
    M.favorites = f.favorites || [];
    M.source = d.source || "";
    M.all = [];
    for (const p of d.providers || [])
      for (const mid of Object.keys(p.models || {}))
        M.all.push({ p: p.id, m: mid, name: p.models[mid]?.name || mid, src: p.source || "" });
    renderModels();
  } catch (e) { ul.innerHTML = ""; toast(e.message, true); }
}

function renderModels() {
  const q = $("#model-search").value.trim().toLowerCase();
  const favKeys = new Set(M.favorites);
  let items = M.all.filter((x) =>
    !q || x.name.toLowerCase().includes(q) || x.p.toLowerCase().includes(q) ||
    x.m.toLowerCase().includes(q));
  // favorites first
  items.sort((a, b) =>
    (favKeys.has(`${b.p}/${b.m}`) - favKeys.has(`${a.p}/${a.m}`)));

  const ul = $("#model-list");
  ul.innerHTML = "";
  if (!items.length)
    ul.innerHTML = `<li>${q ? "No models match your filter." : "No models yet — add one above."}</li>`;

  for (const x of items) {
    const key = `${x.p}/${x.m}`;
    const isFav = favKeys.has(key);
    const isDef = S.model && S.model.providerID === x.p && S.model.modelID === x.m;
    const li = document.createElement("li");
    const liveTag = x.src === "engine"
      ? ' <span style="color:var(--ok);font-size:10px">● live</span>' : "";
    li.innerHTML = `<div class="model-item"><strong>${esc(x.name)}${isFav ? '<span class="fav-tag">★</span>' : ""}</strong>
        <small>${esc(x.p)}${liveTag}</small></div>
      <div class="git-btns">
        ${isDef ? '<span class="badge-default">active</span>' : ""}
        <button class="fav-star ${isFav ? "on" : ""}" title="favorite">${isFav ? "★" : "☆"}</button>
        <button class="ghost accent-sel">use</button>
        <button class="ghost rm">✕</button>
      </div>`;
    li.querySelector(".accent-sel").onclick = () => {
      S.model = { providerID: x.p, modelID: x.m };
      localStorage.setItem("of.model", JSON.stringify(S.model));
      updateChatHeader(); renderModels();
      toast(`Model set: ${key}`);
    };
    li.querySelector(".fav-star").onclick = async () => {
      try {
        const r = await api("/api/favorites", { method: "POST", body: { provider_id: x.p, model_id: x.m } });
        M.favorites = r.favorites;
        renderModels();
      } catch (err) { toast(err.message, true); }
    };
    li.querySelector(".rm").onclick = async () => {
      if (!confirm(`Remove ${x.p}/${x.m} from config?`)) return;
      await api(`/api/models/${S.pid}`,
        { method: "DELETE", body: { provider_id: x.p, model_id: x.m } });
      loadModels(); toast("Model removed");
    };
    ul.appendChild(li);
  }
}

$("#model-search").addEventListener("input", renderModels);

$("#btn-add-model").addEventListener("click", async () => {
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
      await api(`/api/models/${S.pid}`, {
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

const FTABS = [];           // open file tabs: {rel, content, dirty}
let FACTIVE = null;

async function loadFiles(path = "") {
  if (!S.pid) { toast("Open a project first", true); return; }
  try {
    const d = await api(`/fs/${S.pid}/tree?path=${encodeURIComponent(path)}`);
    S.filesPath = path;
    $("#files-path").textContent = "/" + path;
    const ul = $("#file-list");
    ul.innerHTML = "";
    if (path) {
      const up = document.createElement("li");
      up.className = "file-entry"; up.textContent = "..";
      up.onclick = () => loadFiles(path.split("/").slice(0, -1).join("/"));
      ul.appendChild(up);
    }
    for (const e of d.entries) {
      const li = document.createElement("li");
      li.className = "file-entry";
      li.innerHTML = `<span>${e.dir ? "📁" : "📄"} ${esc(e.name)}</span>`;
      const child = path ? `${path}/${e.name}` : e.name;
      li.onclick = () => (e.dir ? loadFiles(child) : openEditor(child, e.name));
      ul.appendChild(li);
    }
  } catch (e) { toast(e.message, true); }
}

$("#files-up").addEventListener("click", () =>
  loadFiles(S.filesPath.split("/").slice(0, -1).join("/")));

function renderTabs() {
  const box = $("#file-tabs");
  box.innerHTML = "";
  for (const t of FTABS) {
    const b = document.createElement("span");
    b.className = "ftab" + (t === FACTIVE ? " on" : "");
    b.textContent = (t.dirty ? "● " : "") + t.name;
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
  const cached = FTABS.find((t) => t.rel === rel);
  if (cached) { showTab(cached); return; }
  const d = await api(`/fs/${S.pid}/read?path=${encodeURIComponent(rel)}`);
  const tab = { rel, name: name || rel.split("/").pop(), content: d.content, dirty: false };
  FTABS.push(tab); FACTIVE = tab;
  $("#editor-wrap").classList.remove("hidden");
  $("#editor-name").textContent = rel;
  $("#editor").value = d.content;
  renderTabs();
}

$("#editor").addEventListener("input", () => {
  if (FACTIVE) { FACTIVE.content = $("#editor").value; FACTIVE.dirty = true; renderTabs(); }
});
$("#editor-save").onclick = async () => {
  if (!FACTIVE) return;
  await api(`/fs/${S.pid}/write`, {
    method: "POST", body: { path: FACTIVE.rel, content: FACTIVE.content },
  });
  FACTIVE.dirty = false; renderTabs(); toast("Saved");
};
$("#editor-lsp").addEventListener("click", async () => {
  try {
    const status = await oc("/lsp");
    const list = status.filter((x) => x.status).map((x) =>
      `${x.name}: ${x.status}${x.progress ? " (" + x.progress + ")" : ""}`);
    toast(list.length ? list.join("\n") : "No LSP servers running");
  } catch (e) { toast(e.message, true); }
});

$("#editor-close").addEventListener("click", () => {
  if (FACTIVE && FACTIVE.dirty &&
      !confirm(`"${FACTIVE.name}" has unsaved changes. Close anyway?`)) return;
  if (FACTIVE) {
    FTABS.splice(FTABS.indexOf(FACTIVE), 1);
    FACTIVE = FTABS[FTABS.length - 1] || null;
  }
  if (FACTIVE) showTab(FACTIVE); else $("#editor-wrap").classList.add("hidden");
  renderTabs();
});

/* project-wide text search via opencode /find */
let searchTimer = null;
$("#proj-search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { $("#proj-search-results").classList.add("hidden"); return; }
  searchTimer = setTimeout(async () => {
    try {
      const res = await oc(`/find?pattern=${encodeURIComponent(q)}`);
      const ul = $("#proj-search-results");
      ul.classList.remove("hidden");
      ul.innerHTML = res.length ? "" : `<li style="color:var(--muted)">No matches</li>`;
      for (const m of res.slice(0, 30)) {
        const line = (m.lines || "").trim().slice(0, 80);
        ul.insertAdjacentHTML("beforeend",
          `<li class="file-entry"><div><strong>${esc(m.path)}</strong>
             <small style="display:block;color:var(--muted)">:${m.line_number} ${esc(line)}</small></div></li>`);
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

function setConn(on) { $("#conn-dot").className = `dot ${on ? "on" : "off"}`; }

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

(async function boot() {
  applySettings();
  initSettings();
  loadModels().catch(() => {});
  await loadProjects();
  if (S.pid) { ensureSession(); }
  else pushMsg("system", "Welcome to OpenForge 👋\nGo to **Projects** to create your first project.");
})();
