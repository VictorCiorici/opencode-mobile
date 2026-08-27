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
4. For the full AI experience install the `opencode` binary on-device (e.g. via Termux at `/data/data/com.termux/files/usr/bin/opencode`). Without it you can still manage projects, files, git and the terminal; the daemon reports `opencode offline` honestly instead of faking responses.

### Option B — Browser / Termux / proot (PWA)
```bash
git clone https://github.com/VictorCiorici/opencode-mobile.git
cd opencode-mobile
./run.sh            # installs deps if needed and starts the bridge
```
Open Chrome at `http://127.0.0.1:8787/ui`, then *Add to Home Screen* to install as a full-screen PWA.

## 🔐 Security model
* The Android daemon generates a random bearer token per install and hands it to its own WebView through a JS interface; every API call (headers or `?token=` for SSE) must present it. Browsers cannot talk to the daemon without it.
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

## 🧪 Testing
```bash
# Go daemon
cd daemon && go test ./...

# Python bridge
pip install -r server/requirements.txt pytest
cd server && python -m pytest tests/ -v
```
CI builds the ARM64 daemon, runs both test suites, and uploads the APK on every push.

## 📜 License

MIT — see [LICENSE](LICENSE).
