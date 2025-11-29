#!/bin/bash

# E2E Test Script for Self-Hosted Happy
# This script runs a full end-to-end test with ISOLATED test credentials
# For normal development, use 'make server' instead
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

# Log directory for this slot
LOG_DIR="/tmp/happy-slot-${SLOT}"
mkdir -p "$LOG_DIR"

# Cleanup function to stop services on exit
cleanup() {
    echo ""
    echo "=== Cleaning up e2e test services (slot $SLOT) ==="
    # Kill web process if it exists
    [ -n "$WEB_PID" ] && kill $WEB_PID 2>/dev/null || true
    "$SCRIPT_DIR/happy-launcher.sh" --slot $SLOT stop || true
}
trap cleanup EXIT

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }
step() { echo -e "${CYAN}[STEP]${NC} $1"; }

echo ""
echo "=== Happy Self-Hosted E2E Demo with Web Client ==="
echo ""
echo "This script will:"
echo "  1. Start all services (PostgreSQL, Redis, MinIO, happy-server)"
echo "  2. Stop existing daemon (to ensure clean credentials)"
echo "  3. Create test credentials (automated, no user interaction)"
echo "  4. Start the web client (browser UI)"
echo "  5. Start the CLI daemon"
echo "  6. Create a CLI session"
echo "  7. Show you how to connect from the browser"
echo ""

# Step 1: Start services on slot 1
step "Step 1: Starting all services on slot $SLOT..."
"$SCRIPT_DIR/happy-launcher.sh" --slot $SLOT start
success "All services started on slot $SLOT"
echo ""

# Step 2: Stop daemon if running (so we can create fresh credentials)
step "Step 2: Stopping daemon if running..."
./happy-cli/bin/happy.mjs daemon stop 2>/dev/null || true
success "Daemon stopped (if it was running)"
echo ""

# Step 3: Create test credentials
step "Step 3: Creating test credentials (automated)..."
# Capture output to extract the secret key
node scripts/setup-test-credentials.mjs > /tmp/creds-output.txt 2>&1
cat /tmp/creds-output.txt
# Extract the secret key (the line with format: XXXXX-XXXXX-...)
WEB_SECRET_KEY=$(grep -E "^  [A-Z0-9]+-[A-Z0-9]+" /tmp/creds-output.txt | xargs)
success "Test credentials created"
echo ""

# Step 4: Start web client
step "Step 4: Starting Happy web client..."
info "The web client will start in the background"
info "Building may take a minute on first run..."
cd happy
# Clear cache to ensure latest code with debug logging is used
info "Clearing cache to load latest code..."
rm -rf .expo/web node_modules/.cache 2>/dev/null || true
EXPO_PUBLIC_HAPPY_SERVER_URL="$HAPPY_SERVER_URL" yarn web --port "$HAPPY_WEBAPP_PORT" > "$LOG_DIR/webapp.log" 2>&1 &
WEB_PID=$!
cd ..
echo "Web client PID: $WEB_PID"
echo ""

# Wait for web server to be ready
info "Waiting for web server to start (this may take 30-60 seconds)..."
sleep 10
for i in {1..12}; do
    if curl -s "$HAPPY_WEBAPP_URL" > /dev/null 2>&1; then
        success "Web client is ready!"
        break
    fi
    echo -n "."
    sleep 5
done
echo ""

if ! curl -s "$HAPPY_WEBAPP_URL" > /dev/null 2>&1; then
    warning "Web client is still starting. Check logs with: tail -f $LOG_DIR/webapp.log"
    warning "It should be ready soon at $HAPPY_WEBAPP_URL"
else
    success "Web client started at $HAPPY_WEBAPP_URL"
fi
echo ""

# Step 5: Check authentication status
step "Step 5: Verifying CLI authentication..."
./happy-cli/bin/happy.mjs auth status
echo ""

# Step 6: Start daemon
step "Step 6: Starting CLI daemon..."
./happy-cli/bin/happy.mjs daemon start
sleep 2
./happy-cli/bin/happy.mjs daemon status | head -20
success "Daemon started"
echo ""

# Step 7: Start a CLI session that can be controlled from web
step "Step 7: Starting a CLI session in remote mode..."
info "This session will be controllable from the web UI"
cd /tmp
timeout 5 $SCRIPT_DIR/happy-cli/bin/happy.mjs --happy-starting-mode remote --started-by terminal > /dev/null 2>&1 &
SESSION_PID=$!
cd $SCRIPT_DIR
sleep 3
success "CLI session started (PID: $SESSION_PID)"
echo ""

# Step 8: List sessions
step "Step 8: Listing active sessions..."
./happy-cli/bin/happy.mjs daemon list
echo ""

# Step 9: Instructions for using web UI
echo ""
echo "=== E2E Web Demo Complete (Slot $SLOT) ==="
echo ""
success "✓ Server running at $HAPPY_SERVER_URL"
success "✓ Web client running at $HAPPY_WEBAPP_URL"
success "✓ Authentication working (no user interaction needed)"
success "✓ CLI daemon running"
success "✓ CLI session created and tracked"
echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║         USING THE WEB CLIENT                             ║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${GREEN}Step 1: Open your browser with DevTools${NC}"
echo "   -> $HAPPY_WEBAPP_URL"
echo "   -> Press F12 to open DevTools Console (to see debug logs)"
echo ""
echo -e "${GREEN}Step 2: Click \"Enter your secret key to restore access\"${NC}"
echo ""
echo -e "${CYAN}NOTE: Web client connects to $HAPPY_SERVER_URL${NC}"
echo "   If you previously used it, clear browser storage to remove cached settings"
echo "   (F12 -> Application -> Storage -> Clear site data)"
echo ""
echo -e "${GREEN}Step 3: Copy and paste this secret key:${NC}"
echo ""
echo -e "${YELLOW}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${YELLOW}║  ${WEB_SECRET_KEY}  ║${NC}"
echo -e "${YELLOW}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${GREEN}Step 4: You're in!${NC}"
echo "   - Click on your machine to view sessions"
echo "   - Click on the active session to connect"
echo "   - Send commands and see real-time output!"
echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "Useful commands:"
echo "  ./happy-launcher.sh --slot $SLOT status   # Check service status"
echo "  ./happy-launcher.sh --slot $SLOT logs server  # View server logs"
echo "  tail -f $LOG_DIR/webapp.log               # View web client logs"
echo ""
echo "Note: Services will be stopped automatically when this script exits (cleanup trap)"
echo ""
echo "Documentation:"
echo "  WEB_CLIENT_GUIDE.md                       # Complete web client guide"
echo "  E2E_TESTING.md                            # Testing guide"
echo "  README.md                                 # Project overview"
echo ""
echo -e "${GREEN}Happy hacking!${NC}"
echo ""
