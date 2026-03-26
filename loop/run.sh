#!/bin/bash
set -euo pipefail

mkdir -p loop/logs

# Prevent Expo from auto-opening browser windows
export BROWSER=none

ITERATION=0
PROMPT="$(cat loop/prompt.md)"

while true; do
    ITERATION=$((ITERATION + 1))
    LOGFILE="loop/logs/iteration-$(printf '%02d' $ITERATION)-$(date +%Y%m%d-%H%M%S).log"

    echo ""
    echo "========================================="
    if (( ITERATION % 2 == 1 )); then AGENT="claude"; else AGENT="codex"; fi
    echo "  ITERATION $ITERATION — $AGENT — $(date)"
    echo "  Log: $LOGFILE"
    echo "========================================="
    echo ""

    # Odd iterations: Claude, even iterations: Codex — 40 min timeout
    if (( ITERATION % 2 == 1 )); then
        timeout 2400 claude -p --dangerously-skip-permissions \
            "$PROMPT" \
            2>&1 | tee "$LOGFILE" || true
    else
        timeout 2400 codex exec -s danger-full-access \
            "$PROMPT" \
            2>&1 | tee "$LOGFILE" || true
    fi

    sleep 5
done
