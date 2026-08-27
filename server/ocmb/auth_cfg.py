"""Authentication & Workspace configuration manager for OpenForge.
Manages OpenCode Zen API tokens, provider API keys, and workspace directory settings.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from .config import DATA_DIR, WORKSPACE_DIR

AUTH_PATH = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share"))) / "opencode" / "auth.json"
SETTINGS_PATH = DATA_DIR / "settings.json"


def _read_json(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            pass
    return {}


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2))
    try:
        path.chmod(0o600)
    except OSError:
        pass


def mask_token(t: str) -> str:
    if not t:
        return ""
    if len(t) <= 8:
        return "****"
    return f"{t[:4]}...{t[-4:]}"


def get_auth_status() -> dict[str, Any]:
    """Inspect stored tokens and return configured status without exposing full keys."""
    auth_data = _read_json(AUTH_PATH)
    from .models_cfg import _config_paths, _read
    cfg = _read(_config_paths(None)[-1])

    providers_cfg = cfg.get("provider", {})
    
    opencode_token = auth_data.get("opencode", {}).get("token", "")
    github_token = auth_data.get("github", {}).get("token", "")
    gemini_key = providers_cfg.get("gemini", {}).get("options", {}).get("apiKey", "") or os.environ.get("GEMINI_API_KEY", "")
    openai_key = providers_cfg.get("openai", {}).get("options", {}).get("apiKey", "") or os.environ.get("OPENAI_API_KEY", "")
    anthropic_key = providers_cfg.get("anthropic", {}).get("options", {}).get("apiKey", "") or os.environ.get("ANTHROPIC_API_KEY", "")
    qwen_key = providers_cfg.get("qwen", {}).get("options", {}).get("apiKey", "") or os.environ.get("DASHSCOPE_API_KEY", "")
    glm_key = providers_cfg.get("glm", {}).get("options", {}).get("apiKey", "") or os.environ.get("ZHIPU_API_KEY", "")

    def _git_identity(key: str) -> str:
        import subprocess
        try:
            out = subprocess.run(["git", "config", "--global", key],
                                 capture_output=True, text=True, check=False)
            return out.stdout.strip()
        except Exception:
            return ""

    return {
        "opencode": {"configured": bool(opencode_token), "preview": mask_token(opencode_token)},
        "github": {"configured": bool(github_token), "preview": mask_token(github_token)},
        "git_user": {"name": _git_identity("user.name"), "email": _git_identity("user.email")},
        "gemini": {"configured": bool(gemini_key), "preview": mask_token(gemini_key)},
        "openai": {"configured": bool(openai_key), "preview": mask_token(openai_key)},
        "anthropic": {"configured": bool(anthropic_key), "preview": mask_token(anthropic_key)},
        "qwen": {"configured": bool(qwen_key), "preview": mask_token(qwen_key)},
        "glm": {"configured": bool(glm_key), "preview": mask_token(glm_key)},
    }


def save_opencode_token(token: str) -> dict:
    """Save OpenCode Zen API token into ~/.local/share/opencode/auth.json."""
    data = _read_json(AUTH_PATH)
    data["opencode"] = {"type": "api", "token": token.strip()}
    _write_json(AUTH_PATH, data)
    return get_auth_status()


def save_provider_key(provider_id: str, api_key: str, base_url: str | None = None) -> dict:
    """Save a provider credential.

    github is special-cased: the PAT goes into ~/.local/share/opencode/auth.json
    and (merged, never clobbered) into ~/.git-credentials for private clones,
    matching the Go daemon behaviour.
    """
    if provider_id == "github":
        data = _read_json(AUTH_PATH)
        token = api_key.strip()
        if token:
            data["github"] = {"type": "token", "token": token}
            _write_json(AUTH_PATH, data)
            _merge_git_credentials(token)
            import subprocess
            try:
                out = subprocess.run(["git", "config", "--global", "credential.helper"],
                                     capture_output=True, text=True, check=False)
                if not out.stdout.strip():
                    subprocess.run(["git", "config", "--global", "credential.helper", "store"],
                                   capture_output=True, text=True, check=False)
            except Exception:
                pass
        else:
            data.pop("github", None)
            _write_json(AUTH_PATH, data)
        return get_auth_status()

    from .models_cfg import _config_paths, _read, _write
    path = _config_paths(None)[-1]
    cfg = _read(path)
    prov = cfg.setdefault("provider", {}).setdefault(provider_id, {})
    opts = prov.setdefault("options", {})
    opts["apiKey"] = api_key.strip()
    if base_url:
        opts["baseURL"] = base_url.strip()
    _write(path, cfg)
    return get_auth_status()


def _merge_git_credentials(token: str) -> None:
    """Replace only github.com entries in ~/.git-credentials, keep other hosts."""
    cred_path = Path.home() / ".git-credentials"
    kept: list[str] = []
    if cred_path.exists():
        try:
            for line in cred_path.read_text().splitlines():
                line = line.strip()
                if not line or ("github.com" not in line):
                    kept.append(line)
        except Exception:
            pass
    entries = [
        f"https://{token}:x-oauth-basic@github.com",
        f"https://oauth2:{token}@github.com",
    ]
    cred_path.parent.mkdir(parents=True, exist_ok=True)
    cred_path.write_text("\n".join(kept + entries) + "\n")
    try:
        cred_path.chmod(0o600)
    except OSError:
        pass


def remove_token(provider_id: str) -> dict:
    """Remove a stored token/key."""
    if provider_id == "opencode":
        data = _read_json(AUTH_PATH)
        data.pop("opencode", None)
        _write_json(AUTH_PATH, data)
    else:
        from .models_cfg import _config_paths, _read, _write
        path = _config_paths(None)[-1]
        cfg = _read(path)
        if provider_id in cfg.get("provider", {}):
            cfg["provider"][provider_id].get("options", {}).pop("apiKey", None)
            _write(path, cfg)
    return get_auth_status()


def get_workspace_dir() -> str:
    """Get active workspace parent directory."""
    settings = _read_json(SETTINGS_PATH)
    return settings.get("workspace_dir") or str(WORKSPACE_DIR)


def set_workspace_dir(new_path: str) -> str:
    """Update workspace parent directory."""
    p = os.path.abspath(os.path.expanduser(new_path.strip()))
    os.makedirs(p, exist_ok=True)
    settings = _read_json(SETTINGS_PATH)
    settings["workspace_dir"] = p
    _write_json(SETTINGS_PATH, settings)
    return p
