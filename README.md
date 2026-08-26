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
| 💬 **Chat** | Full conversations with opencode (async prompts + live status polling), session switch/create |
| 📁 **Projects** | Create separate projects (own folder + `git init`), open/remove, each gets its own isolated opencode instance |
| ⑂ **Git** | Status, stage-all + commit, discard per file, diff viewer, log, branch create/checkout, push/pull |
| 🧠 **Models** | List every provider/model opencode sees, add new models (written to `opencode.json`), remove models, pick active model |
| 📄 **Files** | Browse any project tree, open files in editor, save changes |

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
- Chat uses `/session/:id/prompt_async` + `/session/:id/status` polling, so
  long agent runs don't time out.
- Models are persisted in `~/.config/opencode/opencode.json`
  (`provider.<id>.models.<model>`), exactly like manual config.
- File editing goes through the bridge's own `/fs` endpoints (guarded against
  path traversal), since opencode's file API is read-only.

## Roadmap

- [ ] Native Kotlin/Compose APK wrapping this UI (WebView shell first)
- [ ] SSE event stream rendering (tool calls, file diffs live)
- [ ] Permission-request handling (`/session/:id/permissions/:permissionID`)
- [ ] Session revert/unrevert + share buttons
- [ ] SSH remote mode: point the PWA at a tunneled Debian box instead of localhost
