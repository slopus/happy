#!/usr/bin/env bash
# Start the Happy dev stack: Expo web + Whisper STT + nginx TLS proxy.
# Backend runs on the relay server (happy-relay.seas.house).
set -euo pipefail
cd "$(dirname "$0")"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'
log()  { echo -e "${GREEN}[dev]${NC} $*"; }
info() { echo -e "${CYAN}[dev]${NC} $*"; }

cleanup() {
    log "Shutting down..."
    kill $(jobs -p) 2>/dev/null || true
    wait 2>/dev/null || true
    log "Done."
}
trap cleanup EXIT INT TERM

# --- Kill stale Expo process on port 8081 ---
fuser -k 8081/tcp 2>/dev/null || true

# --- Whisper STT (GPU) ---
if docker ps --format '{{.Names}}' | grep -q '^whisper-stt$'; then
    info "whisper-stt already running"
elif docker ps -a --format '{{.Names}}' | grep -q '^whisper-stt$'; then
    log "Starting whisper-stt..."
    docker start whisper-stt
else
    log "Creating whisper-stt container..."
    docker run -d --name whisper-stt \
        --gpus all \
        -e WHISPER__MODEL=Systran/faster-whisper-base \
        -p 8300:8000 \
        ghcr.io/speaches-ai/speaches:latest-cuda
fi

# --- Nginx TLS proxy ---
if docker ps --format '{{.Names}}' | grep -q '^whisper-tunnel$'; then
    info "whisper-tunnel already running"
else
    log "Starting whisper-tunnel (nginx TLS proxy)..."
    docker compose -f whisper-tunnel/docker-compose.yml up -d
fi

# --- Expo web (don't auto-open browser — we use the TLS proxy URL) ---
log "Starting Expo web on :8081..."
BROWSER=none yarn web &

echo ""
info "========================================="
info "  Happy dev stack is running!"
info "  Web app:   https://happy-dev.seas.house"
info "  Whisper:   https://whisper.seas.house"
info "  (local):   http://localhost:8081"
info "========================================="
echo ""
log "Press Ctrl+C to stop Expo (containers keep running)."

wait
