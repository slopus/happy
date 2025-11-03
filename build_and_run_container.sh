#!/bin/bash

#
# Build and Run Happy Development Container
#
# This script builds the development container image and starts it with all
# necessary ports forwarded. The container includes all dependencies needed
# for running happy-server, happy-cli, and the happy web client.
#
# What this does:
#   1. Builds the Docker/Podman image from .devcontainer/Dockerfile.project
#   2. Starts the container with root user access
#   3. Forwards all necessary ports:
#      - 3005: happy-server API
#      - 8081: happy web client (Expo)
#      - 9000: MinIO API
#      - 9001: MinIO Console
#      - 5432: PostgreSQL
#      - 6379: Redis
#
# Usage:
#   ./build_and_run_container.sh
#
# Note: This uses 'make' which auto-detects whether to use docker or podman
#

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     Happy Development Container - Build & Run             ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

echo -e "${YELLOW}This script will:${NC}"
echo "  1. Build the development container image"
echo "  2. Start the container with all ports forwarded"
echo "  3. Give you root shell access inside the container"
echo ""

echo -e "${YELLOW}Forwarded ports:${NC}"
echo "  3005 → happy-server API"
echo "  8081 → happy web client (Expo)"
echo "  9000 → MinIO API"
echo "  9001 → MinIO Console"
echo "  5432 → PostgreSQL"
echo "  6379 → Redis"
echo ""

# Check if .devcontainer directory exists
if [ ! -d ".devcontainer" ]; then
    echo -e "${YELLOW}Error: .devcontainer directory not found${NC}"
    echo "Please run this script from the project root directory"
    exit 1
fi

echo -e "${GREEN}Building and starting container...${NC}"
echo ""

cd .devcontainer
make build

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Container is built! Running next...                       ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}Quick Start:${NC}"
echo "  1. Run: ${GREEN}./e2e-web-demo.sh${NC}"
echo "  2. Open browser: ${GREEN}http://localhost:8081${NC}"
echo "  3. Use the displayed secret key to authenticate"
echo ""
echo -e "${BLUE}Documentation:${NC}"
echo "  - WEB_CLIENT_GUIDE.md  : Web client setup and usage"
echo "  - E2E_TESTING.md       : Testing infrastructure"
echo "  - README.md            : Project overview"
echo ""

# Still in .devcontainer:
make root
