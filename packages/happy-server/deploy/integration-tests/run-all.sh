#!/usr/bin/env bash
#
# One-click integration test runner.
#
#   ./run-all.sh              # run all tests (assumes cluster is deployed)
#   ./run-all.sh --deploy     # build, deploy, then run all tests
#   ./run-all.sh --safe-only  # skip pod-killing tests
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REDIS_PORT=6379
DEPLOY=false
SAFE_ONLY=false
PF_PIDS=()
SERVER_URL=""

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

# --- Arg parsing ---
for arg in "$@"; do
    case "$arg" in
        --deploy)  DEPLOY=true ;;
        --safe-only) SAFE_ONLY=true ;;
        -h|--help)
            echo "Usage: $0 [--deploy] [--safe-only]"
            echo "  --deploy     Build image and redeploy before testing"
            echo "  --safe-only  Skip pod-killing (destructive) tests"
            exit 0
            ;;
        *) echo "Unknown arg: $arg"; exit 1 ;;
    esac
done

# --- Cleanup on exit ---
cleanup() {
    echo ""
    echo -e "${BOLD}Cleaning up...${NC}"
    for pid in "${PF_PIDS[@]+"${PF_PIDS[@]}"}"; do
        kill "$pid" 2>/dev/null && wait "$pid" 2>/dev/null || true
    done
    pkill -f "port-forward svc/handy-server" 2>/dev/null || true
    pkill -f "port-forward svc/happy-redis" 2>/dev/null || true
}
trap cleanup EXIT

# --- Prerequisites ---
echo -e "${BOLD}=== Integration Test Runner ===${NC}"
echo ""

for cmd in kubectl node minikube; do
    if ! command -v "$cmd" &>/dev/null; then
        echo -e "${RED}Missing: $cmd${NC}"
        exit 1
    fi
done

if ! minikube status --format='{{.Host}}' 2>/dev/null | grep -q Running; then
    echo -e "${RED}minikube is not running. Start it with: minikube start${NC}"
    exit 1
fi

echo -e "${GREEN}Prerequisites OK${NC}"

# --- Deploy (optional) ---
if $DEPLOY; then
    echo ""
    echo -e "${BOLD}=== Building & Deploying ===${NC}"
    bash "$SCRIPT_DIR/../../../deploy/integration-tests/local.sh" 2>&1 || bash "$SCRIPT_DIR/local.sh" 2>&1
fi

# --- Wait for pods ---
echo ""
echo -e "${BOLD}Waiting for pods...${NC}"
kubectl wait --for=condition=ready pod -l app=handy-server --timeout=120s
PODS=$(kubectl get pods -l app=handy-server --no-headers | wc -l | tr -d ' ')
echo -e "${GREEN}$PODS server pods ready${NC}"

# --- Server URL: use minikube tunnel for NodePort (real LB, survives pod kills) ---
setup_server_url() {
    local svc_type
    svc_type=$(kubectl get svc handy-server -o jsonpath='{.spec.type}' 2>/dev/null)

    if [ "$svc_type" = "NodePort" ]; then
        # minikube service creates a tunnel that goes through kube-proxy.
        # Unlike port-forward (single pod tunnel), this uses iptables rules
        # that route to healthy pods — survives pod kills.
        local tmpfile
        tmpfile=$(mktemp)
        minikube service handy-server --url > "$tmpfile" 2>/dev/null &
        PF_PIDS+=($!)
        sleep 2
        SERVER_URL=$(head -1 "$tmpfile")
        rm -f "$tmpfile"
        echo -e "${GREEN}Using minikube tunnel: $SERVER_URL (survives pod kills)${NC}"
    else
        kubectl port-forward svc/handy-server 3005:3000 &>/dev/null &
        PF_PIDS+=($!)
        SERVER_URL="http://127.0.0.1:3005"
        echo -e "${YELLOW}Using port-forward: $SERVER_URL (pod-kill tests will fail)${NC}"
    fi

    # Redis always needs port-forward (only used by stress-prod-realistic)
    kubectl port-forward svc/happy-redis "$REDIS_PORT:6379" &>/dev/null &
    PF_PIDS+=($!)

    # Wait for server
    for i in {1..20}; do
        if curl -s -o /dev/null -w '' "$SERVER_URL/health" 2>/dev/null; then
            return 0
        fi
        sleep 0.5
    done
    echo -e "${RED}Server not reachable at $SERVER_URL${NC}"
    return 1
}

wait_for_pods() {
    echo -e "  ${YELLOW}Waiting for pods to recover...${NC}"
    for i in {1..60}; do
        READY=$(kubectl get pods -l app=handy-server --no-headers 2>/dev/null | grep -c "Running" || true)
        if [ "$READY" -ge 2 ]; then
            break
        fi
        sleep 1
    done
    kubectl wait --for=condition=ready pod -l app=handy-server --timeout=120s 2>/dev/null || true
}

# --- Test runner ---
RESULTS=()
PASSED=0
FAILED=0
SKIPPED=0

run_test() {
    local name="$1"
    local cmd="$2"
    local destructive="${3:-false}"

    if $SAFE_ONLY && [ "$destructive" = "true" ]; then
        echo -e "  ${YELLOW}SKIP${NC} (--safe-only)"
        RESULTS+=("SKIP  $name")
        SKIPPED=$((SKIPPED + 1))
        return
    fi

    if eval "$cmd" 2>&1 | tail -5; then
        echo -e "  ${GREEN}PASS${NC}"
        RESULTS+=("PASS  $name")
        PASSED=$((PASSED + 1))
    else
        echo -e "  ${RED}FAIL${NC}"
        RESULTS+=("FAIL  $name")
        FAILED=$((FAILED + 1))
    fi

    # After destructive tests, wait for pods to recover
    if [ "$destructive" = "true" ]; then
        wait_for_pods
    fi
}

# --- Start ---
setup_server_url
echo ""
echo -e "${BOLD}=== Running Tests ===${NC}"
echo -e "Server: $SERVER_URL"
echo ""

# ---- SAFE TESTS (no pod killing) ----

echo -e "${BOLD}[1/10] stress-prod-realistic (5000 entries/s)${NC}"
run_test "stress-prod-realistic" \
    "SERVER_URL=$SERVER_URL node '$SCRIPT_DIR/stress-prod-realistic.mjs'"

echo ""
echo -e "${BOLD}[2/10] rpc-registration: fire-and-forget${NC}"
run_test "rpc: fire-and-forget" \
    "SERVER_URL=$SERVER_URL node '$SCRIPT_DIR/stress-rpc-registration.mjs' fire-and-forget"

echo ""
echo -e "${BOLD}[3/10] rpc-registration: register-race-timing${NC}"
run_test "rpc: register-race-timing" \
    "SERVER_URL=$SERVER_URL node '$SCRIPT_DIR/stress-rpc-registration.mjs' register-race-timing"

echo ""
echo -e "${BOLD}[4/10] rpc-registration: reconnect-no-ack${NC}"
run_test "rpc: reconnect-no-ack" \
    "SERVER_URL=$SERVER_URL node '$SCRIPT_DIR/stress-rpc-registration.mjs' reconnect-no-ack"

echo ""
echo -e "${BOLD}[5/10] rpc-registration: rapid-sessions${NC}"
run_test "rpc: rapid-sessions" \
    "SERVER_URL=$SERVER_URL node '$SCRIPT_DIR/stress-rpc-registration.mjs' rapid-sessions"

echo ""
echo -e "${BOLD}[6/10] rpc-registration: high-concurrency (50 daemons)${NC}"
run_test "rpc: high-concurrency" \
    "SERVER_URL=$SERVER_URL node '$SCRIPT_DIR/stress-rpc-registration.mjs' high-concurrency"

echo ""
echo -e "${BOLD}[7/10] rpc-registration: ios-session-flow${NC}"
run_test "rpc: ios-session-flow" \
    "SERVER_URL=$SERVER_URL node '$SCRIPT_DIR/stress-rpc-registration.mjs' ios-session-flow"

echo ""
echo -e "${BOLD}[8/10] rpc-registration: cross-replica-3pod${NC}"
run_test "rpc: cross-replica-3pod" \
    "SERVER_URL=$SERVER_URL node '$SCRIPT_DIR/stress-rpc-registration.mjs' cross-replica-3pod"

# ---- DESTRUCTIVE TESTS (kill pods) ----

echo ""
echo -e "${BOLD}[9/10] rpc-registration: rolling-deploy (kills a pod)${NC}"
run_test "rpc: rolling-deploy" \
    "SERVER_URL=$SERVER_URL node '$SCRIPT_DIR/stress-rpc-registration.mjs' rolling-deploy" \
    true

echo ""
echo -e "${BOLD}[10/10] test-rpc-dead-daemon (kills a pod)${NC}"
run_test "rpc-dead-daemon" \
    "SERVER_URL=$SERVER_URL node '$SCRIPT_DIR/test-rpc-dead-daemon.mjs'" \
    true

# ---- SUMMARY ----
echo ""
echo -e "${BOLD}========================================${NC}"
echo -e "${BOLD}           RESULTS${NC}"
echo -e "${BOLD}========================================${NC}"
for r in "${RESULTS[@]}"; do
    if [[ "$r" == PASS* ]]; then
        echo -e "  ${GREEN}$r${NC}"
    elif [[ "$r" == FAIL* ]]; then
        echo -e "  ${RED}$r${NC}"
    else
        echo -e "  ${YELLOW}$r${NC}"
    fi
done
echo ""
echo -e "  ${GREEN}Passed: $PASSED${NC}  ${RED}Failed: $FAILED${NC}  ${YELLOW}Skipped: $SKIPPED${NC}"
echo -e "${BOLD}========================================${NC}"

if [ "$FAILED" -gt 0 ]; then
    exit 1
fi
