#!/bin/bash
set -euo pipefail

mkdir -p .dev/v3-loop-logs
ITERATION=0

while true; do
    ITERATION=$((ITERATION + 1))
    LOGFILE=".dev/v3-loop-logs/iteration-$(printf '%02d' $ITERATION)-$(date +%Y%m%d-%H%M%S).log"

    echo ""
    echo "========================================="
    echo "  ITERATION $ITERATION — $(date)"
    echo "  Log: $LOGFILE"
    echo "========================================="
    echo ""

    timeout 3600 codex exec -s danger-full-access \
        "Read docs/plans/happy-sync-major-refactor.md and do what it says." \
        2>&1 | tee "$LOGFILE" || true

    sleep 5
done
