"""Git operations run directly in the project directory."""
from __future__ import annotations

import asyncio
import os
import signal
import subprocess
import sys

# Never block on an interactive credential prompt; fail instead.
_GIT_ENV = {"GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}
NETWORK_TIMEOUT = 300.0
DEFAULT_TIMEOUT = 60.0
_NETWORK_CMDS = ("push", "pull", "fetch", "clone")


class GitError(Exception):
    pass


async def _kill(proc, tree: bool = False) -> None:
    """Kill a subprocess (and, for shell commands, its children)."""
    try:
        if tree and sys.platform == "win32":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                           capture_output=True, timeout=10)
        elif tree:
            os.killpg(proc.pid, signal.SIGKILL)  # started with start_new_session
        else:
            proc.kill()
    except (ProcessLookupError, PermissionError, OSError, subprocess.SubprocessError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass
    try:
        await asyncio.wait_for(proc.wait(), timeout=5)
    except Exception:
        pass


async def _run(pid_path: str, *args: str, timeout: float | None = None) -> str:
    if timeout is None:
        timeout = NETWORK_TIMEOUT if args and args[0] in _NETWORK_CMDS else DEFAULT_TIMEOUT
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", *args,
            cwd=pid_path,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, **_GIT_ENV},
        )
    except OSError as e:  # git missing, or project folder gone
        raise GitError(f"cannot run git: {e}")
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        await _kill(proc)
        raise GitError(f"git {args[0] if args else ''} timed out after {timeout:g}s")
    except asyncio.CancelledError:
        await _kill(proc)
        raise
    if proc.returncode != 0:
        msg = err.decode(errors="replace").strip() or out.decode(errors="replace").strip()
        raise GitError(msg or f"git {args[0]} failed")
    return out.decode(errors="replace")


def _safe_path(root: str, rel: str) -> str:
    """Return an absolute path under root, rejecting traversal and symlink escapes."""
    abs_root = os.path.realpath(os.path.abspath(root))
    lexical = os.path.normpath(os.path.abspath(os.path.join(root, rel)))
    try:
        full = os.path.realpath(lexical)
    except OSError:
        full = lexical
    for candidate in (abs_root, os.path.abspath(root)):
        try:
            if os.path.commonpath([candidate, full]) == candidate:
                return full
        except ValueError:
            continue
    raise GitError("path escapes project root")


def _git_rel(root: str, rel: str) -> str:
    """Normalized path relative to root, safe to pass to git as a pathspec."""
    abs_root = os.path.abspath(root)
    norm = os.path.normpath(os.path.join(abs_root, rel))
    _safe_path(abs_root, rel)
    out = os.path.relpath(norm, abs_root).replace(os.sep, "/")
    if out in ("", "."):
        raise GitError("invalid path")
    return out


def _safe_name(name: str) -> str:
    """Remote names: plain identifiers, never option-like."""
    name = (name or "").strip()
    if not name or name.startswith("-") or any(c.isspace() or c in ":^~\\?*[" for c in name):
        raise GitError(f"invalid name: {name!r}")
    return name


def _safe_url(url: str) -> str:
    url = (url or "").strip()
    if not url or url.startswith("-") or any(c in url for c in "\r\n\0"):
        raise GitError("invalid url")
    return url


def _safe_ref(ref: str) -> str:
    ref = (ref or "").strip()
    if not ref or ref.startswith("-") or any(c.isspace() for c in ref) or "^" in ref or "~" in ref or ":" in ref:
        raise GitError(f"invalid reference name: {ref!r}")
    return ref


async def init_repo(path: str, branch: str = "main") -> str:
    cmd = ["init"]
    if branch:
        cmd += ["--initial-branch", branch]
    out = await _run(path, *cmd)
    try:
        await _run(path, "commit", "--allow-empty", "-m", "initial commit")
    except GitError:
        pass
    return out.strip() or f"initialized git repository on branch {branch}"


async def status(path: str) -> dict:
    empty = {
        "is_git": False,
        "clean": True,
        "branch": "",
        "staged": [],
        "unstaged": [],
        "untracked": [],
        "conflicts": [],
        "has_conflicts": False,
    }
    if not os.path.exists(os.path.join(path, ".git")):
        return empty
    try:
        porcelain = await _run(path, "status", "--porcelain=v1", "-b")
    except GitError:
        return empty
    staged, unstaged, untracked, conflicts = [], [], [], []
    for line in porcelain.splitlines():
        if len(line) < 4 or line.startswith("##"):
            continue
        x, y, name = line[0], line[1], line[3:].strip()
        entry = {"x": x, "y": y, "path": name}
        if x + y in ("DD", "AU", "UD", "UA", "DU", "AA", "UU") or x == "U" or y == "U":
            conflicts.append(entry)
        elif x == "?":
            untracked.append(entry)
        else:
            # "MM" etc. appear in both lists (staged change + further edits).
            if x != " ":
                staged.append(entry)
            if y != " ":
                unstaged.append(entry)
    branch = ""
    first = porcelain.splitlines()[0] if porcelain else ""
    if first.startswith("## "):
        branch = first[3:].split("...", 1)[0].strip()
        if branch.startswith("No commits yet on "):
            branch = branch[len("No commits yet on "):]
    return {
        "is_git": True,
        "clean": not (staged or unstaged or untracked or conflicts),
        "branch": branch,
        "staged": staged,
        "unstaged": unstaged,
        "untracked": untracked,
        "conflicts": conflicts,
        "has_conflicts": len(conflicts) > 0,
    }


async def log(path: str, limit: int = 30) -> list[dict]:
    fmt = "%H%x1f%an%x1f%ad%x1f%s"
    out = await _run(path, "log", f"-{limit}", f"--pretty=format:{fmt}", "--date=short")
    commits = []
    for line in out.splitlines():
        parts = line.split("\x1f")
        if len(parts) == 4:
            commits.append({"hash": parts[0][:8], "author": parts[1], "date": parts[2], "subject": parts[3]})
    return commits


async def diff(path: str, staged: bool = False) -> str:
    args = ["diff", "--no-color"]
    if staged:
        args.append("--cached")
    try:
        return await _run(path, *args)
    except GitError:
        return ""


async def stage(path: str, files: list[str] | None) -> None:
    if files:
        await _run(path, "add", "--", *[(_git_rel(path, f)) for f in files])
    else:
        await _run(path, "add", "-A")


async def unstage(path: str, files: list[str] | None) -> None:
    if files:
        rels = [_git_rel(path, f) for f in files]
        await _run(path, "reset", "--", *rels)
    else:
        await _run(path, "reset")


async def commit(path: str, message: str) -> str:
    if not (message or "").strip():
        raise GitError("commit message required")
    # Respect the staging area; only stage everything when nothing is staged
    # (the PWA asks the user to confirm that case).
    if not (await _run(path, "diff", "--cached", "--name-only")).strip():
        await stage(path, None)
    out = await _run(path, "commit", "-m", message)
    return out.strip()[:400]


async def push(path: str) -> str:
    return (await _run(path, "push")).strip() or "pushed"


async def pull(path: str) -> str:
    return (await _run(path, "pull")).strip() or "pulled"


async def branches(path: str) -> dict:
    cur = (await _run(path, "rev-parse", "--abbrev-ref", "HEAD")).strip()
    out = await _run(path, "branch", "--format=%(refname:short)")
    return {"current": cur, "all": [b.strip() for b in out.splitlines() if b.strip()]}


async def create_branch(path: str, name: str) -> str:
    return (await _run(path, "checkout", "-b", _safe_ref(name))).strip() or f"created {name}"


async def checkout(path: str, ref: str) -> str:
    return (await _run(path, "checkout", _safe_ref(ref))).strip() or f"on {ref}"


async def discard(path: str, file_rel: str) -> str:
    rel = _git_rel(path, file_rel)
    await _run(path, "checkout", "--", rel)
    return f"discarded changes in {rel}"


async def diff_file(path: str, file_rel: str, staged: bool = False) -> str:
    args = ["diff", "--no-color"]
    if staged:
        args.append("--cached")
    rel = _git_rel(path, file_rel)
    args += ["--", rel]
    try:
        return await _run(path, *args)
    except GitError:
        return ""


# ------------------------------- stashes -----------------------------------

def _stash_ref(index: int) -> str:
    if index < 0:
        raise GitError("invalid stash index")
    return f"stash@{{{index}}}"


async def stash_list(path: str) -> list[dict]:
    out = await _run(path, "stash", "list")
    stashes = []
    for i, line in enumerate(out.splitlines()):
        if not line.strip():
            continue
        # "stash@{0}: WIP on main: abc1234 message"
        rest = line.split(":", 1)[1].strip() if ":" in line else line
        stashes.append({"index": i, "label": rest})
    return stashes


async def stash_push(path: str, message: str | None = None) -> str:
    args = ["stash", "push"]
    if message:
        args += ["-m", message]
    out = await _run(path, *args)
    return out.strip() or "stashed"


async def stash_apply(path: str, index: int, pop: bool = False) -> str:
    ref = _stash_ref(index)
    cmd = "pop" if pop else "apply"
    out = await _run(path, "stash", cmd, ref)
    return out.strip() or f"{cmd}ed {ref}"


async def stash_drop(path: str, index: int) -> str:
    ref = _stash_ref(index)
    out = await _run(path, "stash", "drop", ref)
    return out.strip() or f"dropped {ref}"


# ------------------------------- branches ----------------------------------

async def branch_delete(path: str, name: str, force: bool = False) -> str:
    flag = "-D" if force else "-d"
    return (await _run(path, "branch", flag, _safe_ref(name))).strip() or f"deleted {name}"


async def branch_rename(path: str, old: str, new: str) -> str:
    return (await _run(path, "branch", "-m", _safe_ref(old), _safe_ref(new))).strip() or f"{old} → {new}"


async def merge(path: str, ref: str) -> str:
    return (await _run(path, "merge", "--no-edit", _safe_ref(ref))).strip() or f"merged {ref}"


async def graph(path: str, limit: int = 60) -> list[dict]:
    """Structured commit list (all branches, date order) for graph rendering."""
    fmt = "%H%x1f%P%x1f%h%x1f%d%x1f%s%x1f%an%x1f%ad"
    try:
        out = await _run(
            path, "log", "--all", "--date-order",
            f"--pretty=format:{fmt}", "--date=short", f"-{limit}",
        )
    except GitError:
        return []
    commits = []
    for line in out.splitlines():
        parts = line.split("\x1f")
        if len(parts) < 7:
            continue
        refs = [r.strip().strip("()") .replace("HEAD -> ", "")
                for r in parts[3].split(",")] if parts[3].strip() else []
        commits.append({
            "hash": parts[0],
            "short": parts[2],
            "parents": parts[1].split() if parts[1].strip() else [],
            "refs": [r for r in refs if r],
            "subject": parts[4],
            "author": parts[5],
            "date": parts[6],
        })
    return commits


async def branch_create(path: str, name: str) -> str:
    return (await _run(path, "branch", _safe_ref(name))).strip() or f"created {name}"


async def revert_commit(path: str, ref: str) -> str:
    return (await _run(path, "revert", "--no-edit", _safe_ref(ref))).strip() or f"reverted {ref[:8]}"


def _strip_userinfo(url: str) -> str:
    """Never echo credentials embedded in a remote URL (https://user:token@host/...)."""
    if "://" not in url:
        return url
    scheme, rest = url.split("://", 1)
    host_part, sep, tail = rest.partition("/")
    if "@" in host_part:
        host_part = host_part.rsplit("@", 1)[1]
    return f"{scheme}://{host_part}{sep}{tail}"


async def remotes(path: str) -> list[dict]:
    out = await _run(path, "remote", "-v")
    seen: dict[str, dict] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            r = seen.setdefault(parts[0], {"name": parts[0], "fetch": None, "push": None})
            if "(fetch)" in line:
                r["fetch"] = _strip_userinfo(parts[1])
            elif "(push)" in line:
                r["push"] = _strip_userinfo(parts[1])
    return list(seen.values())


async def remote_add(path: str, name: str, url: str) -> str:
    out = await _run(path, "remote", "add", _safe_name(name), _safe_url(url))
    return out.strip() or f"remote {name} added"


async def remote_set_url(path: str, name: str, url: str) -> str:
    out = await _run(path, "remote", "set-url", _safe_name(name), _safe_url(url))
    return out.strip() or f"remote {name} updated"


async def remote_remove(path: str, name: str) -> str:
    out = await _run(path, "remote", "remove", _safe_name(name))
    return out.strip() or f"remote {name} removed"


async def fetch(path: str, remote: str = "origin") -> str:
    out = await _run(path, "fetch", _safe_name(remote))
    return out.strip() or f"fetched from {remote}"


async def resolve_conflict(path: str, file_rel: str, choice: str = "ours") -> str:
    rel = _git_rel(path, file_rel)
    if choice not in ("ours", "theirs"):
        raise GitError("choice must be 'ours' or 'theirs'")
    flag = "--ours" if choice == "ours" else "--theirs"
    await _run(path, "checkout", flag, "--", rel)
    await stage(path, [rel])
    return f"resolved {rel} using {choice}"


MAX_EXEC_OUTPUT = 1_000_000


async def exec_cmd(path: str, command: str, timeout: float = 30.0) -> dict:
    """Execute a shell command in the project directory.

    This is the explicit terminal feature: the command is run by the shell by
    design (the caller is authenticated). Timeout is clamped to 1..120s and the
    process is killed on expiry."""
    if not (command or "").strip():
        raise ValueError("command required")
    if not timeout or timeout <= 0 or timeout > 120:
        timeout = 30.0
    proc = await asyncio.create_subprocess_shell(
        command,
        cwd=path,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=(sys.platform != "win32"),
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return {
            "ok": proc.returncode == 0,
            "code": proc.returncode,
            "stdout": out[:MAX_EXEC_OUTPUT].decode(errors="replace"),
            "stderr": err[:MAX_EXEC_OUTPUT].decode(errors="replace"),
        }
    except asyncio.TimeoutError:
        await _kill(proc, tree=True)
        return {
            "ok": False,
            "code": -1,
            "stdout": "",
            "stderr": f"Command timed out after {timeout:g}s",
        }
    except asyncio.CancelledError:
        await _kill(proc, tree=True)
        raise
