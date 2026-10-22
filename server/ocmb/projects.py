"""Project registry: create/list/remove coding projects on this machine."""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import threading
from . import config
from .config import WORKSPACE_DIR, write_private

_lock = threading.Lock()


def _load() -> dict:
    if config.REGISTRY_PATH.exists():
        try:
            data = json.loads(config.REGISTRY_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("projects"), list):
                return data
        except Exception:
            pass
    return {"projects": []}


def _save(reg: dict) -> None:
    write_private(config.REGISTRY_PATH, json.dumps(reg, indent=2), 0o644)


def list_projects() -> list[dict]:
    with _lock:
        return _load()["projects"]


def get_project(pid: str) -> dict | None:
    for p in list_projects():
        if p["id"] == pid:
            return p
    return None


def _slug(name: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9-_]+", "-", name.strip()).strip("-").lower()
    return s or "project"


def create_project(name: str, git_init: bool = True, branch: str = "main") -> dict:
    from .auth_cfg import get_workspace_dir
    slug = _slug(name)
    with _lock:
        reg = _load()
        ids = {p["id"] for p in reg["projects"]}
        pid, i = slug, 2
        while pid in ids:
            pid = f"{slug}-{i}"
            i += 1
        ws_dir = get_workspace_dir()
        path = os.path.join(ws_dir, pid)
        os.makedirs(path, exist_ok=True)
        if git_init and not os.path.isdir(os.path.join(path, ".git")):
            init = ["git", "init"]
            if branch:
                init += ["--initial-branch", branch]
            try:
                subprocess.run(init, cwd=path, check=False, capture_output=True, timeout=60)
                subprocess.run(
                    ["git", "commit", "--allow-empty", "-m", "initial commit"],
                    cwd=path, check=False, capture_output=True, timeout=60,
                )
            except (OSError, subprocess.TimeoutExpired):
                pass  # git unavailable: the project is still usable without it
        proj = {"id": pid, "name": name or pid, "path": path, "created": True}
        reg["projects"].append(proj)
        _save(reg)
        return proj


def import_project(path: str) -> dict:
    """Register an existing folder as a project."""
    full = os.path.abspath(os.path.expanduser(path.strip()))
    if not os.path.isdir(full):
        raise ValueError(f"not a folder: {full}")
    with _lock:
        reg = _load()
        if any(os.path.abspath(p["path"]) == full for p in reg["projects"]):
            raise ValueError("folder is already imported as a project")
        base = _slug(os.path.basename(full) or full)
        pid, i = base, 2
        while any(p["id"] == pid for p in reg["projects"]):
            pid = f"{base}-{i}"
            i += 1
        proj = {"id": pid, "name": os.path.basename(full) or pid, "path": full}
        reg["projects"].append(proj)
        _save(reg)
        return proj


def clone_project(url: str, name: str | None = None, branch: str | None = None) -> dict:
    """Clone a git repository into the workspace and register it."""
    from .auth_cfg import get_workspace_dir
    url = (url or "").strip()
    if not url:
        raise ValueError("repository URL required")
    if url.startswith("-") or any(c in url for c in "\r\n\0"):
        raise ValueError("invalid repository URL")
    branch = (branch or "").strip() or None
    if branch and (branch.startswith("-") or any(c.isspace() for c in branch)):
        raise ValueError("invalid branch name")
    base = (name or "").strip() or os.path.basename(url.rstrip("/").replace(":", "/"))
    if base.endswith(".git"):
        base = base[:-4]
    slug = _slug(base or "project")
    # Reserve the id + directory under the lock, but run the (slow) clone
    # outside it so the registry stays responsive.
    with _lock:
        reg = _load()
        taken = {p["id"] for p in reg["projects"]}
        ws = get_workspace_dir()
        pid, i = slug, 2
        while pid in taken or os.path.exists(os.path.join(ws, pid)):
            pid = f"{slug}-{i}"
            i += 1
        dest = os.path.join(ws, pid)
        os.makedirs(ws, exist_ok=True)
    cmd = ["git", "clone"]
    if branch:
        cmd += ["--branch", branch]
    cmd += ["--", url, dest]
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False,
                              timeout=600, stdin=subprocess.DEVNULL, env=env)
    except subprocess.TimeoutExpired:
        shutil.rmtree(dest, ignore_errors=True)
        raise ValueError("git clone timed out")
    except OSError as e:
        raise ValueError(f"git clone failed: {e}")
    if proc.returncode != 0:
        shutil.rmtree(dest, ignore_errors=True)
        raise ValueError(f"git clone failed: {(proc.stderr or proc.stdout).strip()}")
    with _lock:
        reg = _load()
        while any(p["id"] == pid for p in reg["projects"]):
            pid += "-x"
        proj = {"id": pid, "name": base or pid, "path": dest, "created": True}
        reg["projects"].append(proj)
        _save(reg)
        return proj


def _within(child: str, parent: str) -> bool:
    try:
        child, parent = os.path.realpath(child), os.path.realpath(parent)
        return child != parent and os.path.commonpath([child, parent]) == parent
    except ValueError:
        return False


async def remove_project(pid: str, delete_dir: bool = False) -> bool:
    """Unregister a project; with delete_dir also delete its folder, but only
    when that folder lives strictly inside the workspace (imported folders
    elsewhere are never deleted)."""
    from .manager import manager
    from .auth_cfg import get_workspace_dir

    with _lock:
        reg = _load()
        target = next((p for p in reg["projects"] if p["id"] == pid), None)
        if target is None:
            return False
        reg["projects"] = [p for p in reg["projects"] if p["id"] != pid]
        _save(reg)
    await manager.stop_instance(pid)
    path = target.get("path") or ""
    if delete_dir and os.path.isdir(path) and not os.path.islink(path) and _within(path, get_workspace_dir()):
        await asyncio.get_running_loop().run_in_executor(None, lambda: shutil.rmtree(path, ignore_errors=True))
    return True
