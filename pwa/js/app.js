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

/* tiny markdown: fenced code, inline code, bold */
function md(text) {
  let out = esc(text || "");
  out = out.replace(/```(\w*)\n([\s\S]*?)```/g,
    (_, lang, code) => `<pre><code>${code.replace(/\n$/, "")}</code></pre>`);
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

$$(".subtab").forEach((b) =>
  b.addEventListener("click", () => {
    $$(".subtab").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    $$(".subtab-page").forEach((x) => x.classList.remove("active"));
    $(`#git-${b.dataset.subtab}`).classList.add("active");
    if (b.dataset.subtab === "log") loadGitLog();
    if (b.dataset.subtab === "diff") loadGitDiff();
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
  $("#btn-model-pick").textContent = m ? `Model: ${m.providerID}/${m.modelID}` : "Model: default";
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

async function renderChat(full = false) {
  if (full) $("#chat-messages").innerHTML = "";
  if (!S.pid || !S.sid) {
    if (full) pushMsg("system", "Create or select a project to start chatting.");
    return;
  }
  try {
    const msgs = await oc(`/session/${S.sid}/message?limit=50`);
    if (full) {
      $("#chat-messages").innerHTML = "";
      for (const m of msgs.reverse()) {
        const role = m.info?.role || "system";
        if (m.info?.error && m.info.error.name !== "MessageOutputLengthError") {
          const d = m.info.error.data || {};
          pushMsg("system", `<span class="role">error</span>${esc(d.message || m.info.error.name)}`);
          continue;
        }
        const text = (m.parts || []).map((p) => p.text || "").filter(Boolean).join("\n");
        if (text.trim())
          pushMsg(role === "user" ? "user" : "assistant",
            `<span class="role">${role}</span>${md(text)}`, m.info?.id);
      }
    }
    setConn(true);
  } catch (e) { setConn(false); }
}

$("#chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#chat-form").requestSubmit(); }
});

$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text || S.busy) return;
  if (!S.pid || !S.sid) { toast("Open a project first", true); return; }
  input.value = "";

  pushMsg("user", `<span class="role">you</span>${esc(text)}`);
  const wait = pushMsg("assistant thinking", "opencode is working…");

  const body = { parts: [{ type: "text", text }] };
  if (S.model) body.model = S.model;

  try {
    S.busy = true;
    await oc(`/session/${S.sid}/prompt_async`, { method: "POST", body });
    // poll until the session goes idle again
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      const statuses = await oc("/session/status");
      const st = statuses[S.sid];
      if (!st || st.type === "idle") break;
      wait.textContent = "opencode is working… (" + (st.type || "busy") + ")";
    }
    await renderChat(true);
  } catch (err) {
    wait.remove();
    toast(err.message, true);
  } finally { S.busy = false; }
});

/* model quick-pick: jump to models tab */
$("#btn-model-pick").addEventListener("click", () =>
  $$('#bottom-nav button[data-view="models"]')[0].click()
);

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

let gitData = null;

async function loadGit() {
  if (!S.pid) { toast("Open a project first", true); return; }
  try {
    gitData = await git("status");
    $("#git-branch").textContent = gitData.branch || "(no branch)";
    renderGitFiles();
  } catch (e) { toast(e.message, true); }
}

function renderGitFiles() {
  const ul = $("#git-files");
  ul.innerHTML = "";
  const rows = [
    ...gitData.staged.map((f) => ({ f, cls: "add", tag: "staged" })),
    ...gitData.unstaged.map((f) => ({ f, cls: "mod", tag: "modified" })),
    ...gitData.untracked.map((f) => ({ f, cls: "add", tag: "untracked" })),
  ];
  if (!rows.length) ul.innerHTML = `<li>Working tree clean ✓</li>`;
  for (const r of rows) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="git-status-${r.cls}">${esc(r.f.path)}</span>
      <button class="ghost" style="padding:5px 10px;font-size:12px">${r.tag === "untracked" ? "discard?" : "discard"}</button>`;
    li.querySelector("button").onclick = async () => {
      if (!confirm(`Discard changes in ${r.f.path}?`)) return;
      await git("discard", { method: "POST", body: { ref: r.f.path } });
      loadGit(); toast("Changes discarded");
    };
    ul.appendChild(li);
  }
}

async function loadGitLog() {
  const d = await git("log?limit=40");
  const ul = $("#git-log-list");
  ul.innerHTML = "";
  for (const c of d.commits)
    ul.insertAdjacentHTML("beforeend",
      `<li><span class="hash">${c.hash}</span> ${esc(c.subject)}
         <span class="meta">${esc(c.author)} · ${esc(c.date)}</span></li>`);
}

async function loadGitDiff() {
  const d = await git("diff");
  $("#git-diff-view").textContent = d.diff || "(no unstaged diff)";
}

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

$("#btn-commit").addEventListener("click", async () => {  const msg = $("#commit-msg").value.trim();
  if (!msg) return toast("Enter a commit message", true);
  try {
    await git("commit", { method: "POST", body: { message: msg } });
    $("#commit-msg").value = "";
    toast("Committed");
    loadGit();
  } catch (e) { toast(e.message, true); }
});

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
  await loadProjects();
  if (S.pid) { ensureSession(); loadModels().catch(() => {}); }
  else pushMsg("system", "Welcome to OpenForge 👋\nGo to **Projects** to create your first project.");
})();
