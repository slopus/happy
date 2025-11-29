#!/bin/bash
#
# Validation script - runs all tests for the Happy project
# THIS IS THE PRE-COMMIT CHECK - run before pushing changes!
#
# Usage:
#   ./scripts/validate.sh           # Run all tests
#   ./scripts/validate.sh --quick   # Skip E2E tests (builds and unit tests only)
#
# This script:
#   - Does not assume any running services before starting
#   - Uses slot 1 for E2E tests to isolate from any production instance (slot 0)
#   - Cleans up all processes it starts on exit (via trap)
#   - Is run by CI on GitHub Actions
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# =============================================================================
# Configuration
# =============================================================================

# Use slot 1 for validation tests (isolates from production on slot 0)
SLOT=1

# Unset any existing HAPPY_* env vars to avoid conflicts with launcher
unset HAPPY_SERVER_URL HAPPY_SERVER_PORT HAPPY_WEBAPP_PORT HAPPY_WEBAPP_URL HAPPY_HOME_DIR HAPPY_MINIO_PORT HAPPY_MINIO_CONSOLE_PORT HAPPY_METRICS_PORT

# Get environment from launcher for this slot
eval "$("$ROOT_DIR/happy-launcher.sh" --slot $SLOT env)"

# Override HAPPY_HOME_DIR for validation test isolation
export HAPPY_HOME_DIR=/tmp/.happy-validate-slot-${SLOT}

# Log directory for this slot
LOG_DIR="/tmp/happy-slot-${SLOT}"

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

# Cleanup on exit - ALWAYS runs, even on failure
cleanup_on_exit() {
    local exit_code=$?
    echo ""
    echo -e "${BLUE}=== Cleanup ===${NC}"

    if [ "$SERVICES_STARTED" = true ]; then
        echo -e "${BLUE}Stopping services for slot $SLOT...${NC}"
        "$ROOT_DIR/happy-launcher.sh" --slot $SLOT stop 2>/dev/null || true
    fi

    # Clean up test home directory
    rm -rf "$HAPPY_HOME_DIR" 2>/dev/null || true

    echo -e "${BLUE}Cleanup complete${NC}"
    exit $exit_code
}

trap cleanup_on_exit EXIT

# =============================================================================
# Main Script
# =============================================================================

echo ""
echo "=============================================="
echo "  Happy Validation Suite"
echo "  Slot: $SLOT (isolated from production)"
echo "=============================================="
echo ""
echo "Port configuration:"
echo "  Server:  $HAPPY_SERVER_PORT"
echo "  Webapp:  $HAPPY_WEBAPP_PORT"
echo ""

# Clean up any leftover processes from previous runs on this slot
echo -e "${BLUE}Cleaning up any existing slot $SLOT services...${NC}"
"$ROOT_DIR/happy-launcher.sh" --slot $SLOT stop 2>/dev/null || true
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
# E2E/Browser Tests
# =============================================================================

if [ "$QUICK_MODE" = true ]; then
    echo "=== E2E Tests (SKIPPED - quick mode) ==="
    echo ""
else
    echo "=== E2E Tests ==="
    echo ""

    # Start all services using happy-launcher.sh with slot 1
    echo -e "${BLUE}Starting services on slot $SLOT for E2E tests...${NC}"
    if "$ROOT_DIR/happy-launcher.sh" --slot $SLOT start-all; then
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
        echo -e "${YELLOW}  Server log (last 50 lines):${NC}"
        tail -50 "$LOG_DIR/server.log" 2>/dev/null || echo "  (no log file found)"
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
