import asyncio
import os

import pytest

from ocmb import models_cfg, gitops, projects


# ----------------------------- models_cfg -----------------------------

def test_add_remove_model(workspace):
    models_cfg.add_model("acme", "cool-model", {"name": "Cool"}, set_default=True)
    favs, added = models_cfg.toggle_favorite("acme", "cool-model")
    assert added is True
    assert "acme/cool-model" in favs
    cfg = models_cfg.remove_model("acme", "cool-model")
    assert "acme/cool-model" not in (cfg.get("provider", {}).get("acme", {}).get("models", {}))
    assert models_cfg.current_default() is None


def test_favorites_persist(workspace):
    _, added = models_cfg.toggle_favorite("p", "m1")
    assert added
    assert "p/m1" in models_cfg.list_favorites()


# ------------------------------- gitops -------------------------------

def test_status_and_diff(repo):
    (repo / "a.txt").write_text("hello\nworld\n")
    st = asyncio.run(gitops.status(str(repo)))
    assert any(f["path"] == "a.txt" for f in st["unstaged"])

    (repo / "a.txt").write_text("brand new line\n")
    d = asyncio.run(gitops.diff_file(str(repo), "a.txt"))
    assert "brand new line" in d


def test_stash_roundtrip(repo):
    (repo / "a.txt").write_text("changed\n")
    out = asyncio.run(gitops.stash_push(str(repo), "wip"))
    assert "Saved" in out
    stashes = asyncio.run(gitops.stash_list(str(repo)))
    assert stashes and stashes[0]["index"] == 0
    pop = asyncio.run(gitops.stash_apply(str(repo), 0, pop=True))
    assert "Dropped" in pop


def test_branch_ops(repo):
    out = asyncio.run(gitops.branch_create(str(repo), "feature"))
    assert "feature" in out
    branches = asyncio.run(gitops.branches(str(repo)))
    assert "feature" in branches["all"]
    asyncio.run(gitops.checkout(str(repo), "feature"))
    asyncio.run(gitops.checkout(str(repo), "main"))
    asyncio.run(gitops.branch_delete(str(repo), "feature", force=True))


def test_graph_returns_list(repo):
    commits = asyncio.run(gitops.graph(str(repo), 10))
    assert isinstance(commits, list) and commits[0]["short"]


def test_remotes_and_exec(repo):
    out = asyncio.run(gitops.remote_add(str(repo), "origin", "https://github.com/example/test.git"))
    assert "remote" in out or "origin" in out
    rems = asyncio.run(gitops.remotes(str(repo)))
    assert any(r["name"] == "origin" for r in rems)
    
    asyncio.run(gitops.remote_set_url(str(repo), "origin", "https://github.com/example/updated.git"))
    rems2 = asyncio.run(gitops.remotes(str(repo)))
    assert any("updated" in (r.get("fetch") or "") for r in rems2)

    res = asyncio.run(gitops.exec_cmd(str(repo), "echo 'hello from terminal'"))
    assert res["ok"] is True
    assert "hello from terminal" in res["stdout"]


# ------------------------------ projects ------------------------------

def test_create_import_remove(workspace):
    p = projects.create_project("Demo", branch="main")
    assert os.path.isdir(p["path"])
    assert (os.path.join(p["path"], ".git"))  # git initialized
    ext = workspace / "ext"
    ext.mkdir()
    imported = projects.import_project(str(ext))
    assert imported["path"].endswith("ext")
    assert asyncio.run(projects.remove_project(imported["id"], delete_dir=True))
    assert not os.path.isdir(imported["path"])


def test_local_scanner_and_register(workspace):
    from fastapi.testclient import TestClient
    from ocmb.main import app
    client = TestClient(app)

    r = client.post("/api/models/scan-lan", json={"include_lan": False})
    assert r.status_code == 200
    assert "servers" in r.json()

    # Test registering a local Ollama/LAN model
    reg = client.post("/api/models/register-local", json={
        "provider_id": "ollama-test",
        "name": "Ollama (LAN)",
        "base_url": "http://192.168.1.100:11434/v1",
        "models": [{"id": "qwen2.5-coder:7b", "name": "Qwen 2.5 Coder 7B"}]
    })
    assert reg.status_code == 200
    cfg = reg.json()["config"]
    assert "ollama-test" in cfg.get("provider", {})
    assert "qwen2.5-coder:7b" in cfg["provider"]["ollama-test"]["models"]


