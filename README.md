# OpenForge — mobile IDE suite for opencode

A full mobile IDE suite that lets you drive **opencode** running inside your
**Termux proot Debian** from an Android app — chat, projects, models and git
control from one modern interface.

```
┌─────────────────────── Android device ───────────────────────┐
│                                                              │
│   OpenForge PWA (Chrome, "Add to Home Screen")               │
│        │  http://127.0.0.1:8787                              │
│        ▼                                                     │
│   Bridge server (FastAPI)                                    │
│     ├─ project manager ─ spawns `opencode serve` per project │
│     ├─ git operations ── runs git directly in each project   │
│     ├─ model manager ─── edits ~/.config/opencode/*.json     │
│     └─ file read/write for the built-in editor               │
│        │                                                     │
│        ▼                                                     │
│   opencode CLI (per-project instances, ports 4100+)          │
└──────────────────────────────────────────────────────────────┘
```

## Quick start (on-device)

Inside proot Debian:

```bash
cd /android-files/opencode-mobile
chmod +x run.sh
./run.sh
```

Then in Android Chrome open:

```
http://127.0.0.1:8787/ui
```

Menu → **Add to Home screen** → it launches full-screen like a native app.

> The bridge binds to `127.0.0.1` by default. To reach it from another device
> (your chosen SSH-tunnel setup), keep it on localhost and forward:
> `ssh -L 8787:127.0.0.1:8787 <phone>` — or set `OCMB_HOST=0.0.0.0` on a
> trusted LAN/Tailscale.

## Features

| Tab | What it does |
|---|---|
| 💬 **Chat** | Conversations with opencode — **live token streaming** (reasoning + answer render as they arrive), abort/retry, per-message token/cost meta, session switch/create/rename/fork/share |
| 📁 **Projects** | Create (own folder + `git init`, custom **initial branch**) or import a folder, open/remove; each gets its own isolated opencode instance |
| ⑂ **Git** | Status, **stage + unstage** per file or all, commit, discard, diff viewer, clickable commit graph, branch create/checkout/rename/merge/revert/delete, stashes, push/pull |
| 🧠 **Models** | List every provider/model, add/remove, favorites, pick active model |
| 📄 **Files** | Multi-tab editor, in-file search, **project-wide search** (opencode `/find`), **LSP server status** button |

## Configuration (env vars)

| Variable | Default | Purpose |
|---|---|---|
| `OCMB_PORT` | `8787` | Bridge port |
| `OCMB_HOST` | `127.0.0.1` | Bind address |
| `OCMB_WORKSPACE` | `~/opencode-projects` | Where new projects are created |
| `OCMB_OPENCODE_BIN` | `opencode` | Path to the opencode binary |
| `OCMB_TOKEN` | unset | If set, clients must send `Authorization: Bearer <token>` |

## Architecture notes

- **One opencode instance per project**: the bridge lazily spawns
  `opencode serve --port N` with the project as cwd, waits for its health
  endpoint, proxies all opencode REST calls (`/oc/<pid>/...`, including SSE),
  and reaps instances idle >30 min.
- Chat uses `/session/:id/prompt_async` + polling the newest assistant message
  (break on `info.time.completed`/`error`), so long agent runs don't time out
  and tokens reveal live as the model streams them.
- Git `unstage` and `stage` call `gitops.stage/unstage` (the UI relies on the
  `/git/<pid>/unstage` route — keep it in sync with `gitops.py`).
- Models are persisted in `~/.config/opencode/opencode.json`
  (`provider.<id>.models.<model>`), exactly like manual config.
- File editing goes through the bridge's own `/fs` endpoints (guarded against
  path traversal), since opencode's file API is read-only.

## Testing

A pytest suite lives in `server/tests/` and exercises the bridge without needing
a live opencode (it uses temp repos and the temp config dir):

```bash
cd /android-files/opencode-mobile/server
python3 -m pytest tests/ -q
```

It covers: model add/remove/favorites, git status/diff/stash/branch ops/commit
graph, and project create/import/remove.

## Roadmap

- [x] Live token streaming in chat
- [x] Initial-branch on project create
- [x] Project-wide text search (`/find`)
- [x] LSP status display in editor
- [x] pytest suite for the bridge
- [ ] Native Kotlin/Compose APK wrapping this UI (WebView shell first)
- [ ] SSE event stream rendering (tool calls, file diffs live)
- [ ] Permission-request handling (`/session/:id/permissions/:permissionID`)
- [ ] Session revert/unrevert + share buttons
- [ ] SSH remote mode: point the PWA at a tunneled Debian box instead of localhost
