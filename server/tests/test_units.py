"""Unit tests for the bridge's helper modules (no HTTP layer)."""
import asyncio
import json
import os
import stat
import sys

import pytest

from conftest import needs_git, run_git
from ocmb import auth_cfg, config, gitops, local_scanner, models_cfg, projects


def run(coro):
    return asyncio.run(coro)


# ------------------------------------------------------------ write_private ---

def test_write_private_creates_with_mode_and_replaces(tmp_path):
    p = tmp_path / "d" / "secret.json"
    config.write_private(p, "one")
    config.write_private(p, "two")
    assert p.read_text() == "two"
    assert [x.name for x in p.parent.iterdir()] == ["secret.json"]  # no temp litter
    if sys.platform != "win32":
        assert stat.S_IMODE(p.stat().st_mode) == 0o600
    config.write_private(p, "pub", 0o644)
    if sys.platform != "win32":
        assert stat.S_IMODE(p.stat().st_mode) == 0o644


# ------------------------------------------------------------------ gitops ---

def test_safe_ref_rejects_dangerous_names():
    for bad in ("", "  ", "-D", "--orphan", "a b", "a\tb", "a^b", "a~1", "a:b"):
        with pytest.raises(gitops.GitError):
            gitops._safe_ref(bad)
    assert gitops._safe_ref(" feature/x-1 ") == "feature/x-1"


def test_safe_name_and_url():
    for bad in ("", "-x", "a b", "a:b", "a*"):
        with pytest.raises(gitops.GitError):
            gitops._safe_name(bad)
    assert gitops._safe_name("origin") == "origin"
    for bad in ("", "-oProxyCommand=x", "a\nb"):
        with pytest.raises(gitops.GitError):
            gitops._safe_url(bad)
    assert gitops._safe_url("https://h/r.git") == "https://h/r.git"


def test_git_rel_and_safe_path(tmp_path):
    root = str(tmp_path)
    assert gitops._git_rel(root, "a/b.txt") == "a/b.txt"
    assert gitops._git_rel(root, "a/../b.txt") == "b.txt"
    for bad in ("../x", "a/../../x", ".", ""):
        with pytest.raises(gitops.GitError):
            gitops._git_rel(root, bad)
    with pytest.raises(gitops.GitError):
        gitops._git_rel(root, os.path.abspath(os.path.join(root, "..", "x")))


def test_strip_userinfo():
    f = gitops._strip_userinfo
    assert f("https://u:tok@github.com/o/r.git") == "https://github.com/o/r.git"
    assert f("https://tok@github.com/o/r.git") == "https://github.com/o/r.git"
    assert f("https://github.com/o/r.git") == "https://github.com/o/r.git"
    assert f("git@github.com:o/r.git") == "git@github.com:o/r.git"
    assert f("/local/path") == "/local/path"


def test_stash_ref_rejects_negative():
    with pytest.raises(gitops.GitError):
        gitops._stash_ref(-1)
    assert gitops._stash_ref(2) == "stash@{2}"


def test_status_of_non_repo(tmp_path):
    st = run(gitops.status(str(tmp_path)))
    assert st["is_git"] is False and st["clean"] is True and st["has_conflicts"] is False


def test_git_error_on_missing_directory(tmp_path):
    with pytest.raises(gitops.GitError):
        run(gitops.branches(str(tmp_path / "gone")))


@needs_git
def test_status_clean_branch_and_mixed(repo):
    st = run(gitops.status(str(repo)))
    assert st["is_git"] and st["clean"] and st["branch"] == "main"
    (repo / "a.txt").write_text("changed\n")
    run(gitops.stage(str(repo), ["a.txt"]))
    (repo / "a.txt").write_text("changed again\n")
    (repo / "new.txt").write_text("n")
    st = run(gitops.status(str(repo)))
    assert [f["path"] for f in st["staged"]] == ["a.txt"]
    assert [f["path"] for f in st["unstaged"]] == ["a.txt"]
    assert [f["path"] for f in st["untracked"]] == ["new.txt"]
    assert st["clean"] is False


@needs_git
def test_status_branch_with_upstream_and_unborn(tmp_path):
    p = tmp_path / "empty"
    p.mkdir()
    run_git(p, "init", "--initial-branch", "trunk")
    st = run(gitops.status(str(p)))
    assert st["is_git"] and st["branch"] == "trunk"


@needs_git
def test_merge_conflict_detected_and_resolved(repo):
    r = str(repo)
    run(gitops.branch_create(r, "other"))
    (repo / "a.txt").write_text("main side\n")
    run(gitops.commit(r, "main change"))
    run(gitops.checkout(r, "other"))
    (repo / "a.txt").write_text("other side\n")
    run(gitops.commit(r, "other change"))
    run(gitops.checkout(r, "main"))
    with pytest.raises(gitops.GitError):
        run(gitops.merge(r, "other"))
    st = run(gitops.status(r))
    assert st["has_conflicts"] and [c["path"] for c in st["conflicts"]] == ["a.txt"]
    with pytest.raises(gitops.GitError):
        run(gitops.resolve_conflict(r, "a.txt", "bogus"))
    out = run(gitops.resolve_conflict(r, "a.txt", "theirs"))
    assert "resolved a.txt" in out
    assert (repo / "a.txt").read_text() == "other side\n"
    assert not run(gitops.status(r))["has_conflicts"]


@needs_git
def test_commit_requires_message_and_respects_staging(repo):
    r = str(repo)
    (repo / "a.txt").write_text("v2\n")
    (repo / "b.txt").write_text("b\n")
    with pytest.raises(gitops.GitError):
        run(gitops.commit(r, "   "))
    run(gitops.stage(r, ["a.txt"]))
    run(gitops.commit(r, "only a"))
    st = run(gitops.status(r))
    assert [f["path"] for f in st["untracked"]] == ["b.txt"]
    run(gitops.commit(r, "all the rest"))  # nothing staged -> stage all
    assert run(gitops.status(r))["clean"]


@needs_git
def test_revert_and_log(repo):
    r = str(repo)
    (repo / "a.txt").write_text("v2\n")
    run(gitops.commit(r, "v2"))
    run(gitops.revert_commit(r, "HEAD"))
    log = run(gitops.log(r, 5))
    assert [c["subject"] for c in log][0].startswith("Revert")
    assert len(log[0]["hash"]) == 8
    with pytest.raises(gitops.GitError):
        run(gitops.revert_commit(r, "HEAD~1"))  # '~' refs are refused by _safe_ref


@needs_git
def test_discard_restores_file(repo):
    (repo / "a.txt").write_text("oops\n")
    run(gitops.discard(str(repo), "a.txt"))
    assert (repo / "a.txt").read_text() == "hello\n"


@needs_git
def test_git_timeout_kills_process(repo, monkeypatch):
    with pytest.raises(gitops.GitError, match="timed out"):
        run(gitops._run(str(repo), "status", timeout=0.0001))


@needs_git
def test_commit_cancel_does_not_leak(repo):
    async def go():
        t = asyncio.create_task(gitops._run(str(repo), "log"))
        await asyncio.sleep(0)
        t.cancel()
        with pytest.raises(asyncio.CancelledError):
            await t
    run(go())


def test_exec_cmd_validation(tmp_path):
    with pytest.raises(ValueError):
        run(gitops.exec_cmd(str(tmp_path), "  "))
    res = run(gitops.exec_cmd(str(tmp_path), "echo hi", timeout=-5))  # bad timeout -> default
    assert res["ok"] and "hi" in res["stdout"]


# ---------------------------------------------------------------- projects ---

def test_slug():
    assert projects._slug("My Cool App!") == "my-cool-app"
    assert projects._slug("   ") == "project"
    assert projects._slug("../../etc") == "etc"
    assert "/" not in projects._slug("a/b\\c")


def test_registry_survives_corruption(workspace):
    config.REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.REGISTRY_PATH.write_text("{not json")
    assert projects.list_projects() == []
    config.REGISTRY_PATH.write_text(json.dumps({"projects": "oops"}))
    assert projects.list_projects() == []
    p = projects.create_project("ok", git_init=False)
    assert projects.get_project(p["id"])["path"] == p["path"]
    assert projects.get_project("nope") is None


def test_create_project_unique_ids_and_paths_stay_in_workspace(workspace):
    a = projects.create_project("../../escape", git_init=False)
    b = projects.create_project("../../escape", git_init=False)
    assert a["id"] != b["id"]
    for p in (a, b):
        assert os.path.dirname(p["path"]) == str(workspace)


def test_import_rejects_duplicates_and_files(workspace, tmp_path):
    d = tmp_path / "imp"
    d.mkdir()
    projects.import_project(str(d))
    with pytest.raises(ValueError):
        projects.import_project(str(d))
    f = tmp_path / "file.txt"
    f.write_text("x")
    with pytest.raises(ValueError):
        projects.import_project(str(f))


def test_remove_project_delete_dir_rules(workspace):
    inside = projects.create_project("inside", git_init=False)
    assert run(projects.remove_project(inside["id"], delete_dir=False))
    assert os.path.isdir(inside["path"])  # kept when delete_dir is False
    again = projects.create_project("again", git_init=False)
    assert run(projects.remove_project(again["id"], delete_dir=True))
    assert not os.path.exists(again["path"])
    assert run(projects.remove_project("missing")) is False
    # a project that IS the workspace root is never deleted
    root = projects.import_project(str(workspace))
    run(projects.remove_project(root["id"], delete_dir=True))
    assert workspace.exists()


def test_clone_validation(workspace):
    for url in ("", "-u", "--upload-pack=x", "a\nb"):
        with pytest.raises(ValueError):
            projects.clone_project(url)
    with pytest.raises(ValueError):
        projects.clone_project("https://h/r.git", branch="--x")


@needs_git
def test_clone_failure_cleans_up_and_leaves_registry_untouched(workspace, tmp_path):
    with pytest.raises(ValueError, match="git clone failed"):
        projects.clone_project(str(tmp_path / "no-such-repo"), name="bad")
    assert projects.list_projects() == []
    assert not (workspace / "bad").exists()


# ---------------------------------------------------------------- auth_cfg ---

def test_mask_token():
    assert auth_cfg.mask_token("") == ""
    assert auth_cfg.mask_token("short") == "****"
    assert auth_cfg.mask_token("12345678901234") == "****"  # <16 chars: nothing leaks
    m = auth_cfg.mask_token("sk-abcdefghijklmnopqrstuvwxyz")
    assert m == "sk-a...wxyz" and "abcdefg" not in m


def test_auth_status_reads_legacy_token_field(workspace):
    auth_cfg._write_json(auth_cfg.AUTH_PATH, {"opencode": {"type": "api", "token": "legacy-token-0123456789"}})
    st = auth_cfg.get_auth_status()
    assert st["opencode"]["configured"] and "legacy-token" not in json.dumps(st)


def test_env_keys_count_as_configured(workspace, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env-0123456789abcdef")
    st = auth_cfg.get_auth_status()
    assert st["openai"]["configured"] is True and "env-0123" not in json.dumps(st)


def test_corrupt_auth_json_is_tolerated(workspace):
    auth_cfg.AUTH_PATH.parent.mkdir(parents=True, exist_ok=True)
    auth_cfg.AUTH_PATH.write_text("[1,2,3]")
    assert auth_cfg.get_auth_status()["opencode"]["configured"] is False
    auth_cfg.save_provider_key("opencode", "tok-0123456789abcdef")
    assert json.loads(auth_cfg.AUTH_PATH.read_text())["opencode"]["key"] == "tok-0123456789abcdef"


def test_empty_key_removes_credential(workspace):
    auth_cfg.save_provider_key("opencode", "tok-0123456789abcdef")
    auth_cfg.save_provider_key("opencode", "  ")
    assert "opencode" not in json.loads(auth_cfg.AUTH_PATH.read_text())


def test_provider_key_roundtrip_and_base_url(workspace, tmp_path):
    auth_cfg.save_provider_key("glm", "glm-key-0123456789abcdef", "https://glm.example/v4 ")
    cfg = json.loads((tmp_path / "cfg" / "opencode" / "opencode.json").read_text())
    assert cfg["provider"]["glm"]["options"] == {"apiKey": "glm-key-0123456789abcdef",
                                                  "baseURL": "https://glm.example/v4"}
    assert auth_cfg.get_auth_status()["glm"]["configured"]
    auth_cfg.remove_token("glm")
    assert not auth_cfg.get_auth_status()["glm"]["configured"]
    auth_cfg.remove_token("never-configured")  # no error


def test_git_credentials_merge_and_validation(workspace, tmp_path):
    cred = tmp_path / "home" / ".git-credentials"
    cred.write_text("https://a:b@gitlab.com\nhttps://x:y@github.com\n\nhttps://q:r@notgithub.com.evil.io\n")
    auth_cfg._merge_git_credentials("ghp_tok/with+odd=chars")
    lines = cred.read_text().splitlines()
    assert "https://a:b@gitlab.com" in lines
    assert "https://q:r@notgithub.com.evil.io" in lines  # lookalike host kept
    assert not any("x:y@github.com" in l for l in lines)
    assert sum("@github.com" in l for l in lines) == 2
    assert not any("tok/with" in l for l in lines)  # percent-encoded, can't break the URL
    with pytest.raises(ValueError):
        auth_cfg._merge_git_credentials("bad token\nhttps://evil")
    auth_cfg._merge_git_credentials("")
    assert "@github.com" not in cred.read_text()


def test_validate_github_token_handles_failures(monkeypatch):
    import httpx

    class R:
        def __init__(self, code, body):
            self.status_code, self._b = code, body

        def json(self):
            return self._b

    monkeypatch.setattr(httpx, "get", lambda *a, **k: R(401, {}))
    with pytest.raises(ValueError, match="401"):
        auth_cfg.validate_github_token("t")
    monkeypatch.setattr(httpx, "get", lambda *a, **k: R(200, {}))
    with pytest.raises(ValueError, match="no login"):
        auth_cfg.validate_github_token("t")
    monkeypatch.setattr(httpx, "get", lambda *a, **k: R(200, {"login": "me"}))
    assert auth_cfg.validate_github_token("t") == "me"

    def boom(*a, **k):
        raise httpx.ConnectError("dns secret-host")

    monkeypatch.setattr(httpx, "get", boom)
    with pytest.raises(ValueError, match="unreachable"):
        auth_cfg.validate_github_token("t")


def test_workspace_dir_helpers(workspace, tmp_path):
    assert auth_cfg.get_workspace_dir() == str(workspace)
    with pytest.raises(ValueError):
        auth_cfg.set_workspace_dir("")
    new = auth_cfg.set_workspace_dir(str(tmp_path / "a" / "b"))
    assert os.path.isdir(new) and auth_cfg.get_workspace_dir() == new


# -------------------------------------------------------------- models_cfg ---

def test_add_model_whitelists_options_and_merges(workspace):
    cfg = models_cfg.add_model("p", "m", {"name": "N", "apiKey": "leak", "evil": 1, "limit": {"context": 1}})
    entry = cfg["provider"]["p"]["models"]["m"]
    assert entry == {"name": "N", "limit": {"context": 1}}
    cfg = models_cfg.add_model("p", "m", {"note": "hi"})
    assert cfg["provider"]["p"]["models"]["m"] == {"name": "N", "limit": {"context": 1}, "note": "hi"}


def test_models_cfg_tolerates_garbage_config(workspace):
    path = models_cfg._config_paths(None)[-1]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("[1]")
    assert models_cfg._read(path) == {}
    path.write_text(json.dumps({"provider": {"p": "not-a-dict"}}))
    models_cfg.remove_model("p", "m")  # must not raise


def test_redact_masks_nested_keys_but_not_local():
    cfg = {"provider": {"a": {"options": {"apiKey": "k" * 20, "baseURL": "u"}},
                        "b": {"options": {"apiKey": "local"}},
                        "c": {"options": {"apiKey": "short"}}}, "list": [{"apiKey": "z" * 30}]}
    out = models_cfg.redact(cfg)
    assert out["provider"]["a"]["options"]["apiKey"] == "kkkk...kkkk"
    assert out["provider"]["b"]["options"]["apiKey"] == "local"
    assert out["provider"]["c"]["options"]["apiKey"] == "****"
    assert out["list"][0]["apiKey"].startswith("zzzz...")
    assert cfg["provider"]["a"]["options"]["apiKey"] == "k" * 20  # original untouched


def test_config_file_mode_follows_secrets(workspace):
    models_cfg.add_model("p", "m", None)
    path = models_cfg._config_paths(None)[-1]
    if sys.platform != "win32":
        assert stat.S_IMODE(path.stat().st_mode) == 0o644
    auth_cfg.save_provider_key("p", "sk-0123456789abcdefgh")
    if sys.platform != "win32":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    models_cfg.add_model("p", "m2", None)  # rewriting keeps it private
    if sys.platform != "win32":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_favorites_formats(workspace):
    fav = models_cfg._favorites_path()
    fav.parent.mkdir(parents=True, exist_ok=True)
    fav.write_text(json.dumps(["legacy/one"]))  # legacy bare array
    assert models_cfg.list_favorites() == ["legacy/one"]
    favs, added = models_cfg.toggle_favorite("p", "m")
    assert added and favs[0] == "p/m"
    assert json.loads(fav.read_text()) == {"favorites": ["p/m", "legacy/one"]}
    fav.write_text("garbage")
    assert models_cfg.list_favorites() == []


def test_default_model_cleared_on_remove(workspace):
    models_cfg.add_model("p", "m", None, set_default=True)
    assert models_cfg.current_default() == "p/m"
    models_cfg.remove_model("p", "m")
    assert models_cfg.current_default() is None


# ----------------------------------------------------------- local_scanner ---

def test_valid_host():
    for ok in ("localhost", "192.168.1.5", "my-host.local", "fe80::1"):
        assert local_scanner.valid_host(ok), ok
    for bad in ("", " ", "a/b", "a@b", "a?b", "a#b", "a b", "a" + chr(92) + "b", "[::1]", "x" * 300):
        assert not local_scanner.valid_host(bad), bad


def test_is_reasoning_model():
    assert local_scanner.is_reasoning_model("deepseek-R1-distill")
    assert local_scanner.is_reasoning_model("qwq-thinking")
    assert not local_scanner.is_reasoning_model("llama3")


def test_local_subnets_are_cidr24():
    subs = local_scanner._get_local_subnets()
    assert subs and all(s.endswith(".0/24") for s in subs)


class _Resp:
    def __init__(self, code, body):
        self.status_code, self._b = code, body

    def json(self):
        if isinstance(self._b, Exception):
            raise self._b
        return self._b


class _Client:
    def __init__(self, resp):
        self.resp = resp

    async def get(self, url, **kw):
        self.url = url
        if isinstance(self.resp, Exception):
            raise self.resp
        return self.resp


def test_probe_endpoint_parses_ollama_and_openai():
    c = _Client(_Resp(200, {"models": [{"name": "llama3", "size": 2 * 1024 ** 3}, {"model": "qwen"}, {}]}))
    res = run(local_scanner.probe_endpoint(c, "h", 11434, "/api/tags", "ollama", "Ollama"))
    assert [m["id"] for m in res["models"]] == ["llama3", "qwen"]
    assert res["models"][0]["size"] == "2.0 GB"
    assert res["base_url"] == "http://h:11434/v1" and res["healthy"] is True
    assert c.url == "http://h:11434/api/tags"

    c = _Client(_Resp(200, {"data": [{"id": "gpt-x"}, {"nope": 1}]}))
    res = run(local_scanner.probe_endpoint(c, "h", 1234, "/v1/models", "lmstudio", "LM Studio"))
    assert [m["id"] for m in res["models"]] == ["gpt-x"]
    assert res["name"] == "LM Studio (h:1234)"


def test_probe_endpoint_failures_return_none():
    for resp in (_Resp(500, {}), _Resp(200, ValueError("not json")), RuntimeError("conn refused")):
        assert run(local_scanner.probe_endpoint(_Client(resp), "h", 1, "/", "ollama", "x")) is None


def test_scan_ignores_bad_subnet_and_caps_huge_ones(monkeypatch):
    seen = []

    async def fake_probe(client, host):
        seen.append(host)
        return []

    monkeypatch.setattr(local_scanner, "probe_host_all_ports", fake_probe)
    assert run(local_scanner.scan_local_network("not-a-subnet", True)) == []
    assert set(seen) == {"127.0.0.1", "localhost"}
    seen.clear()
    run(local_scanner.scan_local_network("10.0.0.0/8", True))  # must not enumerate 16M hosts
    assert len(seen) == 66


def test_register_local_provider_merges_models_and_masks(workspace, tmp_path):
    out = local_scanner.register_local_provider("p", "P", "http://h/v1", ["a", {"id": "b", "name": "B"}], "key-0123456789abcdefgh")
    assert out["provider"]["p"]["options"]["apiKey"] == "key-...efgh"
    out = local_scanner.register_local_provider("p", "P", "http://h/v1", ["c"], "")
    assert set(out["provider"]["p"]["models"]) == {"a", "b", "c"}
    assert out["provider"]["p"]["options"]["apiKey"] == "local"
