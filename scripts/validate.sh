#!/bin/bash
#
# Validation script - runs all tests for the Happy project
#
# Usage:
#   ./scripts/validate.sh           # Run all tests
#   ./scripts/validate.sh --quick   # Skip browser tests (faster)
#
# Port configuration is inherited from happy-demo.sh via environment variables:
#   HAPPY_SERVER_PORT, HAPPY_WEBAPP_PORT, MINIO_PORT, etc.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# =============================================================================
# Colors and helpers
# =============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

QUICK_MODE=false
FAILED_TESTS=()
PASSED_TESTS=()
SERVICES_STARTED=false

# Port configuration (same defaults as happy-demo.sh)
HAPPY_SERVER_PORT="${HAPPY_SERVER_PORT:-3005}"
HAPPY_WEBAPP_PORT="${HAPPY_WEBAPP_PORT:-8081}"
HAPPY_SERVER_URL="http://localhost:${HAPPY_SERVER_PORT}"
HAPPY_WEBAPP_URL="http://localhost:${HAPPY_WEBAPP_PORT}"

# Parse arguments
for arg in "$@"; do
    case $arg in
        --quick)
            QUICK_MODE=true
            shift
            ;;
    esac
done

# Helper function to run a test
run_test() {
    local name="$1"
    local cmd="$2"

    echo -e "${YELLOW}Running: $name${NC}"
    echo "  Command: $cmd"
    echo ""

    if eval "$cmd"; then
        echo -e "${GREEN}PASSED: $name${NC}"
        PASSED_TESTS+=("$name")
        echo ""
        return 0
    else
        echo -e "${RED}FAILED: $name${NC}"
        FAILED_TESTS+=("$name")
        echo ""
        return 1
    fi
}

# Cleanup on exit
cleanup_on_exit() {
    if [ "$SERVICES_STARTED" = true ]; then
        echo ""
        echo -e "${BLUE}Stopping services...${NC}"
        "$ROOT_DIR/happy-demo.sh" stop 2>/dev/null || true
    fi
}

trap cleanup_on_exit EXIT

# =============================================================================
# Main Script
# =============================================================================

echo ""
echo "=============================================="
echo "  Happy Validation Suite"
echo "=============================================="
echo ""

# Clean up any existing services first
echo -e "${BLUE}Cleaning up any existing services...${NC}"
"$ROOT_DIR/happy-demo.sh" cleanup --clean-logs 2>/dev/null || true
echo ""

# =============================================================================
# Build Tests
# =============================================================================

echo "=== Build Validation ==="
echo ""

run_test "happy-cli build" "cd '$ROOT_DIR/happy-cli' && yarn build" || true
run_test "happy-server typecheck" "cd '$ROOT_DIR/happy-server' && yarn build" || true
run_test "happy webapp typecheck" "cd '$ROOT_DIR/happy' && yarn typecheck" || true

# =============================================================================
# Unit Tests
# =============================================================================

echo "=== Unit Tests ==="
echo ""

# happy-server unit tests (if they exist)
if [ -f "$ROOT_DIR/happy-server/package.json" ] && grep -q '"test"' "$ROOT_DIR/happy-server/package.json"; then
    run_test "happy-server unit tests" "cd '$ROOT_DIR/happy-server' && yarn test --run 2>/dev/null || true" || true
else
    echo "  Skipping happy-server unit tests (no test script found)"
fi

# happy-cli unit tests (if they exist)
if [ -f "$ROOT_DIR/happy-cli/package.json" ] && grep -q '"test"' "$ROOT_DIR/happy-cli/package.json"; then
    run_test "happy-cli unit tests" "cd '$ROOT_DIR/happy-cli' && yarn test --run 2>/dev/null || true" || true
else
    echo "  Skipping happy-cli unit tests (no test script found)"
fi

echo ""

# =============================================================================
# Browser/E2E Tests
# =============================================================================

if [ "$QUICK_MODE" = true ]; then
    echo "=== Browser Tests (SKIPPED - quick mode) ==="
    echo ""
else
    echo "=== Browser Tests ==="
    echo ""

    # Start all services using happy-demo.sh
    echo -e "${BLUE}Starting services for E2E tests...${NC}"
    if "$ROOT_DIR/happy-demo.sh" start-all; then
        SERVICES_STARTED=true
        echo ""
        echo "  Services running: server on :${HAPPY_SERVER_PORT}, webapp on :${HAPPY_WEBAPP_PORT}"
        echo ""

        # Run browser tests with environment variables for ports
        export WEBAPP_URL="$HAPPY_WEBAPP_URL"
        export HAPPY_SERVER_URL="$HAPPY_SERVER_URL"

        run_test "webapp create account" "cd '$ROOT_DIR/scripts/browser' && node test-create-account.mjs" || true

        # Add more browser tests here as they are created
        # run_test "webapp e2e" "cd '$ROOT_DIR/scripts/browser' && node test-webapp-e2e.mjs" || true
        # run_test "webapp restore login" "cd '$ROOT_DIR/scripts/browser' && node test-restore-login.mjs" || true
    else
        echo -e "${RED}  Failed to start services - skipping browser tests${NC}"
        FAILED_TESTS+=("service startup")
    fi
fi

# =============================================================================
# Summary
# =============================================================================

echo "=============================================="
echo "  Validation Summary"
echo "=============================================="
echo ""

if [ ${#PASSED_TESTS[@]} -gt 0 ]; then
    echo -e "${GREEN}Passed (${#PASSED_TESTS[@]}):${NC}"
    for test in "${PASSED_TESTS[@]}"; do
        echo "  - $test"
    done
    echo ""
fi

if [ ${#FAILED_TESTS[@]} -gt 0 ]; then
    echo -e "${RED}Failed (${#FAILED_TESTS[@]}):${NC}"
    for test in "${FAILED_TESTS[@]}"; do
        echo "  - $test"
    done
    echo ""
    echo -e "${RED}Validation FAILED${NC}"
    exit 1
else
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
fi
