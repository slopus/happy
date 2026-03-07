#!/usr/bin/env bash
# rebuild-dev.sh — rebuild dev CLI after code changes, restart daemon if running
#
# Usage: ./scripts/rebuild-dev.sh
#
# - Runs yarn build (typecheck + bundle)
# - If build fails, keeps last working dist/ intact
# - If build succeeds and dev daemon is running via systemd, restarts it

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
CLI_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Rebuilding happy-cli dev ==="
echo ""

# Save a backup of dist/ in case build fails
if [[ -d "$CLI_ROOT/dist" ]]; then
    cp -r "$CLI_ROOT/dist" "$CLI_ROOT/dist.bak" 2>/dev/null || true
fi

# Build
cd "$CLI_ROOT"
if yarn build; then
    echo ""
    echo "Build succeeded."
    rm -rf "$CLI_ROOT/dist.bak" 2>/dev/null || true
else
    echo ""
    echo "BUILD FAILED — keeping last working dist/"
    if [[ -d "$CLI_ROOT/dist.bak" ]]; then
        rm -rf "$CLI_ROOT/dist"
        mv "$CLI_ROOT/dist.bak" "$CLI_ROOT/dist"
        echo "Restored previous dist/ from backup."
    fi
    exit 1
fi

# Restart dev daemon via systemd if the service is active
if systemctl --user is-active happy-dev-daemon.service &>/dev/null; then
    echo ""
    echo "Restarting happy-dev-daemon.service..."
    systemctl --user restart happy-dev-daemon.service
    sleep 2
    if systemctl --user is-active happy-dev-daemon.service &>/dev/null; then
        echo "Daemon restarted with new build."
    else
        echo "WARNING: Daemon failed to restart. Check: systemctl --user status happy-dev-daemon.service"
    fi
else
    echo ""
    echo "happy-dev-daemon.service not active (start with: systemctl --user start happy-dev-daemon.service)"
fi

echo ""
echo "Done. New sessions will use the updated code."
