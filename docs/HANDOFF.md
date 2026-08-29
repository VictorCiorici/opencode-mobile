# Dev Handoff — OpenForge engine/key debugging session (2026-08-27 → 08-29)

Continuation notes for development on another device. Read together with
`docs/ENGINE-DEBUGGING.md` (problems 1–5, all resolved).

## Current state — what works

- **Bundled engine runs in-app.** The APK ships `opencode-linux-arm64-musl`
  + Alpine musl loader + libstdc++/libgcc in `assets/runtime-arm64.zip`,
  extracted to `files/`. The daemon invokes
  `ld-musl-aarch64.so.1 --library-path <dir> opencode …`.
  Verified: `/api/health` shows `"version":"1.18.25"`, `error:""` **after a
  cold launcher relaunch** → the engine survives the zygote seccomp filter.
  Root cause of the long SIGSYS saga: Android kills glibc's
  `set_robust_list(99)` (also rseq 293 / clone3 435); musl never calls them.
  targetSdk is intentionally 28 (see build.gradle comment).
- Keys → models chain is code-correct (auth.json `"key"` shape, migration,
  StopAll+respawn on save).
- Model listing sources: engine `/config/providers` → models.dev catalog →
  config providers. Fake fallback catalog removed. UI badge honest.

## OPEN Problem 6 — Zen/Go keys not persisted after relaunch; only 6 default models — **FIXED**

**Root cause (found 2026-08-29, verified on-device):** a regression introduced
by the musl fix in `0a0e993`. `engineCommand` set
`XDG_DATA_HOME=<files>/tmp` (and `XDG_CONFIG_HOME`) for the engine. opencode
resolves its data dir via `XDG_DATA_HOME` when set, so the **engine** looked
for credentials in `files/tmp/opencode/auth.json` while the daemon writes
them to `files/.local/share/opencode/auth.json` (HOME-based). The engine
therefore never saw any credential: `opencode-go` was missing from
`/config/providers` and Zen listed only its free tier.

Fixes shipped:

- `daemon/main.go` `engineCommand`: only `TMPDIR` and `XDG_CACHE_HOME` point
  at `files/tmp`; `HOME=filesDir` stays and DATA/CONFIG are **not**
  redirected, so engine and daemon resolve the same auth.json.
- `writeAuthJSON` now returns errors; `/api/auth/token` surfaces save
  failures as HTTP 500 (`auth save failed: …`) instead of failing silently.
- versionCode/Name bumped to 6 / 0.5.1 for on-device identification.

Verified end-to-end on-device (Fold5, daemon-spawned engine):
`/api/auth/status` shows both keys configured; `/api/models` →
`source:"engine"` with `opencode` (60 models) **and** `opencode-go`
(24 models).

Symptoms reported on-device (v0.5.0, musl runtime build):

1. Setting a Zen or Go key in Settings → after app relaunch the key shows
   **"not set"** again.
2. Setting a key does **not** add models — only the **6 default ones**
   (these are the `opencode` Zen **free-tier** models: nemotron-*-free,
   hy3-free, …). The `opencode-go` provider never appears in
   `/config/providers`, which is consistent with the engine not seeing a
   valid Go credential in auth.json.

Symptom 2 is almost certainly the same root cause as symptom 1 (no
persisted credential → engine lists only the free tier).

### Verified already (do not re-investigate)

- UI save handlers are correct: `POST /api/auth/token` with
  `provider_id:"opencode"` / `"opencode-go"` (`pwa/js/app.js:992,1004`).
- Daemon handler writes `{"type":"api","key":…}` into
  `$HOME/.local/share/opencode/auth.json` and calls `instMgr.StopAll()`
  so the engine respawns with fresh creds (`daemon/main.go`,
  `handleAuthToken`, `readAuthJSON` migration).
- `writeFileSecret` (0600) is sound; `writeAuthJSON` ignores errors —
  add error surfacing if the write turns out to fail.
- Status reads back `"key"` then `"token"` (`authStatusPayload.getTok`).
- Engine HOME = daemon HOME = `filesDir` (set in `ProcessManager`), so
  daemon and engine agree on the auth.json path.

### Hypotheses, ranked

1. **Port 8787 ownership race with the proot Python bridge (most likely).**
   The dev environment is Termux + proot Debian on the same phone; the
   Python bridge (`run.sh`, stores keys in `/root/.local/share/opencode/`)
   implements the same API. If the bridge grabs :8787 while the APK daemon
   is down/restarting, keys saved from the app UI land in the **proot
   filesystem**, and the APK engine never sees them. Check `uvicorn`
   processes and who binds 8787 over a daemon restart cycle.
2. **Stale/parallel daemon** — the "already healthy" shortcut could attach
   the UI to a daemon with a different `HOME` (e.g. one started by an older
   APK or from adb). Install-stamp logic (`7c71441`) should prevent this;
   verify pid file contents vs actual listener.
3. **Silent write failure** — `writeAuthJSON` discards errors. If
   `files/.local/share/opencode/` can't be created/owned correctly, the
   write dies quietly and status would show "not set" *immediately* after
   save (distinguishing test below).
4. **Engine rewrites auth.json** — not observed, but worth ruling out once
   the file is confirmed to exist (watch mtime after engine spawn).

### First diagnostics for the next session

Run in the app terminal drawer (runs as the app uid; each command is a
fresh shell — no `cd` persistence):

```sh
ls -la /data/data/com.openforge/files/.local/share/opencode/
head -c 400 /data/data/com.openforge/files/.local/share/opencode/auth.json
curl -s http://127.0.0.1:8787/api/health
```

Decision tree:

- auth.json **missing** right after a save → hypothesis 3 (write fails) →
  surface `writeAuthJSON` errors via `/api/auth/token` response and health.
- auth.json **exists with the key** but status shows "not set" after
  relaunch → the relaunch-time reader is a different process (hypotheses
  1/2) → check which server owns :8787 across a restart cycle, and whether
  `daemon_version` ever goes missing from health (bridge has no field).
- auth.json exists and status shows configured, but `opencode-go` still
  missing from `/config/providers` → engine-side: check
  `StopAll()` actually killed old instances, and add the engine's
  `auth.json` read errors to health diagnostics.

Also worth confirming: does Settings show `configured (xxxx…)`
*immediately* after save (before relaunch)? That splits write-time vs
read-time failure cleanly.

## Environment notes (dev box = the phone itself)

- Termux + proot Debian; repo at `/android-files` (a bind mount of
  `/data/data/com.termux/files/home/storage/shared/Work`).
- **Go builds fail on this FS** ("RLock go.mod: function not implemented") —
  copy `daemon/*.go` + `go.mod` to `/tmp/opencode/build/` and build/test
  there. No `go.sum` (stdlib only).
- `adb` is NOT available inside this environment; the user tests via the
  app UI, the terminal drawer, and occasionally adb from outside.
- Remember `run-as`/adb shells do **not** inherit the zygote seccomp
  filter — any engine test via adb is NOT evidence of in-app seccomp
  survival. Always confirm via launcher relaunch + health.
- CI: `.github/workflows/build-apk.yml` builds on push touching
  `android/** pwa/** server/** daemon/**`; APK artifact ~70 MB in run
  artifacts. Version: keep bumping `versionCode`/`versionName` per fix
  round (currently 5 / 0.5.0) so the running daemon version is
  identifiable via `health.daemon_version`.

## Suggested next fixes (after Problem 6)

- `writeAuthJSON`: return + log/surface errors.
- `extractZip` in `RuntimeInstaller`: clean removed entries (stale glibc
  runtime files survived the musl switch on devices that had both).
- Remove dead `/data/data/com.openforge/lib/libopencode.so` candidate in
  `findOpenCodeBinary` (symlink no longer created on modern Android).
- Extend the runtime fingerprint to cover the `web`/`bin` asset copies.
- Consider `/api/health` reporting `auth_json_path` + `auth_json_exists`
  to make Problem 6-class bugs diagnosable from the About box alone.
