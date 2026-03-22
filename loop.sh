#!/bin/bash
set -euo pipefail

mkdir -p .dev/v3-loop-logs
ITERATION=0
PROMPT="Read docs/plans/happy-sync-major-refactor.md and do what it says."

while true; do
    ITERATION=$((ITERATION + 1))
    LOGFILE=".dev/v3-loop-logs/iteration-$(printf '%02d' $ITERATION)-$(date +%Y%m%d-%H%M%S).log"

    # Odd iterations: Claude, even iterations: Codex
    if (( ITERATION % 2 == 1 )); then
        AGENT="claude"
    else
        AGENT="codex"
    fi

    echo ""
    echo "========================================="
    echo "  ITERATION $ITERATION — $AGENT — $(date)"
    echo "  Log: $LOGFILE"
    echo "========================================="
    echo ""

    if [ "$AGENT" = "claude" ]; then
        timeout 3600 claude -p --dangerously-skip-permissions \
            "$PROMPT" \
            2>&1 | tee "$LOGFILE" || true
    else
        timeout 3600 codex exec -s danger-full-access \
            "$PROMPT" \
            2>&1 | tee "$LOGFILE" || true
    fi

    sleep 5
done
