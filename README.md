# OpenForge Mobile ⚡

<p align="center">
  <b>The Autonomous AI Coding Agent & Mobile IDE Suite for Android</b><br>
  <i>Turn your Android phone into an autonomous development environment with OpenCode, Git, local LLMs, and real-time streaming.</i>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-0.2.0-blue.svg" alt="Version 0.2.0">
  <img src="https://img.shields.io/badge/Platform-Android_&_PWA-green.svg" alt="Platform">
  <img src="https://img.shields.io/badge/License-MIT-purple.svg" alt="License MIT">
  <img src="https://img.shields.io/badge/Build-GitHub_Actions_CI-orange.svg" alt="CI">
</p>

---

## 🌟 Overview

**OpenForge** is a full-featured mobile IDE and AI agent controller designed specifically for Android. It connects directly with the **OpenCode** agent loop and local AI engines, giving you full conversational coding, project workspace management, multi-tab file editing, interactive bash permission reviews, and advanced Git operations from a clean, mobile-optimized dark UI.

```
┌──────────────────────────────── Android Device ────────────────────────────────┐
│                                                                                │
│   OpenForge Native Android APK / PWA (Hardware-Accelerated Dark UI #0B0E14)    │
│        │                                                                       │
│        ├── 💬 Real-Time Streaming Agent Chat (Token telemetry, Reasoning)     │
│        ├── 📁 Project & Dynamic Workspace Manager                              │
│        ├── ⑂ Full Git Suite (Diffs, Commits, Remotes, Merge Conflicts)         │
│        ├── 🧠 Local AI & LAN Subnet Scanner (Ollama, llama.cpp, LM Studio)     │
│        ├── 📟 Built-in Project Terminal Drawer                                 │
│        └── 🔑 AI Credentials & API Keys Manager (OpenCode Zen, BYOK)           │
│                                                                                │
│   Android Foreground Service (DaemonService :8787)                             │
│        │                                                                       │
│        ▼                                                                       │
│   OpenCode AI Engine & Project Instances (Lazy-spawned on ports 4100+)         │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## ✨ Key Features

### 🤖 1. Autonomous AI Coding Agent & Live Streaming
* **Real-time SSE Token Streaming:** Watch the agent reason and generate code live.
* **Interactive Tool Approvals:** Instant permission prompt cards (*Allow / Always for session / Deny*) for bash commands and file writes with syntax-highlighted diffs.
* **Checkpoint Reverts & Redo:** Undo turns or restore rolled-back turns instantly with the **↪ Redo** button.
* **Session Management:** Fork sessions, switch branches, export/share transcripts, and inspect token usage & cost telemetry.

### 📡 2. Local AI Models & Wi-Fi LAN Auto-Scanner
* **1-Tap Network Discovery:** Automatically probes localhost and active Wi-Fi subnets for running AI servers:
  * **Ollama** (`:11434`)
  * **LM Studio** (`:1234`)
  * **llama.cpp** (`:8080`)
  * **vLLM / LocalAI** (`:8000` / `:5000`)
* **Direct IP Probing:** Connect to desktop/server AI instances over Wi-Fi, Tailscale, or WireGuard.
* **1-Tap Import:** Imports all discovered local models directly into OpenForge configuration.

### 🔑 3. Flexible AI Provider Credentials (BYOK & OpenCode Zen)
* Configure credentials in **Settings ⚙️** with zero terminal editing:
  * **OpenCode Zen API Token**
  * **Google Gemini / Antigravity API Key**
  * **OpenAI / Anthropic / Qwen (DashScope) / GLM (Zhipu AI)**
* Masked secure preview (`zen_...456`, `AIza...`) so secret keys are never exposed in plaintext.

### ⑂ 4. Complete Mobile Git Suite
* **Staging & Commits:** Per-file and bulk staging/unstaging, commit creation, and commit history graph.
* **Diff Viewer:** Live side-by-side and unified diffs with syntax highlighting.
* **Remote Manager:** Add, edit, or remove Git `origin` remotes with custom SSH/HTTPS URLs.
* **1-Tap Merge Conflict Resolver:** Interactive 3-way conflict cards (*Accept Ours / Accept Theirs / Custom Edit*).
* **Stash Roundtrip:** Create, inspect, pop, and drop stashes.

### 📱 5. Built for Touch & Mobile Ergonomics
* **Full-Height Bottom Drawers:** Touch-scrollable cards with safe-area padding so no items are hidden behind Android navigation bars.
* **Terminal Drawer:** Built-in mini-terminal drawer to run shell commands in the active project directory.
* **Offline Asset Fallback:** Bundled local assets ensure the UI shell opens instantly without browser error screens.
* **Deterministic App Signing:** Updates install seamlessly in-place without signature conflicts.

---

## 🚀 Installation & Quick Start

### Option A: Install Android APK (Recommended)
1. Download the latest release APK from [GitHub Actions Releases](https://github.com/VictorCiorici/opencode-mobile/actions).
2. Install the APK on your Android device (Android 7.0+ supported).
3. Open **OpenForge** and start coding!

### Option B: Run via Browser / Termux PWA
Inside your Linux / Termux PRoot environment:

```bash
# Clone the repository
git clone https://github.com/VictorCiorici/opencode-mobile.git
cd opencode-mobile

# Start the bridge server
python3 -m uvicorn ocmb.main:app --app-dir server --host 127.0.0.1 --port 8787
```

Open Chrome on your phone and navigate to:
```
http://127.0.0.1:8787/ui
```
Tap **Chrome Menu ➔ Add to Home Screen** to install as a full-screen PWA.

---

## ⚙️ Configuration Environment Variables

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `OCMB_PORT` | `8787` | Bridge listening port |
| `OCMB_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for LAN access) |
| `OCMB_WORKSPACE` | `~/opencode-projects` | Default parent folder for new projects |
| `OCMB_OPENCODE_BIN` | `opencode` | Path to the OpenCode binary |
| `OCMB_TOKEN` | *unset* | Optional Bearer token for API authentication |

---

## 🧪 Automated Testing

OpenForge includes a complete pytest test suite covering models, favorites, Git operations, remotes, local LAN scanning, and authentication:

```bash
cd server
python3 -m pytest tests/ -v
```

All 10 automated test suites verify bridge resilience, non-git project fallbacks, and local model registration.

---

## 📜 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.
