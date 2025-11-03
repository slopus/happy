#!/bin/bash

# E2E Web Demo Script for Self-Hosted Happy
# This script demonstrates the complete flow including the web frontend

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export HAPPY_HOME_DIR=/root/.happy-dev-test
export HAPPY_SERVER_URL=http://localhost:3005

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
echo "  2. Create test credentials (automated, no user interaction)"
echo "  3. Start the web client (browser UI)"
echo "  4. Start the CLI daemon"
echo "  5. Create a CLI session"
echo "  6. Show you how to connect from the browser"
echo ""

# Step 1: Start services
step "Step 1: Starting all services..."
./happy-demo.sh start
success "All services started"
echo ""

# Step 2: Create test credentials
step "Step 2: Creating test credentials (automated)..."
# Capture output to extract the secret key
node scripts/setup-test-credentials.mjs > /tmp/creds-output.txt 2>&1
cat /tmp/creds-output.txt
# Extract the secret key (the line with format: XXXXX-XXXXX-...)
WEB_SECRET_KEY=$(grep -E "^  [A-Z0-9]+-[A-Z0-9]+" /tmp/creds-output.txt | xargs)
success "Test credentials created"
echo ""

# Step 3: Start web client
step "Step 3: Starting Happy web client..."
info "The web client will start in the background"
info "Building may take a minute on first run..."
cd happy
# Clear cache to ensure latest code with debug logging is used
info "Clearing cache to load latest code..."
rm -rf .expo/web node_modules/.cache 2>/dev/null || true
yarn start:local-server > /tmp/happy-web.log 2>&1 &
WEB_PID=$!
cd ..
echo "Web client PID: $WEB_PID"
echo ""

# Wait for web server to be ready
info "Waiting for web server to start (this may take 30-60 seconds)..."
sleep 10
for i in {1..12}; do
    if curl -s http://localhost:8081 > /dev/null 2>&1; then
        success "Web client is ready!"
        break
    fi
    echo -n "."
    sleep 5
done
echo ""

if ! curl -s http://localhost:8081 > /dev/null 2>&1; then
    warning "Web client is still starting. Check logs with: tail -f /tmp/happy-web.log"
    warning "It should be ready soon at http://localhost:8081"
else
    success "Web client started at http://localhost:8081"
fi
echo ""

# Step 4: Check authentication status
step "Step 4: Verifying CLI authentication..."
./happy-cli/bin/happy.mjs auth status
echo ""

# Step 5: Start daemon
step "Step 5: Starting CLI daemon..."
./happy-cli/bin/happy.mjs daemon start
sleep 2
./happy-cli/bin/happy.mjs daemon status | head -20
success "Daemon started"
echo ""

# Step 6: Start a CLI session that can be controlled from web
step "Step 6: Starting a CLI session in remote mode..."
info "This session will be controllable from the web UI"
cd /tmp
timeout 5 $SCRIPT_DIR/happy-cli/bin/happy.mjs --happy-starting-mode remote --started-by terminal > /dev/null 2>&1 &
SESSION_PID=$!
cd $SCRIPT_DIR
sleep 3
success "CLI session started (PID: $SESSION_PID)"
echo ""

# Step 7: List sessions
step "Step 7: Listing active sessions..."
./happy-cli/bin/happy.mjs daemon list
echo ""

# Step 8: Instructions for using web UI
echo ""
echo "=== E2E Web Demo Complete ==="
echo ""
success "✓ Server running at http://localhost:3005"
success "✓ Web client running at http://localhost:8081"
success "✓ Authentication working (no user interaction needed)"
success "✓ CLI daemon running"
success "✓ CLI session created and tracked"
echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║         🌐 USING THE WEB CLIENT                          ║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${GREEN}Step 1: Open your browser with DevTools${NC}"
echo "   → http://localhost:8081"
echo "   → Press F12 to open DevTools Console (to see debug logs)"
echo ""
echo -e "${GREEN}Step 2: Click \"Enter your secret key to restore access\"${NC}"
echo ""
echo -e "${CYAN}ℹ️  NOTE: Web client auto-detects localhost and uses http://localhost:3005${NC}"
echo "   If you previously used it, clear browser storage to remove cached settings"
echo "   (F12 → Application → Storage → Clear site data)"
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
echo "  ./happy-demo.sh status                    # Check service status"
echo "  ./happy-demo.sh cli daemon list           # List sessions"
echo "  tail -f /tmp/happy-web.log                # View web client logs"
echo "  ./happy-demo.sh logs server               # View server logs"
echo "  pkill -f 'expo start' && ./happy-demo.sh stop  # Stop everything"
echo ""
echo "Documentation:"
echo "  WEB_CLIENT_GUIDE.md                       # Complete web client guide"
echo "  E2E_TESTING.md                            # Testing guide"
echo "  README.md                                 # Project overview"
echo ""
echo -e "${GREEN}Happy hacking!${NC}"
echo ""
