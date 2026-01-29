#!/bin/bash

# PostgreSQL Setup Script
# Ensures PostgreSQL is configured correctly for happy-server

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/happy-server"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check if PostgreSQL is running
if ! pgrep -f "postgres.*17/main" > /dev/null 2>&1; then
    error "PostgreSQL is not running. Please start it first with: service postgresql start"
    exit 1
fi

info "Checking PostgreSQL setup..."

# Check if we can connect with password
DB_EXISTS=false
PASSWORD_OK=false

if PGPASSWORD=postgres psql -U postgres -h localhost -c "SELECT 1;" > /dev/null 2>&1; then
    PASSWORD_OK=true
    success "PostgreSQL password is configured correctly"
else
    warning "PostgreSQL password needs to be set"
    info "Setting PostgreSQL password..."
    sudo -u postgres psql -c "ALTER USER postgres WITH PASSWORD 'postgres';" > /dev/null
    success "PostgreSQL password set to 'postgres'"
    PASSWORD_OK=true
fi

# Check if handy database exists
if PGPASSWORD=postgres psql -U postgres -h localhost -lqt 2>/dev/null | cut -d \| -f 1 | grep -qw handy; then
    DB_EXISTS=true
    success "Database 'handy' exists"
else
    warning "Database 'handy' does not exist"
    info "Creating database 'handy'..."
    sudo -u postgres psql -c "CREATE DATABASE handy;" > /dev/null
    success "Database 'handy' created"
    DB_EXISTS=true
fi

# Check if migrations have been run by checking for Session table
MIGRATIONS_OK=false
if PGPASSWORD=postgres psql -U postgres -h localhost -d handy -c "\dt" 2>/dev/null | grep -q "Session"; then
    MIGRATIONS_OK=true
    success "Database schema is up to date"
else
    warning "Database schema needs to be created"
    info "Running Prisma migrations..."
    cd "$SERVER_DIR"
    yarn migrate > /dev/null 2>&1
    success "Database migrations completed"
    MIGRATIONS_OK=true
fi

echo ""
success "PostgreSQL is ready for happy-server!"
echo ""
