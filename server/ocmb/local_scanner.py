"""Local network & device AI model server scanner.
Discovers Ollama, llama.cpp, LM Studio, LocalAI, and vLLM instances on localhost and LAN.
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import socket
from pathlib import Path
from typing import Any
import httpx

# Standard local AI server ports & detection endpoints
PROBES = [
    {"type": "ollama", "port": 11434, "path": "/api/tags", "name": "Ollama"},
    {"type": "lmstudio", "port": 1234, "path": "/v1/models", "name": "LM Studio"},
    {"type": "llamacpp", "port": 8080, "path": "/v1/models", "name": "llama.cpp"},
    {"type": "vllm", "port": 8000, "path": "/v1/models", "name": "vLLM / LocalAI"},
    {"type": "localai", "port": 5000, "path": "/v1/models", "name": "LocalAI / Text-Gen"},
]


def _get_local_subnets() -> list[str]:
    """Find active IPv4 LAN subnets on this device (e.g. 192.168.1.0/24)."""
    subnets = set()
    try:
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            if not ip.startswith("127."):
                parts = ip.split(".")
                if len(parts) == 4:
                    subnets.add(f"{parts[0]}.{parts[1]}.{parts[2]}.0/24")
    except Exception:
        pass

    try:
        arp_path = Path("/proc/net/arp")
        if arp_path.exists():
            for line in arp_path.read_text().splitlines()[1:]:
                parts = line.split()
                if len(parts) >= 1:
                    ip = parts[0]
                    p = ip.split(".")
                    if len(p) == 4 and not ip.startswith("127."):
                        subnets.add(f"{p[0]}.{p[1]}.{p[2]}.0/24")
    except Exception:
        pass

    if not subnets:
        subnets.add("192.168.1.0/24")
        subnets.add("192.168.0.0/24")

    return list(subnets)


async def probe_endpoint(client: httpx.AsyncClient, host: str, port: int, path: str, s_type: str, s_name: str) -> dict[str, Any] | None:
    url = f"http://{host}:{port}{path}"
    try:
        r = await client.get(url, timeout=0.6)
        if r.status_code != 200:
            return None
        data = r.json()
        models = []

        if s_type == "ollama":
            for m in data.get("models", []):
                m_name = m.get("name") or m.get("model")
                if m_name:
                    size_gb = ""
                    if m.get("size"):
                        size_gb = f"{(m['size'] / (1024**3)):.1f} GB"
                    models.append({
                        "id": m_name,
                        "name": m_name,
                        "size": size_gb,
                        "details": m.get("details", {}),
                    })
            base_url = f"http://{host}:{port}/v1"

        else:
            for m in data.get("data", []):
                m_id = m.get("id")
                if m_id:
                    models.append({"id": m_id, "name": m_id, "size": ""})
            base_url = f"http://{host}:{port}/v1"

        return {
            "type": s_type,
            "name": f"{s_name} ({host}:{port})",
            "host": host,
            "port": port,
            "url": f"http://{host}:{port}",
            "base_url": base_url,
            "models": models,
            "healthy": True,
        }
    except Exception:
        return None


async def probe_host_all_ports(client: httpx.AsyncClient, host: str) -> list[dict[str, Any]]:
    tasks = [
        probe_endpoint(client, host, p["port"], p["path"], p["type"], p["name"])
        for p in PROBES
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    return [r for r in results if isinstance(r, dict)]


async def scan_local_network(custom_subnet: str | None = None, include_lan: bool = True) -> list[dict[str, Any]]:
    """Scan localhost and optionally the local LAN subnet for running AI model servers."""
    found: list[dict[str, Any]] = []
    hosts_to_scan = ["127.0.0.1", "localhost"]

    if include_lan:
        subnets = [custom_subnet] if custom_subnet else _get_local_subnets()
        for sub in subnets:
            try:
                net = ipaddress.ip_network(sub, strict=False)
                for ip in list(net.hosts())[:64]:
                    hosts_to_scan.append(str(ip))
            except Exception:
                pass

    hosts_to_scan = list(dict.fromkeys(hosts_to_scan))

    limits = httpx.Limits(max_keepalive_connections=50, max_connections=100)
    async with httpx.AsyncClient(limits=limits, headers={"User-Agent": "OpenForge-Scanner/1.0"}) as client:
        sem = asyncio.Semaphore(40)

        async def _scan_host(h: str):
            async with sem:
                return await probe_host_all_ports(client, h)

        tasks = [_scan_host(h) for h in hosts_to_scan]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for res in results:
            if isinstance(res, list):
                found.extend(res)

    return found


def register_local_provider(provider_id: str, name: str, base_url: str, models: list[dict[str, Any]], api_key: str = "") -> dict:
    """Save a local/LAN provider into ~/.config/opencode/opencode.json."""
    from .models_cfg import _config_paths, _read, _write

    path = _config_paths(None)[-1]
    cfg = _read(path)
    prov = cfg.setdefault("provider", {}).setdefault(provider_id, {})
    prov["npm"] = "@ai-sdk/openai-compatible"
    prov["name"] = name
    prov["options"] = {"baseURL": base_url}
    if api_key:
        prov["options"]["apiKey"] = api_key

    existing_models = prov.setdefault("models", {})
    for m in models:
        mid = m["id"] if isinstance(m, dict) else str(m)
        mname = m.get("name", mid) if isinstance(m, dict) else mid
        is_reasoning = "r1" in mid.lower() or "reasoning" in mid.lower() or "thinking" in mid.lower()
        existing_models[mid] = {
            "name": mname,
            "tool_call": True,
            "reasoning": is_reasoning,
        }

    _write(path, cfg)
    return cfg
