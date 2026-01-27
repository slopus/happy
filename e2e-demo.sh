#!/bin/bash

# E2E Demo Script for Self-Hosted Happy
# This script demonstrates the complete e2e flow without requiring manual authentication
# Uses --slot 1 to isolate from production (slot 0)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Use slot 1 for e2e tests (isolates from production on slot 0)
SLOT=1

# Unset any existing HAPPY_* env vars to avoid conflicts with launcher
unset HAPPY_SERVER_URL HAPPY_SERVER_PORT HAPPY_WEBAPP_PORT HAPPY_WEBAPP_URL HAPPY_HOME_DIR HAPPY_MINIO_PORT HAPPY_MINIO_CONSOLE_PORT HAPPY_METRICS_PORT

# Get environment from launcher for this slot
eval "$("$SCRIPT_DIR/happy-launcher.sh" --slot $SLOT env)"

# Override HAPPY_HOME_DIR for e2e test isolation
export HAPPY_HOME_DIR=/root/.happy-e2e-slot-${SLOT}

# Cleanup function to stop services on exit
cleanup() {
    echo ""
    echo "=== Cleaning up e2e test services (slot $SLOT) ==="
    "$SCRIPT_DIR/happy-launcher.sh" --slot $SLOT stop || true
}
trap cleanup EXIT

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

echo ""
echo "=== Happy Self-Hosted E2E Demo ==="
echo ""
echo "This script will:"
echo "  1. Verify PostgreSQL setup"
echo "  2. Start all services (PostgreSQL, Redis, MinIO, happy-server)"
echo "  3. Create test credentials (automated, no user interaction)"
echo "  4. Start the daemon"
echo "  5. Create a test session"
echo "  6. List active sessions"
echo ""

# Step 1: Verify PostgreSQL setup
info "Step 1: Verifying PostgreSQL setup..."
./setup-postgres.sh
success "PostgreSQL setup verified"
echo ""

# Step 2: Start services on slot 1
info "Step 2: Starting all services on slot $SLOT..."
"$SCRIPT_DIR/happy-launcher.sh" --slot $SLOT start
success "All services started on slot $SLOT"
echo ""

# Step 3: Create test credentials
info "Step 3: Creating test credentials (automated)..."
node scripts/setup-test-credentials.mjs
success "Test credentials created"
echo ""

# Step 4: Check authentication status
info "Step 4: Verifying authentication..."
./happy-cli/bin/happy.mjs auth status
echo ""

# Step 5: Start daemon
info "Step 5: Starting daemon..."
./happy-cli/bin/happy.mjs daemon start
sleep 2
./happy-cli/bin/happy.mjs daemon status
success "Daemon started"
echo ""

# Step 6: Create a test session
info "Step 6: Creating test session..."
echo "Running: timeout 3 ./happy-cli/bin/happy.mjs --happy-starting-mode remote &"
cd /tmp
timeout 3 $SCRIPT_DIR/happy-cli/bin/happy.mjs --happy-starting-mode remote --started-by terminal > /dev/null 2>&1 &
SESSION_PID=$!
cd $SCRIPT_DIR
sleep 2
success "Test session created (PID: $SESSION_PID)"
echo ""

# Step 7: List sessions
info "Step 7: Listing active sessions..."
./happy-cli/bin/happy.mjs daemon list
echo ""

# Step 8: Show logs
info "Step 8: Recent daemon log entries..."
tail -n 20 "$HAPPY_HOME_DIR/logs"/*-daemon.log 2>/dev/null || echo "No logs found yet"
echo ""

# Summary
echo ""
echo "=== E2E Demo Complete (Slot $SLOT) ==="
echo ""
success "✓ Server running at $HAPPY_SERVER_URL"
success "✓ Authentication working (no user interaction needed)"
success "✓ Daemon running"
success "✓ Session created and tracked"
echo ""
echo "Try these commands:"
echo "  ./happy-launcher.sh --slot $SLOT status   # Check service status"
echo "  ./happy-launcher.sh --slot $SLOT logs server  # View server logs"
echo ""
echo "To use the CLI with test credentials:"
echo "  HAPPY_HOME_DIR=$HAPPY_HOME_DIR HAPPY_SERVER_URL=$HAPPY_SERVER_URL ./happy-cli/bin/happy.mjs"
echo ""
echo "Note: Services will be stopped automatically when this script exits (cleanup trap)"
echo ""
