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
