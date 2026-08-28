# OpenForge Engine Debugging — Problems, Solutions, Next Steps

Timeline of the "connected but no models" investigation on-device, with root
causes, fixes shipped (commit hashes), and what remains open.

---

## Problem index

| # | Symptom | Root cause | Status | Commit |
|---|---------|-----------|--------|--------|
| 1 | Phantom "OpenCode Zen" / Gemini (Antigravity) models listed offline | Hardcoded fallback catalog in the daemon | **Fixed** | `9eecf2e` |
| 2 | Keys (Zen / Go) lost after every APK update | Stale-daemon detection compared `versionName`, which never changed between builds → old daemon kept serving :8787 | **Fixed** | `7c71441` |
| 3 | Subscription models never listed even with keys set | Daemon wrote auth.json entries as `{"type":"api","token":…}`; opencode only honors `"key"` | **Fixed** | `4e8e90c` |
| 4 | Settings said "93 Models Active" while Models tab was empty | UI faked the count (`M.all?.length \|\| 93`) | **Fixed** | `37bd2e2` |
| 5 | Engine "found" but never runs; version always `?` | Binary not bundled at first; then a chain of exec failures (see below) | **Fixed** (5e: musl runtime) | `7f90db7`, `280601e` |
| 6 | Cold engine spawn timed out on mobile | `waitHealthy` gave up after 12 s | **Fixed** (25 s) | `37bd2e2` |
| 7 | models.dev catalog empty on slow networks | 3 s fetch timeout | **Fixed** (8 s) | `37bd2e2` |
| 8 | About box showed hardcoded "v0.3", no diagnostics | Static string; no error surfacing | **Fixed** | `7c71441`, `7c8df65` |

---

## Problem 5 in detail — the engine execution chain

Each fix exposed the next failure. Every stage below was verified live on the
device (terminal drawer) or locally (proot Debian reproduction).

### 5a. No engine in the APK at all
CI built only the Go daemon. `opencode` was never included, so the APK relied
on Termux installs. → CI now bundles the engine (see 5c for the current form).

### 5b. SELinux W^X blocks exec from app storage (targetSdk ≥ 29)
`files/bin/opencode` was fully extracted, exec bits set, yet `execve` returned
`Permission denied` (exit 126) from the terminal drawer. Android 10+ forbids
executing anything in writable app storage for apps targeting API 29+.
→ Partial fix: ship as `jniLibs` (nativeLibraryDir is exec-allowed) — but see
5c: final solution also lowers `targetSdk` to **28** (the Termux approach), so
extracted runtime under `files/` is exec-able again.

### 5c. `fork/exec …: no such file or directory` although the file exists
The musl engine build is **dynamically linked and non-PIE**:
`PT_INTERP = /lib/ld-musl-aarch64.so.1` — a path that does not exist on
Android → ENOENT from execve. Worse, musl's loader refuses non-PIE binaries
("Not a valid dynamic program"), so loader-invocation was impossible.
→ Switch to the **glibc build** (`opencode-linux-arm64.tar.gz`) and bundle
glibc's own loader: the daemon spawns
`ld-linux-aarch64.so.1 --library-path <libdir> opencode <args>`
(validated end-to-end locally: prints `1.18.23`).
Commits: `255dd27` (jniLibs attempt) → `7f90db7` (loader approach).

### 5d. `signal: bad system call` (SIGSYS) with glibc 2.43
Android's app seccomp filter killed the loader+engine. Ubuntu 24.04 glibc
2.43 uses syscalls the filter does not allowlist. Debian 12's glibc **2.36**
is proven to run under this device's filter (Termux proot daily use).
→ CI pins `libc6_2.36-9+deb12u*_arm64.deb` from the Debian pool. Commit:
`280601e`.

### 5e. `signal: bad system call` persists with glibc 2.36 — **FIXED (musl)**
Termux's proot shields its tracees from some seccomp traps (it intercepts and
rewrites syscalls); a directly-spawned loader+engine does not get that
protection.

**Root cause, identified live on-device** (ptrace tracer shim
`android/engine/seccomp-trace.c` installed as the loader; its stderr —
`SIGSYS-SYSCALL=99 arch=0xc00000b7 code=1` — is surfaced by
`/api/health.opencode.error`): Android's app seccomp filter **kills
`set_robust_list` (99 on arm64)**, which glibc calls unconditionally at
startup for every thread. `code=1` = `SECCOMP_RET_KILL_THREAD` — the SIGSYS
is *uncatchable*, and since stacked seccomp filters resolve to the
highest-precedence action, a `RET_ERRNO` shim cannot neutralize it either.
`clone3` (435) and `rseq` (293) are also not allowlisted. This is why:

- `GLIBC_TUNABLES=glibc.pthread.rseq=0` did not help (set_robust_list comes
  first),
- an in-loader seccomp `RET_ERRNO` shim could not help (KILL outranks ERRNO),
- every `run-as`/adb repro attempt succeeded — `run-as` never inherits the
  zygote-installed app filter, so the bug only manifests for daemon-spawned
  engines.

**Fix: switch the runtime to musl** (musl never calls `set_robust_list`,
`rseq`, or `clone3`):

- engine: `opencode-linux-arm64-musl.tar.gz` (Bun musl build) — links against
  Alpine `libstdc++.so.6` + `libgcc_s.so.1`, loaded via Alpine's
  `ld-musl-aarch64.so.1` with `--library-path <binDir>`.
- daemon `engineCommand` prefers `ld-musl-aarch64.so.1`; the glibc loader
  path remains only as a desktop/dev fallback.
- daemon also sets `TMPDIR`/`HOME`/`XDG_{CACHE,CONFIG,DATA}_HOME` to
  `files/tmp` — Android has no writable `/tmp`, so Bun aborted with
  `EACCES: mkdir '/tmp/opencode'` right after printing its banner (seen only
  once the SIGSYS was gone).

Verified end-to-end on-device (Z Fold5, daemon-spawned engine under the app
seccomp policy): `/api/health` → `"version":"1.18.25"`, `error:""`.

---

## Verification checklist (per install)

```sh
# 1. daemon is the current build
curl -s http://127.0.0.1:8787/api/health
#    expect daemon_version matching the installed versionName

# 2. engine resolves AND executes
#    expect "version":"1.18.x" and no "error" field
#    (health now reports engine path + exec error)

# 3. engine spawned
curl -s http://127.0.0.1:4100/config/providers | head -c 300
#    expect {"providers":[…]} with opencode / opencode-go entries
#    (port only exists after opening the Models tab once)

# 4. models listed
#    Models tab → providers with models; Settings badge shows "(engine)"
```

Useful drawer one-liners (single shell per command — no `cd` persistence):

```sh
F=/data/data/com.openforge/files; $F/bin/ld-musl-aarch64.so.1 --library-path $F/bin $F/bin/opencode --version
```

---

## Follow-ups worth doing

- `findOpenCodeBinary` still probes a `/data/data/com.openforge/lib` symlink
  that modern Android no longer creates — dead candidate, can be removed.
- The glibc fallback branch in `engineCommand` (loader + `rseq=0` tunable) is
  now desktop/dev-only; consider deleting it once Android-only.
- `RuntimeInstaller` re-copies the whole `web`/`bin` asset tree on every
  service start (only the runtime zip is fingerprint-skipped) — extend the
  fingerprint to cover those too.
- Python bridge (`server/`): audit its auth writer for the same `"key"` vs
  `"token"` contract (`auth_cfg.py` already writes `"key"` ✓).
- Consider surfacing `health.opencode.path/error` in the Settings engine
  section (currently only the About box shows it).
- Re-test on a second device/Android version: the blocked-syscall set
  (`set_robust_list`/`clone3`/`rseq`) varies by OEM policy; musl sidesteps
  all three, but Bun may still probe other syscalls on exotic builds
  (`seccomp-trace.c` will name the culprit via the health error field).

---

## Key files

| Area | File |
|------|------|
| Engine spawn + musl loader + TMPDIR/HOME env | `daemon/main.go` (`engineCommand`, `spawnLocked`, `handleHealth`) |
| Engine binary lookup paths | `daemon/main.go` (`findOpenCodeBinary`) |
| ptrace SIGSYS tracer (debug tool; expose blocked syscall via health error) | `android/engine/seccomp-trace.c` |
| Auth save/read + legacy migration | `daemon/main.go` (`handleAuthToken`, `readAuthJSON`) |
| Model listing sources (engine → catalog → config) | `daemon/main.go` (`handleModels`, `catalogProviders`, `fetchEngineProviders`) |
| Runtime bundle extraction + fingerprint | `android/app/src/main/java/com/openforge/RuntimeInstaller.java` |
| Daemon lifecycle / stale replacement / install stamp | `android/app/src/main/java/com/openforge/ProcessManager.java` |
| CI bundling (engine + musl runtime zip) | `.github/workflows/build-apk.yml` |
| targetSdk decision | `android/app/build.gradle` (targetSdk 28, with rationale) |
