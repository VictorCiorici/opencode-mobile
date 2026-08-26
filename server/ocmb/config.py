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
