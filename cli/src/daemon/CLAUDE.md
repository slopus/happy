# Happy CLI Daemon: Control Flow and Lifecycle

This document details the inner workings of the Happy CLI daemon, its lifecycle, how it manages sessions, and how it interacts with other parts of the CLI like the `doctor` command.

## 1. Daemon Lifecycle Management

The daemon is designed to run as a single, persistent background process. Its lifecycle is managed through a combination of detached processes, state files, and self-healing mechanisms.

### a. Starting the Daemon

The process is initiated by the user but quickly hands off to a background process.

**Command:** `happy daemon start`

**Control Flow:**
1.  **`src/index.ts`**: The main CLI entrypoint receives the `daemon start` command.
2.  **`spawnHappyCLI`**: It calls `spawnHappyCLI(['daemon', 'start-sync'], { detached: true, stdio: 'ignore' })`.
    -   `spawnHappyCLI` is a utility that reliably spawns the Happy CLI entrypoint (`dist/index.mjs`) with the correct Node.js flags (`--no-warnings`, `--no-deprecation`) in a cross-platform way.
    -   `detached: true` ensures the daemon process continues to run even after the parent terminal session closes.
    -   The actual work is handed off to the `daemon start-sync` command.
3.  **`src/index.ts` (in new process)**: The new detached process starts and immediately calls `startDaemon()` from `src/daemon/run.ts`.
4.  **`startDaemon()` in `src/daemon/run.ts`**: This is the core of the daemon.
    -   **Version & Stale Check**: It first calls `isDaemonRunningSameVersion()`. This function checks if a `daemon.state.json` file exists and if the process PID within it is still running.
        -   If a daemon is running but its version (stored in the state file) doesn't match the current CLI's `package.json` version, it calls `stopDaemon()` to kill the old one before proceeding. This is the **auto-update mechanism**.
        -   If a daemon is already running with the *same* version, the new process prints "Daemon already running" and exits.
    -   **Authentication**: It ensures credentials exist by calling `authAndSetupMachineIfNeeded()`.
    -   **State File**: It writes its process ID, the current CLI version, and the HTTP port to `~/.happy/daemon.state.json` via `writeDaemonState()`. This file acts as the lock and state record.
    -   **HTTP Control Server**: It starts an HTTP server (`controlServer.ts`) on a random available port to listen for commands from the local CLI (e.g., `stop`, `list`).
    -   **Backend Connection**: It establishes a persistent WebSocket connection to the Happy backend using `ApiMachineClient`. This client registers RPC handlers (`spawn-happy-session`, `stop-session`, `requestShutdown`) that the backend can invoke.
    -   **Heartbeat & Self-Healing**: It starts a `setInterval` loop (every 60 seconds) to:
        -   Prune stale sessions from its internal tracking map by checking if the PIDs are still active.
        -   Check for version mismatches using `isDaemonRunningSameVersion()`. If it detects it's now outdated (because the user installed a new `happy-coder` version), it triggers a restart by spawning a *new* daemon and then hanging, waiting to be killed by the new daemon's startup check.

### b. Stopping the Daemon

**Command:** `happy daemon stop`

**Control Flow:**
1.  **`src/index.ts`**: Receives the `daemon stop` command.
2.  **`stopDaemon()` in `controlClient.ts`**:
    -   Reads `daemon.state.json` to get the daemon's PID and HTTP port.
    -   **Graceful Shutdown**: It first attempts a graceful shutdown by sending a POST request to the daemon's `/stop` HTTP endpoint.
    -   **Daemon-side `cleanupAndShutdown()`**: The daemon's control server receives the request and calls its `cleanupAndShutdown` function. This function updates its status on the backend to "shutting-down", closes the WebSocket connection, stops the HTTP server, and deletes the `daemon.state.json` file before exiting.
    -   **Forced Shutdown**: If the HTTP request fails (e.g., the daemon is hung), `stopDaemon` will fall back to using `process.kill(pid, 'SIGKILL')` to ensure the process is terminated.

### c. Daemon Status

**Command:** `happy daemon status`

**Control Flow:**
1.  **`src/index.ts`**: Receives the `daemon status` command.
2.  It calls `getDaemonState()` to read `daemon.state.json`.
3.  It then calls `checkIfDaemonRunningAndCleanupStaleState()` which uses `process.kill(pid, 0)` to verify the process is actually running. If not, it cleans up the stale state file.
4.  It prints the status, PID, start time, and version from the state file.

## 2. Session Lifecycle Management

The daemon is responsible for tracking all `happy` processes, whether it spawned them or not.

### a. Daemon-Spawned Sessions (Remote Start)

This flow is initiated by an external actor, like the mobile app.

**Control Flow:**
1.  **RPC Call**: The mobile app sends a request to the Happy backend, which forwards it as an RPC call (`<machine-id>:spawn-happy-session`) over the WebSocket to the correct daemon.
2.  **`ApiMachineClient`**: The daemon's `apiMachine` client receives the RPC call and invokes the `spawnSession` handler in `src/daemon/run.ts`.
3.  **`spawnSession()`**:
    -   It uses `spawnHappyCLI` to run a new, detached `happy` process with the flags `--happy-starting-mode remote` and `--started-by daemon`.
    -   It immediately adds the new process to its internal `pidToTrackedSession` map, but the `happySessionId` is still unknown.
    -   It sets up an "awaiter" and a 10-second timeout, waiting for the new session to report back.
4.  **New `happy` Process (`start.ts`)**:
    -   The newly spawned `happy` process starts up.
    -   It creates its own session with the Happy backend via a REST call, receiving a `happySessionId`.
    -   It immediately calls `notifyDaemonSessionStarted()`, which sends a POST request to the daemon's local HTTP `/session-started` endpoint, reporting its PID and new `happySessionId`.
5.  **Daemon `controlServer.ts`**:
    -   The daemon's HTTP server receives the webhook.
    -   It calls the `onHappySessionWebhook` callback in `run.ts`.
    -   This callback updates the `TrackedSession` entry in the `pidToTrackedSession` map with the `happySessionId`.
    -   It resolves the "awaiter" from step 3.
6.  **RPC Response**: The original `spawnSession` function now has the `happySessionId` and returns it. The `ApiMachineClient` sends this back to the backend, which relays it to the mobile app.

### b. User-Spawned Sessions (Terminal Start)

This happens when a user just runs `happy` from their terminal.

**Control Flow:**
1.  **`happy` command**: The user runs `happy`.
2.  **Auto-start Daemon**: If the user has opted-in, `src/index.ts` first ensures the daemon is running and up-to-date.
3.  **`start.ts`**: The main `happy` process starts.
4.  **`notifyDaemonSessionStarted()`**: It calls this function from `controlClient.ts`, which sends a POST to the daemon's `/session-started` endpoint.
5.  **Daemon `controlServer.ts`**: The daemon receives the webhook and calls `onHappySessionWebhook`. Since this PID is not one the daemon spawned, it creates a new `TrackedSession` entry for it, marking it as `startedBy: 'happy directly...'`.

### c. Session Termination

**Control Flow:**
1.  **Termination Signal**: A session can be stopped via an RPC call (`stop-session`) or by the daemon's self-healing loop if the process dies.
2.  **`stopSession()` in `run.ts`**:
    -   Finds the session in its tracking map by `happySessionId`.
    -   Uses `process.kill(pid, 'SIGTERM')` to terminate the session process.
3.  **Process Exit Handler**: The `on('exit')` handler for the child process (set up in `spawnSession`) fires, which removes the session from the `pidToTrackedSession` map. This prevents orphaned entries.

## 3. Doctor Interaction

The `doctor` command provides tools to inspect and clean up the system, which is crucial for handling orphaned processes.

**Command:** `happy doctor` and `happy doctor kill-all`

**Control Flow:**
1.  **`findAllHappyProcesses()` in `doctor.ts`**:
    -   This function is the core of the doctor's diagnostic capabilities.
    -   It uses `ps aux | grep ...` to find **all** running processes that look like a `happy` CLI process, whether for production (`happy.mjs`) or development (`tsx src/index.ts`).
    -   It then categorizes each found process based on its command-line arguments (e.g., `daemon`, `doctor`, `--started-by daemon`).
2.  **`findRunawayHappyProcesses()`**: This is a filtered version of the above. It specifically looks for processes that are likely orphans: daemons and any session that was started by a daemon (`--started-by daemon`). The assumption is that if a user wants to kill things, these are the primary targets.
3.  **`killRunawayHappyProcesses()`**:
    -   Called by `happy doctor kill-all`.
    -   It gets the list from `findRunawayHappyProcesses`.
    -   It iterates through the PIDs, first sending a graceful `SIGTERM`, waiting a moment, and then sending `SIGKILL` if the process is still alive. This ensures even hung processes are terminated.


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

