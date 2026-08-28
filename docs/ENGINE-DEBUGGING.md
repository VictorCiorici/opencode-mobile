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
| 5 | Engine "found" but never runs; version always `?` | Binary not bundled at first; then a chain of exec failures (see below) | **In progress** | `7f90db7`, `280601e` |
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

### 5e. `signal: bad system call` persists with glibc 2.36 — **OPEN**
Termux's proot shields its tracees from some seccomp traps (it intercepts and
rewrites syscalls); a directly-spawned loader+engine does not get that
protection. Prime suspect: **`rseq(2)`** — glibc ≥ 2.35 registers it at
startup, bionic never calls it, so Android's allowlist lacks it.

Shipped prophylaxis: the daemon now sets
`GLIBC_TUNABLES=glibc.pthread.rseq=0` for every engine spawn (commit on
branch; build in flight). Manual drawer verification is pending.

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
F=/data/data/com.openforge/files; $F/bin/ld-linux-aarch64.so.1 --library-path $F/lib $F/bin/opencode --version
```

---

## Next steps — decision tree

### If the rseq tunable fixes it (`1.18.23` in drawer test)
1. Confirm the new APK shows `opencode 1.18.x — healthy ✓` in the About box.
2. Open Models tab → expect Zen/Go models with badge `(engine)`.
3. Re-save keys once if they were cleared (auth entries self-heal via the
   read-side migration, commit `4e8e90c`).
4. Close out: bump `versionCode`, tag a release.

### If SIGSYS persists (rseq was not the only blocked syscall)
Ordered strategies, cheapest first:

1. **Isolate the syscall** — the app is a debug build (ptrace allowed):
   bundle a static `strace` (aarch64) into the runtime zip and run
   `strace -f -e trace=none -o /dev/null loader engine --version` from the
   drawer to catch the exact SIGSYS syscall number (si_syscall), then add a
   targeted workaround/tunable.
2. **More tunables** — candidates: `glibc.mem.tagging=0`, `glibc.cpu.hwcaps`,
   and bun-side env (`BUN_…`). Cheap to try; each is a one-line env addition
   in `engineCommand`.
3. **proot wrapper (battle-tested)** — bundle a static `proot` (aarch64) plus
   a minimal rootfs; spawn the engine as
   `proot -0 -r <rootfs> <loader> <engine> serve …`. This is exactly the
   mechanism the user's Termux Debian uses and is proven to shield glibc from
   Android's filter on this device. Cost: ~2–5 MB extra, some spawn latency.
4. **bionic-native engine** — investigate the Termux `opencode` package
   (built against bionic, needs no glibc). If redistributable, it may run
   without any loader wrapper; must verify its `$PREFIX` dependencies.

### Unrelated follow-ups worth doing
- `findOpenCodeBinary` still probes a `/data/data/com.openforge/lib` symlink
  that modern Android no longer creates — dead candidate, can be removed.
- `RuntimeInstaller` re-copies the whole `web`/`bin` asset tree on every
  service start (only the runtime zip is fingerprint-skipped) — extend the
  fingerprint to cover those too.
- Python bridge (`server/`) never had the fake fallback, but its auth writer
  and model listing should be audited for the same `"key"` vs `"token"`
  contract (`auth_cfg.py` already writes `"key"` ✓).
- Consider surfacing `health.opencode.path/error` in the Settings engine
  section (currently only the About box shows it).

---

## Key files

| Area | File |
|------|------|
| Engine spawn + loader wrapper + rseq env | `daemon/main.go` (`engineCommand`, `spawnLocked`, `handleHealth`) |
| Engine binary lookup paths | `daemon/main.go` (`findOpenCodeBinary`) |
| Auth save/read + legacy migration | `daemon/main.go` (`handleAuthToken`, `readAuthJSON`) |
| Model listing sources (engine → catalog → config) | `daemon/main.go` (`handleModels`, `catalogProviders`, `fetchEngineProviders`) |
| Runtime bundle extraction + fingerprint | `android/app/src/main/java/com/openforge/RuntimeInstaller.java` |
| Daemon lifecycle / stale replacement / install stamp | `android/app/src/main/java/com/openforge/ProcessManager.java` |
| CI bundling (engine + glibc runtime zip) | `.github/workflows/build-apk.yml` |
| targetSdk decision | `android/app/build.gradle` (targetSdk 28, with rationale) |
