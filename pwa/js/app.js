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
};

/* ---------------- helpers ---------------- */

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) {
    let msg = `${r.status}`;
    try { const j = await r.json(); msg = j.detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.status === 204 ? null : r.json();
}
const oc = (p, o) => api(`/oc/${S.pid}${p}`, o);
const git = (a, o) => api(`/git/${S.pid}/${a}`, o);

function toast(msg, err = false, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = err ? "err" : "";
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), ms);
}

function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
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
  try {
    const p = await api("/api/projects", { method: "POST", body: { name } });
    $("#new-project-name").value = "";
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
  } catch (e) { setConn(false); toast(e.message, true); }
}

$("#btn-new-session").addEventListener("click", async () => {
  if (!S.pid) return toast("Select a project first", true);
  const s = await oc("/session", { method: "POST", body: {} });
  S.sid = s.id;
  renderChat(true);
  toast("New session");
});

$("#btn-sessions").addEventListener("click", async () => {
  if (!S.pid) return;
  S.sessions = await oc("/session");
  const pick = prompt(
    "Sessions:\n" + S.sessions.map((s, i) => `${i + 1}. ${s.title || s.id}`).join("\n") +
    "\n\nEnter number to switch:",
  );
  const i = parseInt(pick, 10);
  if (i >= 1 && i <= S.sessions.length) { S.sid = S.sessions[i - 1].id; renderChat(true); }
});

function updateChatHeader() {
  const m = S.model;
  $("#model-label").textContent = m ? `${m.providerID}/${m.modelID}` : "default";
}

const chatScroll = () => $("#chat-scroll");

function pushMsg(cls, html, id) {
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  if (id) el.dataset.mid = id;
  el.innerHTML = html;
  $("#chat-messages").appendChild(el);
  chatScroll().scrollTop = chatScroll().scrollHeight;
  return el;
}

function partHtml(p) {  if (p.type === "text" && (p.text || "").trim())
    return md(p.text);
  if (p.type === "reasoning") {
    const t = p.text || "";
    if (!t.trim()) return "";
    const open = localStorage.getItem("of.set.reasoning") === "1" ? " open" : "";
    return `<details class="reasoning"${open}><summary>💭 Reasoning</summary>${esc(t)}</details>`;
  }
  if (p.type === "tool" && p.state?.title)
    return `<div class="msg-line tool-line">🔧 ${esc(p.state.title)}</div>`;
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

async function renderChat(full = false) {
  if (full) $("#chat-messages").innerHTML = "";
  if (!S.pid || !S.sid) {
    if (full) pushMsg("system", "Create or select a project to start chatting.");
    return;
  }
  try {
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
  } catch (e) { setConn(false); }
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

  pushMsg("user", esc(text));
  const wait = pushMsg("assistant thinking", "opencode is thinking… <span class=\"elapsed\"></span>");
  const elapsedEl = wait.querySelector(".elapsed");
  const t0 = Date.now();

  const body = { parts: [{ type: "text", text }] };
  if (S.model) body.model = S.model;

  try {
    S.busy = true;
    S.abortReq = false;
    updateSendBtn();
    // remember the newest message before sending so we can detect a NEW reply
    const base = await oc(`/session/${S.sid}/message?limit=1`);
    const baseId = base[0]?.info?.id;
    await oc(`/session/${S.sid}/prompt_async`, { method: "POST", body });

    let warned = false;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      elapsedEl.textContent = `(${Math.round((Date.now() - t0) / 1000)}s)`;
      let last = null;
      try {
        const msgs = await oc(`/session/${S.sid}/message?limit=1`);
        last = msgs[0];
        if (last?.info?.role === "assistant") {
          updateCtxBar(msgs);
          const r = (last.parts || []).filter((p) => p.type === "reasoning" && p.text).pop();
          if (r && !(last.info?.time?.completed)) {
            wait.classList.remove("thinking");
            const tail = r.text.length > 300 ? "…" + r.text.slice(-299) : r.text;
            wait.innerHTML = `<span class="role">💭 reasoning…</span>${esc(tail)}
              <span class="elapsed">(${Math.round((Date.now() - t0) / 1000)}s)</span>`;
          }
        }
      } catch {}

      const isNew = last && baseId && last.info?.id !== baseId;
      const done = isNew && last.info?.role === "assistant" &&
        (last.info?.time?.completed || last.info?.error);
      if (done) break;

      /* stall detection: no new assistant message at all */
      const waited = Date.now() - t0;
      if (!isNew && waited > 20000 && !warned) {
        warned = true;
        wait.innerHTML = `Still waiting for opencode… <span class="elapsed"></span>`;
      }
      if (!isNew && waited > 90000) {
        wait.classList.remove("thinking");
        wait.innerHTML = `<span class="role">no response</span>The model never replied.`;
        const btn = document.createElement("button");
        btn.className = "ghost";
        btn.style.marginTop = "8px";
        btn.textContent = retryOf ? "↻ Try again" : "↻ Retry";
        btn.onclick = () => { wait.remove(); sendPrompt(text, true); };
        wait.appendChild(btn);
        break;
      }
      if (S.abortReq) {
        await new Promise((r) => setTimeout(r, 1500));
        break;
      }
    }
    await renderChat(true);
  } catch (err) {
    wait.remove();
    toast(err.message, true);
  } finally {
    S.busy = false;
    updateSendBtn();
    chatScroll().scrollTop = chatScroll().scrollHeight;
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

/* ---------------- settings ---------------- */

function applySettings() {
  document.body.classList.toggle("hide-meta",
    localStorage.getItem("of.set.meta") !== "1");
}

function initSettings() {
  const map = [
    ["#set-reasoning", "of.set.reasoning"],
    ["#set-meta", "of.set.meta"],
    ["#set-live-ctx", "of.set.live"],
  ];
  for (const [sel, key] of map) {
    const el = $(sel);
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
      `OpenForge v0.1 · bridge <b>${h.bridge}</b><br>` +
      `opencode ${esc(h.opencode?.version || "?")} — ` +
      `${h.opencode?.healthy ? "healthy ✓" : "<span style='color:var(--err)'>offline</span>"}`;
  }).catch(() => { $("#about-box").textContent = "Bridge unreachable"; });
}

/* ---------------- folder browser (import existing project) ---------------- */

const BR = { path: "" };

$("#btn-import-project").addEventListener("click", () => openBrowser());

function openBrowser() {
  $("#browser-overlay").classList.remove("hidden");
  browseTo("");
}

async function browseTo(path) {
  try {
    const d = await api(`/api/browse?path=${encodeURIComponent(path)}`);
    BR.path = d.path;
    $("#browser-path").textContent = d.path;
    const ul = $("#browser-list");
    ul.innerHTML = "";
    if (d.parent !== null && d.parent !== undefined) {
      const up = document.createElement("li");
      up.className = "file-entry";
      up.textContent = "📁 ..";
      up.onclick = () => browseTo(d.parent);
      ul.appendChild(up);
    }
    if (!d.entries.length)
      ul.innerHTML += `<li style="color:var(--muted)">No subfolders</li>`;
    for (const e of d.entries) {
      const li = document.createElement("li");
      li.className = "file-entry";
      li.innerHTML = `<span>📁 ${esc(e.name)}</span>`;
      li.onclick = () => browseTo(`${d.path}/${e.name}`.replace(/\/+/, "/"));
      ul.appendChild(li);
    }
  } catch (err) { toast(err.message, true); }
}

$("#browser-up").addEventListener("click", async () => {
  const d = await api(`/api/browse?path=${encodeURIComponent(BR.path)}`);
  if (d.parent !== null && d.parent !== undefined) browseTo(d.parent);
});
$("#browser-close").addEventListener("click", () =>
  $("#browser-overlay").classList.add("hidden"));

$("#browser-select").addEventListener("click", async () => {
  try {
    const p = await api("/api/projects/import", { method: "POST", body: { path: BR.path } });
    $("#browser-overlay").classList.add("hidden");
    await loadProjects(false);
    S.pid = p.id; S.sid = null;
    localStorage.setItem("of.pid", p.id);
    $("#project-select").value = p.id;
    renderProjectList();
    ensureSession();
    toast(`Imported “${p.name}”`);
  } catch (err) { toast(err.message, true); }
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
    $("#git-branch").textContent = G.status.branch || "(no branch)";
    renderGitFiles();
    api(`/git/${S.pid}/graph?limit=1`)
      .then((d) => {
        const rem = d.remotes || [];
        $("#git-remotes").innerHTML =
          rem.length ? rem.map((r) => `⇅ ${esc(r.name)} → ${esc(r.fetch || "")}`).join("<br>") : "";
      }).catch(() => {});
  } catch (e) { toast(e.message, true); }
}

function fileBadge(f) {
  if (f.x === "?" ) return `<span class="st-badge st-question">new</span>`;
  const c = f.x !== " " ? f.x : f.y;
  return `<span class="st-badge st-${esc(c)}">${esc(c)}</span>`;
}

function allFiles() {
  const s = G.status;
  return [
    ...s.staged.map((f) => ({ ...f, area: "staged" })),
    ...s.unstaged.map((f) => ({ ...f, area: "unstaged" })),
    ...s.untracked.map((f) => ({ ...f, area: "untracked" })),
  ];
}

function renderGitFiles() {
  const ul = $("#git-files");
  ul.innerHTML = "";
  const files = allFiles();
  if (!files.length) { ul.innerHTML = `<li>Working tree clean ✓</li>`; return; }
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

$$("#view-git .git-btns button").forEach((b) =>
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

/* ---------------- models ---------------- */

/* ---------------- models ---------------- */

const M = { all: [], favorites: [] };

async function loadModels() {
  if (!S.pid) return;
  const ul = $("#model-list");
  ul.innerHTML = `<li>Loading…</li>`;
  try {
    const [d, f] = await Promise.all([
      api(`/api/models/${S.pid}`),
      api(`/api/favorites`),
    ]);
    M.favorites = f.favorites || [];
    M.all = [];
    for (const p of d.providers || [])
      for (const mid of Object.keys(p.models || {}))
        M.all.push({ p: p.id, m: mid, name: p.models[mid]?.name || mid });
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
    li.innerHTML = `<div class="model-item"><strong>${esc(x.name)}${isFav ? '<span class="fav-tag">★</span>' : ""}</strong>
        <small>${esc(x.p)}</small></div>
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
  if (!provider_id || !model_id) return toast("Provider and model ids required", true);
  try {
    await api(`/api/models/${S.pid}`, {
      method: "POST",
      body: {
        provider_id, model_id,
        options: $("#m-name").value.trim() ? { name: $("#m-name").value.trim() } : null,
        set_default: $("#m-default").checked,
      },
    });
    ["#m-provider", "#m-model", "#m-name"].forEach((s) => ($(s).value = ""));
    $("#m-default").checked = false;
    toast("Model added");
    loadModels();
  } catch (e) { toast(e.message, true); }
});

/* ---------------- files ---------------- */

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
      li.onclick = () => (e.dir ? loadFiles(child) : openEditor(child));
      ul.appendChild(li);
    }
  } catch (e) { toast(e.message, true); }
}

$("#files-up").addEventListener("click", () =>
  loadFiles(S.filesPath.split("/").slice(0, -1).join("/")));

async function openEditor(rel) {
  const d = await api(`/fs/${S.pid}/read?path=${encodeURIComponent(rel)}`);
  $("#editor-wrap").classList.remove("hidden");
  $("#editor-name").textContent = rel;
  $("#editor").value = d.content;
  $("#editor-save").onclick = async () => {
    await api(`/fs/${S.pid}/write`, {
      method: "POST", body: { path: rel, content: $("#editor").value },
    });
    toast("Saved");
  };
}

$("#editor-close").addEventListener("click", () => $("#editor-wrap").classList.add("hidden"));

/* ---------------- health ---------------- */

function setConn(on) { $("#conn-dot").className = `dot ${on ? "on" : "off"}`; }

setInterval(async () => {
  try { await api("/api/health"); setConn(true); } catch { setConn(false); }
}, 10000);

/* ---------------- boot ---------------- */

(async function boot() {
  applySettings();
  initSettings();
  await loadProjects();
  if (S.pid) { ensureSession(); loadModels().catch(() => {}); }
  else pushMsg("system", "Welcome to OpenForge 👋\nGo to **Projects** to create your first project.");
})();
