#!/bin/bash

# Start Happy Server (infrastructure only)
# This script starts all backend services without creating test accounts or sessions
# Use this for normal development work

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
step() { echo -e "${CYAN}[STEP]${NC} $1"; }

echo ""
echo "=== Happy Server Startup ==="
echo ""
echo "This will start:"
echo "  - PostgreSQL (port 5432)"
echo "  - Redis (port 6379)"
echo "  - MinIO (ports 9000, 9001)"
echo "  - happy-server API (port 3005)"
echo "  - happy webapp (port 8081)"
echo ""

# Step 1: Start backend services
step "Step 1: Starting backend services..."
./happy-demo.sh start
success "Backend services started"
echo ""

# Step 2: Start web client
step "Step 2: Starting Happy web client..."
info "Building may take a minute on first run..."
cd happy
# Clear cache to ensure latest code
rm -rf .expo/web node_modules/.cache 2>/dev/null || true
yarn start:local-server > /tmp/happy-web.log 2>&1 &
WEB_PID=$!
cd ..
echo "Web client PID: $WEB_PID"
echo ""

# Wait for web server to be ready
info "Waiting for web server to start..."
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

echo ""
echo "=== Server Started ==="
echo ""
success "API Server:  http://localhost:3005"
success "Web Client:  http://localhost:8081"
success "MinIO Console: http://localhost:9001 (minioadmin/minioadmin)"
echo ""
echo "To use the CLI (defaults to ~/.happy):"
echo "  HAPPY_SERVER_URL=http://localhost:3005 ./happy-cli/bin/happy.mjs"
echo ""
echo "To authenticate a new CLI:"
echo "  1. Run CLI and scan QR code with webapp"
echo "  2. Or use 'make setup-credentials' to auto-create credentials"
echo ""
echo "Useful commands:"
echo "  make stop               # Stop all services"
echo "  make logs               # View server logs"
echo "  make cli                # Run CLI with local server"
echo ""
