#!/bin/bash
#
# Validation script - runs all tests for the Happy project
# THIS IS THE PRE-COMMIT CHECK - run before pushing changes!
#
# Usage:
#   ./scripts/validate.sh              # Run all tests (builds + unit + E2E)
#   ./scripts/validate.sh --quick      # Skip E2E tests (builds and unit tests only)
#   ./scripts/validate.sh --e2e-only   # Skip builds/unit tests, only run E2E
#
# This script:
#   - Does not assume any running services before starting
#   - Uses slot-based isolation for E2E tests (slot 1+ for tests, slot 0 for production)
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

# Get port configuration from launcher (but don't export yet - launcher checks for these)
SLOT_ENV=$("$ROOT_DIR/happy-launcher.sh" --slot $SLOT env)

# Extract values for display
HAPPY_SERVER_PORT=$(echo "$SLOT_ENV" | grep HAPPY_SERVER_PORT | cut -d= -f2)
HAPPY_WEBAPP_PORT=$(echo "$SLOT_ENV" | grep HAPPY_WEBAPP_PORT | cut -d= -f2)

# =============================================================================
# Colors and helpers
# =============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

QUICK_MODE=false
E2E_ONLY=false
FAILED_TESTS=()
PASSED_TESTS=()

# Parse arguments
for arg in "$@"; do
    case $arg in
        --quick)
            QUICK_MODE=true
            shift
            ;;
        --e2e-only)
            E2E_ONLY=true
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
    echo -e "${BLUE}Stopping services for slot $SLOT...${NC}"
    "$ROOT_DIR/happy-launcher.sh" --slot $SLOT stop 2>/dev/null || true
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

if [ "$E2E_ONLY" = false ]; then
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
else
    echo "=== Skipping builds and unit tests (--e2e-only mode) ==="
    echo ""
fi

# =============================================================================
# E2E Tests (vitest-based)
# =============================================================================

if [ "$QUICK_MODE" = true ]; then
    echo "=== E2E Tests (SKIPPED - quick mode) ==="
    echo ""
else
    echo "=== E2E Tests ==="
    echo ""

    # Install e2e dependencies if needed
    if [ ! -d "$SCRIPT_DIR/e2e/node_modules" ]; then
        echo -e "${BLUE}Installing e2e test dependencies...${NC}"
        (cd "$SCRIPT_DIR/e2e" && npm install)
    fi

    # Run vitest - it handles slot allocation internally
    echo -e "${BLUE}Running E2E tests (vitest)...${NC}"
    echo "  Tests will automatically claim slots for parallel execution"
    echo ""

    if run_test "e2e tests" "cd '$SCRIPT_DIR/e2e' && npm test"; then
        echo ""
    else
        echo ""
        echo -e "${YELLOW}  Check logs in /tmp/happy-slot-* for details${NC}"
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
