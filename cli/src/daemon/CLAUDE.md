# Happy CLI Daemon: Control Flow and Lifecycle

The daemon is a persistent background process that manages Happy sessions, enables remote control from the mobile app, and handles auto-updates when the CLI version changes.

## 1. Daemon Lifecycle

### Starting the Daemon

Command: `happy daemon start`

Control Flow:
1. `src/index.ts` receives `daemon start` command
2. Spawns detached process via `spawnHappyCLI(['daemon', 'start-sync'], { detached: true })`
3. New process calls `startDaemon()` from `src/daemon/run.ts`
4. `startDaemon()` performs startup:
   - Sets up shutdown promise and handlers (SIGINT, SIGTERM, uncaughtException, unhandledRejection)
   - Version check: `isDaemonRunningSameVersion()` reads daemon.state.json, compares `startedWithCliVersion` with `configuration.currentCliVersion`
   - If version mismatch: calls `stopDaemon()` to kill old daemon before proceeding
   - If same version running: exits with "Daemon already running"
   - Lock acquisition: `acquireDaemonLock()` creates exclusive lock file to prevent multiple daemons
   - Authentication: `authAndSetupMachineIfNeeded()` ensures credentials exist
   - State persistence: writes PID, version, HTTP port to daemon.state.json
   - HTTP server: starts on random port for local CLI control (list, stop, spawn)
   - WebSocket: establishes persistent connection to backend via `ApiMachineClient`
   - RPC registration: exposes `spawn-happy-session`, `stop-session`, `requestShutdown` handlers
   - Heartbeat loop: every 60s (or HAPPY_DAEMON_HEARTBEAT_INTERVAL) checks for version updates and prunes dead sessions
5. Awaits shutdown promise which resolves when:
   - OS signal received (SIGINT/SIGTERM)
   - HTTP `/stop` endpoint called
   - RPC `requestShutdown` invoked
   - Uncaught exception occurs
6. On shutdown, `cleanupAndShutdown()` performs:
   - Clears heartbeat interval
   - Updates daemon state to "shutting-down" on backend
   - Disconnects WebSocket
   - Stops HTTP server
   - Deletes daemon.state.json
   - Releases lock file
   - Exits process

### Version Mismatch Auto-Update

The daemon detects when `npm upgrade happy-coder` occurs:
1. Heartbeat reads package.json from disk
2. Compares `JSON.parse(package.json).version` with compiled `configuration.currentCliVersion`
3. If mismatch detected:
   - Spawns new daemon via `spawnHappyCLI(['daemon', 'start'])`
   - Hangs and waits to be killed
4. New daemon starts, sees old daemon.state.json version != its compiled version
5. New daemon calls `stopDaemon()` which tries HTTP `/stop`, falls back to SIGKILL
6. New daemon takes over

### Stopping the Daemon

Command: `happy daemon stop`

Control Flow:
1. `stopDaemon()` in `controlClient.ts` reads daemon.state.json
2. Attempts graceful shutdown via HTTP POST to `/stop`
3. Daemon receives request, calls `cleanupAndShutdown()`:
   - Updates backend status to "shutting-down"
   - Closes WebSocket connection
   - Stops HTTP server
   - Deletes daemon.state.json
   - Releases lock file
4. If HTTP fails, falls back to `process.kill(pid, 'SIGKILL')`

## 2. Session Management

### Daemon-Spawned Sessions (Remote)

Initiated by mobile app via backend RPC:
1. Backend forwards RPC `spawn-happy-session` to daemon via WebSocket
2. `ApiMachineClient` invokes `spawnSession()` handler
3. `spawnSession()`:
   - Creates directory if needed
   - Spawns detached Happy process with `--happy-starting-mode remote --started-by daemon`
   - Adds to `pidToTrackedSession` map
   - Sets up 10-second awaiter for session webhook
4. New Happy process:
   - Creates session with backend, receives `happySessionId`
   - Calls `notifyDaemonSessionStarted()` to POST to daemon's `/session-started`
5. Daemon updates tracking with `happySessionId`, resolves awaiter
6. RPC returns session info to mobile app

### Terminal-Spawned Sessions

User runs `happy` directly:
1. CLI auto-starts daemon if configured
2. Happy process calls `notifyDaemonSessionStarted()` 
3. Daemon receives webhook, creates `TrackedSession` with `startedBy: 'happy directly...'`
4. Session tracked for health monitoring

### Session Termination

Via RPC `stop-session` or health check:
1. `stopSession()` finds session by `happySessionId`
2. Sends SIGTERM to process
3. `on('exit')` handler removes from tracking map

## 3. HTTP Control Server

Local HTTP server (127.0.0.1 only) provides:
- `/session-started` - webhook for sessions to report themselves
- `/list` - returns tracked sessions
- `/stop-session` - terminates specific session
- `/spawn-session` - creates new session (used by integration tests)
- `/stop` - graceful daemon shutdown

## 4. Process Discovery and Cleanup

### Doctor Command

`happy doctor` uses `ps aux | grep` to find all Happy processes:
- Production: matches `happy.mjs`, `happy-coder`, `dist/index.mjs`
- Development: matches `tsx.*src/index.ts`
- Categorizes by command args: daemon, daemon-spawned, user-session, doctor

### Clean Runaway Processes

`happy doctor clean`:
1. `findRunawayHappyProcesses()` filters for likely orphans
2. `killRunawayHappyProcesses()`:
   - Sends SIGTERM
   - Waits 1 second
   - Sends SIGKILL if still alive

## 5. State Persistence

### daemon.state.json
```json
{
  "pid": 12345,
  "httpPort": 50097,
  "startTime": "8/24/2025, 6:46:22 PM",
  "startedWithCliVersion": "0.9.0-6",
  "lastHeartbeat": "8/24/2025, 6:47:22 PM",
  "daemonLogPath": "/path/to/daemon.log"
}
```

### Lock File
- Created with O_EXCL flag for atomic acquisition
- Contains PID for debugging
- Prevents multiple daemon instances
- Cleaned up on graceful shutdown

## 6. WebSocket Communication

`ApiMachineClient` handles bidirectional communication:
- Daemon to Server: machine-alive, machine-update-metadata, machine-update-state
- Server to Daemon: rpc-request (spawn-happy-session, stop-session, requestShutdown)
- All data encrypted with TweetNaCl

## 7. Integration Testing Challenges

Version mismatch test simulates npm upgrade:
- Test modifies package.json, rebuilds with new version
- Daemon's compiled version != package.json on disk
- Critical timing: heartbeat interval must exceed rebuild time
- pkgroll doesn't update compiled imports, must use full yarn build

# Improvements

I do not like how

- daemon.state.json file is getting hard removed when daemon exits or is stopped. We should keep it around and have 'state' field and 'stateReason' field that will explain why the daemon is in that state
- If the file is not found - we assume the daemon was never started or was cleaned out by the user or doctor
- If the file is found and corrupted - we should try to upgrade it to the latest version? or simply remove it if we have write access

- posts helpers for daemon do not return typed results
- I don't like that daemonPost returns either response from daemon or { error: ... }. We should have consistent envelope type

- we loose track of children processes when daemon exits / restarts - we should write them to the same state file? At least the pids should be there for doctor & cleanup

- caffeinate process is not tracked in state at all & might become runaway
- caffeinate is also started by individual sesions - we should not do that for simpler cleanup 

- the port is not protected - lets encrypt something with a public portion of the secret key & send it as a signature along the rest of the unencrypted payload to the daemon - will make testing harder :/