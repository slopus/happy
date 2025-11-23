#!/bin/bash

# Setup script for happy submodules
# Ensures correct remote configuration and branch setup

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

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

# Check if we're in a feature branch
FEATURE_FILE="$REPO_ROOT/feature_name.txt"
if [ -f "$FEATURE_FILE" ]; then
    FEATURE_NAME=$(cat "$FEATURE_FILE")
    PARENT_BRANCH="happy-$FEATURE_NAME"
    SUBMODULE_BRANCH="feature-$FEATURE_NAME"
    info "Feature mode detected: $FEATURE_NAME"
else
    PARENT_BRANCH="happy"
    SUBMODULE_BRANCH="main"
    info "Base development mode"
fi

# Verify parent branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "$PARENT_BRANCH" ]; then
    warning "Current branch is '$CURRENT_BRANCH' but expected '$PARENT_BRANCH'"
    warning "Consider switching to '$PARENT_BRANCH' first"
fi

echo ""
info "Configuring submodules..."
echo ""

# Function to setup a submodule
setup_submodule() {
    local name=$1
    local origin_url=$2
    local upstream_url=$3

    info "Setting up $name..."
    cd "$REPO_ROOT/$name"

    # Configure origin
    if git remote get-url origin >/dev/null 2>&1; then
        CURRENT_ORIGIN=$(git remote get-url origin)
        if [ "$CURRENT_ORIGIN" != "$origin_url" ]; then
            warning "Updating origin URL from $CURRENT_ORIGIN to $origin_url"
            git remote set-url origin "$origin_url"
        fi
    else
        info "Adding origin remote"
        git remote add origin "$origin_url"
    fi

    # Configure upstream
    if git remote get-url upstream >/dev/null 2>&1; then
        CURRENT_UPSTREAM=$(git remote get-url upstream)
        if [ "$CURRENT_UPSTREAM" != "$upstream_url" ]; then
            warning "Updating upstream URL from $CURRENT_UPSTREAM to $upstream_url"
            git remote set-url upstream "$upstream_url"
        fi
    else
        info "Adding upstream remote"
        git remote add upstream "$upstream_url"
    fi

    # Fetch from remotes
    info "Fetching from origin and upstream..."
    git fetch origin --quiet
    git fetch upstream --quiet

    # Ensure we're on the correct branch
    CURRENT_SUBMODULE_BRANCH=$(git rev-parse --abbrev-ref HEAD)

    if [ "$CURRENT_SUBMODULE_BRANCH" == "HEAD" ]; then
        # Detached HEAD - need to checkout the correct branch
        info "Detached HEAD detected, checking out $SUBMODULE_BRANCH..."
        if git show-ref --verify --quiet "refs/heads/$SUBMODULE_BRANCH"; then
            git checkout "$SUBMODULE_BRANCH" --quiet
        else
            # Branch doesn't exist locally, create it
            if git show-ref --verify --quiet "refs/remotes/origin/$SUBMODULE_BRANCH"; then
                git checkout -b "$SUBMODULE_BRANCH" "origin/$SUBMODULE_BRANCH" --quiet
            else
                error "Branch $SUBMODULE_BRANCH doesn't exist on origin"
                return 1
            fi
        fi
    elif [ "$CURRENT_SUBMODULE_BRANCH" != "$SUBMODULE_BRANCH" ]; then
        warning "Currently on '$CURRENT_SUBMODULE_BRANCH', expected '$SUBMODULE_BRANCH'"
        info "Checking out $SUBMODULE_BRANCH..."
        git checkout "$SUBMODULE_BRANCH" --quiet
    fi

    # Set up tracking branch
    if ! git rev-parse --abbrev-ref --symbolic-full-name @{u} >/dev/null 2>&1; then
        info "Setting up tracking branch origin/$SUBMODULE_BRANCH"
        git branch --set-upstream-to="origin/$SUBMODULE_BRANCH" "$SUBMODULE_BRANCH"
    fi

    success "$name configured: on branch $SUBMODULE_BRANCH tracking origin/$SUBMODULE_BRANCH"
    cd "$REPO_ROOT"
}

# Setup each submodule
setup_submodule "happy" "git@github.com:rrnewton/happy" "git@github.com:slopus/happy"
setup_submodule "happy-cli" "git@github.com:rrnewton/happy-cli" "git@github.com:slopus/happy-cli"
setup_submodule "happy-server" "git@github.com:rrnewton/happy-server" "git@github.com:slopus/happy-server"

echo ""
success "All submodules configured!"
echo ""

# Show final status
info "Submodule status:"
echo ""
cd "$REPO_ROOT"
for submod in happy happy-cli happy-server; do
    cd "$REPO_ROOT/$submod"
    BRANCH=$(git rev-parse --abbrev-ref HEAD)
    TRACKING=$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo "none")
    echo "  $submod: $BRANCH (tracking $TRACKING)"
done
echo ""
