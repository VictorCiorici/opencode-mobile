"""Git operations run directly in the project directory."""
from __future__ import annotations

import asyncio
import os


class GitError(Exception):
    pass


async def _run(pid_path: str, *args: str) -> str:
    proc = await asyncio.create_subprocess_exec(
        "git", *args,
        cwd=pid_path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise GitError(err.decode(errors="replace").strip() or f"git {args[0]} failed")
    return out.decode(errors="replace")


def _safe_path(root: str, rel: str) -> str:
    full = os.path.abspath(os.path.join(root, rel))
    if not full.startswith(os.path.abspath(root)):
        raise GitError("path escapes project root")
    return full


async def status(path: str) -> dict:
    porcelain = await _run(path, "status", "--porcelain=v1", "-b")
    staged, unstaged, untracked = [], [], []
    for line in porcelain.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        x, y, name = line[0], line[1], line[3:].strip()
        entry = {"x": x, "y": y, "path": name}
        if x == "?" :
            untracked.append(entry)
        elif x not in (" ", "?"):
            staged.append(entry)
        elif y != " ":
            unstaged.append(entry)
    branch = porcelain.splitlines()[0][2:] if porcelain else ""
    return {"branch": branch, "staged": staged, "unstaged": unstaged, "untracked": untracked}


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
        await _run(path, "add", "--", *[(_safe_path(path, f).removeprefix(os.path.abspath(path)).lstrip("/") or ".") for f in files])
    else:
        await _run(path, "add", "-A")


async def unstage(path: str, files: list[str] | None) -> None:
    if files:
        rels = [_safe_path(path, f).removeprefix(os.path.abspath(path)).lstrip("/") for f in files]
        await _run(path, "reset", "--", *rels)
    else:
        await _run(path, "reset")


async def unstage(path: str, files: list[str] | None) -> None:
    if files:
        await _run(path, "reset", "--", *files)
    else:
        await _run(path, "reset")


async def commit(path: str, message: str) -> str:
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
    return (await _run(path, "checkout", "-b", name)).strip() or f"created {name}"


async def checkout(path: str, ref: str) -> str:
    return (await _run(path, "checkout", ref)).strip() or f"on {ref}"


async def discard(path: str, file_rel: str) -> str:
    full = _safe_path(path, file_rel)
    rel = full.removeprefix(os.path.abspath(path)).lstrip("/")
    await _run(path, "checkout", "--", rel)
    return f"discarded changes in {rel}"


async def diff_file(path: str, file_rel: str, staged: bool = False) -> str:
    args = ["diff", "--no-color"]
    if staged:
        args.append("--cached")
    rel = _safe_path(path, file_rel).removeprefix(os.path.abspath(path)).lstrip("/")
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
    return (await _run(path, "branch", flag, name)).strip() or f"deleted {name}"


async def branch_rename(path: str, old: str, new: str) -> str:
    return (await _run(path, "branch", "-m", old, new)).strip() or f"{old} → {new}"


async def merge(path: str, ref: str) -> str:
    return (await _run(path, "merge", "--no-edit", ref)).strip() or f"merged {ref}"


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
    return (await _run(path, "branch", name)).strip() or f"created {name}"


async def revert_commit(path: str, ref: str) -> str:
    return (await _run(path, "revert", "--no-edit", ref)).strip() or f"reverted {ref[:8]}"


async def remotes(path: str) -> list[dict]:
    out = await _run(path, "remote", "-v")
    seen: dict[str, dict] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            r = seen.setdefault(parts[0], {"name": parts[0], "fetch": None, "push": None})
            if "(fetch)" in line:
                r["fetch"] = parts[1]
            elif "(push)" in line:
                r["push"] = parts[1]
    return list(seen.values())
