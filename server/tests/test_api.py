"""HTTP-level tests of the bridge (hermetic: temp dirs, no network)."""
import json
import os
import sys

import pytest

from conftest import needs_git, run_git


# ------------------------------------------------------------------ auth ---

@pytest.fixture
def secured(client, monkeypatch):
    from ocmb import main
    monkeypatch.setattr(main, "AUTH_TOKEN", "s3cret-token")
    return client


def test_auth_required_everywhere(secured):
    for method, path in [
        ("get", "/api/projects"), ("get", "/api/auth/status"), ("get", "/api/browse"),
        ("get", "/git/config"), ("get", "/api/git/config"), ("get", "/projects"),
        ("post", "/api/projects"), ("get", "/api/models/global"), ("get", "/api/favorites"),
        ("get", "/fs/x/read?path=a"), ("post", "/api/terminal/x/exec"),
        ("get", "/oc/x/event"), ("get", "/api/settings/workspace"),
    ]:
        r = getattr(secured, method)(path)
        assert r.status_code == 401, (method, path, r.status_code)


def test_auth_bearer_ok_and_wrong(secured):
    ok = secured.get("/api/projects", headers={"Authorization": "Bearer s3cret-token"})
    assert ok.status_code == 200
    bad = secured.get("/api/projects", headers={"Authorization": "Bearer nope"})
    assert bad.status_code == 401
    bad2 = secured.get("/api/projects", headers={"Authorization": "s3cret-token"})
    assert bad2.status_code == 401


def test_query_token_only_for_sse_proxy_get(secured):
    # ?token= must NOT authenticate ordinary endpoints...
    assert secured.get("/api/projects?token=s3cret-token").status_code == 401
    assert secured.post("/api/projects?token=s3cret-token", json={"name": "x"}).status_code == 401
    # ...nor non-GET proxy calls, but does pass auth on GET /oc/ (404: unknown project).
    assert secured.post("/oc/nope/session?token=s3cret-token").status_code == 401
    assert secured.get("/oc/nope/event?token=wrong").status_code == 401
    assert secured.get("/oc/nope/event?token=s3cret-token").status_code == 404


def test_non_ascii_token_does_not_crash(secured):
    r = secured.get("/api/projects", headers={"Authorization": b"Bearer caf" + bytes([0xe9])})
    assert r.status_code == 401
    assert secured.get("/oc/nope/event?token=%C3%A9").status_code == 401


def test_health_is_public_and_reports_auth(secured):
    r = secured.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["bridge"] == "ok" and body["auth"] is True
    assert "healthy" in body["opencode"]
    assert secured.get("/health").status_code == 200


def test_no_token_configured_means_open(client):
    assert client.get("/api/projects").status_code == 200


# --------------------------------------------------------------- aliases ---

def test_route_aliases(client, project):
    pid = project["id"]
    assert client.get("/projects").json() == client.get("/api/projects").json()
    assert client.get("/api/browse").status_code == client.get("/browse").status_code == 200
    assert client.get(f"/api/fs/{pid}/tree").status_code == 200
    assert client.get(f"/api/git/{pid}/status").json()["is_git"] in (True, False)
    assert client.get("/api/git/config").status_code == 200
    r = client.post(f"/terminal/{pid}/exec", json={"command": "echo hi"})
    assert r.status_code == 200 and "hi" in r.json()["stdout"]
    assert client.get(f"/projects/{pid}").json()["id"] == pid


# -------------------------------------------------------------- projects ---

def test_project_lifecycle(client, workspace):
    r = client.post("/api/projects", json={"name": "My App!", "git_init": False})
    p = r.json()
    assert p["id"] == "my-app" and os.path.isdir(p["path"])
    assert not os.path.exists(os.path.join(p["path"], ".git"))
    # duplicate names get unique ids
    p2 = client.post("/api/projects", json={"name": "My App!", "git_init": False}).json()
    assert p2["id"] == "my-app-2"
    listing = client.get("/api/projects").json()
    assert {x["id"] for x in listing["projects"]} == {"my-app", "my-app-2"}
    assert listing["workspace"] == str(workspace)
    assert client.get("/api/projects/my-app").json()["path"] == p["path"]
    assert client.get("/api/projects/missing").status_code == 404
    assert client.post("/api/projects/my-app/stop").json() == {"ok": True}
    d = client.delete("/api/projects/my-app?delete_dir=true")
    assert d.status_code == 200 and not os.path.exists(p["path"])
    assert client.delete("/api/projects/my-app").status_code == 404


def test_create_project_rejects_option_like_branch(client):
    r = client.post("/api/projects", json={"name": "x", "branch": "--evil"})
    assert r.status_code == 400


def test_import_and_delete_never_removes_outside_workspace(client, tmp_path):
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "keep.txt").write_text("x")
    p = client.post("/api/projects/import", json={"path": str(outside)}).json()
    assert client.delete(f"/api/projects/{p['id']}?delete_dir=true").status_code == 200
    assert (outside / "keep.txt").exists()
    assert client.post("/api/projects/import", json={"path": str(tmp_path / "nope")}).status_code == 400


def test_workspace_prefix_sibling_not_deleted(client, workspace):
    """A project dir whose path merely shares the workspace string prefix must survive."""
    sibling = workspace.parent / (workspace.name + "-evil")
    sibling.mkdir()
    p = client.post("/api/projects/import", json={"path": str(sibling)}).json()
    client.delete(f"/api/projects/{p['id']}?delete_dir=true")
    assert sibling.exists()


def test_clone_rejects_option_injection(client):
    for url in ("--upload-pack=touch /tmp/pwned", "-c core.sshCommand=x"):
        r = client.post("/api/projects/clone", json={"url": url})
        assert r.status_code == 400
    assert client.post("/api/projects/clone", json={"url": "  "}).status_code == 400
    r = client.post("/api/projects/clone", json={"url": "https://example.invalid/x.git", "branch": "-x"})
    assert r.status_code == 400


@needs_git
def test_clone_local_repo(client, repo):
    r = client.post("/api/projects/clone", json={"url": str(repo), "name": "Cloned"})
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["id"] == "cloned" and os.path.isfile(os.path.join(p["path"], "a.txt"))


def test_browse(client, tmp_path):
    root = tmp_path / "browse-me"
    root.mkdir()
    (root / "sub").mkdir()
    (root / "f.txt").write_text("x")
    (root / ".hidden").write_text("x")
    r = client.get("/api/browse", params={"path": str(root)})
    body = r.json()
    names = [e["name"] for e in body["entries"]]
    assert names[0] == "sub" and "f.txt" in names and ".hidden" not in names
    assert body["entries"][0]["is_dir"] is True
    assert body["current"] == body["path"]
    assert client.get("/api/browse", params={"path": str(tmp_path / "f.txt")}).status_code == 400


# ----------------------------------------------------------------- files ---

def test_fs_roundtrip_and_tree(client, project):
    pid = project["id"]
    w = client.post(f"/fs/{pid}/write", json={"path": "src/a/b.txt", "content": "line1\r\nline2\n"})
    assert w.status_code == 200
    r = client.get(f"/fs/{pid}/read", params={"path": "src/a/b.txt"}).json()
    assert r["content"] == "line1\r\nline2\n"  # no newline translation
    tree = client.get(f"/fs/{pid}/tree", params={"path": "src/a"}).json()
    assert tree["entries"] == [{"name": "b.txt", "dir": False, "size": 13}]
    top = client.get(f"/fs/{pid}/tree").json()["entries"]
    assert all(e["name"] != ".git" for e in top)
    assert client.get(f"/fs/{pid}/read", params={"path": "nope.txt"}).status_code == 404
    assert client.get(f"/fs/{pid}/tree", params={"path": "nope"}).status_code == 404
    assert client.get("/fs/ghost/tree").status_code == 404


def test_fs_unicode(client, project):
    pid = project["id"]
    client.post(f"/fs/{pid}/write", json={"path": "u.txt", "content": "héllo 世界"})
    assert client.get(f"/fs/{pid}/read", params={"path": "u.txt"}).json()["content"] == "héllo 世界"


def test_fs_rejects_traversal(client, project, tmp_path):
    pid = project["id"]
    outside = os.path.join(os.path.dirname(project["path"]), "outside.txt")
    for bad in ("../outside.txt", "a/../../outside.txt", outside, os.path.abspath(outside)):
        assert client.post(f"/fs/{pid}/write", json={"path": bad, "content": "x"}).status_code == 400, bad
        assert client.get(f"/fs/{pid}/read", params={"path": bad}).status_code == 400, bad
    assert client.get(f"/fs/{pid}/tree", params={"path": ".."}).status_code == 400
    assert not os.path.exists(outside)


def _symlink_or_skip(target, link):
    try:
        os.symlink(target, link, target_is_directory=os.path.isdir(target))
    except (OSError, NotImplementedError, AttributeError):
        pytest.skip("symlinks not permitted here")


def test_fs_rejects_symlink_escape(client, project, tmp_path):
    pid = project["id"]
    secret_dir = tmp_path / "secret"
    secret_dir.mkdir()
    (secret_dir / "pw.txt").write_text("hunter2")
    _symlink_or_skip(str(secret_dir), os.path.join(project["path"], "link"))
    # read through the link
    assert client.get(f"/fs/{pid}/read", params={"path": "link/pw.txt"}).status_code == 400
    # write to a NEW file/dir behind the link (the not-yet-existing tail case)
    assert client.post(f"/fs/{pid}/write", json={"path": "link/new/x.txt", "content": "pwn"}).status_code == 400
    assert client.post(f"/fs/{pid}/write", json={"path": "link/x.txt", "content": "pwn"}).status_code == 400
    assert not (secret_dir / "new").exists() and not (secret_dir / "x.txt").exists()
    assert client.get(f"/fs/{pid}/tree", params={"path": "link"}).status_code == 400


def test_fs_rejects_dangling_symlink_file_escape(client, project, tmp_path):
    pid = project["id"]
    target = tmp_path / "does-not-exist-yet.txt"
    _symlink_or_skip(str(target), os.path.join(project["path"], "dangling"))
    r = client.post(f"/fs/{pid}/write", json={"path": "dangling", "content": "pwn"})
    assert r.status_code == 400
    assert not target.exists()


def test_fs_write_size_cap(client, project):
    r = client.post(f"/fs/{project['id']}/write", json={"path": "big", "content": "a" * 8_000_001})
    assert r.status_code == 413


def test_fs_write_to_directory_rejected(client, project):
    pid = project["id"]
    client.post(f"/fs/{pid}/write", json={"path": "d/x.txt", "content": "1"})
    assert client.post(f"/fs/{pid}/write", json={"path": "d", "content": "1"}).status_code == 400


# -------------------------------------------------------------- terminal ---

def test_terminal_exec(client, project):
    pid = project["id"]
    r = client.post(f"/api/terminal/{pid}/exec", json={"command": "echo out && echo err 1>&2"}).json()
    assert r["ok"] is True and r["code"] == 0
    assert "out" in r["stdout"] and "err" in r["stderr"]
    r = client.post(f"/api/terminal/{pid}/exec", json={"command": "exit 3"}).json()
    assert r["ok"] is False and r["code"] == 3
    # runs inside the project dir
    pwd = "cd" if sys.platform == "win32" else "pwd"
    r = client.post(f"/api/terminal/{pid}/exec", json={"command": pwd}).json()
    assert os.path.basename(project["path"]) in r["stdout"]


def test_terminal_errors_and_timeout(client, project):
    pid = project["id"]
    assert client.post("/api/terminal/ghost/exec", json={"command": "echo"}).status_code == 404
    assert client.post(f"/api/terminal/{pid}/exec", json={"command": "   "}).status_code == 400
    sleeper = "ping -n 30 127.0.0.1" if sys.platform == "win32" else "sleep 30"
    r = client.post(f"/api/terminal/{pid}/exec", json={"command": sleeper, "timeout": 0.5}).json()
    assert r["ok"] is False and r["code"] == -1 and "timed out" in r["stderr"]


# ------------------------------------------------------------------- git ---

@needs_git
def test_git_endpoints_flow(client, project):
    pid, path = project["id"], project["path"]
    run_git(path, "config", "user.email", "t@t.io")
    run_git(path, "config", "user.name", "t")
    st = client.get(f"/git/{pid}/status").json()
    assert st["is_git"] is True and st["clean"] is True

    client.post(f"/fs/{pid}/write", json={"path": "a.txt", "content": "one\n"})
    client.post(f"/fs/{pid}/write", json={"path": "b.txt", "content": "two\n"})
    st = client.get(f"/git/{pid}/status").json()
    assert {f["path"] for f in st["untracked"]} == {"a.txt", "b.txt"} and st["clean"] is False

    assert client.post(f"/git/{pid}/stage", json={"files": ["a.txt"]}).json() == {"ok": True}
    st = client.get(f"/git/{pid}/status").json()
    assert [f["path"] for f in st["staged"]] == ["a.txt"]

    # commit respects the staging area: b.txt stays untracked
    c = client.post(f"/git/{pid}/commit", json={"message": "add a"})
    assert c.status_code == 200, c.text
    st = client.get(f"/git/{pid}/status").json()
    assert [f["path"] for f in st["untracked"]] == ["b.txt"]
    assert client.post(f"/git/{pid}/commit", json={"message": "  "}).status_code == 400

    # nothing staged -> commit stages everything (PWA confirms this with the user)
    assert client.post(f"/git/{pid}/commit", json={"message": "add b"}).status_code == 200
    log = client.get(f"/git/{pid}/log", params={"limit": 5}).json()["commits"]
    assert [c["subject"] for c in log][:2] == ["add b", "add a"]

    # staged + further unstaged edits show in both lists
    client.post(f"/fs/{pid}/write", json={"path": "a.txt", "content": "two\n"})
    client.post(f"/git/{pid}/stage", json={"files": ["a.txt"]})
    client.post(f"/fs/{pid}/write", json={"path": "a.txt", "content": "three\n"})
    st = client.get(f"/git/{pid}/status").json()
    assert [f["path"] for f in st["staged"]] == ["a.txt"]
    assert [f["path"] for f in st["unstaged"]] == ["a.txt"]
    d = client.get(f"/git/{pid}/diff/file", params={"path": "a.txt", "staged": "true"}).json()["diff"]
    assert "+two" in d
    d2 = client.get(f"/git/{pid}/diff", params={"file": "a.txt"}).json()["diff"]
    assert "+three" in d2
    assert client.post(f"/git/{pid}/unstage", json={"files": ["a.txt"]}).status_code == 200
    assert client.post(f"/git/{pid}/discard", json={"ref": "a.txt"}).status_code == 200

    g = client.get(f"/git/{pid}/graph", params={"limit": 10}).json()
    assert g["commits"] and "branches" in g and "remotes" in g and "status" in g


@needs_git
def test_git_branches_stash_remotes_endpoints(client, project):
    pid, path = project["id"], project["path"]
    run_git(path, "config", "user.email", "t@t.io")
    run_git(path, "config", "user.name", "t")
    assert client.post(f"/git/{pid}/branch/create", json={"name": "feat"}).status_code == 200
    assert client.post(f"/git/{pid}/checkout", json={"ref": "feat"}).status_code == 200
    br = client.get(f"/git/{pid}/branches").json()
    assert br["current"] == "feat" and "feat" in br["all"]
    assert client.post(f"/git/{pid}/branch/rename", json={"old": "feat", "new": "feat2"}).status_code == 200
    assert client.post(f"/git/{pid}/checkout", json={"ref": "main"}).status_code == 200
    assert client.post(f"/git/{pid}/branch/delete", json={"name": "feat2", "force": True}).status_code == 200
    assert client.post(f"/git/{pid}/branch", json={"name": "other"}).status_code == 200

    # option-like refs are rejected, not passed to git
    for bad in ("--orphan", "-D", "a b", "x:y"):
        assert client.post(f"/git/{pid}/checkout", json={"ref": bad}).status_code == 400
        assert client.post(f"/git/{pid}/merge", json={"ref": bad}).status_code == 400

    client.post(f"/fs/{pid}/write", json={"path": "init.txt", "content": "x"})
    client.post(f"/git/{pid}/commit", json={"message": "c"})
    client.post(f"/fs/{pid}/write", json={"path": "init.txt", "content": "y"})
    assert client.post(f"/git/{pid}/stash", json={"message": "wip"}).status_code == 200
    stashes = client.get(f"/git/{pid}/stash").json()["stashes"]
    assert stashes and stashes[0]["index"] == 0
    assert client.post(f"/git/{pid}/stash/apply", json={"index": 0}).status_code == 200
    assert client.post(f"/git/{pid}/stash/drop", json={"index": 0}).status_code == 200
    assert client.post(f"/git/{pid}/stash/pop", json={"index": -1}).status_code == 400

    # remotes: add/list/set-url/remove; credentials in URLs are never echoed
    assert client.post(f"/git/{pid}/remote/add",
                       json={"name": "origin", "url": "https://user:tok3n@example.com/r.git"}).status_code == 200
    remotes = client.get(f"/git/{pid}/remotes").json()["remotes"]
    assert remotes[0]["fetch"] == "https://example.com/r.git"
    assert "tok3n" not in json.dumps(client.get(f"/git/{pid}/graph").json())
    assert client.post(f"/git/{pid}/remote/set-url",
                       json={"name": "origin", "url": "https://example.com/new.git"}).status_code == 200
    assert client.post(f"/git/{pid}/remote/add", json={"name": "--x", "url": "u"}).status_code == 400
    assert client.post(f"/git/{pid}/remote/add", json={"name": "r", "url": "--upload-pack=x"}).status_code == 400
    assert client.post(f"/git/{pid}/fetch", json={"name": "--all"}).status_code == 400
    assert client.post(f"/git/{pid}/remote/remove", json={"name": "origin"}).status_code == 200


@needs_git
def test_git_path_arguments_are_contained(client, project):
    pid = project["id"]
    for ep in ("discard", "resolve"):
        r = client.post(f"/git/{pid}/{ep}", json={"ref" if ep == "discard" else "path": "../../etc/passwd"})
        assert r.status_code == 400, ep
    assert client.post(f"/git/{pid}/stage", json={"files": ["../x"]}).status_code == 400
    assert client.get(f"/git/{pid}/diff/file", params={"path": "/etc/passwd"}).status_code == 400


def test_git_unknown_project(client):
    assert client.get("/git/ghost/status").status_code == 404
    assert client.get("/git/ghost/log").status_code == 404


def test_git_init_on_plain_folder(client):
    p = client.post("/api/projects", json={"name": "plain", "git_init": False}).json()
    st = client.get(f"/git/{p['id']}/status").json()
    assert st["is_git"] is False and st["clean"] is True and st["conflicts"] == []
    if not __import__("shutil").which("git"):
        pytest.skip("git not installed")
    assert client.post(f"/git/{p['id']}/init").status_code == 200
    assert client.get(f"/git/{p['id']}/status").json()["is_git"] is True


def test_git_identity_roundtrip(client):
    if not __import__("shutil").which("git"):
        pytest.skip("git not installed")
    assert client.post("/git/config", json={"name": "Ada", "email": "ada@example.com"}).json() == {"ok": True}
    assert client.get("/api/git/config").json() == {"name": "Ada", "email": "ada@example.com"}
    assert client.post("/api/git/config", json={"name": "bad\nname"}).status_code == 400


# ------------------------------------------------------------ auth + keys ---

def test_auth_token_endpoints_and_secret_handling(client, workspace, tmp_path):
    secret = "zen_live_0123456789abcdef"
    r = client.post("/api/auth/token", json={"provider_id": "opencode", "token": secret})
    assert r.status_code == 200 and r.json()["status"]["opencode"]["configured"] is True
    assert secret not in r.text
    auth_file = tmp_path / "share" / "opencode" / "auth.json"
    data = json.loads(auth_file.read_text())
    assert data["opencode"] == {"type": "api", "key": secret}  # opencode's own shape
    if sys.platform != "win32":
        assert oct(auth_file.stat().st_mode & 0o777) == "0o600"

    # opencode-go is stored the same way and is removable
    client.post("/api/auth/token", json={"provider_id": "opencode-go", "token": "go-key-0123456789abcdef"})
    st = client.get("/api/auth/status").json()
    assert st["opencode-go"]["configured"] is True
    assert "go-key-0123456789abcdef" not in json.dumps(st)
    out = client.request("DELETE", "/api/auth/token", json={"provider_id": "opencode-go"}).json()
    assert out["status"]["opencode-go"]["configured"] is False
    assert json.loads(auth_file.read_text()).get("opencode-go") is None

    # provider key lives in opencode.json, 0600, never echoed
    gem = "AIzaSy-test-key-0123456789"
    r = client.post("/api/auth/token", json={"provider_id": "gemini", "token": gem,
                                              "base_url": "https://x.example/v1"})
    assert gem not in r.text
    cfg_path = tmp_path / "cfg" / "opencode" / "opencode.json"
    assert json.loads(cfg_path.read_text())["provider"]["gemini"]["options"]["apiKey"] == gem
    if sys.platform != "win32":
        assert oct(cfg_path.stat().st_mode & 0o777) == "0o600"
    client.request("DELETE", "/api/auth/token", json={"provider_id": "gemini"})
    assert client.get("/api/auth/status").json()["gemini"]["configured"] is False


def test_short_tokens_are_fully_masked(client):
    client.post("/api/auth/token", json={"provider_id": "opencode", "token": "abcdefghij"})  # 10 chars
    prev = client.get("/api/auth/status").json()["opencode"]["preview"]
    assert prev == "****"


def test_github_token_validated_and_credentials_merged(client, monkeypatch, tmp_path):
    from ocmb import auth_cfg
    home = tmp_path / "home"
    cred = home / ".git-credentials"
    cred.write_text("https://u:p@gitlab.com\nhttps://old:tok@github.com\n")

    def reject(tok):
        raise ValueError("github rejected token (HTTP 401)")

    monkeypatch.setattr(auth_cfg, "validate_github_token", reject)
    r = client.post("/api/auth/token", json={"provider_id": "github", "token": "ghp_bad"})
    assert r.status_code == 400 and "invalid" in r.json()["detail"].lower()
    assert "old:tok" in cred.read_text()  # untouched on failure

    monkeypatch.setattr(auth_cfg, "validate_github_token", lambda tok: "octocat")
    tok = "ghp_abcdefghijklmnopqrstuvwxyz0123"
    r = client.post("/api/auth/token", json={"provider_id": "github", "token": tok})
    assert r.status_code == 200
    assert tok not in r.text
    assert r.json()["status"]["github"]["login"] == "octocat"
    text = cred.read_text()
    assert "gitlab.com" in text and "old:tok" not in text and tok in text
    if sys.platform != "win32":
        assert oct(cred.stat().st_mode & 0o777) == "0o600"

    client.request("DELETE", "/api/auth/token", json={"provider_id": "github"})
    text = cred.read_text()
    assert "gitlab.com" in text and "github.com" not in text
    assert client.get("/api/auth/status").json()["github"]["configured"] is False


def test_workspace_setting_validation(client, tmp_path):
    assert client.post("/api/settings/workspace", json={"path": "  "}).status_code == 400
    target = str(tmp_path / "newws")
    assert client.post("/api/settings/workspace", json={"path": target}).json()["workspace_dir"] == target
    assert client.get("/api/settings/workspace").json() == {"workspace_dir": target}
    # new projects land in the new workspace
    p = client.post("/api/projects", json={"name": "inws", "git_init": False}).json()
    assert os.path.dirname(p["path"]) == target


# ---------------------------------------------------------------- models ---

def test_models_global_catalog_and_config_providers(client):
    client.post("/api/models/register-local", json={
        "provider_id": "lan", "name": "LAN", "base_url": "http://10.0.0.5:11434/v1",
        "models": ["llama3"], "api_key": ""})
    g = client.get("/api/models/global").json()
    ids = {p["id"] for p in g["providers"]}
    assert "opencode" in ids and "lan" in ids and g["source"] == "catalog"
    assert client.get("/api/models/default").json()["source"] == "catalog"


def test_models_for_project_falls_back_without_engine(client, project, monkeypatch):
    from ocmb import main

    async def boom(pid):
        raise RuntimeError("no engine")

    monkeypatch.setattr(main.manager, "get", boom)
    r = client.get(f"/api/models/{project['id']}")
    assert r.status_code == 200 and r.json()["source"] == "catalog"
    r = client.get("/api/models/ghost-project")  # unknown project: still not a 500
    assert r.status_code == 200


def test_models_engine_providers_normalized(client, project, monkeypatch):
    from ocmb import main

    class Inst:
        url = "http://engine.invalid"

    async def get(pid):
        return Inst()

    class FakeResp:
        status_code = 200

        def json(self):
            return {"providers": [{"id": "p1", "name": "P1", "models": [{"id": "m1", "name": "M One"}]}],
                    "default": {"p1": "m1"}}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, **kw):
            return FakeResp()

    monkeypatch.setattr(main.manager, "get", get)
    monkeypatch.setattr(main, "_client", lambda: FakeClient())
    r = client.get(f"/api/models/{project['id']}").json()
    assert r["source"] == "engine"
    p1 = next(p for p in r["providers"] if p["id"] == "p1")
    assert p1["models"] == {"m1": {"name": "M One"}}
    assert any(p["id"] == "opencode" for p in r["providers"])  # catalog fills the gaps


def test_models_add_delete_never_echo_keys(client, project, tmp_path):
    client.post("/api/auth/token", json={"provider_id": "acme", "token": "sk-supersecret-0123456789"})
    r = client.post(f"/api/models/{project['id']}", json={
        "provider_id": "acme", "model_id": "m1", "options": {"name": "M1", "apiKey": "x"}, "set_default": True})
    assert r.status_code == 200 and "supersecret" not in r.text
    cfg_path = tmp_path / "cfg" / "opencode" / "opencode.json"
    on_disk = json.loads(cfg_path.read_text())
    assert on_disk["model"] == "acme/m1"
    assert "apiKey" not in on_disk["provider"]["acme"]["models"]["m1"]  # options are whitelisted
    d = client.request("DELETE", f"/api/models/{project['id']}", json={"provider_id": "acme", "model_id": "m1"})
    assert d.status_code == 200 and "supersecret" not in d.text
    assert "model" not in json.loads(cfg_path.read_text())
    assert client.post(f"/api/models/{project['id']}", json={"provider_id": " ", "model_id": "m"}).status_code == 400


def test_register_local_masks_key_and_uses_placeholder(client, tmp_path):
    key = "lm-secret-key-0123456789"
    r = client.post("/api/models/register-local", json={
        "provider_id": "lm", "name": "LM", "base_url": "http://h:1234/v1",
        "models": [{"id": "r1-distill"}, {"name": "no id"}, "plain"], "api_key": key})
    assert r.status_code == 200 and key not in r.text
    cfg_path = tmp_path / "cfg" / "opencode" / "opencode.json"
    prov = json.loads(cfg_path.read_text())["provider"]["lm"]
    assert prov["options"]["apiKey"] == key
    assert set(prov["models"]) == {"r1-distill", "plain"}
    assert prov["models"]["r1-distill"]["reasoning"] is True
    client.post("/api/models/register-local", json={
        "provider_id": "open", "name": "Open", "base_url": "http://h:1/v1", "models": []})
    assert json.loads(cfg_path.read_text())["provider"]["open"]["options"]["apiKey"] == "local"
    assert client.post("/api/models/register-local", json={
        "provider_id": "", "name": "x", "base_url": "http://h"}).status_code == 400


def test_probe_host_validation(client):
    for host in ("evil.com/x?", "a@b", "a b", ""):
        assert client.post("/api/models/probe-host", json={"host": host}).status_code == 400, host
    assert client.post("/api/models/probe-host", json={"host": "h", "port": 0}).status_code == 400
    assert client.post("/api/models/probe-host", json={"host": "h", "path": "x"}).status_code == 400


def test_favorites_toggle(client, tmp_path):
    assert client.get("/api/favorites").json() == {"favorites": []}
    r = client.post("/api/favorites", json={"provider_id": "p", "model_id": "m"}).json()
    assert r == {"favorites": ["p/m"], "added": True}
    r = client.post("/api/favorites", json={"provider_id": "p", "model_id": "m"}).json()
    assert r == {"favorites": [], "added": False}


def test_scan_lan_localhost_only(client):
    r = client.post("/api/models/scan-lan", json={"include_lan": False})
    assert r.status_code == 200 and r.json()["count"] == len(r.json()["servers"])


# ----------------------------------------------------------------- proxy ---

def test_proxy_unknown_project_404(client):
    assert client.get("/oc/ghost/session").status_code == 404
    assert client.post("/oc/ghost/session", json={}).status_code == 404
    assert client.get("/api/oc/ghost/event").status_code == 404


def test_proxy_engine_missing_is_502_and_no_leak(client, project, monkeypatch):
    from ocmb import main, manager as mgr
    monkeypatch.setattr(mgr, "OPENCODE_BIN", "definitely-not-an-installed-binary-xyz")
    r = client.get(f"/oc/{project['id']}/session")
    assert r.status_code == 502
    assert main.manager._instances == {}  # failed start leaves nothing behind


def test_proxy_strips_bridge_token(client, project, monkeypatch):
    from ocmb import main
    seen = {}

    class Inst:
        url = "http://engine.invalid"

    async def get(pid):
        return Inst()

    class FakeResp:
        status_code = 200
        content = b"{}"
        headers = {"content-type": "application/json"}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def request(self, method, url, **kw):
            seen["url"] = url
            return FakeResp()

    monkeypatch.setattr(main, "AUTH_TOKEN", "tk")
    monkeypatch.setattr(main.manager, "get", get)
    monkeypatch.setattr(main, "_client", lambda: FakeClient())
    r = client.get(f"/oc/{project['id']}/session?token=tk&limit=5")
    assert r.status_code == 200
    assert seen["url"] == "http://engine.invalid/session?limit=5"
