"""Central configuration for the opencode-mobile bridge."""
from __future__ import annotations

import os
from pathlib import Path

# Where the bridge listens (on-device: localhost is fine; for remote access
# over an SSH tunnel keep 127.0.0.1).
HOST = os.environ.get("OCMB_HOST", "127.0.0.1")
PORT = int(os.environ.get("OCMB_PORT", "8787"))

# Parent directory that holds all projects created from the app.
WORKSPACE_DIR = Path(os.environ.get("OCMB_WORKSPACE", str(Path.home() / "opencode-projects")))

# Persistent project registry.
DATA_DIR = Path(os.environ.get("OCMB_DATA", str(Path.home() / ".local/share/opencode-mobile")))
REGISTRY_PATH = DATA_DIR / "projects.json"

# First port used when spawning per-project `opencode serve` instances.
INSTANCE_BASE_PORT = int(os.environ.get("OCMB_BASE_PORT", "4100"))

# Path to the opencode CLI binary.
OPENCODE_BIN = os.environ.get("OCMB_OPENCODE_BIN", "opencode")

# Optional bearer token. If set, every /api request must send
# "Authorization: Bearer <token>".
AUTH_TOKEN = os.environ.get("OCMB_TOKEN") or None

# Extra Host header names accepted while bound to loopback (comma-separated),
# e.g. a reverse proxy name. Loopback names are always accepted.
ALLOWED_HOSTS = {h.strip().lower() for h in os.environ.get("OCMB_ALLOWED_HOSTS", "").split(",") if h.strip()}


def write_private(path, text: str, mode: int = 0o600) -> None:
    """Atomically write text to path, creating the file with `mode` from the
    start (no window where a secret is world-readable)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        try:
            os.chmod(tmp, mode)
        except OSError:
            pass
        os.replace(tmp, path)
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass
