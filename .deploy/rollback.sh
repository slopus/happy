#!/usr/bin/env bash
#
# Roll back to the previous deploy (restore :rollback tagged images)
#
# Usage:
#   ./scripts/rollback.sh            # Roll back server + webapp
#   ./scripts/rollback.sh --server   # Roll back server only
#   ./scripts/rollback.sh --webapp   # Roll back webapp only
#
# This restores the images tagged as :rollback by deploy.sh.
# No rebuild required — just swaps the image tag and restarts.
#
set -euo pipefail

ERYING="root@erying-0"
RELAY_DIR="/mnt/gluster-remote-docker-storage/happy-relay"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}==> $*${NC}"; }
warn()  { echo -e "${YELLOW}==> $*${NC}"; }
error() { echo -e "${RED}==> $*${NC}" >&2; }

MODE="all"
for arg in "$@"; do
    case "$arg" in
        --server) MODE="server" ;;
        --webapp) MODE="webapp" ;;
        --help|-h)
            head -12 "$0" | tail -8
            exit 0
            ;;
        *) error "Unknown arg: $arg"; exit 1 ;;
    esac
done

info "Rolling back (mode: $MODE)..."
ssh "$ERYING" bash -s -- "$MODE" "$RELAY_DIR" <<'REMOTE_ROLLBACK'
set -euo pipefail
MODE="$1"
RELAY_DIR="$2"

TARGETS=()
if [ "$MODE" = "server" ] || [ "$MODE" = "all" ]; then
    TARGETS+=(happy-server)
fi
if [ "$MODE" = "webapp" ] || [ "$MODE" = "all" ]; then
    TARGETS+=(happy-webapp)
fi

for img in "${TARGETS[@]}"; do
    if docker image inspect "${img}:rollback" &>/dev/null; then
        docker tag "${img}:rollback" "${img}:latest"
        echo "  Restored ${img}:rollback -> ${img}:latest"
    else
        echo "  WARNING: No ${img}:rollback image found — skipping"
    fi
done

cd "$RELAY_DIR"
echo "  Restarting containers..."
if [ "$MODE" = "server" ]; then
    docker compose up -d --force-recreate happy-server
elif [ "$MODE" = "webapp" ]; then
    docker compose up -d --force-recreate happy-webapp
else
    docker compose up -d --force-recreate happy-server happy-webapp
fi
REMOTE_ROLLBACK

info "Rollback complete."

sleep 3
if curl -sf --max-time 10 "https://happy-relay.seas.house/health" > /dev/null 2>&1; then
    info "Server is healthy after rollback."
else
    warn "Health check failed. Check logs on erying-0."
fi
