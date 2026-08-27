"""Project registry: create/list/remove coding projects on this machine."""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import threading
from .config import WORKSPACE_DIR, REGISTRY_PATH

_lock = threading.Lock()


def _load() -> dict:
    if REGISTRY_PATH.exists():
        try:
            return json.loads(REGISTRY_PATH.read_text())
        except Exception:
            pass
    return {"projects": []}


def _save(reg: dict) -> None:
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY_PATH.write_text(json.dumps(reg, indent=2))


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
            subprocess.run(init, cwd=path, check=False, capture_output=True)
            subprocess.run(
                ["git", "commit", "--allow-empty", "-m", "initial commit"],
                cwd=path, check=False, capture_output=True,
            )
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
    base = name or os.path.basename(url.rstrip("/"))
    if base.endswith(".git"):
        base = base[:-4]
    slug = _slug(base or "project")
    with _lock:
        reg = _load()
        pid, i = slug, 2
        while any(p["id"] == pid for p in reg["projects"]):
            pid = f"{slug}-{i}"
            i += 1
        dest = os.path.join(get_workspace_dir(), pid)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        cmd = ["git", "clone"]
        if branch:
            cmd += ["--branch", branch]
        cmd += [url, dest]
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if proc.returncode != 0:
            shutil.rmtree(dest, ignore_errors=True)
            raise ValueError(f"git clone failed: {(proc.stderr or proc.stdout).strip()}")
        proj = {"id": pid, "name": base or pid, "path": dest, "created": True}
        reg["projects"].append(proj)
        _save(reg)
        return proj


async def remove_project(pid: str, delete_dir: bool = False) -> bool:
    from .manager import manager

    async with asyncio.Lock():
        reg = _load()
        keep = [p for p in reg["projects"] if p["id"] != pid]
        if len(keep) == len(reg["projects"]):
            return False
        reg["projects"] = keep
        _save(reg)
    await manager.stop_instance(pid)
    path = os.path.join(str(WORKSPACE_DIR), pid)
    if delete_dir and os.path.isdir(path) and os.path.abspath(path).startswith(os.path.abspath(str(WORKSPACE_DIR))):
        shutil.rmtree(path, ignore_errors=True)
    return True
