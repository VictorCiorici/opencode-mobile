# OpenForge Agent Guidelines

## Exploration Scope — MUST Follow

When exploring the codebase at `/storage/emulated/0/WORK/opencode-mobile` (or `/android-files/opencode-mobile` in proot):

**DO:**
- Limit `Glob` to specific directories: `server/**/*.py`, `daemon/**/*.go`, `pwa/**/*.js` — never `**/*` from root.
- Use `Grep` with `include` filters (`*.go`, `*.py`, `*.js`) instead of reading every file.
- Cap `Read` to 2-3 targeted files after `Glob`/`Grep` identifies candidates.
- For top-level structure, use `Read` on the directory (lists entries) — do NOT recursive glob.

**DO NOT:**
- `Glob(pattern="**/*")` from repo root — scans `apk/` (271 MB), `.git/` (50k objects), `pwa/node_modules` (if present) and hangs for hours on Android FUSE/Scoped Storage.
- `Task(subagent_type="explore", prompt="Explore the repository thoroughly...")` without `maxFiles`/`timeout` — the default explore prompt is unbounded and will time out on this repo.
- Read `apk/*.apk` or `android/.gradle` — large binaries, not source.

**Timeouts:**
- Any `Task(..., subagent_type="explore")` must set `timeout: 30000` (30s) and `maxFiles: 50`.
- If a `Glob` returns >100 files, refine the pattern — don't `Read` all.

**Workspace Path Note:**
`/storage/emulated/0/WORK/opencode-mobile` and `/android-files/opencode-mobile` are the same directory via different mounts (Android scoped storage vs Termux/proot). Prefer the shorter proot path for tool calls to avoid double-scanning.

## Project Structure (for quick reference)

```
opencode-mobile/
├── daemon/          Go daemon (opencode serve spawner, git, file API)
├── server/ocmb/     Python bridge (FastAPI, same API as Go daemon)
├── pwa/             Web UI (js/app.js, sw.js)
├── android/         Gradle + RuntimeInstaller.java (asset extraction)
├── docs/            Handoff & debugging logs
└── apk/             Built APKs (ignored)
```

Key entry points: `daemon/main.go:436 spawnLocked`, `pwa/js/app.js:api()`, `server/ocmb/`.
