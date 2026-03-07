#!/usr/bin/env bash
# happy-dev-safe.sh — wrapper that runs dev CLI with auto-fallback to stock happy
#
# If the dev CLI crashes within CRASH_THRESHOLD seconds, automatically falls back
# to the NPM-installed 'happy' binary. This ensures you always have a working CLI
# even if a dev build is broken.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
CLI_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEV_BIN="$CLI_ROOT/bin/happy-dev.mjs"
DEV_HOME="$HOME/.happy-dev"
FALLBACK_LOG="$DEV_HOME/logs/fallback.log"
CRASH_THRESHOLD=5  # seconds — if dev CLI exits this fast with error, it's a crash

# Find the stock happy binary (skip ourselves in PATH)
find_stock_happy() {
    local self_dir
    self_dir="$(dirname "$(readlink -f "$0")")"
    while IFS=: read -r dir; do
        if [[ "$dir" != "$self_dir" && -x "$dir/happy" ]]; then
            echo "$dir/happy"
            return 0
        fi
    done <<< "$(echo "$PATH" | tr ':' '\n')"
    return 1
}

log_fallback() {
    mkdir -p "$(dirname "$FALLBACK_LOG")"
    echo "[$(date -Iseconds)] $*" >> "$FALLBACK_LOG"
}

# Check if this is a daemon start command
is_daemon_start() {
    [[ "${1:-}" == "daemon" && "${2:-}" == "start" ]] || \
    [[ "${1:-}" == "daemon" && "${2:-}" == "start-sync" ]]
}

run_with_fallback() {
    local start_time exit_code

    # Check dev binary exists and dist/ is built
    if [[ ! -f "$DEV_BIN" ]]; then
        log_fallback "FALLBACK: dev binary not found at $DEV_BIN"
        echo "[happy-dev] Dev binary not found, falling back to stock happy" >&2
        exec "$(find_stock_happy)" "$@"
    fi

    if [[ ! -f "$CLI_ROOT/dist/index.mjs" ]]; then
        log_fallback "FALLBACK: dist/index.mjs not found — dev CLI not built"
        echo "[happy-dev] Dev CLI not built, falling back to stock happy" >&2
        exec "$(find_stock_happy)" "$@"
    fi

    start_time=$(date +%s)

    # Run the dev CLI
    set +e
    node --no-warnings --no-deprecation "$DEV_BIN" "$@"
    exit_code=$?
    set -e

    # If it exited successfully, we're done
    if [[ $exit_code -eq 0 ]]; then
        exit 0
    fi

    # Check if it crashed quickly (startup failure)
    local elapsed=$(( $(date +%s) - start_time ))

    if [[ $elapsed -lt $CRASH_THRESHOLD ]]; then
        log_fallback "FALLBACK: dev CLI crashed in ${elapsed}s (exit $exit_code) — args: $*"
        echo "" >&2
        echo "[happy-dev] Dev CLI crashed on startup (exit $exit_code)." >&2
        echo "[happy-dev] Falling back to stock happy..." >&2
        echo "[happy-dev] See $FALLBACK_LOG for details." >&2
        echo "" >&2

        local stock
        stock="$(find_stock_happy)" || {
            echo "[happy-dev] FATAL: No stock happy binary found in PATH either!" >&2
            exit 1
        }
        exec "$stock" "$@"
    else
        # It ran for a while then failed — that's a normal exit, not a startup crash
        exit $exit_code
    fi
}

run_with_fallback "$@"
