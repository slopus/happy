# Daemon Architecture

## Core Purpose
HTTP server (64875) that manages Claude sessions and communicates with Happy Server.

## Key Components

### 1. DaemonHappyServerSession (`serverSession.ts`)
- WebSocket connection to Happy Server on `/v1/updates` path
- Registers machine with server on connect
- Implements RPC handler: `{machineId}:spawn-happy-session`
- Sends `machine-alive` heartbeat every 20 seconds
- Auth: Bearer token in socket.io auth field

### 2. DaemonHttpServer (`httpServer.ts`)
- Listens on localhost:64875
- Routes:
  - `POST /sessions` - Create new Claude session
  - `GET /sessions` - List active sessions
  - `DELETE /sessions/:id` - Stop session
  - `GET /health` - Health check
- Calls `sessionManager` to spawn actual processes

### 3. TrackedSessionManager (`trackedSessionManager.ts`)
- Manages Claude process lifecycle
- Spawns `claude` with flags: `--print --output-format stream-json --verbose`
- Monitors stdout/stderr via file watchers
- Maintains session state in memory
- Handles process cleanup on exit

### 4. Run Loop (`run.ts`)
- Entry point from CLI
- Creates daemon metadata file with PID/port
- Establishes server connection if credentials exist
- Starts HTTP server
- Graceful shutdown handling

## Control Flow

### Session Creation
1. Mobile/CLI → POST /sessions → Daemon HTTP server
2. Daemon spawns `claude` process with working directory
3. Daemon starts watching output files
4. Returns session ID to caller

### Remote Session Spawn (via RPC)
1. Server → WebSocket RPC `spawn-happy-session` → Daemon
2. Daemon spawns Claude in specified directory
3. Returns success/failure via RPC callback

### Machine Registration
1. On connect: Daemon → `machine-register` event → Server
2. Server updates machine in database
3. Mobile clients receive machine status updates

## Key Files
- `~/.happy-dev/daemon-metadata.json` - PID, port, start time
- `~/.happy-dev/logs/*-daemon.log` - Daemon logs
- `~/.happy-dev/settings.json` - Machine ID, host
- `~/.happy-dev/access.key` - Auth credentials

## Environment Variables
- `HAPPY_SERVER_URL` - Server URL (default: production)
- `HAPPY_HOME_DIR` - Home directory (default: ~/.happy-dev for local)

## Running Commands

### Start daemon (detached):
```bash
yarn dev:local-server daemon start
# OR
HAPPY_HOME_DIR=~/.happy-dev ./bin/happy.mjs daemon start
```

### Start daemon (synchronous - for debugging):
```bash
yarn dev:local-server daemon start-sync
# OR  
HAPPY_HOME_DIR=~/.happy-dev ./bin/happy.mjs daemon start-sync
```

### Stop daemon:
```bash
yarn dev:local-server daemon stop
# OR
HAPPY_HOME_DIR=~/.happy-dev ./bin/happy.mjs daemon stop
```

## Debugging

### Check running daemons:
```bash
ps aux | grep "happy.mjs daemon" | grep -v grep
```

### Read daemon logs:
```bash
# Latest daemon log
ls -lt ~/.happy-dev/logs/*daemon.log | head -1 | xargs cat

# All recent logs
ls -lt ~/.happy-dev/logs/*.log | head -5
```

### Check daemon state:
```bash
cat ~/.happy-dev/daemon.state.json | jq .
```