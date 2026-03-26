#!/bin/bash
# Watchdog: checks every 2 min if loop/run.sh is alive, restarts if dead.
# Run with: nohup bash loop/watchdog.sh &

set -euo pipefail
cd /Users/kirilldubovitskiy/projects/happy/.dev/worktree/happy-sync-refactor

LOGFILE="loop/logs/watchdog.log"
mkdir -p loop/logs

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOGFILE"
}

log "Watchdog started (PID $$)"

while true; do
    # Check if loop/run.sh is running (exclude grep itself and this script)
    if ! pgrep -f "bash loop/run.sh" > /dev/null 2>&1; then
        log "loop/run.sh is NOT running — restarting"

        # Kill any orphaned claude/codex processes from the loop (temp dir markers)
        for pid in $(pgrep -f "happy-e2e-" 2>/dev/null || true); do
            log "  Killing orphaned test process $pid"
            kill "$pid" 2>/dev/null || true
        done

        # Restart the loop in background
        nohup bash loop/run.sh >> loop/logs/loop-stdout.log 2>&1 &
        LOOP_PID=$!
        log "Restarted loop/run.sh as PID $LOOP_PID"
    else
        LOOP_PID=$(pgrep -f "bash loop/run.sh" | head -1)
        log "loop/run.sh alive (PID $LOOP_PID)"
    fi

    sleep 120
done
