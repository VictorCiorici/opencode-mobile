"""Manages one `opencode serve` instance per project.

Each project gets its own opencode server process bound to 127.0.0.1 on a
dedicated port, started lazily on first use and stopped when idle.
"""
from __future__ import annotations

import asyncio
import subprocess
import time

import httpx

from .config import OPENCODE_BIN, INSTANCE_BASE_PORT
from .projects import get_project


class Instance:
    def __init__(self, pid: str, path: str, port: int):
        self.pid = pid
        self.path = path
        self.port = port
        self.proc: subprocess.Popen | None = None
        self.last_used = time.time()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.last_used = time.time()
            return
        self.proc = subprocess.Popen(
            [OPENCODE_BIN, "serve", "--port", str(self.port), "--hostname", "127.0.0.1"],
            cwd=self.path,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc = None


class Manager:
    def __init__(self) -> None:
        self._instances: dict[str, Instance] = {}
        self._ports: set[int] = set()
        self._lock = asyncio.Lock()

    async def _alloc_port(self) -> int:
        port = INSTANCE_BASE_PORT
        while port in self._ports:
            port += 1
        return port

    async def get(self, pid: str) -> Instance:
        """Return a healthy running instance for the project."""
        async with self._lock:
            inst = self._instances.get(pid)
            proj = get_project(pid)
            if not proj:
                raise KeyError(f"unknown project: {pid}")
            created = False
            if inst is None:
                inst = Instance(pid, proj["path"], await self._alloc_port())
                self._instances[pid] = inst
                self._ports.add(inst.port)
                created = True
            inst.start()
        if created or await self.needs_wait(inst):
            ok = await self._wait_healthy(inst)
            if not ok:
                raise RuntimeError(
                    f"opencode failed to start for project '{pid}'. "
                    "Is 'opencode' installed inside this Debian proot?"
                )
        return inst

    @staticmethod
    async def needs_wait(inst: Instance) -> bool:
        try:
            async with httpx.AsyncClient(timeout=1.5) as c:
                r = await c.get(f"{inst.url}/global/health")
                return r.status_code != 200
        except Exception:
            return True

    @staticmethod
    async def _wait_healthy(inst: Instance, timeout: float = 30.0) -> bool:
        deadline = time.time() + timeout
        async with httpx.AsyncClient(timeout=2.0) as c:
            while time.time() < deadline:
                try:
                    r = await c.get(f"{inst.url}/global/health")
                    if r.status_code == 200:
                        return True
                except Exception:
                    pass
                await asyncio.sleep(0.5)
        return False

    async def stop_instance(self, pid: str, remove: bool = True) -> None:
        async with self._lock:
            inst = self._instances.pop(pid, None)
            if inst:
                inst.stop()
                if remove:
                    self._ports.discard(inst.port)

    async def reap_idle(self, max_idle: float = 1800.0) -> None:
        """Stop instances unused for max_idle seconds (called periodically)."""
        now = time.time()
        async with self._lock:
            for pid, inst in list(self._instances.items()):
                if inst.proc and inst.proc.poll() is not None:
                    continue
                if now - inst.last_used > max_idle:
                    inst.stop()


manager = Manager()
