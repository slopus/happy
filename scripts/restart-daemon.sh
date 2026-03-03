#!/bin/bash
# Restart Happy daemon and recover active sessions
# Runs daily at 4:05 AM IST via cron
#
# Flow:
# 1. Stop daemon gracefully
# 2. Kill any remaining orphan Claude processes
# 3. Start daemon (which auto-recovers sessions via cleanupGhostSessions)
# 4. Wait and verify sessions were recovered

LOG="/opt/llmchat/logs/daemon-restart.log"
mkdir -p /opt/llmchat/logs

echo "$(date '+%Y-%m-%d %H:%M:%S') Starting daemon restart..." >> "$LOG"

# Stop daemon gracefully
/usr/local/bin/happy daemon stop >> "$LOG" 2>&1
sleep 2

# Kill any remaining orphan session processes
/usr/local/bin/happy doctor clean >> "$LOG" 2>&1
sleep 2

# Start daemon (will auto-recover sessions via cleanupGhostSessions)
cd /opt/llmchat && HAPPY_SERVER_URL=https://app.304.systems /usr/local/bin/happy daemon start >> "$LOG" 2>&1

# Wait for session recovery to complete (cleanupGhostSessions runs async on startup)
sleep 10

# Log recovered sessions
echo "$(date '+%Y-%m-%d %H:%M:%S') Active sessions after restart:" >> "$LOG"
/usr/local/bin/happy daemon list >> "$LOG" 2>&1

echo "$(date '+%Y-%m-%d %H:%M:%S') Daemon restart complete" >> "$LOG"
