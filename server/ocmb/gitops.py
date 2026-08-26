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
