#!/bin/bash

# Happy Self-Hosted Service Launcher
# This script manages the self-hosted happy-server and happy-cli environment
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
#   start         Start all services (PostgreSQL, Redis, MinIO, happy-server, webapp)
#   start-backend Start only backend services (PostgreSQL, Redis, MinIO, happy-server)
#   start-webapp  Start only the webapp
#   stop          Stop all services
#   status        Show status of services
#   env           Print environment variables for this slot
#   ... (run with 'help' for full list)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/happy-server"
CLI_DIR="$SCRIPT_DIR/happy-cli"
WEBAPP_DIR="$SCRIPT_DIR/happy"

# =============================================================================
# Argument Parsing
# =============================================================================

SLOT=""
DEBUG_MODE=""
ARGS=()

# Parse --slot and --debug arguments before other processing
while [[ $# -gt 0 ]]; do
    case "$1" in
        --slot)
            SLOT="$2"
            shift 2
            ;;
        --debug)
            DEBUG_MODE="true"
            shift
            ;;
        *)
            ARGS+=("$1")
            shift
            ;;
    esac
done

# Restore remaining arguments
set -- "${ARGS[@]}"

# Validate slot
if [[ -n "$SLOT" && ! "$SLOT" =~ ^[0-9]+$ ]]; then
    echo "Error: --slot must be a non-negative integer" >&2
    exit 1
fi

# =============================================================================
# Environment Variable Check
# =============================================================================

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

# Run the check
check_env_vars

# =============================================================================
# Port Configuration with Slot Support
# =============================================================================

# Default ports for slot 0 (or when no slot specified)
DEFAULT_SERVER_PORT=3005
DEFAULT_WEBAPP_PORT=8081
DEFAULT_MINIO_PORT=9000
DEFAULT_MINIO_CONSOLE_PORT=9001
DEFAULT_METRICS_PORT=9090

# Base ports for slot 1+
BASE_SERVER_PORT=10001
BASE_WEBAPP_PORT=10002
BASE_MINIO_PORT=10003
BASE_MINIO_CONSOLE_PORT=10004
BASE_METRICS_PORT=10005
SLOT_OFFSET=10

# Calculate ports based on slot
calculate_ports() {
    local slot="${1:-0}"

    if [[ "$slot" -eq 0 ]]; then
        HAPPY_SERVER_PORT="${HAPPY_SERVER_PORT:-$DEFAULT_SERVER_PORT}"
        HAPPY_WEBAPP_PORT="${HAPPY_WEBAPP_PORT:-$DEFAULT_WEBAPP_PORT}"
        MINIO_PORT="${MINIO_PORT:-$DEFAULT_MINIO_PORT}"
        MINIO_CONSOLE_PORT="${MINIO_CONSOLE_PORT:-$DEFAULT_MINIO_CONSOLE_PORT}"
        METRICS_PORT="${METRICS_PORT:-$DEFAULT_METRICS_PORT}"
    else
        local offset=$(( (slot - 1) * SLOT_OFFSET ))
        HAPPY_SERVER_PORT=$(( BASE_SERVER_PORT + offset ))
        HAPPY_WEBAPP_PORT=$(( BASE_WEBAPP_PORT + offset ))
        MINIO_PORT=$(( BASE_MINIO_PORT + offset ))
        MINIO_CONSOLE_PORT=$(( BASE_MINIO_CONSOLE_PORT + offset ))
        METRICS_PORT=$(( BASE_METRICS_PORT + offset ))
    fi
}

# Apply slot configuration
calculate_ports "${SLOT:-0}"

# These ports are shared (system services) - not affected by slots
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
REDIS_PORT="${REDIS_PORT:-6379}"

# Derived URLs
HAPPY_SERVER_URL="http://localhost:${HAPPY_SERVER_PORT}"
HAPPY_WEBAPP_URL="http://localhost:${HAPPY_WEBAPP_PORT}"

# Slot-specific directories and database for isolation
SLOT_SUFFIX="${SLOT:-0}"
MINIO_DATA_DIR="$SERVER_DIR/.minio-slot-${SLOT_SUFFIX}"
LOG_DIR="/tmp/happy-slot-${SLOT_SUFFIX}"
PIDS_DIR="$SCRIPT_DIR/.pids-slot-${SLOT_SUFFIX}"
mkdir -p "$LOG_DIR" "$PIDS_DIR"

# Slot-specific database name (critical for test isolation!)
# - Slot 0 (production): uses 'handy' database
# - Slot 1+: uses 'handy_test_N' databases
if [[ "${SLOT:-0}" -eq 0 ]]; then
    DATABASE_NAME="handy"
else
    DATABASE_NAME="handy_test_${SLOT}"
fi
DATABASE_URL="postgresql://postgres:postgres@localhost:${POSTGRES_PORT}/${DATABASE_NAME}"

# =============================================================================
# Colors and helpers
# =============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check if a service is running (system-wide, slot-unaware)
is_running() {
    pgrep -f "$1" > /dev/null 2>&1
}

# Check if a slot-specific service is running by checking its PID file
is_slot_service_running() {
    local service="$1"
    local pid_file="$PIDS_DIR/${service}.pid"
    if [ -f "$pid_file" ]; then
        local pid=$(cat "$pid_file")
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

# Check if a port is listening
port_listening() {
    local port=$1
    # Try bash /dev/tcp first (works for any TCP port)
    (echo > /dev/tcp/localhost/"$port") 2>/dev/null && return 0
    # Fallback to curl for HTTP services
    curl -s --max-time 1 "http://localhost:${port}" > /dev/null 2>&1 && return 0
    curl -s --max-time 1 "http://localhost:${port}/health" > /dev/null 2>&1 && return 0
    return 1
}

# Get all active slots (slots with PID directories or log directories)
# Outputs slot numbers, one per line, sorted numerically
get_active_slots() {
    local slots=()

    # Find slots with PID directories
    for pids_dir in "$SCRIPT_DIR"/.pids-slot-*; do
        [ -d "$pids_dir" ] || continue
        local slot=$(echo "$pids_dir" | sed 's/.*\.pids-slot-//')
        slots+=("$slot")
    done

    # Find slots with log directories (may exist without PID dirs)
    for log_dir in /tmp/happy-slot-*; do
        [ -d "$log_dir" ] || continue
        local slot=$(echo "$log_dir" | sed 's/.*happy-slot-//')
        # Add only if not already in list
        local found=false
        for existing in "${slots[@]}"; do
            if [ "$existing" = "$slot" ]; then
                found=true
                break
            fi
        done
        if [ "$found" = "false" ]; then
            slots+=("$slot")
        fi
    done

    # Output sorted unique slots
    printf '%s\n' "${slots[@]}" | sort -n | uniq
}

# Wait for a port to become available
wait_for_port() {
    local port=$1
    local name=$2
    local max_attempts=${3:-30}
    local attempt=1

    echo -n "  Waiting for $name on port $port"
    while [ $attempt -le $max_attempts ]; do
        if port_listening "$port"; then
            echo " - ready!"
            return 0
        fi
        echo -n "."
        sleep 1
        attempt=$((attempt + 1))
    done
    echo " - TIMEOUT"
    return 1
}

# =============================================================================
# Service Start Functions
# =============================================================================

ensure_postgres_ready() {
    # Ensure postgres user has expected password
    sudo -u postgres psql -c "ALTER USER postgres WITH PASSWORD 'postgres';" > /dev/null 2>&1 || true

    # Ensure slot-specific database exists
    # - Slot 0: 'handy' (production)
    # - Slot N: 'handy_test_N' (isolated test databases)
    if ! PGPASSWORD=postgres psql -U postgres -h localhost -lqt 2>/dev/null | cut -d \| -f 1 | grep -qw "$DATABASE_NAME"; then
        info "Creating database '$DATABASE_NAME' for slot ${SLOT:-0}..."
        sudo -u postgres psql -c "CREATE DATABASE $DATABASE_NAME;" > /dev/null 2>&1 || true
    fi

    # Ensure database schema exists (run migrations if needed)
    if ! PGPASSWORD=postgres psql -U postgres -h localhost -d "$DATABASE_NAME" -c "\dt" 2>/dev/null | grep -q "Session"; then
        info "Running database migrations for '$DATABASE_NAME'..."
        (cd "$SERVER_DIR" && DATABASE_URL="$DATABASE_URL" yarn migrate > /dev/null 2>&1) || true
    fi
}

start_postgres() {
    # Check if port is already listening (e.g., via Docker/CI service)
    if port_listening "$POSTGRES_PORT"; then
        info "PostgreSQL is already running on port $POSTGRES_PORT"
        ensure_postgres_ready
        return 0
    fi
    if is_running "postgres.*17/main"; then
        info "PostgreSQL process detected, waiting for port..."
        wait_for_port "$POSTGRES_PORT" "PostgreSQL" 10 || {
            error "PostgreSQL process running but port not responding"
            return 1
        }
    else
        info "Starting PostgreSQL..."
        service postgresql start 2>/dev/null || {
            error "Failed to start PostgreSQL service"
            return 1
        }
        wait_for_port "$POSTGRES_PORT" "PostgreSQL" 10 || {
            error "PostgreSQL failed to start"
            return 1
        }
        ensure_postgres_ready
        success "PostgreSQL started on port $POSTGRES_PORT"
    fi
}

start_redis() {
    # Check if port is already listening (e.g., via Docker/CI service)
    if port_listening "$REDIS_PORT"; then
        info "Redis is already running on port $REDIS_PORT"
        return 0
    fi
    if is_running "redis-server"; then
        info "Redis process detected, waiting for port..."
        wait_for_port "$REDIS_PORT" "Redis" 10 || {
            error "Redis process running but port not responding"
            return 1
        }
    else
        info "Starting Redis..."
        redis-server --daemonize yes --port "$REDIS_PORT" 2>/dev/null || \
            service redis-server start 2>/dev/null || true
        wait_for_port "$REDIS_PORT" "Redis" 10 || {
            error "Redis failed to start"
            return 1
        }
        success "Redis started on port $REDIS_PORT"
    fi
}

start_minio() {
    if port_listening "$MINIO_PORT"; then
        info "MinIO is already running on port $MINIO_PORT"
    else
        info "Starting MinIO (slot ${SLOT:-0})..."
        mkdir -p "$MINIO_DATA_DIR/data"
        MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
            minio server "$MINIO_DATA_DIR/data" --address ":${MINIO_PORT}" --console-address ":${MINIO_CONSOLE_PORT}" \
            > "$LOG_DIR/minio.log" 2>&1 &
        echo $! > "$PIDS_DIR/minio.pid"
        wait_for_port "$MINIO_PORT" "MinIO" 15 || {
            error "MinIO failed to start"
            return 1
        }
        # Create bucket if mc is available
        if command -v mc >/dev/null 2>&1; then
            mc alias set "local-slot-${SLOT_SUFFIX}" "http://localhost:${MINIO_PORT}" minioadmin minioadmin 2>/dev/null || true
            mc mb "local-slot-${SLOT_SUFFIX}/happy" 2>/dev/null || true
        fi
        success "MinIO started on port $MINIO_PORT (Console: $MINIO_CONSOLE_PORT)"
    fi
}

start_server() {
    if port_listening "$HAPPY_SERVER_PORT"; then
        info "happy-server is already running on port $HAPPY_SERVER_PORT"
    else
        info "Starting happy-server (slot ${SLOT:-0})..."
        cd "$SERVER_DIR"

        # Ensure .env exists
        if [ ! -f .env ]; then
            info "Creating .env from .env.dev..."
            cp .env.dev .env
        fi

        # Build environment variables for server
        local debug_env=""
        if [[ -n "$DEBUG_MODE" ]]; then
            debug_env="DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING=true"
            info "Debug mode enabled for server"
        fi

        # Start server with environment variables for ports
        # DATABASE_URL uses slot-specific database for test isolation
        env $debug_env \
        PORT="$HAPPY_SERVER_PORT" \
        METRICS_PORT="$METRICS_PORT" \
        DATABASE_URL="$DATABASE_URL" \
        REDIS_URL="redis://localhost:${REDIS_PORT}" \
        HANDY_MASTER_SECRET="test-secret-for-local-development" \
        S3_HOST="localhost" \
        S3_PORT="$MINIO_PORT" \
        S3_USE_SSL="false" \
        S3_ACCESS_KEY="minioadmin" \
        S3_SECRET_KEY="minioadmin" \
        S3_BUCKET="happy" \
        S3_PUBLIC_URL="http://localhost:${MINIO_PORT}/happy" \
            yarn start > "$LOG_DIR/server.log" 2>&1 &
        echo $! > "$PIDS_DIR/server.pid"
        cd "$SCRIPT_DIR"

        wait_for_port "$HAPPY_SERVER_PORT" "happy-server" 30 || {
            error "happy-server failed to start. Check logs: tail $LOG_DIR/server.log"
            return 1
        }
        success "happy-server started on port $HAPPY_SERVER_PORT"
    fi
}

start_webapp() {
    if port_listening "$HAPPY_WEBAPP_PORT"; then
        info "Webapp is already running on port $HAPPY_WEBAPP_PORT"
    else
        info "Starting webapp (slot ${SLOT:-0})..."
        cd "$WEBAPP_DIR"

        # Build debug environment variables
        local debug_env=""
        if [[ -n "$DEBUG_MODE" ]]; then
            debug_env="PUBLIC_EXPO_DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING=1 EXPO_PUBLIC_DEBUG=1"
            info "Debug mode enabled for webapp"
        fi

        # Clear Metro cache to ensure fresh bundle transformation
        # The --clear flag is essential for CI environments where the cache may be stale
        env $debug_env \
            BROWSER=none \
            EXPO_PUBLIC_HAPPY_SERVER_URL="$HAPPY_SERVER_URL" \
            yarn web --port "$HAPPY_WEBAPP_PORT" --clear > "$LOG_DIR/webapp.log" 2>&1 &
        echo $! > "$PIDS_DIR/webapp.pid"
        cd "$SCRIPT_DIR"

        # Webapp takes longer to start (Metro bundler)
        wait_for_port "$HAPPY_WEBAPP_PORT" "webapp" 60 || {
            error "Webapp failed to start. Check logs: tail $LOG_DIR/webapp.log"
            return 1
        }
        success "Webapp started on port $HAPPY_WEBAPP_PORT"
    fi
}

# =============================================================================
# Service Stop Functions
# =============================================================================

stop_all() {
    info "Stopping services for slot ${SLOT_SUFFIX}..."

    # Stop processes using PID files (slot-specific)
    for service in webapp server minio; do
        local pid_file="$PIDS_DIR/${service}.pid"
        if [ -f "$pid_file" ]; then
            local pid=$(cat "$pid_file")
            if kill -0 "$pid" 2>/dev/null; then
                info "Stopping $service (PID $pid)..."
                kill "$pid" 2>/dev/null || true
                # Wait briefly for graceful shutdown
                sleep 1
                # Force kill if still running
                kill -9 "$pid" 2>/dev/null || true
                success "$service stopped"
            fi
            rm -f "$pid_file"
        fi
    done

    # Note: Not stopping PostgreSQL and Redis as they're system services
    warning "PostgreSQL and Redis are system services and were not stopped"
    warning "To stop them manually: service postgresql stop && service redis-server stop"
}

cleanup_slot() {
    local slot="$1"
    local clean_logs="${2:-false}"
    local nuke_happy_dir="${3:-false}"

    local slot_suffix="$slot"
    local pids_dir="$SCRIPT_DIR/.pids-slot-${slot_suffix}"
    local log_dir="/tmp/happy-slot-${slot_suffix}"
    local happy_home_dir="$HOME/.happy-slot-${slot_suffix}"

    # Stop processes using PID files
    if [ -d "$pids_dir" ]; then
        for pid_file in "$pids_dir"/*.pid; do
            [ -f "$pid_file" ] || continue
            local service=$(basename "$pid_file" .pid)
            local pid=$(cat "$pid_file" 2>/dev/null)
            if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
                info "Stopping $service (slot $slot, PID $pid)..."
                kill "$pid" 2>/dev/null || true
                sleep 1
                kill -9 "$pid" 2>/dev/null || true
                success "$service stopped"
            fi
        done
        # Remove the entire pids directory
        rm -rf "$pids_dir"
    fi

    # Clean up log directory
    if [ "$clean_logs" = "true" ] && [ -d "$log_dir" ]; then
        rm -rf "$log_dir"
        info "Cleaned log directory: $log_dir"
    fi

    # Nuke happy home directory
    if [ "$nuke_happy_dir" = "true" ] && [ -d "$happy_home_dir" ]; then
        rm -rf "$happy_home_dir"
        warning "Deleted happy home directory: $happy_home_dir"
    fi
}

cleanup_all() {
    local clean_logs=false
    local nuke_happy_dir=false
    local all_slots=false

    # Parse arguments
    while [ $# -gt 0 ]; do
        case "$1" in
            --clean-logs)
                clean_logs=true
                shift
                ;;
            --nuke-happy-dir)
                nuke_happy_dir=true
                shift
                ;;
            --all-slots)
                all_slots=true
                shift
                ;;
            *)
                shift
                ;;
        esac
    done

    info "Running complete cleanup..."
    echo ""

    if [ "$all_slots" = "true" ]; then
        # Find all slot directories and clean them using shared function
        info "Cleaning ALL slots..."
        local active_slots
        active_slots=$(get_active_slots)
        if [ -n "$active_slots" ]; then
            while IFS= read -r slot; do
                info "Cleaning slot $slot..."
                cleanup_slot "$slot" "$clean_logs" "$nuke_happy_dir"
            done <<< "$active_slots"
        else
            info "No active slots found"
        fi
        # Clean happy home directories if nuking
        if [ "$nuke_happy_dir" = "true" ]; then
            for happy_dir in "$HOME"/.happy-slot-*; do
                [ -d "$happy_dir" ] || continue
                rm -rf "$happy_dir"
                warning "Deleted: $happy_dir"
            done
            # Also delete the default .happy directory
            if [ -d "$HOME/.happy" ]; then
                rm -rf "$HOME/.happy"
                warning "Deleted: $HOME/.happy"
            fi
        fi
    else
        # Just clean the current slot
        cleanup_slot "$SLOT_SUFFIX" "$clean_logs" "$nuke_happy_dir"
    fi

    # Stop system-wide processes (not slot-specific)

    # Stop any remaining webapp processes
    if is_running "expo start"; then
        info "Stopping webapp..."
        pkill -f "expo start" || true
        pkill -f "metro" || true
        success "Webapp stopped"
    fi

    # Stop any remaining happy-server processes
    if is_running "tsx.*sources/main.ts"; then
        info "Stopping happy-server..."
        pkill -f "tsx.*sources/main.ts" || true
        pkill -f "yarn tsx.*sources/main.ts" || true
        success "happy-server stopped"
    fi

    # Stop any remaining MinIO processes
    if is_running "minio server"; then
        info "Stopping MinIO..."
        pkill -f "minio server" || true
        success "MinIO stopped"
    fi

    # Stop PostgreSQL
    if is_running "postgres.*17/main"; then
        info "Stopping PostgreSQL..."
        service postgresql stop || true
        success "PostgreSQL stopped"
    fi

    # Stop Redis
    if is_running "redis-server"; then
        info "Stopping Redis..."
        service redis-server stop || true
        pkill -f "redis-server" 2>/dev/null || true
        success "Redis stopped"
    fi

    # Kill any orphaned processes
    info "Cleaning up any orphaned processes..."
    pkill -f "node.*happy-server" 2>/dev/null || true
    pkill -f "node.*happy-cli" 2>/dev/null || true

    echo ""
    success "Complete cleanup finished!"
    echo ""
    info "All services have been stopped"
    if [ "$clean_logs" != "true" ]; then
        info "Logs preserved. Use '$0 cleanup --clean-logs' to remove them"
    fi
    if [ "$nuke_happy_dir" = "true" ]; then
        warning "Happy home directories have been deleted"
    fi
    echo ""
}

# =============================================================================
# Status and Info Functions
# =============================================================================

# Show status for a specific slot (uses local variables, doesn't affect global state)
show_slot_services_status() {
    local slot="$1"

    # Calculate ports for this slot
    local server_port webapp_port minio_port minio_console_port metrics_port
    local db_name pids_dir log_dir minio_data

    if [[ "$slot" -eq 0 ]]; then
        server_port="${DEFAULT_SERVER_PORT}"
        webapp_port="${DEFAULT_WEBAPP_PORT}"
        minio_port="${DEFAULT_MINIO_PORT}"
        minio_console_port="${DEFAULT_MINIO_CONSOLE_PORT}"
        metrics_port="${DEFAULT_METRICS_PORT}"
        db_name="handy"
    else
        local offset=$(( (slot - 1) * SLOT_OFFSET ))
        server_port=$(( BASE_SERVER_PORT + offset ))
        webapp_port=$(( BASE_WEBAPP_PORT + offset ))
        minio_port=$(( BASE_MINIO_PORT + offset ))
        minio_console_port=$(( BASE_MINIO_CONSOLE_PORT + offset ))
        metrics_port=$(( BASE_METRICS_PORT + offset ))
        db_name="handy_test_${slot}"
    fi

    pids_dir="$SCRIPT_DIR/.pids-slot-${slot}"
    log_dir="/tmp/happy-slot-${slot}"
    minio_data="$SERVER_DIR/.minio-slot-${slot}"

    echo "--- Slot $slot (DB: $db_name, Server: $server_port, Webapp: $webapp_port) ---"

    # Helper to check slot-specific service by PID file
    local_is_slot_service_running() {
        local service="$1"
        local pid_file="$pids_dir/${service}.pid"
        if [ -f "$pid_file" ]; then
            local pid=$(cat "$pid_file")
            if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
                return 0
            fi
        fi
        return 1
    }

    # MinIO (slot-specific)
    if local_is_slot_service_running "minio"; then
        if port_listening "$minio_port"; then
            success "  MinIO: Running (API: $minio_port, Console: $minio_console_port)"
        else
            warning "  MinIO: Process exists but port not responding"
        fi
    elif port_listening "$minio_port"; then
        success "  MinIO: Running (API: $minio_port, Console: $minio_console_port)"
    else
        error "  MinIO: Stopped"
    fi

    # happy-server (slot-specific)
    if local_is_slot_service_running "server"; then
        if port_listening "$server_port"; then
            success "  happy-server: Running (port $server_port)"
        else
            warning "  happy-server: Process exists but port not responding"
        fi
    elif port_listening "$server_port"; then
        success "  happy-server: Running (port $server_port)"
    else
        error "  happy-server: Stopped"
    fi

    # Webapp (slot-specific)
    if local_is_slot_service_running "webapp"; then
        if port_listening "$webapp_port"; then
            success "  Webapp: Running (port $webapp_port)"
        else
            warning "  Webapp: Process exists but port not responding"
        fi
    elif port_listening "$webapp_port"; then
        success "  Webapp: Running (port $webapp_port)"
    else
        error "  Webapp: Stopped"
    fi
}

show_status() {
    echo ""
    echo "=== Happy Self-Hosted Status (Slot ${SLOT:-0}) ==="
    echo ""
    echo "Port configuration:"
    echo "  Server:   $HAPPY_SERVER_PORT"
    echo "  Metrics:  $METRICS_PORT"
    echo "  Webapp:   $HAPPY_WEBAPP_PORT"
    echo "  MinIO:    $MINIO_PORT (Console: $MINIO_CONSOLE_PORT)"
    echo ""
    echo "Database:"
    echo "  Name:     $DATABASE_NAME"
    echo "  URL:      $DATABASE_URL"
    echo ""
    echo "Shared services (all slots use same Postgres/Redis process):"
    echo "  Postgres: $POSTGRES_PORT"
    echo "  Redis:    $REDIS_PORT"
    echo ""
    echo "Directories:"
    echo "  MinIO data: $MINIO_DATA_DIR"
    echo "  Logs:       $LOG_DIR"
    echo "  PIDs:       $PIDS_DIR"
    echo ""

    # Shared services (PostgreSQL and Redis)
    echo "--- Shared Services ---"
    if port_listening "$POSTGRES_PORT"; then
        success "PostgreSQL: Running (port $POSTGRES_PORT, database: $DATABASE_NAME)"
    else
        error "PostgreSQL: Stopped"
    fi

    if port_listening "$REDIS_PORT"; then
        success "Redis: Running (port $REDIS_PORT, shared)"
    else
        error "Redis: Stopped"
    fi

    # Slot-specific services
    echo ""
    show_slot_services_status "${SLOT:-0}"

    echo ""
}

show_all_slots_status() {
    echo ""
    echo "=== Happy Self-Hosted Status (All Slots) ==="
    echo ""

    # Shared services (PostgreSQL and Redis)
    echo "--- Shared Services ---"
    if port_listening "$POSTGRES_PORT"; then
        success "PostgreSQL: Running (port $POSTGRES_PORT)"
    else
        error "PostgreSQL: Stopped"
    fi

    if port_listening "$REDIS_PORT"; then
        success "Redis: Running (port $REDIS_PORT)"
    else
        error "Redis: Stopped"
    fi
    echo ""

    # Get all active slots
    local active_slots
    active_slots=$(get_active_slots)

    if [ -z "$active_slots" ]; then
        info "No active slots found"
    else
        while IFS= read -r slot; do
            show_slot_services_status "$slot"
            echo ""
        done <<< "$active_slots"
    fi
}

show_logs() {
    local service=$1
    case $service in
        server)
            info "Showing happy-server logs (slot ${SLOT:-0})..."
            tail -f "$LOG_DIR/server.log"
            ;;
        webapp)
            info "Showing webapp logs (slot ${SLOT:-0})..."
            tail -f "$LOG_DIR/webapp.log"
            ;;
        minio)
            info "Showing MinIO logs (slot ${SLOT:-0})..."
            tail -f "$LOG_DIR/minio.log"
            ;;
        postgres)
            info "Showing PostgreSQL logs..."
            tail -f /var/log/postgresql/postgresql-17-main.log 2>/dev/null || \
                echo "PostgreSQL logs not found at standard location"
            ;;
        *)
            error "Unknown service: $service"
            echo "Available services: server, webapp, minio, postgres"
            exit 1
            ;;
    esac
}

# Print environment variables for this slot (can be sourced)
print_env() {
    cat << EOF
export HAPPY_SERVER_PORT=$HAPPY_SERVER_PORT
export HAPPY_WEBAPP_PORT=$HAPPY_WEBAPP_PORT
export HAPPY_SERVER_URL=$HAPPY_SERVER_URL
export HAPPY_WEBAPP_URL=$HAPPY_WEBAPP_URL
export HAPPY_HOME_DIR=~/.happy-slot-${SLOT_SUFFIX}
export HAPPY_MINIO_PORT=$MINIO_PORT
export HAPPY_MINIO_CONSOLE_PORT=$MINIO_CONSOLE_PORT
export HAPPY_METRICS_PORT=$METRICS_PORT
export DATABASE_URL=$DATABASE_URL
export DATABASE_NAME=$DATABASE_NAME
EOF
}

show_urls() {
    echo ""
    echo "=== Service URLs ==="
    echo ""
    echo "  happy-server:    $HAPPY_SERVER_URL/"
    echo "  Webapp:          $HAPPY_WEBAPP_URL/"
    echo "  MinIO Console:   http://localhost:${MINIO_CONSOLE_PORT}/"
    echo ""
    echo "=== Database Connections ==="
    echo ""
    echo "  PostgreSQL:      $DATABASE_URL"
    echo "  Database:        $DATABASE_NAME"
    echo "  Redis:           redis://localhost:${REDIS_PORT}"
    echo ""
}

# =============================================================================
# CLI and Test Functions
# =============================================================================

run_cli() {
    info "Running happy CLI..."
    cd "$CLI_DIR"
    export HAPPY_HOME_DIR=~/.happy
    export HAPPY_SERVER_URL="$HAPPY_SERVER_URL"

    if [ $# -eq 0 ]; then
        ./bin/happy.mjs
    else
        ./bin/happy.mjs "$@"
    fi
}

test_connection() {
    info "Testing connection..."
    echo ""

    # Test server
    if curl -s "$HAPPY_SERVER_URL/" | grep -q "Happy"; then
        success "Server responding at $HAPPY_SERVER_URL/"
    else
        error "Server not responding"
        exit 1
    fi

    # Test CLI
    cd "$CLI_DIR"
    if HAPPY_SERVER_URL="$HAPPY_SERVER_URL" ./bin/happy.mjs --version 2>&1 | grep -q "happy version"; then
        success "CLI executable and shows version"
    else
        error "CLI failed to execute"
        exit 1
    fi

    echo ""
    success "All tests passed!"
    echo ""
}

# =============================================================================
# Main Command Handler
# =============================================================================

case "${1:-}" in
    start)
        info "Starting all services..."
        start_postgres
        start_redis
        start_minio
        start_server
        start_webapp
        echo ""
        success "All services started!"
        echo ""
        info "Server: $HAPPY_SERVER_URL"
        info "Webapp: $HAPPY_WEBAPP_URL"
        echo ""
        ;;

    start-backend)
        info "Starting backend services..."
        start_postgres
        start_redis
        start_minio
        start_server
        echo ""
        success "Backend services started!"
        echo ""
        info "Run '$0 status' to check service status"
        info "Run '$0 start-webapp' to also start the webapp"
        echo ""
        ;;

    start-webapp)
        start_webapp
        ;;

    stop)
        stop_all
        echo ""
        success "Services stopped"
        echo ""
        ;;

    cleanup)
        shift
        cleanup_all "$@"
        ;;

    restart)
        $0 stop
        sleep 2
        $0 start
        ;;

    restart-all)
        $0 cleanup --clean-logs
        sleep 2
        $0 start
        ;;

    status)
        shift
        if [ "${1:-}" = "--all-slots" ]; then
            show_all_slots_status
        else
            show_status
        fi
        ;;

    logs)
        if [ -z "${2:-}" ]; then
            error "Please specify a service: server, webapp, minio, or postgres"
            exit 1
        fi
        show_logs "$2"
        ;;

    cli)
        shift
        run_cli "$@"
        ;;

    test)
        test_connection
        ;;

    urls)
        show_urls
        ;;

    env)
        print_env
        ;;

    help|--help|-h|"")
        echo ""
        echo "Happy Self-Hosted Service Launcher"
        echo ""
        echo "Usage: $0 [--slot N] [--debug] <command> [options]"
        echo ""
        echo "Options:"
        echo "  --slot N    Use slot N for port/database isolation (default: 0)"
        echo "  --debug     Enable debug logging (DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING)"
        echo ""
        echo "Slot Concept:"
        echo "  --slot 0 (default)  Primary instance: Server=3005, Webapp=8081, DB=handy"
        echo "  --slot 1            Test slot 1: Server=10001, Webapp=10002, DB=handy_test_1"
        echo "  --slot 2            Test slot 2: Server=10011, Webapp=10012, DB=handy_test_2"
        echo "  --slot N            Ports = base + 10*(N-1), separate database per slot"
        echo ""
        echo "Database Isolation:"
        echo "  Each slot uses its own database (handy_test_N) to prevent test/prod conflicts."
        echo "  PostgreSQL and Redis processes are shared, but data is isolated by database."
        echo ""
        echo "Commands:"
        echo "  start              Start all services (backend + webapp)"
        echo "  start-backend      Start only backend (PostgreSQL, Redis, MinIO, happy-server)"
        echo "  start-webapp       Start only the webapp"
        echo "  stop               Stop happy-server, webapp, and MinIO (leaves databases running)"
        echo "  cleanup            Stop ALL services including PostgreSQL and Redis"
        echo "  cleanup --clean-logs       Also delete log files"
        echo "  cleanup --all-slots        Clean all slots (not just current)"
        echo "  cleanup --nuke-happy-dir   Also delete HAPPY_HOME_DIR (~/.happy-slot-*)"
        echo "  restart            Full cleanup and restart all services"
        echo "  status             Show status of all services"
        echo "  status --all-slots Show status for all active slots"
        echo "  logs <service>     Tail logs for a service (server, webapp, minio, postgres)"
        echo "  env                Print environment variables for this slot (can be sourced)"
        echo "  cli [args]         Run happy CLI with local server configuration"
        echo "  test               Test server and CLI connectivity"
        echo "  urls               Show all service URLs and connection strings"
        echo "  help               Show this help message"
        echo ""
        echo "Shared Services (not slot-specific):"
        echo "  POSTGRES_PORT       PostgreSQL port (default: 5432)"
        echo "  REDIS_PORT          Redis port (default: 6379)"
        echo ""
        echo "Examples:"
        echo "  $0 start                    # Start slot 0 (default ports)"
        echo "  $0 --slot 1 start           # Start slot 1 (test ports)"
        echo "  $0 --slot 1 status          # Check slot 1 status"
        echo "  $0 status --all-slots       # Check status of all active slots"
        echo "  $0 --slot 1 env             # Print env vars for slot 1"
        echo "  eval \$($0 --slot 1 env)     # Set env vars in current shell"
        echo ""
        ;;

    *)
        error "Unknown command: $1"
        echo "Run '$0 help' for usage information"
        exit 1
        ;;
esac
