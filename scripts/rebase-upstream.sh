#!/bin/bash

# Rebase upstream script for happy submodules
# Fetches latest upstream and rebases our branches on upstream/main

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

# First run setup to ensure everything is configured
info "Running setup first to ensure correct configuration..."
"$SCRIPT_DIR/setup-submodules.sh"

echo ""
info "Rebasing submodules on upstream/main..."
echo ""

# Check if we're in a feature branch
FEATURE_FILE="$REPO_ROOT/feature_name.txt"
if [ -f "$FEATURE_FILE" ]; then
    FEATURE_NAME=$(cat "$FEATURE_FILE")
    SUBMODULE_BRANCH="feature-$FEATURE_NAME"
    info "Feature mode: rebasing feature-$FEATURE_NAME on upstream/main"
else
    SUBMODULE_BRANCH="main"
    info "Base development mode: rebasing main on upstream/main"
fi

# Function to rebase a submodule
rebase_submodule() {
    local name=$1

    info "Rebasing $name..."
    cd "$REPO_ROOT/$name"

    # Fetch latest upstream
    info "Fetching upstream..."
    git fetch upstream --quiet

    # Check for uncommitted changes
    if ! git diff-index --quiet HEAD --; then
        error "$name has uncommitted changes. Please commit or stash them first."
        return 1
    fi

    # Get current branch
    CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

    if [ "$CURRENT_BRANCH" != "$SUBMODULE_BRANCH" ]; then
        error "$name is on branch '$CURRENT_BRANCH' but expected '$SUBMODULE_BRANCH'"
        return 1
    fi

    # Rebase on upstream/main
    info "Rebasing $SUBMODULE_BRANCH on upstream/main..."
    if git rebase upstream/main; then
        success "$name rebased successfully"

        # Show summary
        BEHIND=$(git rev-list --count upstream/main..$SUBMODULE_BRANCH 2>/dev/null || echo "0")
        AHEAD=$(git rev-list --count $SUBMODULE_BRANCH..upstream/main 2>/dev/null || echo "0")

        if [ "$AHEAD" = "0" ] && [ "$BEHIND" != "0" ]; then
            info "  $BEHIND commits ahead of upstream/main"
        elif [ "$AHEAD" = "0" ] && [ "$BEHIND" = "0" ]; then
            info "  Up to date with upstream/main"
        fi
    else
        error "$name rebase failed"
        info "  Run 'cd $name && git rebase --abort' to cancel the rebase"
        info "  Or resolve conflicts and run 'git rebase --continue'"
        return 1
    fi

    cd "$REPO_ROOT"
}

# Rebase each submodule
FAILED=0

rebase_submodule "happy" || FAILED=1
rebase_submodule "happy-cli" || FAILED=1
rebase_submodule "happy-server" || FAILED=1

echo ""

if [ $FAILED -eq 0 ]; then
    success "All submodules rebased successfully!"
    echo ""
    info "Next steps:"
    echo "  - Review the rebased commits"
    echo "  - Test your changes"
    echo "  - Push to origin with: git push origin $SUBMODULE_BRANCH --force-with-lease"
    echo ""
else
    error "Some submodules failed to rebase. See errors above."
    exit 1
fi
