import os
import sys
import tempfile

# Point data/config at temp dirs BEFORE importing the app package.
_TMP = tempfile.mkdtemp(prefix="openforge-test-")
os.environ["OCMB_DATA"] = _TMP
os.environ["XDG_CONFIG_HOME"] = _TMP
os.environ["OCMB_WORKSPACE"] = os.path.join(_TMP, "ws")

SERVER = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.abspath(SERVER))

from ocmb import config, models_cfg, gitops, projects  # noqa: E402

import pytest  # noqa: E402


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    ws = tmp_path / "ws"
    ws.mkdir()
    monkeypatch.setattr(config, "WORKSPACE_DIR", ws)
    monkeypatch.setattr(projects, "WORKSPACE_DIR", ws)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    return ws


def run_git(path, *args):
    import subprocess
    subprocess.run(["git", *args], cwd=str(path), check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path):
    p = tmp_path / "repo"
    p.mkdir()
    run_git(p, "init", "--initial-branch", "main")
    run_git(p, "config", "user.email", "t@t.io")
    run_git(p, "config", "user.name", "t")
    (p / "a.txt").write_text("hello\n")
    run_git(p, "add", "-A")
    run_git(p, "commit", "-m", "init")
    return p
