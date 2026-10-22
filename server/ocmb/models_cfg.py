"""Model management: add/remove models by editing the opencode JSON config."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .config import write_private


def _config_paths(project_path: str | None) -> list[Path]:
    paths = []
    if project_path:
        paths.append(Path(project_path) / "opencode.json")
    xdg = os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))
    paths.append(Path(xdg) / "opencode" / "opencode.json")
    return paths


def _read(path: Path) -> dict:
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            pass
    return {}


def redact(v: Any) -> Any:
    """Deep copy of a config with apiKey values masked (safe to return over HTTP)."""
    if isinstance(v, dict):
        out = {}
        for k, val in v.items():
            if k == "apiKey" and isinstance(val, str) and val and val != "local":
                out[k] = f"{val[:4]}...{val[-4:]}" if len(val) >= 16 else "****"
            else:
                out[k] = redact(val)
        return out
    if isinstance(v, list):
        return [redact(x) for x in v]
    return v


def _write(path: Path, cfg: dict) -> None:
    # 0600 from creation if the file contains credentials.
    has_secret = False
    for prov in (cfg.get("provider") or {}).values():
        try:
            key = (prov or {}).get("options", {}).get("apiKey")
        except AttributeError:
            continue
        if isinstance(key, str) and key and key != "local":
            has_secret = True
            break
    write_private(path, json.dumps(cfg, indent=2), 0o600 if has_secret else 0o644)


def add_model(provider_id: str, model_id: str, options: dict | None,
              project_path: str | None = None, set_default: bool = False) -> dict:
    """Add a model under providers.<provider>.models in the global config."""
    path = _config_paths(None)[-1]
    cfg = _read(path)
    prov = cfg.setdefault("provider", {}).setdefault(provider_id, {})
    models = prov.setdefault("models", {})
    entry: dict = {}
    if options:
        for k in ("name", "note", "reasoning", "tool_call", "temperature",
                  "top_p", "max_tokens", "cost", "limit", "modalities"):
            if k in options:
                entry[k] = options[k]
    models[model_id] = {**(models.get(model_id) or {}), **entry}
    if set_default:
        cfg["model"] = f"{provider_id}/{model_id}"
    _write(path, cfg)
    return redact(cfg)


def remove_model(provider_id: str, model_id: str, project_path: str | None = None) -> dict:
    path = _config_paths(None)[-1]
    cfg = _read(path)
    try:
        cfg.get("provider", {}).get(provider_id, {}).get("models", {}).pop(model_id, None)
    except AttributeError:
        pass
    if cfg.get("model") == f"{provider_id}/{model_id}":
        cfg.pop("model", None)
    _write(path, cfg)
    return redact(cfg)


def current_default() -> str | None:
    path = _config_paths(None)[-1]
    return _read(path).get("model")


# --------------------------- favorites -------------------------------------
# Persisted in the bridge's own data dir so they work for any provider/model.

def _favorites_path():
    from .config import DATA_DIR
    return DATA_DIR / "favorites.json"


def list_favorites() -> list[str]:
    p = _favorites_path()
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, dict):          # {"favorites": [...]} (Go-daemon format)
                return [str(x) for x in data.get("favorites") or []]
            if isinstance(data, list):          # legacy bare array
                return [str(x) for x in data]
        except Exception:
            pass
    return []


def toggle_favorite(provider_id: str, model_id: str) -> tuple[list[str], bool]:
    key = f"{provider_id}/{model_id}"
    favs = list_favorites()
    added = key not in favs
    if added:
        favs.insert(0, key)
    else:
        favs.remove(key)
    p = _favorites_path()
    # Store the object format shared with the Go daemon.
    write_private(p, json.dumps({"favorites": favs}))
    return favs, added
