#!/bin/bash

# Happy Self-Hosted Demo Control Script
# This script manages the self-hosted happy-server and happy-cli demo environment

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/happy-server"
CLI_DIR="$SCRIPT_DIR/happy-cli"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print colored message
info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check if a service is running
is_running() {
    pgrep -f "$1" > /dev/null 2>&1
}

# Start PostgreSQL
start_postgres() {
    if is_running "postgres.*17/main"; then
        info "PostgreSQL is already running"
    else
        info "Starting PostgreSQL..."
        service postgresql start
        success "PostgreSQL started"
    fi
}

# Start Redis
start_redis() {
    if is_running "redis-server"; then
        info "Redis is already running"
    else
        info "Starting Redis..."
        service redis-server start
        success "Redis started"
    fi
}

# Start MinIO
start_minio() {
    if is_running "minio server"; then
        info "MinIO is already running"
    else
        info "Starting MinIO..."
        cd "$SERVER_DIR"
        mkdir -p .minio/data
        MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
            minio server .minio/data --address :9000 --console-address :9001 \
            > /tmp/minio.log 2>&1 &
        sleep 2
        success "MinIO started on ports 9000 (API) and 9001 (Console)"
    fi
}

# Start happy-server
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

        yarn tsx --env-file=.env ./sources/main.ts > /tmp/happy-server.log 2>&1 &
        sleep 3

        # Check if server started successfully
        if curl -s http://localhost:3005/ > /dev/null 2>&1; then
            success "happy-server started on port 3005"
        else
            error "happy-server failed to start. Check logs with: $0 logs server"
            exit 1
        fi
    fi
}

# Stop all services
stop_all() {
    info "Stopping all services..."

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
    # and may be used by other applications
    warning "PostgreSQL and Redis are system services and were not stopped"
    warning "To stop them manually: service postgresql stop && service redis-server stop"
}

# Complete cleanup - stops everything including system services
cleanup_all() {
    info "Running complete cleanup (stopping ALL services)..."
    echo ""

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
        # Also kill any orphaned redis processes that the service didn't catch
        pkill -f "redis-server" 2>/dev/null || true
        success "Redis stopped"
    else
        info "Redis not running"
    fi

    # Kill any orphaned node/yarn processes related to happy
    info "Cleaning up any orphaned processes..."
    pkill -f "node.*happy-server" 2>/dev/null || true
    pkill -f "node.*happy-cli" 2>/dev/null || true
    pkill -f "expo start" 2>/dev/null || true  # Also stop web client if running

    # Clean up log files (optional)
    if [ "${2:-}" = "--clean-logs" ]; then
        info "Cleaning up log files..."
        rm -f /tmp/happy-server.log
        rm -f /tmp/minio.log
        success "Log files cleaned"
    fi

    echo ""
    success "Complete cleanup finished!"
    echo ""
    info "All services have been stopped"
    if [ "${2:-}" != "--clean-logs" ]; then
        info "Logs preserved. Use '$0 cleanup --clean-logs' to remove them"
    fi
    echo ""
}

# Show status of all services
show_status() {
    echo ""
    echo "=== Happy Self-Hosted Demo Status ==="
    echo ""

    # PostgreSQL
    if is_running "postgres.*17/main"; then
        success "PostgreSQL: Running (port 5432)"
    else
        error "PostgreSQL: Stopped"
    fi

    # Redis
    if is_running "redis-server"; then
        success "Redis: Running (port 6379)"
    else
        error "Redis: Stopped"
    fi

    # MinIO
    if is_running "minio server"; then
        success "MinIO: Running (API: 9000, Console: 9001)"
    else
        error "MinIO: Stopped"
    fi

    # happy-server
    if is_running "tsx.*sources/main.ts"; then
        if curl -s http://localhost:3005/ > /dev/null 2>&1; then
            success "happy-server: Running (port 3005)"
        else
            warning "happy-server: Process running but not responding"
        fi
    else
        error "happy-server: Stopped"
    fi

    echo ""
}

# Show logs
show_logs() {
    local service=$1
    case $service in
        server)
            info "Showing happy-server logs (tail -f /tmp/happy-server.log)..."
            tail -f /tmp/happy-server.log
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
            echo "Available services: server, minio, postgres"
            exit 1
            ;;
    esac
}

# Run happy CLI
run_cli() {
    info "Running happy CLI..."
    cd "$CLI_DIR"
    export HAPPY_HOME_DIR=~/.happy-dev
    export HAPPY_SERVER_URL=http://localhost:3005

    if [ $# -eq 0 ]; then
        ./bin/happy.mjs
    else
        ./bin/happy.mjs "$@"
    fi
}

# Test the connection
test_connection() {
    info "Testing connection..."
    echo ""

    # Test server
    if curl -s http://localhost:3005/ | grep -q "Happy"; then
        success "Server responding at http://localhost:3005/"
    else
        error "Server not responding"
        exit 1
    fi

    # Test CLI
    cd "$CLI_DIR"
    if HAPPY_SERVER_URL=http://localhost:3005 ./bin/happy.mjs --version 2>&1 | grep -q "happy version"; then
        success "CLI executable and shows version"
    else
        error "CLI failed to execute"
        exit 1
    fi

    echo ""
    success "All tests passed!"
    echo ""
}

# Main command handler
case "${1:-}" in
    start)
        info "Starting all services..."
        start_postgres
        start_redis
        start_minio
        start_server
        echo ""
        success "All services started!"
        echo ""
        info "Run '$0 status' to check service status"
        info "Run '$0 cli' to use the happy CLI"
        info "Run '$0 test' to test the connection"
        echo ""
        ;;

    stop)
        stop_all
        echo ""
        success "Services stopped"
        echo ""
        ;;

    cleanup)
        cleanup_all "$@"
        ;;

    restart)
        $0 stop
        sleep 2
        $0 start
        ;;

    status)
        show_status
        ;;

    logs)
        if [ -z "${2:-}" ]; then
            error "Please specify a service: server, minio, or postgres"
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
        echo ""
        echo "=== Service URLs ==="
        echo ""
        echo "  happy-server:    http://localhost:3005/"
        echo "  MinIO Console:   http://localhost:9001/"
        echo "  Metrics:         http://localhost:9090/metrics"
        echo ""
        echo "=== Database Connections ==="
        echo ""
        echo "  PostgreSQL:      postgresql://postgres:postgres@localhost:5432/handy"
        echo "  Redis:           redis://localhost:6379"
        echo ""
        ;;

    help|--help|-h|"")
        echo ""
        echo "Happy Self-Hosted Demo Control Script"
        echo ""
        echo "Usage: $0 <command> [options]"
        echo ""
        echo "Commands:"
        echo "  start              Start all services (PostgreSQL, Redis, MinIO, happy-server)"
        echo "  stop               Stop happy-server and MinIO (leaves PostgreSQL/Redis running)"
        echo "  cleanup            Stop ALL services including PostgreSQL and Redis"
        echo "  cleanup --clean-logs   Stop all services and delete log files"
        echo "  restart            Restart all services"
        echo "  status             Show status of all services"
        echo "  logs <service>     Tail logs for a service (server, minio, postgres)"
        echo "  cli [args]         Run happy CLI with local server configuration"
        echo "  test               Test server and CLI connectivity"
        echo "  urls               Show all service URLs and connection strings"
        echo "  help               Show this help message"
        echo ""
        echo "Examples:"
        echo "  $0 start                    # Start everything"
        echo "  $0 status                   # Check what's running"
        echo "  $0 stop                     # Stop server/MinIO (keep databases running)"
        echo "  $0 cleanup                  # Stop everything including databases"
        echo "  $0 cleanup --clean-logs     # Stop everything and delete logs"
        echo "  $0 logs server              # Watch server logs"
        echo "  $0 cli --version            # Run CLI command"
        echo "  $0 cli                      # Start interactive CLI session"
        echo ""
        ;;

    *)
        error "Unknown command: $1"
        echo "Run '$0 help' for usage information"
        exit 1
        ;;
esac
