"""opencode-mobile bridge: HTTP API between the Android/PWA client and
per-project `opencode serve` instances running on-device or proot."""
from __future__ import annotations

import asyncio
import hmac
import ipaddress
import os
import shutil
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

# Add bundled vendor libraries to python search path if present
_vendor = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "vendor"))
if os.path.isdir(_vendor) and _vendor not in sys.path:
    sys.path.insert(0, _vendor)

import httpx
from fastapi import FastAPI, Request, Response, Depends, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .config import AUTH_TOKEN, WORKSPACE_DIR, OPENCODE_BIN
from . import config
from . import projects as proj_store
from . import gitops
from . import models_cfg
from . import auth_cfg
from .manager import manager

PWA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "pwa"))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

    async def reaper() -> None:
        while True:
            await asyncio.sleep(300)
            await manager.reap_idle()

    task = asyncio.create_task(reaper())
    try:
        yield
    finally:
        task.cancel()
        # Don't leave `opencode serve` children running after shutdown.
        await manager.stop_all()


app = FastAPI(title="opencode-mobile", version="0.2.0", lifespan=lifespan)


# Route aliases accepted by the Go daemon (the PWA mixes both spellings).
_ALIASES = (
    ("/api/git/", "/git/"),
    ("/api/fs/", "/fs/"),
    ("/api/oc/", "/oc/"),
    ("/terminal/", "/api/terminal/"),
    ("/projects/", "/api/projects/"),
)
_EXACT_ALIASES = {
    "/projects": "/api/projects",
    "/browse": "/api/browse",
    "/health": "/api/health",
}


def _alias_path(path: str) -> str:
    if path in _EXACT_ALIASES:
        return _EXACT_ALIASES[path]
    for old, new in _ALIASES:
        if path.startswith(old):
            return new + path[len(old):]
    return path


class AliasMiddleware:
    """Pure-ASGI path rewrite so every daemon route spelling hits one handler."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            new = _alias_path(scope["path"])
            if new != scope["path"]:
                scope = dict(scope)
                scope["path"] = new
                scope["raw_path"] = new.encode()
        await self.app(scope, receive, send)


app.add_middleware(AliasMiddleware)


def _is_loopback(host: str) -> bool:
    host = host.strip("[]").lower()
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _host_only(value: str) -> str:
    value = value.strip()
    if value.startswith("["):  # [::1]:8787
        return value[1:value.find("]")] if "]" in value else value
    return value.rsplit(":", 1)[0] if value.count(":") == 1 else value


class HostGuardMiddleware:
    """Defeats DNS rebinding: while bound to loopback (where auth is usually
    off), a request whose Host is not a loopback name came from a web page that
    re-pointed its own domain at 127.0.0.1 — it must not reach the terminal."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket") and _is_loopback(config.HOST):
            host = ""
            for k, v in scope.get("headers") or ():
                if k == b"host":
                    host = _host_only(v.decode("latin-1"))
                    break
            if host and not _is_loopback(host) and host.lower() not in config.ALLOWED_HOSTS:
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1008})
                    return
                await send({"type": "http.response.start", "status": 403,
                            "headers": [(b"content-type", b"application/json")]})
                await send({"type": "http.response.body", "body": b'{"detail":"host not allowed"}'})
                return
        await self.app(scope, receive, send)


app.add_middleware(HostGuardMiddleware)


def _tok_eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


async def auth(request: Request) -> None:
    if not AUTH_TOKEN:
        return
    header = request.headers.get("authorization", "")
    if _tok_eq(header, f"Bearer {AUTH_TOKEN}"):
        return
    # EventSource cannot send headers, so ?token= is accepted ONLY for GETs
    # on the /oc/ proxy (SSE). Everywhere else tokens stay out of URLs/logs.
    if request.method == "GET" and request.url.path.startswith("/oc/") and \
            _tok_eq(request.query_params.get("token", ""), AUTH_TOKEN):
        return
    raise HTTPException(status_code=401, detail="unauthorized")


# ---------------------------------------------------------------- health ---

@app.get("/api/health")
async def health():
    """Public (like the Go daemon) so clients can detect that a token is needed."""
    healthy, version = False, ""
    try:
        async with httpx.AsyncClient(timeout=1.5) as c:
            r = await c.get("http://127.0.0.1:4096/global/health")
        info = r.json()
        healthy = bool(info.get("healthy"))
        version = str(info.get("version") or "")
    except Exception:
        pass
    path = shutil.which(OPENCODE_BIN) or ""
    return {
        "bridge": "ok",
        "auth": bool(AUTH_TOKEN),
        "daemon_version": app.version,
        "opencode": {
            "healthy": healthy or bool(path),
            "local": bool(path),
            "shared": healthy,
            "version": version,
            "path": path,
            "error": "",
        },
    }


# -------------------------------------------------------------- projects ---

class ProjectIn(BaseModel):
    name: str
    git_init: bool = True
    branch: str | None = None
    initial_branch: str | None = None  # Go-daemon compatible alias

    def resolved_branch(self) -> str:
        return self.initial_branch or self.branch or "main"


class CloneIn(BaseModel):
    url: str
    name: str | None = None
    branch: str | None = None


class ImportIn(BaseModel):
    path: str


@app.get("/api/projects")
async def list_projects(_: None = Depends(auth)):
    return {"projects": proj_store.list_projects(), "workspace": auth_cfg.get_workspace_dir()}


@app.post("/api/projects")
async def create_project(body: ProjectIn, _: None = Depends(auth)):
    branch = body.resolved_branch()
    if branch.startswith("-") or any(c.isspace() for c in branch):
        raise HTTPException(400, "invalid branch name")
    return await asyncio.to_thread(proj_store.create_project, body.name, body.git_init, branch)


@app.get("/api/projects/{pid}")
async def get_project(pid: str, _: None = Depends(auth)):
    p = proj_store.get_project(pid)
    if not p:
        raise HTTPException(404, "project not found")
    return p


@app.post("/api/projects/clone")
async def clone_project(body: CloneIn, _: None = Depends(auth)):
    try:
        return await asyncio.to_thread(proj_store.clone_project, body.url, body.name, body.branch)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/projects/{pid}")
async def delete_project(pid: str, delete_dir: bool = False, _: None = Depends(auth)):
    ok = await proj_store.remove_project(pid, delete_dir)
    if not ok:
        raise HTTPException(404, "project not found")
    return {"ok": True}


@app.post("/api/projects/import")
async def import_project(body: ImportIn, _: None = Depends(auth)):
    try:
        return await asyncio.to_thread(proj_store.import_project, body.path)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/browse")
def browse(path: str = "", _: None = Depends(auth)):
    # Plain `def`: runs in the threadpool, so directory scans never block the loop.
    full = os.path.realpath(os.path.abspath(os.path.expanduser(path))) if path.strip() else str(Path.home())
    if not os.path.isdir(full):
        raise HTTPException(400, "not a folder")
    entries = []
    try:
        for e in sorted(os.scandir(full), key=lambda x: (not x.is_dir(), x.name.lower())):
            if e.name.startswith(".") and e.name != ".gitignore":
                continue
            try:
                is_dir = e.is_dir()
            except OSError:
                is_dir = False
            entries.append({
                "name": e.name,
                "path": os.path.join(full, e.name),
                "is_dir": is_dir,
            })
            if len(entries) >= 500:
                break
    except OSError:
        pass
    parent_dir = os.path.dirname(full)
    return {
        "current": full,
        "path": full,
        "parent": parent_dir if parent_dir != full else "",
        "entries": entries,
    }


@app.post("/api/projects/{pid}/stop")
async def stop_project(pid: str, _: None = Depends(auth)):
    await manager.stop_instance(pid)
    return {"ok": True}


# ------------------------------------------------- opencode proxy (any) ---
# /oc/{pid}/<rest>  ->  http://127.0.0.1:<port>/<rest>
# Covers sessions, messages, events (SSE), files, agents, config, ...


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=None)


@app.api_route("/oc/{pid}/{rest:path}", methods=["GET", "POST", "PATCH", "DELETE", "PUT"])
async def proxy(pid: str, rest: str, request: Request, _: None = Depends(auth)):
    try:
        inst = await manager.get(pid)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except RuntimeError as e:
        raise HTTPException(502, str(e))

    url = f"{inst.url}/{rest}"
    # Never forward the bridge token (used for SSE) to the engine.
    fwd = [(k, v) for k, v in request.query_params.multi_items() if k != "token"]
    if fwd:
        url += f"?{urlencode(fwd)}"
    body = await request.body()
    headers = {k: v for k, v in request.headers.items()
               if k.lower() in ("content-type", "accept")}

    is_sse = rest == "event" or request.headers.get("accept") == "text/event-stream"

    if is_sse and request.method == "GET":
        async def stream():
            try:
                async with _client() as c:
                    async with c.stream("GET", url, headers=headers) as r:
                        async for chunk in r.aiter_bytes():
                            yield chunk
            except httpx.HTTPError:
                return  # engine went away: end the stream, client reconnects

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    async with _client() as c:
        try:
            r = await c.request(request.method, url, content=body or None, headers=headers)
        except httpx.HTTPError as e:
            raise HTTPException(502, f"opencode instance error: {e}")
    return Response(content=r.content, status_code=r.status_code,
                    media_type=r.headers.get("content-type", "application/json"))


# ---------------------------------------------------------------- models ---

class ModelIn(BaseModel):
    provider_id: str
    model_id: str
    options: dict | None = None
    set_default: bool = False


class ModelDel(BaseModel):
    provider_id: str
    model_id: str


from . import local_scanner

# ------------------------------------------------------------- local scan ---

class ScanIn(BaseModel):
    subnet: str | None = None
    include_lan: bool = True


class ProbeIn(BaseModel):
    host: str
    port: int = 11434
    path: str = "/api/tags"
    type: str = "ollama"
    name: str = "Ollama"


class RegisterLocalIn(BaseModel):
    provider_id: str
    name: str
    base_url: str
    models: list[dict | str] = []
    api_key: str = ""


@app.post("/api/models/scan-lan")
async def scan_lan(body: ScanIn = ScanIn(), _: None = Depends(auth)):
    servers = await local_scanner.scan_local_network(custom_subnet=body.subnet, include_lan=body.include_lan)
    return {"servers": servers, "count": len(servers)}


@app.post("/api/models/probe-host")
async def probe_host(body: ProbeIn, _: None = Depends(auth)):
    body.host = body.host.strip()
    if not local_scanner.valid_host(body.host):
        raise HTTPException(400, "invalid host")
    if not (0 < body.port < 65536) or not body.path.startswith("/"):
        raise HTTPException(400, "invalid port or path")
    async with httpx.AsyncClient() as client:
        res = await local_scanner.probe_endpoint(
            client, body.host, body.port, body.path, body.type, body.name
        )
    if not res:
        raise HTTPException(404, f"No AI model service found on {body.host}:{body.port}")
    return res


@app.post("/api/models/register-local")
async def register_local(body: RegisterLocalIn, _: None = Depends(auth)):
    if not body.provider_id.strip() or not body.base_url.strip():
        raise HTTPException(400, "provider_id and base_url are required")
    cfg = await asyncio.to_thread(
        local_scanner.register_local_provider,
        body.provider_id.strip(), body.name or body.provider_id, body.base_url.strip(),
        body.models, body.api_key,
    )
    return {"ok": True, "config": cfg}


def _normalize_providers(data: Any) -> list[dict]:
    """Normalize engine/catalog provider payloads to the PWA shape:
    providers:[{id, name, models: {model_id: {name}}}].
    The engine returns models as a list of objects; the catalog as a map."""
    provs = data.get("providers") if isinstance(data, dict) else data
    out = []
    for p in provs or []:
        if not isinstance(p, dict):
            continue
        pid = p.get("id") or p.get("name") or ""
        if not pid:
            continue
        models_in = p.get("models")
        models: dict = {}
        if isinstance(models_in, list):
            for m in models_in:
                if isinstance(m, dict) and m.get("id"):
                    models[m["id"]] = {"name": m.get("name") or m["id"]}
        elif isinstance(models_in, dict):
            for mid, mv in models_in.items():
                name = mv.get("name") if isinstance(mv, dict) else None
                models[mid] = {"name": name or mid}
        out.append({
            "id": pid,
            "name": p.get("name") or pid,
            "models": models,
            "source": p.get("source") or "engine",
        })
    return out


_FALLBACK_MODELS = {
    "opencode": {
        "id": "opencode",
        "name": "OpenCode Zen",
        "models": {
            "claude-3-7-sonnet": {"name": "Claude 3.7 Sonnet (Thinking)"},
            "claude-3-5-sonnet": {"name": "Claude 3.5 Sonnet"},
            "gemini-2.5-pro": {"name": "Gemini 2.5 Pro"},
            "gemini-2.5-flash": {"name": "Gemini 2.5 Flash"},
            "gpt-4o": {"name": "GPT-4o"},
            "deepseek-r1": {"name": "DeepSeek R1 (Reasoning)"},
            "qwen-2.5-coder": {"name": "Qwen 2.5 Coder"},
        },
    },
}


async def _live_catalog() -> dict:
    """Fetch models.dev (the live Zen catalog lives under provider 'opencode');
    fall back to a small offline registry when unreachable."""
    try:
        async with httpx.AsyncClient(timeout=3.0) as c:
            r = await c.get("https://models.dev/api.json")
            if r.status_code == 200:
                return r.json()
    except Exception:
        pass
    return _FALLBACK_MODELS


def _config_providers() -> list[dict]:
    """Providers declared in the user's opencode.json (local/LAN/custom)."""
    cfg = models_cfg._read(models_cfg._config_paths(None)[-1])
    out = []
    provs = cfg.get("provider")
    for pid, p in (provs.items() if isinstance(provs, dict) else []):
        if not isinstance(p, dict):
            continue
        mm = p.get("models") if isinstance(p.get("models"), dict) else {}
        out.append({
            "id": pid,
            "name": p.get("name") or pid,
            "models": {mid: {"name": (mv.get("name") if isinstance(mv, dict) else None) or mid}
                       for mid, mv in mm.items()},
            "source": "config",
        })
    return out


async def _catalog_providers() -> list[dict]:
    live = await _live_catalog()
    providers = []
    for pid in ("opencode", "opencode-go", "google", "anthropic", "openai", "deepseek"):
        entry = live.get(pid) if isinstance(live, dict) else None
        if isinstance(entry, dict):
            providers.append({
                "id": pid,
                "name": entry.get("name") or pid,
                "models": entry.get("models") or {},
                "source": "catalog",
            })
    return providers


async def _catalog_response() -> dict:
    provs = await _catalog_providers()
    have = {p["id"] for p in provs}
    provs += [p for p in _config_providers() if p["id"] not in have]
    return {"providers": provs, "source": "catalog"}


@app.get("/api/models/global")
@app.get("/api/models/default")
async def list_global_models(_: None = Depends(auth)):
    """No project open: browse the live model catalog (Zen et al.)."""
    return await _catalog_response()


@app.get("/api/models/{pid}")
async def list_models(pid: str, _: None = Depends(auth)):
    """Engine providers when an opencode engine is reachable, else the catalog
    + local config (same degradation as the Go daemon)."""
    try:
        inst = await manager.get(pid)
        async with _client() as c:
            r = await c.get(f"{inst.url}/config/providers", timeout=10.0)
        if r.status_code != 200:
            raise RuntimeError("engine returned %d" % r.status_code)
        data = r.json()
    except (KeyError, RuntimeError, httpx.HTTPError, ValueError):
        return await _catalog_response()
    providers = _normalize_providers(data)
    have = {p["id"] for p in providers}
    providers += [p for p in await _catalog_providers() if p["id"] not in have]
    return {"providers": providers, "source": "engine",
            "default_model": data.get("default") if isinstance(data, dict) else None}


@app.post("/api/models/{pid}")
async def add_model(pid: str, body: ModelIn, _: None = Depends(auth)):
    if not body.provider_id.strip() or not body.model_id.strip():
        raise HTTPException(400, "provider_id and model_id are required")
    proj = proj_store.get_project(pid)
    cfg = await asyncio.to_thread(
        models_cfg.add_model, body.provider_id, body.model_id, body.options,
        proj["path"] if proj else None, body.set_default)
    return {"ok": True, "config": cfg}


@app.delete("/api/models/{pid}")
async def del_model(pid: str, body: ModelDel, _: None = Depends(auth)):
    cfg = await asyncio.to_thread(models_cfg.remove_model, body.provider_id, body.model_id)
    return {"ok": True, "config": cfg}


# ------------------------------------------------------------- auth & settings ---

class TokenIn(BaseModel):
    provider_id: str = "opencode"
    token: str
    base_url: str | None = None


class TokenDel(BaseModel):
    provider_id: str = "opencode"


class WorkspaceIn(BaseModel):
    path: str


@app.get("/api/auth/status")
async def get_auth_status(_: None = Depends(auth)):
    return await asyncio.to_thread(auth_cfg.get_auth_status)


@app.post("/api/auth/token")
async def save_token(body: TokenIn, _: None = Depends(auth)):
    provider = (body.provider_id or "opencode").strip()
    tok = body.token.strip()
    try:
        if provider == "github" and tok:
            try:
                login = await asyncio.to_thread(auth_cfg.validate_github_token, tok)
            except ValueError as e:
                raise HTTPException(400, f"GitHub token invalid: {e}")
            res = await asyncio.to_thread(auth_cfg.save_provider_key, provider, tok, None, login)
        else:
            res = await asyncio.to_thread(auth_cfg.save_provider_key, provider, tok, body.base_url)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if provider != "github":
        # Engines cache credentials at spawn time: respawn with the new ones.
        await manager.stop_all()
    return {"ok": True, "status": res}


@app.delete("/api/auth/token")
async def delete_token(body: TokenDel, _: None = Depends(auth)):
    res = await asyncio.to_thread(auth_cfg.remove_token, body.provider_id)
    if body.provider_id != "github":
        await manager.stop_all()
    return {"ok": True, "status": res}


@app.get("/api/settings/workspace")
async def get_workspace_setting(_: None = Depends(auth)):
    return {"workspace_dir": auth_cfg.get_workspace_dir()}


@app.post("/api/settings/workspace")
async def set_workspace_setting(body: WorkspaceIn, _: None = Depends(auth)):
    try:
        p = await asyncio.to_thread(auth_cfg.set_workspace_dir, body.path)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except OSError as e:
        raise HTTPException(400, f"cannot use that folder: {e}")
    return {"ok": True, "workspace_dir": p}


# ------------------------------------------------------------- favorites ---

class FavIn(BaseModel):
    provider_id: str
    model_id: str


@app.get("/api/favorites")
async def get_favorites(_: None = Depends(auth)):
    return {"favorites": models_cfg.list_favorites()}


@app.post("/api/favorites")
async def toggle_favorite(body: FavIn, _: None = Depends(auth)):
    favs, added = models_cfg.toggle_favorite(body.provider_id, body.model_id)
    return {"favorites": favs, "added": added}


# ------------------------------------------------------------------- git ---

class CommitIn(BaseModel):
    message: str


class BranchIn(BaseModel):
    name: str


class RefIn(BaseModel):
    ref: str


class StageIn(BaseModel):
    files: list[str] | None = None


def _proj_or_404(pid: str) -> str:
    p = proj_store.get_project(pid)
    if not p:
        raise HTTPException(404, "project not found")
    return p["path"]


class InitIn(BaseModel):
    branch: str = "main"


@app.post("/git/{pid}/init")
async def git_init(pid: str, body: InitIn | None = None, _: None = Depends(auth)):
    try:
        return {"ok": True, "out": await gitops.init_repo(_proj_or_404(pid), body.branch if body else "main")}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.get("/git/{pid}/status")
async def git_status(pid: str, _: None = Depends(auth)):
    try:
        return await gitops.status(_proj_or_404(pid))
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.get("/git/{pid}/log")
async def git_log(pid: str, limit: int = 30, _: None = Depends(auth)):
    if limit <= 0 or limit > 200:
        limit = 30
    try:
        return {"commits": await gitops.log(_proj_or_404(pid), limit)}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.get("/git/{pid}/diff")
async def git_diff(pid: str, staged: bool = False, file: str = "", path: str = "", _: None = Depends(auth)):
    """Unified diff. Accepts an optional per-file target via ?file= or ?path=
    (Go-daemon compatible)."""
    try:
        target = file or path or ""
        if target:
            return {"diff": await gitops.diff_file(_proj_or_404(pid), target, staged)}
        return {"diff": await gitops.diff(_proj_or_404(pid), staged)}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.post("/git/{pid}/stage")
async def git_stage(pid: str, body: StageIn | None = None, _: None = Depends(auth)):
    try:
        await gitops.stage(_proj_or_404(pid), body.files if body else None)
        return {"ok": True}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.post("/git/{pid}/unstage")
async def git_unstage(pid: str, body: StageIn | None = None, _: None = Depends(auth)):
    try:
        await gitops.unstage(_proj_or_404(pid), body.files if body else None)
        return {"ok": True}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.post("/git/{pid}/commit")
async def git_commit(pid: str, body: CommitIn, _: None = Depends(auth)):
    try:
        return {"ok": True, "out": await gitops.commit(_proj_or_404(pid), body.message)}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.post("/git/{pid}/push")
async def git_push(pid: str, _: None = Depends(auth)):
    try:
        return {"ok": True, "out": await gitops.push(_proj_or_404(pid))}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.post("/git/{pid}/pull")
async def git_pull(pid: str, _: None = Depends(auth)):
    try:
        return {"ok": True, "out": await gitops.pull(_proj_or_404(pid))}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.get("/git/{pid}/branches")
async def git_branches(pid: str, _: None = Depends(auth)):
    try:
        return await gitops.branches(_proj_or_404(pid))
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.post("/git/{pid}/branch")
async def git_new_branch(pid: str, body: BranchIn, _: None = Depends(auth)):
    try:
        return {"ok": True, "out": await gitops.create_branch(_proj_or_404(pid), body.name)}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.post("/git/{pid}/checkout")
async def git_checkout(pid: str, body: RefIn, _: None = Depends(auth)):
    try:
        return {"ok": True, "out": await gitops.checkout(_proj_or_404(pid), body.ref)}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.post("/git/{pid}/discard")
async def git_discard(pid: str, body: RefIn, _: None = Depends(auth)):
    try:
        return {"ok": True, "out": await gitops.discard(_proj_or_404(pid), body.ref)}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


# ------------------------------------------------- advanced git (v2) -------

class FileIn(BaseModel):
    path: str
    staged: bool = False


class StashPushIn(BaseModel):
    message: str | None = None


class StashIndexIn(BaseModel):
    index: int


class BranchDelIn(BaseModel):
    name: str
    force: bool = False


class BranchRenameIn(BaseModel):
    old: str
    new: str


@app.get("/git/{pid}/diff/file")
async def git_diff_file(pid: str, path: str, staged: bool = False, _: None = Depends(auth)):
    try:
        return {"diff": await gitops.diff_file(_proj_or_404(pid), path, staged)}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.get("/git/{pid}/stash")
async def git_stash_list(pid: str, _: None = Depends(auth)):
    try:
        return {"stashes": await gitops.stash_list(_proj_or_404(pid))}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.post("/git/{pid}/stash")
async def git_stash_push(pid: str, body: StashPushIn | None = None, _: None = Depends(auth)):
    try:
        return {"ok": True,
                "out": await gitops.stash_push(_proj_or_404(pid), body.message if body else None)}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.post("/git/{pid}/stash/apply")
async def git_stash_apply(pid: str, body: StashIndexIn, _: None = Depends(auth)):
    try:
        return {"ok": True, "out": await gitops.stash_apply(_proj_or_404(pid), body.index)}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.post("/git/{pid}/stash/pop")
async def git_stash_pop(pid: str, body: StashIndexIn, _: None = Depends(auth)):
    try:
        return {"ok": True, "out": await gitops.stash_apply(_proj_or_404(pid), body.index, pop=True)}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.post("/git/{pid}/stash/drop")
async def git_stash_drop(pid: str, body: StashIndexIn, _: None = Depends(auth)):
    try:
        return {"ok": True, "out": await gitops.stash_drop(_proj_or_404(pid), body.index)}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.get("/git/{pid}/graph")
async def git_graph(pid: str, limit: int = 60, _: None = Depends(auth)):
    if limit <= 0 or limit > 300:
        limit = 60
    try:
        p = _proj_or_404(pid)
        return {
            "commits": await gitops.graph(p, limit),
            "branches": await gitops.branches(p),
            "remotes": await gitops.remotes(p),
            "status": await gitops.status(p),
        }
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


class BranchCreateIn(BaseModel):
    name: str


@app.get("/git/{pid}/remotes")
async def git_remotes(pid: str, _: None = Depends(auth)):
    try:
        return {"remotes": await gitops.remotes(_proj_or_404(pid))}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.post("/git/{pid}/branch/create")
async def git_branch_create(pid: str, body: BranchCreateIn, _: None = Depends(auth)):
    try:
        return {"ok": True, "out": await gitops.branch_create(_proj_or_404(pid), body.name)}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.post("/git/{pid}/revert")
async def git_revert(pid: str, body: RefIn, _: None = Depends(auth)):
    try:
        return {"ok": True, "out": await gitops.revert_commit(_proj_or_404(pid), body.ref)}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.post("/git/{pid}/branch/delete")
async def git_branch_delete(pid: str, body: BranchDelIn, _: None = Depends(auth)):
    try:
        return {"ok": True, "out": await gitops.branch_delete(_proj_or_404(pid), body.name, body.force)}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.post("/git/{pid}/branch/rename")
async def git_branch_rename(pid: str, body: BranchRenameIn, _: None = Depends(auth)):
    try:
        return {"ok": True, "out": await gitops.branch_rename(_proj_or_404(pid), body.old, body.new)}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.post("/git/{pid}/merge")
async def git_merge(pid: str, body: RefIn, _: None = Depends(auth)):
    try:
        return {"ok": True, "out": await gitops.merge(_proj_or_404(pid), body.ref)}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


class RemoteIn(BaseModel):
    name: str
    url: str


class RemoteNameIn(BaseModel):
    name: str


class ResolveIn(BaseModel):
    path: str
    choice: str = "ours"


class ExecIn(BaseModel):
    command: str
    timeout: float = 30.0


@app.post("/git/{pid}/remote/add")
async def git_remote_add(pid: str, body: RemoteIn, _: None = Depends(auth)):
    try:
        return {"ok": True, "out": await gitops.remote_add(_proj_or_404(pid), body.name, body.url)}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.post("/git/{pid}/remote/set-url")
async def git_remote_set_url(pid: str, body: RemoteIn, _: None = Depends(auth)):
    try:
        return {"ok": True, "out": await gitops.remote_set_url(_proj_or_404(pid), body.name, body.url)}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.post("/git/{pid}/remote/remove")
async def git_remote_remove(pid: str, body: RemoteNameIn, _: None = Depends(auth)):
    try:
        return {"ok": True, "out": await gitops.remote_remove(_proj_or_404(pid), body.name)}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.post("/git/{pid}/fetch")
async def git_fetch(pid: str, body: RemoteNameIn | None = None, _: None = Depends(auth)):
    try:
        return {"ok": True, "out": await gitops.fetch(_proj_or_404(pid), body.name if body else "origin")}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


@app.post("/git/{pid}/resolve")
async def git_resolve(pid: str, body: ResolveIn, _: None = Depends(auth)):
    try:
        return {"ok": True, "out": await gitops.resolve_conflict(_proj_or_404(pid), body.path, body.choice)}
    except gitops.GitError as e:
        raise HTTPException(400, str(e))


# --------------------------------------------------- global git identity ----

class GitIdentityIn(BaseModel):
    name: str = ""
    email: str = ""


@app.get("/git/config")
async def get_git_identity(_: None = Depends(auth)):
    name, email = await asyncio.gather(
        asyncio.to_thread(auth_cfg._git_global, "user.name"),
        asyncio.to_thread(auth_cfg._git_global, "user.email"))
    return {"name": name, "email": email}


@app.post("/git/config")
async def set_git_identity(body: GitIdentityIn, _: None = Depends(auth)):
    for v in (body.name, body.email):
        if any(ord(c) < 32 for c in v):
            raise HTTPException(400, "invalid characters")
    if body.name.strip():
        await asyncio.to_thread(auth_cfg._git_global_set, "user.name", body.name.strip())
    if body.email.strip():
        await asyncio.to_thread(auth_cfg._git_global_set, "user.email", body.email.strip())
    return {"ok": True}


@app.post("/api/terminal/{pid}/exec")
async def terminal_exec(pid: str, body: ExecIn, _: None = Depends(auth)):
    """Explicit shell feature (authenticated): runs `command` via the shell in
    the project dir with a hard timeout (clamped to 120s)."""
    p = _proj_or_404(pid)
    if not body.command.strip():
        raise HTTPException(400, "command required")
    try:
        return await gitops.exec_cmd(p, body.command, body.timeout)
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))


# ------------------------------------------------------------------- fs ----
# Direct read/write for the built-in editor (opencode's file API is read-only).

class WriteIn(BaseModel):
    path: str
    content: str


def _safe_join(root: str, rel: str) -> str:
    """Resolve `rel` under `root`, following symlinks, and reject anything that
    lands outside (traversal, absolute paths, symlink escapes - including via a
    not-yet-existing tail behind a symlinked directory). Returns the resolved
    path, which callers must use for the actual I/O."""
    abs_root = os.path.realpath(root)
    if "\0" in rel:
        raise HTTPException(400, "invalid path")
    # realpath (non-strict) resolves every existing component, symlinks
    # included, and appends the non-existent remainder verbatim.
    full = os.path.realpath(os.path.join(abs_root, rel))
    try:
        if os.path.commonpath([abs_root, full]) == abs_root:
            return full
    except ValueError:
        pass
    raise HTTPException(400, "path escapes project root")


@app.get("/fs/{pid}/read")
def fs_read(pid: str, path: str, _: None = Depends(auth)):
    full = _safe_join(_proj_or_404(pid), path)
    if not os.path.isfile(full):
        raise HTTPException(404, "file not found")
    with open(full, encoding="utf-8", errors="replace", newline="") as f:
        return {"path": path, "content": f.read(2_000_000)}


@app.post("/fs/{pid}/write")
def fs_write(pid: str, body: WriteIn, _: None = Depends(auth)):
    if len(body.content) > 8_000_000:
        raise HTTPException(413, "file too large (8 MB cap)")
    full = _safe_join(_proj_or_404(pid), body.path)
    if os.path.isdir(full):
        raise HTTPException(400, "path is a directory")
    try:
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8", newline="") as f:
            f.write(body.content)
    except OSError as e:
        raise HTTPException(500, str(e))
    return {"ok": True}


@app.get("/fs/{pid}/tree")
def fs_tree(pid: str, path: str = "", _: None = Depends(auth)):
    root = _proj_or_404(pid)
    full = _safe_join(root, path)
    if not os.path.isdir(full):
        raise HTTPException(404, "folder not found")
    entries = []
    try:
        for e in sorted(os.scandir(full), key=lambda x: (not x.is_dir(), x.name.lower())):
            if e.name in (".git", "node_modules", "__pycache__"):
                continue
            try:
                size = e.stat().st_size
                is_dir = e.is_dir()
            except OSError:
                size, is_dir = 0, False
            entries.append({"name": e.name, "dir": is_dir, "size": size})
            if len(entries) >= 500:
                break
    except OSError as e:
        raise HTTPException(500, str(e))
    return {"path": path, "entries": entries}


# ------------------------------------------------------------------ PWA ---

if os.path.isdir(PWA_DIR):
    app.mount("/ui", StaticFiles(directory=PWA_DIR, html=True), name="pwa")

    @app.get("/", include_in_schema=False)
    async def index():
        return FileResponse(os.path.join(PWA_DIR, "index.html"))
