# OpenForge Mobile ⚡

<p align="center">
  <b>The Autonomous AI Coding Agent & Mobile IDE Suite for Android</b><br>
  <i>Turn your Android phone into an autonomous development environment with OpenCode, Git, local LLMs, and real-time streaming.</i>
</p>

---

## 🌟 Overview

**OpenForge** is a full-featured mobile IDE and AI agent controller for Android. It connects directly with the **OpenCode** agent loop and local AI engines, giving you conversational coding, project workspace management, multi-tab file editing, a built-in project terminal, and advanced Git operations from a mobile-optimized dark UI.

```
┌─────────────────────────── Android device (APK) ───────────────────────────┐
│  OpenForge WebView UI (secure asset-served shell, #0B0E14)                 │
│      │  bearer-token auth (auto-generated per install)                     │
│      ▼                                                                     │
│  OpenForge Native Go Daemon (:8787, foreground service)                    │
│      ├── projects registry, folder browser, file editor API                │
│      ├── full Git suite (status/diff/stage/commit/log/graph/stash/…)       │
│      ├── project terminal (sh exec), LAN AI-server scanner                 │
│      └── spawns `opencode serve` per project on demand (ports 4100+)       │
└────────────────────────────────────────────────────────────────────────────┘

┌──────────── Termux / proot Debian / desktop browser (PWA) ─────────────────┐
│  run.sh → Python bridge (server/, FastAPI) serves the same UI + API        │
└────────────────────────────────────────────────────────────────────────────┘
```

Both backends (Go daemon and Python bridge) implement the **same HTTP API contract**, so the PWA works unchanged against either.

## ✨ Key Features
* **Real-time streaming chat** with tool-approval cards, checkpoint revert/redo, session fork/share.
* **Project management**: create, import any folder, clone from GitHub/Git URLs.
* **Complete Git suite**: staging, commits, per-file diffs, commit graph, branches, remotes, stashes, merge-conflict resolver.
* **Built-in terminal drawer** running commands in the active project directory.
* **Local AI discovery**: scans localhost/LAN for Ollama (`:11434`), LM Studio (`:1234`), llama.cpp (`:8080`), vLLM/LocalAI; one-tap import into the OpenCode config.
* **Credentials manager**: OpenCode Zen, Gemini, OpenAI, Anthropic, Qwen, GLM keys + GitHub PAT (used for private clones); everything stored with restrictive permissions, never echoed back in API responses.

## 🚀 Installation & Quick Start

### Option A — Android APK (recommended)
1. Download the latest APK from [GitHub Actions artifacts](https://github.com/VictorCiorici/opencode-mobile/actions).
2. Install it (Android 7.0+). Updates install in place — the debug keystore is committed so signatures stay stable.
3. On first launch grant notifications and storage access when prompted.
4. The APK bundles the OpenCode engine (musl build, pinned to the on-device-verified release — see `OPENCODE_VERSION` in `.github/workflows/build-apk.yml`). OpenForge speaks the opencode **1.x** API; 2.x engines serve a different API and are reported as incompatible instead of failing obscurely.

### Option B — Browser / Termux / proot (PWA)
```bash
git clone https://github.com/VictorCiorici/opencode-mobile.git
cd opencode-mobile
./run.sh            # installs deps if needed and starts the bridge
```
Open Chrome at `http://127.0.0.1:8787/ui`, then *Add to Home Screen* to install as a full-screen PWA.

## 🔐 Security model
* The Android daemon generates a random bearer token per install and hands it to its own WebView through a JS interface — only while the WebView shows the bundled UI origin or the daemon's own loopback port (external links open in the system browser). Every mutating API call (headers, or `?token=` for SSE) must present it.
* CORS is limited to the bundled UI origin and loopback, and while bound to loopback both backends reject requests whose `Host` is not a loopback name (DNS-rebinding protection). Extra names can be allowed on the Python bridge with `OCMB_ALLOWED_HOSTS`.
* App data is excluded from Android backups (`allowBackup=false`) because it holds API keys.
* Termux/desktop flow: set `OCMB_TOKEN` to require a token there too (otherwise auth is disabled, which is fine while bound to loopback only).
* File APIs are strictly contained inside each project root (traversal- and symlink-proof).
* Secrets (auth.json, opencode config with API keys, `.git-credentials`) are written with `0600`; GitHub PAT edits merge into `.git-credentials` instead of clobbering other hosts.
* Android allows cleartext HTTP **only** to loopback — remote bridges must use HTTPS/Tailscale/WireGuard.

## ⚙️ Configuration

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `OCMB_PORT` / `-port` | `8787` | Bridge listening port |
| `OCMB_HOST` / `-host` | `127.0.0.1` | Bind address |
| `OCMB_WORKSPACE` / `-workspace` | `~/opencode-projects` (`/sdcard/OpenForge/projects` on device) | Parent folder for new projects |
| `OCMB_DATA` / `-data` | `~/.local/share/opencode-mobile` | Registry/sessions/cache storage |
| `OCMB_OPENCODE_BIN` | `opencode` | Path to the OpenCode binary (Python bridge) |
| `OCMB_TOKEN` / `-token` | *unset* | Require bearer token for API authentication |
| `OCMB_ALLOWED_HOSTS` | *unset* | Extra `Host` names accepted by the Python bridge while bound to loopback |

## 🩺 Troubleshooting
* **Daemon log** (Android): `files/daemon.log` (rotated at 4 MB to `daemon.log.1`). The app restarts a crashed daemon with backoff.
* **Engine logs**: `<data>/logs/engine-<project>.log` — the engine's own stdout/stderr for each spawned `opencode serve`.
* **`/api/health`** reports the engine path, version and last exec error.

## 🧪 Testing
```bash
# Go daemon
cd daemon && go vet ./... && go test ./...

# Python bridge
pip install -r server/requirements.txt pytest
cd server && python -m pytest tests/ -q

# PWA helpers (zero dependencies)
node --test pwa/tests/

# Android JVM unit tests
cd android && gradle testDebugUnitTest
```
CI builds the ARM64 daemon, runs all suites, and uploads the APK on every push and pull request.

## 📜 License

MIT — see [LICENSE](LICENSE).
