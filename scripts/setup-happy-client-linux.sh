#!/usr/bin/env bash
# Set up a Linux machine (server / remote) as a happy CLI client of an
# existing self-hosted happy server.
#
# What it does:
#   - Verifies Node 20+ (installs into ~/local via official tarball if missing)
#   - Installs happy@1.1.10-beta.4 globally
#   - Writes ~/.happy/settings.json pointing at $HAPPY_SERVER_URL
#   - Either copies an existing access.key (pass --access-key <path>) or
#     runs scripts/happy-register.mjs to mint a fresh account
#   - Verifies with `happy doctor`
#
# Required env:
#   HAPPY_SERVER_URL                e.g. http://192.0.2.10:3006
#   HAPPY_BASIC_AUTH_URL            e.g. http://happy:URLENC-PASS@192.0.2.10:3006
#                                    (only used by the inline register flow)
#
# Optional env:
#   HAPPY_CLI_VERSION               default: 1.1.10-beta.4
#   HAPPY_NODE_INSTALL_PATH         default: ~/local  (only used if Node 20+ missing)
#
# Usage (existing-account):
#   HAPPY_SERVER_URL=http://192.0.2.10:3006 \
#   ./setup-happy-client-linux.sh --access-key /path/to/access.key
#
# Usage (fresh-account, bootstrap):
#   HAPPY_SERVER_URL=http://192.0.2.10:3006 \
#   HAPPY_BASIC_AUTH_URL='http://happy:URLENC@192.0.2.10:3006' \
#   ./setup-happy-client-linux.sh --register
#
# Re-running is safe.

set -euo pipefail

HAPPY_CLI_VERSION="${HAPPY_CLI_VERSION:-1.1.10-beta.4}"
HAPPY_NODE_INSTALL_PATH="${HAPPY_NODE_INSTALL_PATH:-$HOME/local}"

ACCESS_KEY_SRC=""
DO_REGISTER=0

while [ $# -gt 0 ]; do
    case "$1" in
        --access-key) ACCESS_KEY_SRC="$2"; shift 2 ;;
        --register)   DO_REGISTER=1; shift ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
hl()     { printf '\033[36m%s\033[0m\n' "$*"; }

if [ -z "${HAPPY_SERVER_URL:-}" ]; then
    red "HAPPY_SERVER_URL is required"; exit 1
fi

# --- Node ---
NODE_PATH=""
if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
fi
if command -v node >/dev/null; then
    NODE_MAJOR=$(node --version | sed 's/^v//' | cut -d. -f1)
    [ "$NODE_MAJOR" -ge 20 ] && NODE_PATH="$(command -v node)"
fi
if [ -z "$NODE_PATH" ]; then
    hl "Node 20+ not found — installing standalone into $HAPPY_NODE_INSTALL_PATH ..."
    mkdir -p "$HAPPY_NODE_INSTALL_PATH"
    curl -fsSL https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-x64.tar.xz \
        | tar -xJ -C "$HAPPY_NODE_INSTALL_PATH" --strip-components=1
    export PATH="$HAPPY_NODE_INSTALL_PATH/bin:$PATH"

    # Make permanent in shell rc files
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
        [ -f "$rc" ] || continue
        if ! grep -q "$HAPPY_NODE_INSTALL_PATH/bin" "$rc"; then
            printf '\n# Added by setup-happy-client-linux.sh\nexport PATH=%s/bin:$PATH\n' "$HAPPY_NODE_INSTALL_PATH" >> "$rc"
        fi
    done
    NODE_PATH="$HAPPY_NODE_INSTALL_PATH/bin/node"
fi
hl "Using Node at: $NODE_PATH ($(node --version 2>/dev/null || echo unknown))"

# --- happy CLI ---
if happy --version 2>/dev/null | grep -q "$HAPPY_CLI_VERSION"; then
    hl "happy@$HAPPY_CLI_VERSION already installed"
else
    hl "Installing happy@$HAPPY_CLI_VERSION globally..."
    npm install -g "happy@$HAPPY_CLI_VERSION"
fi

# --- settings.json ---
mkdir -p "$HOME/.happy"
cat > "$HOME/.happy/settings.json" <<EOF
{
    "schemaVersion": 2,
    "onboardingCompleted": false,
    "serverUrl": "$HAPPY_SERVER_URL",
    "webappUrl": "$HAPPY_SERVER_URL"
}
EOF
hl "Wrote $HOME/.happy/settings.json (serverUrl=$HAPPY_SERVER_URL)"

# --- credentials ---
if [ -f "$HOME/.happy/access.key" ]; then
    hl "$HOME/.happy/access.key already exists — leaving in place"
elif [ -n "$ACCESS_KEY_SRC" ]; then
    cp "$ACCESS_KEY_SRC" "$HOME/.happy/access.key"
    chmod 600 "$HOME/.happy/access.key"
    green "Copied access.key from $ACCESS_KEY_SRC"
elif [ "$DO_REGISTER" = 1 ]; then
    if [ -z "${HAPPY_BASIC_AUTH_URL:-}" ]; then
        red "Register requested but HAPPY_BASIC_AUTH_URL not set"; exit 1
    fi
    # find scripts/happy-register.mjs in this repo
    HERE="$(cd "$(dirname "$0")" && pwd)"
    REG_SCRIPT="$HERE/happy-register.mjs"
    if [ ! -f "$REG_SCRIPT" ]; then
        red "scripts/happy-register.mjs not next to this script. Clone the repo or copy the file."; exit 1
    fi
    hl "Registering fresh account against $HAPPY_BASIC_AUTH_URL ..."
    node "$REG_SCRIPT" "$HAPPY_BASIC_AUTH_URL"
else
    red "No access.key, no --access-key, no --register. Provide one to authenticate."; exit 1
fi

# --- verify ---
green "✓ Setup complete. Verification:"
happy doctor 2>&1 | grep -iE 'Server URL|Authent|Happy CLI Version' | head -10 || true
echo
echo "  Try:  happy claude   (in any project directory)"
