import os
import shutil
import subprocess
import sys
import tempfile

# Point data/config/home at temp dirs BEFORE importing the app package so the
# tests can never touch the developer's real ~/.git-credentials, auth.json,
# opencode.json or global git config.
_TMP = tempfile.mkdtemp(prefix="openforge-test-")
_HOME = os.path.join(_TMP, "home")
os.makedirs(_HOME, exist_ok=True)
os.environ["OCMB_DATA"] = os.path.join(_TMP, "data")
os.environ["XDG_CONFIG_HOME"] = os.path.join(_TMP, "cfg")
os.environ["XDG_DATA_HOME"] = os.path.join(_TMP, "share")
os.environ["OCMB_WORKSPACE"] = os.path.join(_TMP, "ws")
os.environ["HOME"] = _HOME
os.environ["USERPROFILE"] = _HOME
os.environ["GIT_CONFIG_GLOBAL"] = os.path.join(_HOME, ".gitconfig")
os.environ["GIT_CONFIG_NOSYSTEM"] = "1"
os.environ.pop("OCMB_TOKEN", None)
# Starlette TestClient sends "Host: testserver".
os.environ["OCMB_ALLOWED_HOSTS"] = "testserver"
for _k in ("OPENCODE_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
           "DASHSCOPE_API_KEY", "ZHIPU_API_KEY"):
    os.environ.pop(_k, None)

SERVER = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.abspath(SERVER))

from ocmb import config, models_cfg, gitops, projects, auth_cfg  # noqa: E402

import pytest  # noqa: E402

HAVE_GIT = shutil.which("git") is not None
needs_git = pytest.mark.skipif(not HAVE_GIT, reason="git not installed")


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    """Fully isolated bridge state: workspace, registry, settings, auth.json,
    opencode.json, favorites and $HOME are all under tmp_path."""
    ws = tmp_path / "ws"
    ws.mkdir()
    data = tmp_path / "data"
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(config, "WORKSPACE_DIR", ws)
    monkeypatch.setattr(auth_cfg, "WORKSPACE_DIR", ws)
    monkeypatch.setattr(config, "DATA_DIR", data)
    monkeypatch.setattr(config, "REGISTRY_PATH", data / "projects.json")
    monkeypatch.setattr(auth_cfg, "SETTINGS_PATH", data / "settings.json")
    monkeypatch.setattr(auth_cfg, "AUTH_PATH", tmp_path / "share" / "opencode" / "auth.json")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "cfg"))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(home / ".gitconfig"))
    (home / ".gitconfig").write_text("[user]" + chr(10) + "  name = Test" + chr(10) + "  email = test@example.com" + chr(10))
    return ws


@pytest.fixture
def client(workspace, monkeypatch):
    from fastapi.testclient import TestClient
    from ocmb import main

    async def _no_net():
        return main._FALLBACK_MODELS

    monkeypatch.setattr(main, "_live_catalog", _no_net)
    return TestClient(main.app)


@pytest.fixture
def project(client):
    """A registered project (with git) created through the API."""
    r = client.post("/api/projects", json={"name": "Demo"})
    assert r.status_code == 200, r.text
    return r.json()


def run_git(path, *args):
    subprocess.run(["git", *args], cwd=str(path), check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path):
    if not HAVE_GIT:
        pytest.skip("git not installed")
    p = tmp_path / "repo"
    p.mkdir()
    run_git(p, "init", "--initial-branch", "main")
    run_git(p, "config", "user.email", "t@t.io")
    run_git(p, "config", "user.name", "t")
    (p / "a.txt").write_text("hello\n")
    run_git(p, "add", "-A")
    run_git(p, "commit", "-m", "init")
    return p
