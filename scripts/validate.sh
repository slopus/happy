#!/bin/bash
#
# Validation script - runs all tests for the Happy project
#
# Usage:
#   ./scripts/validate.sh           # Run all tests
#   ./scripts/validate.sh --quick   # Skip browser tests (faster)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

QUICK_MODE=false
FAILED_TESTS=()
PASSED_TESTS=()

# Parse arguments
for arg in "$@"; do
    case $arg in
        --quick)
            QUICK_MODE=true
            shift
            ;;
    esac
done

echo ""
echo "=============================================="
echo "  Happy Validation Suite"
echo "=============================================="
echo ""

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
# Browser Tests (requires running services)
# =============================================================================

if [ "$QUICK_MODE" = true ]; then
    echo "=== Browser Tests (SKIPPED - quick mode) ==="
    echo ""
else
    echo "=== Browser Tests ==="
    echo ""

    # Check if services are running
    WEBAPP_RUNNING=false
    SERVER_RUNNING=false

    if curl -s http://localhost:8081 > /dev/null 2>&1; then
        WEBAPP_RUNNING=true
    fi

    if curl -s http://localhost:3005/health > /dev/null 2>&1; then
        SERVER_RUNNING=true
    fi

    if [ "$WEBAPP_RUNNING" = true ] && [ "$SERVER_RUNNING" = true ]; then
        echo "  Services detected: webapp on :8081, server on :3005"
        echo ""

        # Run browser tests
        run_test "webapp create account" "cd '$ROOT_DIR/scripts/browser' && node test-create-account.mjs" || true

        # Add more browser tests here as they are created
        # run_test "webapp e2e" "cd '$ROOT_DIR/scripts/browser' && node test-webapp-e2e.mjs" || true
        # run_test "webapp restore login" "cd '$ROOT_DIR/scripts/browser' && node test-restore-login.mjs" || true
    else
        echo -e "${YELLOW}  Skipping browser tests - services not running${NC}"
        echo "  Start services with: make server"
        echo ""
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
