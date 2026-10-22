"""Authentication & Workspace configuration manager for OpenForge.
Manages OpenCode Zen API tokens, provider API keys, and workspace directory settings.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

from .config import DATA_DIR, WORKSPACE_DIR, OPENCODE_BIN, write_private

AUTH_PATH = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share"))) / "opencode" / "auth.json"
SETTINGS_PATH = DATA_DIR / "settings.json"

# Providers whose credentials live in auth.json (not in opencode.json).
AUTH_FILE_PROVIDERS = ("opencode", "opencode-go")


def _read_json(path: Path) -> dict:
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    return {}


def _write_json(path: Path, data: dict) -> None:
    """Write JSON that may hold credentials: created 0600 from the start."""
    write_private(path, json.dumps(data, indent=2), 0o600)


def mask_token(t: str) -> str:
    if not t:
        return ""
    if len(t) < 16:
        return "****"
    return f"{t[:4]}...{t[-4:]}"


def _auth_tok(auth_data: dict, key: str) -> str:
    """Token stored for `key` in auth.json. opencode writes "key"; older
    bridge versions wrote "token" — accept both (as the Go daemon does)."""
    obj = auth_data.get(key)
    if isinstance(obj, dict):
        return obj.get("key") or obj.get("token") or ""
    return ""


def _git_global(key: str) -> str:
    try:
        out = subprocess.run(["git", "config", "--global", key],
                             capture_output=True, text=True, check=False, timeout=10)
        return out.stdout.strip()
    except Exception:
        return ""


def _git_global_set(key: str, value: str) -> None:
    try:
        subprocess.run(["git", "config", "--global", key, value],
                       capture_output=True, text=True, check=False, timeout=10)
    except Exception:
        pass


def get_auth_status() -> dict[str, Any]:
    """Inspect stored tokens and return configured status without exposing full keys."""
    auth_data = _read_json(AUTH_PATH)
    from .models_cfg import _config_paths, _read
    cfg = _read(_config_paths(None)[-1])

    providers_cfg = cfg.get("provider") if isinstance(cfg.get("provider"), dict) else {}

    def _prov_key(pid: str, env: str) -> str:
        prov = providers_cfg.get(pid)
        opts = prov.get("options") if isinstance(prov, dict) else None
        key = opts.get("apiKey") if isinstance(opts, dict) else ""
        return (key if isinstance(key, str) else "") or os.environ.get(env, "")

    opencode_token = _auth_tok(auth_data, "opencode")
    opencode_go_token = _auth_tok(auth_data, "opencode-go") or os.environ.get("OPENCODE_API_KEY", "")
    github_token = _auth_tok(auth_data, "github")
    gh = auth_data.get("github")
    gh_login = gh.get("login", "") if isinstance(gh, dict) else ""
    gemini_key = _prov_key("gemini", "GEMINI_API_KEY")
    openai_key = _prov_key("openai", "OPENAI_API_KEY")
    anthropic_key = _prov_key("anthropic", "ANTHROPIC_API_KEY")
    qwen_key = _prov_key("qwen", "DASHSCOPE_API_KEY")
    glm_key = _prov_key("glm", "ZHIPU_API_KEY")

    return {
        "opencode": {"configured": bool(opencode_token), "preview": mask_token(opencode_token)},
        "opencode-go": {"configured": bool(opencode_go_token), "preview": mask_token(opencode_go_token)},
        "github": {"configured": bool(github_token), "preview": mask_token(github_token), "login": gh_login},
        "git_user": {"name": _git_global("user.name"), "email": _git_global("user.email")},
        "gemini": {"configured": bool(gemini_key), "preview": mask_token(gemini_key)},
        "openai": {"configured": bool(openai_key), "preview": mask_token(openai_key)},
        "anthropic": {"configured": bool(anthropic_key), "preview": mask_token(anthropic_key)},
        "qwen": {"configured": bool(qwen_key), "preview": mask_token(qwen_key)},
        "glm": {"configured": bool(glm_key), "preview": mask_token(glm_key)},
        "opencode_local": shutil.which(OPENCODE_BIN) is not None,
    }


def validate_github_token(token: str) -> str:
    """Verify a PAT against api.github.com and return the login.
    Raises ValueError with a user-presentable message on failure."""
    import httpx
    try:
        r = httpx.get(
            "https://api.github.com/user",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
            timeout=12.0,
        )
    except Exception as e:
        raise ValueError(f"github API unreachable: {type(e).__name__}")
    if r.status_code != 200:
        raise ValueError(f"github rejected token (HTTP {r.status_code})")
    try:
        login = r.json().get("login") or ""
    except Exception:
        login = ""
    if not login:
        raise ValueError("github token valid but returned no login")
    return login


def save_opencode_token(token: str) -> dict:
    """Save OpenCode Zen API token into ~/.local/share/opencode/auth.json."""
    return save_provider_key("opencode", token)


def save_provider_key(provider_id: str, api_key: str, base_url: str | None = None,
                      login: str = "") -> dict:
    """Save a provider credential.

    github is special-cased: the PAT goes into ~/.local/share/opencode/auth.json
    and (merged, never clobbered) into ~/.git-credentials for private clones,
    matching the Go daemon behaviour. An empty key removes the credential.
    """
    token = (api_key or "").strip()
    if provider_id in AUTH_FILE_PROVIDERS:
        # Same shape `opencode auth login` writes.
        data = _read_json(AUTH_PATH)
        if token:
            data[provider_id] = {"type": "api", "key": token}
        else:
            data.pop(provider_id, None)
        _write_json(AUTH_PATH, data)
        return get_auth_status()

    if provider_id == "github":
        data = _read_json(AUTH_PATH)
        if token:
            _merge_git_credentials(token)  # validates the token charset first
            data["github"] = {"type": "token", "token": token, "login": login}
            _write_json(AUTH_PATH, data)
            if not _git_global("credential.helper"):
                _git_global_set("credential.helper", "store")
        else:
            data.pop("github", None)
            _write_json(AUTH_PATH, data)
            _merge_git_credentials("")
        return get_auth_status()

    from .models_cfg import _config_paths, _read, _write
    path = _config_paths(None)[-1]
    cfg = _read(path)
    provs = cfg.get("provider")
    if not isinstance(provs, dict):
        provs = cfg["provider"] = {}
    prov = provs.get(provider_id)
    if not isinstance(prov, dict):
        prov = provs[provider_id] = {}
    opts = prov.get("options")
    if not isinstance(opts, dict):
        opts = prov["options"] = {}
    if token:
        opts["apiKey"] = token
    else:
        opts.pop("apiKey", None)
    if base_url:
        opts["baseURL"] = base_url.strip()
    _write(path, cfg)
    return get_auth_status()


def _git_credentials_path() -> Path:
    return Path.home() / ".git-credentials"


def _merge_git_credentials(token: str) -> None:
    """Replace only github.com entries in ~/.git-credentials, keep other hosts.
    An empty token just removes the github entries."""
    if token and any(c.isspace() or ord(c) < 32 for c in token):
        raise ValueError("token contains invalid characters")
    cred_path = _git_credentials_path()
    kept: list[str] = []
    if cred_path.exists():
        try:
            for line in cred_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    host = urlparse(line).hostname or ""
                except ValueError:
                    host = ""
                if host != "github.com" and not host.endswith(".github.com"):
                    kept.append(line)
        except Exception:
            pass
    entries: list[str] = []
    if token:
        t = quote(token, safe="")
        entries = [
            f"https://{t}:x-oauth-basic@github.com",
            f"https://oauth2:{t}@github.com",
        ]
    write_private(cred_path, "\n".join(kept + entries) + "\n", 0o600)


def remove_token(provider_id: str) -> dict:
    """Remove a stored token/key."""
    if provider_id in AUTH_FILE_PROVIDERS or provider_id == "github":
        return save_provider_key(provider_id, "")
    from .models_cfg import _config_paths, _read, _write
    path = _config_paths(None)[-1]
    cfg = _read(path)
    prov = (cfg.get("provider") or {}).get(provider_id)
    if isinstance(prov, dict) and isinstance(prov.get("options"), dict):
        prov["options"].pop("apiKey", None)
        _write(path, cfg)
    return get_auth_status()


def get_workspace_dir() -> str:
    """Get active workspace parent directory."""
    settings = _read_json(SETTINGS_PATH)
    return settings.get("workspace_dir") or str(WORKSPACE_DIR)


def set_workspace_dir(new_path: str) -> str:
    """Update workspace parent directory."""
    if not (new_path or "").strip():
        raise ValueError("path required")
    p = os.path.abspath(os.path.expanduser(new_path.strip()))
    os.makedirs(p, exist_ok=True)
    settings = _read_json(SETTINGS_PATH)
    settings["workspace_dir"] = p
    _write_json(SETTINGS_PATH, settings)
    return p
