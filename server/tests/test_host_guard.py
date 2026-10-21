"""DNS-rebinding guard: loopback-bound bridges only answer loopback Host names."""
import pytest

from ocmb import config, main


@pytest.mark.parametrize("value,expected", [
    ("127.0.0.1:8787", "127.0.0.1"),
    ("localhost", "localhost"),
    ("[::1]:8787", "::1"),
    ("evil.com:80", "evil.com"),
])
def test_host_only(value, expected):
    assert main._host_only(value) == expected


@pytest.mark.parametrize("host,ok", [
    ("127.0.0.1", True), ("127.8.9.10", True), ("::1", True), ("[::1]", True),
    ("LOCALHOST", True), ("evil.com", False), ("127.0.0.1.nip.io", False), ("", False),
])
def test_is_loopback(host, ok):
    assert main._is_loopback(host) is ok


@pytest.mark.parametrize("host,status", [
    ("127.0.0.1:8787", 200),
    ("localhost:8787", 200),
    ("[::1]:8787", 200),
    ("testserver", 200),          # explicitly allowed via OCMB_ALLOWED_HOSTS
    ("evil.com:8787", 403),
    ("rebind.attacker.example", 403),
])
def test_host_guard_on_loopback_bind(client, monkeypatch, host, status):
    monkeypatch.setattr(config, "HOST", "127.0.0.1")
    r = client.get("/api/health", headers={"Host": host})
    assert r.status_code == status


def test_host_guard_blocks_terminal_via_rebinding(client, monkeypatch):
    monkeypatch.setattr(config, "HOST", "127.0.0.1")
    r = client.post("/api/terminal/x/exec", json={"cmd": "echo pwned"},
                    headers={"Host": "evil.com"})
    assert r.status_code == 403


def test_host_guard_off_when_bound_to_lan(client, monkeypatch):
    monkeypatch.setattr(config, "HOST", "0.0.0.0")
    r = client.get("/api/health", headers={"Host": "phone.tailnet.ts.net:8787"})
    assert r.status_code == 200
