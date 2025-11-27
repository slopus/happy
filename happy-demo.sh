#!/bin/bash

# Happy Self-Hosted Demo Control Script
# This script manages the self-hosted happy-server and happy-cli demo environment
#
# Port Configuration (can be overridden via environment variables):
#   HAPPY_SERVER_PORT   - Server port (default: 3005)
#   HAPPY_WEBAPP_PORT   - Webapp port (default: 8081)
#   MINIO_PORT          - MinIO API port (default: 9000)
#   MINIO_CONSOLE_PORT  - MinIO console port (default: 9001)
#   POSTGRES_PORT       - PostgreSQL port (default: 5432)
#   REDIS_PORT          - Redis port (default: 6379)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/happy-server"
CLI_DIR="$SCRIPT_DIR/happy-cli"
WEBAPP_DIR="$SCRIPT_DIR/happy"

# =============================================================================
# Port Configuration
# =============================================================================

HAPPY_SERVER_PORT="${HAPPY_SERVER_PORT:-3005}"
HAPPY_WEBAPP_PORT="${HAPPY_WEBAPP_PORT:-8081}"
MINIO_PORT="${MINIO_PORT:-9000}"
MINIO_CONSOLE_PORT="${MINIO_CONSOLE_PORT:-9001}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
REDIS_PORT="${REDIS_PORT:-6379}"

# Derived URLs
HAPPY_SERVER_URL="http://localhost:${HAPPY_SERVER_PORT}"
HAPPY_WEBAPP_URL="http://localhost:${HAPPY_WEBAPP_PORT}"

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

# Check if a service is running
is_running() {
    pgrep -f "$1" > /dev/null 2>&1
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

start_postgres() {
    if is_running "postgres.*17/main"; then
        info "PostgreSQL is already running"
    else
        info "Starting PostgreSQL..."
        service postgresql start
        wait_for_port "$POSTGRES_PORT" "PostgreSQL" 10 || {
            error "PostgreSQL failed to start"
            return 1
        }
        success "PostgreSQL started on port $POSTGRES_PORT"
    fi
}

start_redis() {
    if is_running "redis-server"; then
        info "Redis is already running"
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
    if is_running "minio server"; then
        info "MinIO is already running"
    else
        info "Starting MinIO..."
        cd "$SERVER_DIR"
        mkdir -p .minio/data
        MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
            minio server .minio/data --address ":${MINIO_PORT}" --console-address ":${MINIO_CONSOLE_PORT}" \
            > /tmp/minio.log 2>&1 &
        cd "$SCRIPT_DIR"
        wait_for_port "$MINIO_PORT" "MinIO" 15 || {
            error "MinIO failed to start"
            return 1
        }
        # Create bucket if mc is available
        if command -v mc >/dev/null 2>&1; then
            mc alias set local "http://localhost:${MINIO_PORT}" minioadmin minioadmin 2>/dev/null || true
            mc mb local/happy 2>/dev/null || true
        fi
        success "MinIO started on port $MINIO_PORT (Console: $MINIO_CONSOLE_PORT)"
    fi
}

start_server() {
    if is_running "tsx.*sources/main.ts"; then
        info "happy-server is already running"
    else
        info "Starting happy-server..."
        cd "$SERVER_DIR"

        # Ensure .env exists
        if [ ! -f .env ]; then
            info "Creating .env from .env.dev..."
            cp .env.dev .env
        fi

        PORT="$HAPPY_SERVER_PORT" yarn start > /tmp/happy-server.log 2>&1 &
        cd "$SCRIPT_DIR"

        wait_for_port "$HAPPY_SERVER_PORT" "happy-server" 30 || {
            error "happy-server failed to start. Check logs: tail /tmp/happy-server.log"
            return 1
        }
        success "happy-server started on port $HAPPY_SERVER_PORT"
    fi
}

start_webapp() {
    if is_running "expo start"; then
        info "Webapp is already running"
    else
        info "Starting webapp..."
        cd "$WEBAPP_DIR"
        BROWSER=none \
            EXPO_PUBLIC_HAPPY_SERVER_URL="$HAPPY_SERVER_URL" \
            yarn web --port "$HAPPY_WEBAPP_PORT" > /tmp/webapp.log 2>&1 &
        cd "$SCRIPT_DIR"

        # Webapp takes longer to start (Metro bundler)
        wait_for_port "$HAPPY_WEBAPP_PORT" "webapp" 60 || {
            error "Webapp failed to start. Check logs: tail /tmp/webapp.log"
            return 1
        }
        success "Webapp started on port $HAPPY_WEBAPP_PORT"
    fi
}

# =============================================================================
# Service Stop Functions
# =============================================================================

stop_all() {
    info "Stopping all services..."

    # Stop webapp
    if is_running "expo start"; then
        info "Stopping webapp..."
        pkill -f "expo start" || true
        pkill -f "metro" || true
        success "Webapp stopped"
    fi

    # Stop happy-server
    if is_running "tsx.*sources/main.ts"; then
        info "Stopping happy-server..."
        pkill -f "tsx.*sources/main.ts" || true
        success "happy-server stopped"
    fi

    # Stop MinIO
    if is_running "minio server"; then
        info "Stopping MinIO..."
        pkill -f "minio server" || true
        success "MinIO stopped"
    fi

    # Note: Not stopping PostgreSQL and Redis as they're system services
    warning "PostgreSQL and Redis are system services and were not stopped"
    warning "To stop them manually: service postgresql stop && service redis-server stop"
}

cleanup_all() {
    info "Running complete cleanup (stopping ALL services)..."
    echo ""

    # Stop webapp
    if is_running "expo start"; then
        info "Stopping webapp..."
        pkill -f "expo start" || true
        pkill -f "metro" || true
        success "Webapp stopped"
    else
        info "Webapp not running"
    fi

    # Stop happy-server
    if is_running "tsx.*sources/main.ts"; then
        info "Stopping happy-server..."
        pkill -f "tsx.*sources/main.ts" || true
        pkill -f "yarn tsx.*sources/main.ts" || true
        success "happy-server stopped"
    else
        info "happy-server not running"
    fi

    # Stop MinIO
    if is_running "minio server"; then
        info "Stopping MinIO..."
        pkill -f "minio server" || true
        success "MinIO stopped"
    else
        info "MinIO not running"
    fi

    # Stop PostgreSQL
    if is_running "postgres.*17/main"; then
        info "Stopping PostgreSQL..."
        service postgresql stop || true
        success "PostgreSQL stopped"
    else
        info "PostgreSQL not running"
    fi

    # Stop Redis
    if is_running "redis-server"; then
        info "Stopping Redis..."
        service redis-server stop || true
        pkill -f "redis-server" 2>/dev/null || true
        success "Redis stopped"
    else
        info "Redis not running"
    fi

    # Kill any orphaned processes
    info "Cleaning up any orphaned processes..."
    pkill -f "node.*happy-server" 2>/dev/null || true
    pkill -f "node.*happy-cli" 2>/dev/null || true

    # Clean up log files (optional)
    if [ "${1:-}" = "--clean-logs" ]; then
        info "Cleaning up log files..."
        rm -f /tmp/happy-server.log /tmp/minio.log /tmp/webapp.log
        success "Log files cleaned"
    fi

    echo ""
    success "Complete cleanup finished!"
    echo ""
    info "All services have been stopped"
    if [ "${1:-}" != "--clean-logs" ]; then
        info "Logs preserved. Use '$0 cleanup --clean-logs' to remove them"
    fi
    echo ""
}

# =============================================================================
# Status and Info Functions
# =============================================================================

show_status() {
    echo ""
    echo "=== Happy Self-Hosted Demo Status ==="
    echo ""
    echo "Port configuration:"
    echo "  Server:  $HAPPY_SERVER_PORT"
    echo "  Webapp:  $HAPPY_WEBAPP_PORT"
    echo "  MinIO:   $MINIO_PORT"
    echo "  Postgres: $POSTGRES_PORT"
    echo "  Redis:   $REDIS_PORT"
    echo ""

    # PostgreSQL
    if is_running "postgres.*17/main"; then
        success "PostgreSQL: Running (port $POSTGRES_PORT)"
    else
        error "PostgreSQL: Stopped"
    fi

    # Redis
    if is_running "redis-server"; then
        success "Redis: Running (port $REDIS_PORT)"
    else
        error "Redis: Stopped"
    fi

    # MinIO
    if is_running "minio server"; then
        success "MinIO: Running (API: $MINIO_PORT, Console: $MINIO_CONSOLE_PORT)"
    else
        error "MinIO: Stopped"
    fi

    # happy-server
    if is_running "tsx.*sources/main.ts"; then
        if port_listening "$HAPPY_SERVER_PORT"; then
            success "happy-server: Running (port $HAPPY_SERVER_PORT)"
        else
            warning "happy-server: Process running but not responding"
        fi
    else
        error "happy-server: Stopped"
    fi

    # Webapp
    if is_running "expo start"; then
        if port_listening "$HAPPY_WEBAPP_PORT"; then
            success "Webapp: Running (port $HAPPY_WEBAPP_PORT)"
        else
            warning "Webapp: Process running but not responding"
        fi
    else
        error "Webapp: Stopped"
    fi

    echo ""
}

show_logs() {
    local service=$1
    case $service in
        server)
            info "Showing happy-server logs (tail -f /tmp/happy-server.log)..."
            tail -f /tmp/happy-server.log
            ;;
        webapp)
            info "Showing webapp logs (tail -f /tmp/webapp.log)..."
            tail -f /tmp/webapp.log
            ;;
        minio)
            info "Showing MinIO logs (tail -f /tmp/minio.log)..."
            tail -f /tmp/minio.log
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
    echo "  PostgreSQL:      postgresql://postgres:postgres@localhost:${POSTGRES_PORT}/handy"
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
        info "Starting backend services..."
        start_postgres
        start_redis
        start_minio
        start_server
        echo ""
        success "Backend services started!"
        echo ""
        info "Run '$0 status' to check service status"
        info "Run '$0 start-all' to also start the webapp"
        echo ""
        ;;

    start-all)
        info "Starting all services (including webapp)..."
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
        $0 start-all
        ;;

    status)
        show_status
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

    help|--help|-h|"")
        echo ""
        echo "Happy Self-Hosted Demo Control Script"
        echo ""
        echo "Usage: $0 <command> [options]"
        echo ""
        echo "Commands:"
        echo "  start              Start backend services (PostgreSQL, Redis, MinIO, happy-server)"
        echo "  start-all          Start all services including webapp"
        echo "  start-webapp       Start only the webapp"
        echo "  stop               Stop happy-server, webapp, and MinIO (leaves databases running)"
        echo "  cleanup            Stop ALL services including PostgreSQL and Redis"
        echo "  cleanup --clean-logs   Stop all services and delete log files"
        echo "  restart            Restart backend services"
        echo "  restart-all        Full cleanup and restart all services"
        echo "  status             Show status of all services"
        echo "  logs <service>     Tail logs for a service (server, webapp, minio, postgres)"
        echo "  cli [args]         Run happy CLI with local server configuration"
        echo "  test               Test server and CLI connectivity"
        echo "  urls               Show all service URLs and connection strings"
        echo "  help               Show this help message"
        echo ""
        echo "Environment Variables:"
        echo "  HAPPY_SERVER_PORT   Server port (default: 3005)"
        echo "  HAPPY_WEBAPP_PORT   Webapp port (default: 8081)"
        echo "  MINIO_PORT          MinIO API port (default: 9000)"
        echo "  MINIO_CONSOLE_PORT  MinIO console port (default: 9001)"
        echo "  POSTGRES_PORT       PostgreSQL port (default: 5432)"
        echo "  REDIS_PORT          Redis port (default: 6379)"
        echo ""
        echo "Examples:"
        echo "  $0 start                    # Start backend services"
        echo "  $0 start-all                # Start everything including webapp"
        echo "  $0 status                   # Check what's running"
        echo "  $0 cleanup --clean-logs     # Stop everything and delete logs"
        echo "  HAPPY_SERVER_PORT=4000 $0 start  # Use custom port"
        echo ""
        ;;

    *)
        error "Unknown command: $1"
        echo "Run '$0 help' for usage information"
        exit 1
        ;;
esac
