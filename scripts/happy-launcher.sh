#!/bin/bash
#
# happy-launcher.sh - Happy self-hosted service launcher
#
# Manages the lifecycle of Happy services (server, webapp, MinIO) with support
# for multiple isolated instances via "slots".
#
# SLOT CONCEPT:
#   --slot 0 (or no --slot): Primary/production instance with default ports
#     - Server: 3005, Webapp: 8081, MinIO: 9000/9001
#   --slot 1, 2, 3...: Test/dev instances with deterministic ports
#     - Base ports: 10001, 10002, 10003, 10004
#     - Slot N adds: 10 * (N-1) to each port
#     - Slot 1: Server=10001, Webapp=10002, MinIO=10003/10004
#     - Slot 2: Server=10011, Webapp=10012, MinIO=10013/10014
#
# ENVIRONMENT VARIABLES:
#   The script expects HAPPY_* variables to NOT be set. If they are set,
#   it will print a warning (or error if --slot is used).
#
# USAGE:
#   ./happy-launcher.sh [--slot N] <command>
#
# COMMANDS:
#   start       Start all services
#   stop        Stop all services
#   status      Show status of services
#   restart     Restart all services
#   logs        Show logs (tail -f)
#   env         Print environment variables for this slot
#
# EXAMPLES:
#   ./happy-launcher.sh start                    # Start slot 0 (production)
#   ./happy-launcher.sh --slot 1 start          # Start slot 1 (test instance)
#   ./happy-launcher.sh --slot 1 status         # Check slot 1 status
#   ./happy-launcher.sh --slot 1 env            # Print env vars for slot 1
#   eval $(./happy-launcher.sh --slot 1 env)    # Set env vars in shell
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default ports for slot 0
DEFAULT_SERVER_PORT=3005
DEFAULT_WEBAPP_PORT=8081
DEFAULT_MINIO_PORT=9000
DEFAULT_MINIO_CONSOLE_PORT=9001

# Base ports for slot 1+
BASE_SERVER_PORT=10001
BASE_WEBAPP_PORT=10002
BASE_MINIO_PORT=10003
BASE_MINIO_CONSOLE_PORT=10004
SLOT_OFFSET=10

# Parse arguments
SLOT=""
COMMAND=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --slot)
            SLOT="$2"
            shift 2
            ;;
        *)
            COMMAND="$1"
            shift
            ;;
    esac
done

# Validate slot
if [[ -n "$SLOT" && ! "$SLOT" =~ ^[0-9]+$ ]]; then
    echo "Error: --slot must be a non-negative integer" >&2
    exit 1
fi

# Check for HAPPY_* environment variables
check_env_vars() {
    local has_vars=false
    local vars=""

    for var in HAPPY_SERVER_URL HAPPY_SERVER_PORT HAPPY_WEBAPP_PORT HAPPY_WEBAPP_URL HAPPY_HOME_DIR; do
        if [[ -n "${!var}" ]]; then
            has_vars=true
            vars="$vars $var=${!var}"
        fi
    done

    if $has_vars; then
        if [[ -n "$SLOT" ]]; then
            echo "Error: HAPPY_* environment variables are set, but --slot was specified." >&2
            echo "When using --slot, environment variables should not be pre-set." >&2
            echo "Found:$vars" >&2
            exit 1
        else
            echo "Warning: Using HAPPY_* environment variables from environment:$vars" >&2
        fi
    fi
}

# Calculate ports for given slot
calculate_ports() {
    local slot="${1:-0}"

    if [[ "$slot" -eq 0 ]]; then
        SERVER_PORT=$DEFAULT_SERVER_PORT
        WEBAPP_PORT=$DEFAULT_WEBAPP_PORT
        MINIO_PORT=$DEFAULT_MINIO_PORT
        MINIO_CONSOLE_PORT=$DEFAULT_MINIO_CONSOLE_PORT
    else
        local offset=$(( (slot - 1) * SLOT_OFFSET ))
        SERVER_PORT=$(( BASE_SERVER_PORT + offset ))
        WEBAPP_PORT=$(( BASE_WEBAPP_PORT + offset ))
        MINIO_PORT=$(( BASE_MINIO_PORT + offset ))
        MINIO_CONSOLE_PORT=$(( BASE_MINIO_CONSOLE_PORT + offset ))
    fi

    # Set derived values
    SERVER_URL="http://localhost:$SERVER_PORT"
    WEBAPP_URL="http://localhost:$WEBAPP_PORT"
    HOME_DIR="$ROOT_DIR/.happy-slot-${slot:-0}"
    MINIO_DATA_DIR="$ROOT_DIR/happy-server/.minio-slot-${slot:-0}"
    PID_DIR="$ROOT_DIR/.pids-slot-${slot:-0}"
}

# Print environment variables
print_env() {
    cat << EOF
export HAPPY_SERVER_PORT=$SERVER_PORT
export HAPPY_WEBAPP_PORT=$WEBAPP_PORT
export HAPPY_SERVER_URL=$SERVER_URL
export HAPPY_WEBAPP_URL=$WEBAPP_URL
export HAPPY_HOME_DIR=$HOME_DIR
export HAPPY_MINIO_PORT=$MINIO_PORT
export HAPPY_MINIO_CONSOLE_PORT=$MINIO_CONSOLE_PORT
EOF
}

# Start MinIO
start_minio() {
    echo "Starting MinIO on port $MINIO_PORT (console: $MINIO_CONSOLE_PORT)..."
    mkdir -p "$MINIO_DATA_DIR" "$PID_DIR"

    MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
        minio server "$MINIO_DATA_DIR" \
        --address ":$MINIO_PORT" \
        --console-address ":$MINIO_CONSOLE_PORT" \
        > "$PID_DIR/minio.log" 2>&1 &

    echo $! > "$PID_DIR/minio.pid"

    # Wait for MinIO to be ready
    for i in {1..30}; do
        if curl -s "http://localhost:$MINIO_PORT/minio/health/live" > /dev/null 2>&1; then
            echo "  MinIO ready"
            return 0
        fi
        sleep 0.5
    done
    echo "  Warning: MinIO may not be ready yet"
}

# Start server
start_server() {
    echo "Starting happy-server on port $SERVER_PORT..."
    mkdir -p "$PID_DIR"

    cd "$ROOT_DIR/happy-server"
    PORT=$SERVER_PORT \
    S3_ENDPOINT="http://localhost:$MINIO_PORT" \
        yarn start > "$PID_DIR/server.log" 2>&1 &

    echo $! > "$PID_DIR/server.pid"
    cd - > /dev/null

    # Wait for server to be ready
    for i in {1..60}; do
        if curl -s "http://localhost:$SERVER_PORT/health" > /dev/null 2>&1; then
            echo "  Server ready"
            return 0
        fi
        sleep 1
    done
    echo "  Warning: Server may not be ready yet"
}

# Start webapp
start_webapp() {
    echo "Starting happy webapp on port $WEBAPP_PORT..."
    mkdir -p "$PID_DIR"

    cd "$ROOT_DIR/happy"
    BROWSER=none \
    PORT=$WEBAPP_PORT \
    EXPO_PUBLIC_HAPPY_SERVER_URL="$SERVER_URL" \
        yarn web > "$PID_DIR/webapp.log" 2>&1 &

    echo $! > "$PID_DIR/webapp.pid"
    cd - > /dev/null

    # Wait for webapp to be ready
    for i in {1..120}; do
        if curl -s "http://localhost:$WEBAPP_PORT" > /dev/null 2>&1; then
            echo "  Webapp ready"
            return 0
        fi
        sleep 1
    done
    echo "  Warning: Webapp may not be ready yet"
}

# Stop a service
stop_service() {
    local name="$1"
    local pid_file="$PID_DIR/$name.pid"

    if [[ -f "$pid_file" ]]; then
        local pid=$(cat "$pid_file")
        if kill -0 "$pid" 2>/dev/null; then
            echo "Stopping $name (PID: $pid)..."
            kill "$pid" 2>/dev/null || true
            sleep 1
            kill -9 "$pid" 2>/dev/null || true
        fi
        rm -f "$pid_file"
    fi
}

# Check service status
check_service() {
    local name="$1"
    local port="$2"
    local health_path="${3:-/}"

    local pid_file="$PID_DIR/$name.pid"
    local status="stopped"
    local pid="N/A"

    if [[ -f "$pid_file" ]]; then
        pid=$(cat "$pid_file")
        if kill -0 "$pid" 2>/dev/null; then
            status="running"
        else
            status="stale PID"
        fi
    fi

    local reachable="no"
    if curl -s "http://localhost:$port$health_path" > /dev/null 2>&1; then
        reachable="yes"
    fi

    printf "  %-10s port=%-5s pid=%-8s status=%-10s reachable=%s\n" \
        "$name" "$port" "$pid" "$status" "$reachable"
}

# Show status
show_status() {
    echo "Slot ${SLOT:-0} Status:"
    echo "  Directories:"
    echo "    Home:  $HOME_DIR"
    echo "    PIDs:  $PID_DIR"
    echo "    MinIO: $MINIO_DATA_DIR"
    echo ""
    echo "  Services:"
    check_service "minio" "$MINIO_PORT" "/minio/health/live"
    check_service "server" "$SERVER_PORT" "/health"
    check_service "webapp" "$WEBAPP_PORT" "/"
    echo ""
    echo "  URLs:"
    echo "    Server: $SERVER_URL"
    echo "    Webapp: $WEBAPP_URL"
    echo "    MinIO:  http://localhost:$MINIO_PORT"
}

# Show logs
show_logs() {
    echo "Logs for slot ${SLOT:-0}:"
    if [[ -d "$PID_DIR" ]]; then
        tail -f "$PID_DIR"/*.log 2>/dev/null || echo "No logs found"
    else
        echo "No log directory found"
    fi
}

# Main logic
main() {
    check_env_vars
    calculate_ports "${SLOT:-0}"

    case "$COMMAND" in
        start)
            echo "Starting services for slot ${SLOT:-0}..."
            start_minio
            start_server
            start_webapp
            echo ""
            show_status
            ;;
        stop)
            echo "Stopping services for slot ${SLOT:-0}..."
            stop_service "webapp"
            stop_service "server"
            stop_service "minio"
            echo "Done"
            ;;
        restart)
            echo "Restarting services for slot ${SLOT:-0}..."
            stop_service "webapp"
            stop_service "server"
            stop_service "minio"
            sleep 2
            start_minio
            start_server
            start_webapp
            echo ""
            show_status
            ;;
        status)
            show_status
            ;;
        logs)
            show_logs
            ;;
        env)
            print_env
            ;;
        "")
            echo "Usage: $0 [--slot N] <command>"
            echo ""
            echo "Commands: start, stop, restart, status, logs, env"
            echo ""
            echo "Examples:"
            echo "  $0 start                    # Start slot 0 (default ports)"
            echo "  $0 --slot 1 start          # Start slot 1 (test ports)"
            echo "  $0 --slot 1 env            # Print env vars for slot 1"
            echo "  eval \$($0 --slot 1 env)    # Set env vars in current shell"
            exit 1
            ;;
        *)
            echo "Unknown command: $COMMAND" >&2
            exit 1
            ;;
    esac
}

main "$@"
