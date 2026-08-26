"""Model management: add/remove models by editing the opencode JSON config."""
from __future__ import annotations

import json
import os
from pathlib import Path


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
            return json.loads(path.read_text())
        except Exception:
            pass
    return {}


def _write(path: Path, cfg: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cfg, indent=2))


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
    return cfg


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
    return cfg


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
            return json.loads(p.read_text())
        except Exception:
            pass
    return []


def toggle_favorite(provider_id: str, model_id: str) -> tuple[list[str], bool]:
    key = f"{provider_id}/{model_id}"
    favs = list_favorites()
    if key in favs:
        favs.remove(key)
        added = False
    else:
        favs.insert(0, key)
        added = True
    p = _favorites_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(favs))
    return favs, added
