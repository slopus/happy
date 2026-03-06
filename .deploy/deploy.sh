#!/usr/bin/env bash
#
# Deploy happy-dev to production (erying-0)
#
# Usage:
#   ./scripts/deploy.sh              # Push + rebuild server + webapp
#   ./scripts/deploy.sh --server     # Push + rebuild server only
#   ./scripts/deploy.sh --webapp     # Push + rebuild webapp only
#   ./scripts/deploy.sh --push-only  # Just push, don't rebuild
#
# Prerequisites:
#   - SSH access to erying-0 (ssh root@erying-0)
#   - Git remote 'origin' pointing to your fork
#
set -euo pipefail

ERYING="root@erying-0"
RELAY_DIR="/mnt/gluster-remote-docker-storage/happy-relay"
REPO_DIR="/mnt/docker-local/happy-relay/happy"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}==> $*${NC}"; }
warn()  { echo -e "${YELLOW}==> $*${NC}"; }
error() { echo -e "${RED}==> $*${NC}" >&2; }

# Parse args
MODE="all"
for arg in "$@"; do
    case "$arg" in
        --server)    MODE="server" ;;
        --webapp)    MODE="webapp" ;;
        --push-only) MODE="push-only" ;;
        --help|-h)
            head -12 "$0" | tail -9
            exit 0
            ;;
        *) error "Unknown arg: $arg"; exit 1 ;;
    esac
done

# Step 1: Push to origin
info "Pushing to origin..."
BRANCH=$(git rev-parse --abbrev-ref HEAD)
git push origin "$BRANCH"
info "Pushed $BRANCH"

if [ "$MODE" = "push-only" ]; then
    info "Push complete. Skipping rebuild."
    exit 0
fi

# Step 2: Tag current images as :rollback (safety net)
info "Tagging current images as :rollback on erying-0..."
ssh "$ERYING" bash -s <<'REMOTE_TAG'
set -euo pipefail
for img in happy-server happy-webapp; do
    if docker image inspect "${img}:latest" &>/dev/null; then
        docker tag "${img}:latest" "${img}:rollback"
        echo "  Tagged ${img}:latest -> ${img}:rollback"
    fi
done
REMOTE_TAG

# Step 3: Pull + rebuild on erying-0
info "Rebuilding on erying-0 (mode: $MODE)..."
ssh "$ERYING" bash -s -- "$MODE" "$REPO_DIR" "$RELAY_DIR" <<'REMOTE_BUILD'
set -euo pipefail
MODE="$1"
REPO_DIR="$2"
RELAY_DIR="$3"

cd "$REPO_DIR"
echo "  Pulling latest from origin..."
git pull origin main --ff-only

if [ "$MODE" = "server" ] || [ "$MODE" = "all" ]; then
    echo "  Building happy-server..."
    docker build -f Dockerfile.server -t happy-server:latest .
fi

if [ "$MODE" = "webapp" ] || [ "$MODE" = "all" ]; then
    echo "  Building happy-webapp..."
    docker build -f Dockerfile.webapp \
        --build-arg HAPPY_SERVER_URL="https://happy-relay.seas.house" \
        -t happy-webapp:latest .
fi

cd "$RELAY_DIR"
echo "  Restarting containers..."
if [ "$MODE" = "server" ]; then
    docker compose up -d --force-recreate happy-server
elif [ "$MODE" = "webapp" ]; then
    docker compose up -d --force-recreate happy-webapp
else
    docker compose up -d --force-recreate happy-server happy-webapp
fi
REMOTE_BUILD

# Step 4: Health check
info "Running health check..."
sleep 3
if curl -sf --max-time 10 "https://happy-relay.seas.house/health" > /dev/null 2>&1; then
    info "Deploy successful! Server is healthy."
else
    warn "Health check failed or timed out. Check logs:"
    warn "  ssh $ERYING 'cd $RELAY_DIR && docker compose logs --tail 50 happy-server'"
    warn "  To rollback: ./.deploy/rollback.sh"
    exit 1
fi
