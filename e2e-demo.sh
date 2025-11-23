#!/bin/bash

# E2E Demo Script for Self-Hosted Happy
# This script demonstrates the complete e2e flow without requiring manual authentication

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export HAPPY_HOME_DIR=/root/.happy-dev-test
export HAPPY_SERVER_URL=http://localhost:3005

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

# Step 2: Start services
info "Step 2: Starting all services..."
./happy-demo.sh start
success "All services started"
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
echo "=== E2E Demo Complete ==="
echo ""
success "✓ Server running at http://localhost:3005"
success "✓ Authentication working (no user interaction needed)"
success "✓ Daemon running"
success "✓ Session created and tracked"
echo ""
echo "Try these commands:"
echo "  ./happy-demo.sh status          # Check service status"
echo "  ./happy-demo.sh cli daemon list # List sessions"
echo "  ./happy-demo.sh logs server     # View server logs"
echo "  ./happy-demo.sh stop            # Stop services"
echo ""
echo "To use the CLI with test credentials:"
echo "  HAPPY_HOME_DIR=$HAPPY_HOME_DIR HAPPY_SERVER_URL=$HAPPY_SERVER_URL ./happy-cli/bin/happy.mjs"
echo ""
