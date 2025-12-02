#!/bin/bash

# Start Happy Server (infrastructure only)
# This script starts all backend services without creating test accounts or sessions
# Use this for normal development work
#
# This is a thin wrapper around happy-launcher.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

# Use happy-launcher.sh to start all services
"$SCRIPT_DIR/happy-launcher.sh" start

echo ""
echo "Useful commands:"
echo "  make stop               # Stop all services"
echo "  make logs               # View server logs"
echo "  make cli                # Run CLI with local server"
echo ""
