#!/data/data/com.termux/files/usr/bin/env bash
# Launches the OpenForge bridge (and opencode if needed) inside proot Debian.
set -e
cd "$(dirname "$0")"

# 1. Python deps (first run only) — apt wheels work best on aarch64 proot
if ! python3 -c "import fastapi, uvicorn, httpx" >/dev/null 2>&1; then
    echo "[*] Installing python dependencies (apt)…"
    apt-get install -y python3-fastapi python3-uvicorn python3-httpx \
        || pip3 install -r server/requirements.txt
fi

# 2. Make sure an opencode TUI/serve instance is available for /api/health
if ! curl -s --max-time 2 http://127.0.0.1:4096/global/health >/dev/null 2>&1; then
    echo "[*] Starting shared opencode serve on :4096…"
    nohup opencode serve --port 4096 --hostname 127.0.0.1 \
        >/dev/null 2>&1 &
fi

# 3. Start the bridge
echo "[*] Bridge starting → open http://127.0.0.1:8787/ui in your browser"
echo "    (or 'Add to Home Screen' in Chrome for a native-app experience)"
exec python3 -m uvicorn ocmb.main:app \
    --app-dir server \
    --host "${OCMB_HOST:-127.0.0.1}" \
    --port "${OCMB_PORT:-8787}"
