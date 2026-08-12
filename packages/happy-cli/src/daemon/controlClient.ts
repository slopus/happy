/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { logger } from '@/ui/logger';
import { clearDaemonState, readDaemonState } from '@/persistence';
import { Metadata } from '@/api/types';
import { configuration } from '@/configuration';

function hasErrorCode(error: unknown, expectedCode: string, seen = new Set<object>()): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  if (seen.has(error)) return false;
  seen.add(error);

  const candidate = error as {
    code?: unknown;
    cause?: unknown;
    errors?: unknown[];
  };
  if (candidate.code === expectedCode) {
    return true;
  }
  if (hasErrorCode(candidate.cause, expectedCode, seen)) {
    return true;
  }
  return candidate.errors?.some(nestedError => hasErrorCode(nestedError, expectedCode, seen)) ?? false;
}

async function daemonPost(path: string, body?: any): Promise<{ error?: string } | any> {
  const state = await readDaemonState();
  if (!state?.httpPort) {
    const errorMessage = 'No daemon running, no state file found';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    };
  }

  try {
    process.kill(state.pid, 0);
  } catch (error) {
    const errorMessage = 'Daemon is not running, file is stale';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    };
  }

  try {
    const timeout = process.env.HAPPY_DAEMON_HTTP_TIMEOUT ? parseInt(process.env.HAPPY_DAEMON_HTTP_TIMEOUT) : 10_000;
    const response = await fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      // Mostly increased for stress test
      signal: AbortSignal.timeout(timeout)
    });
    
    if (!response.ok) {
      const errorMessage = `Request failed: ${path}, HTTP ${response.status}`;
      logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
      return {
        error: errorMessage
      };
    }
    
    return await response.json();
  } catch (error) {
    const errorMessage = `Request failed: ${path}, ${error instanceof Error ? error.message : 'Unknown error'}`;
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    }
  }
}

const SESSION_STARTED_RETRY_TIMEOUT_MS = 3000;
const SESSION_STARTED_RETRY_INTERVAL_MS = 100;

export async function notifyDaemonSessionStarted(
  sessionId: string,
  metadata: Metadata,
  encryption?: {
    encryptionKey: string;
    encryptionVariant: 'legacy' | 'dataKey';
    seq: number;
    metadataVersion: number;
    agentStateVersion: number;
  }
): Promise<{ error?: string } | any> {
  // Retry briefly — ensureDaemonRunning already waits for readiness, but we may
  // race a daemon that is mid-restart (version upgrade, crash recovery). Without
  // this, the session's encryption data never reaches the daemon and the mobile
  // app's resume-happy-session RPC fails with "not tracked by this daemon".
  const payload = { sessionId, metadata, encryption };
  const deadline = Date.now() + SESSION_STARTED_RETRY_TIMEOUT_MS;
  let result: { error?: string } | any;

  while (true) {
    result = await daemonPost('/session-started', payload);
    if (!result?.error) {
      return result;
    }
    if (Date.now() >= deadline) {
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, SESSION_STARTED_RETRY_INTERVAL_MS));
  }
}

export async function listDaemonSessions(): Promise<any[]> {
  const result = await daemonPost('/list');
  return result.children || [];
}

export async function stopDaemonSession(sessionId: string): Promise<boolean> {
  const result = await daemonPost('/stop-session', { sessionId });
  return result.success || false;
}

export async function spawnDaemonSession(directory: string, sessionId?: string): Promise<any> {
  const result = await daemonPost('/spawn-session', { directory, sessionId });
  return result;
}

type DaemonStopResponse = {
  status: 'stopping';
  /** Added by newer daemons so a force-kill can be tied to this process. */
  pid?: number;
};

export async function stopDaemonHttp(): Promise<DaemonStopResponse> {
  const result = await daemonPost('/stop');
  if (result?.error) {
    throw new Error(result.error);
  }
  if (!result || result.status !== 'stopping') {
    throw new Error('Daemon stop endpoint returned an invalid identity response');
  }
  if (
    result.pid !== undefined
    && (!Number.isSafeInteger(result.pid) || result.pid <= 0)
  ) {
    throw new Error('Daemon stop endpoint returned an invalid PID');
  }
  return result as DaemonStopResponse;
}

/**
 * The version check is still quite naive.
 * For instance we are not handling the case where we upgraded happy,
 * the daemon is still running, and it recieves a new message to spawn a new session.
 * This is a tough case - we need to somehow figure out to restart ourselves,
 * yet still handle the original request.
 * 
 * Options:
 * 1. Periodically check during the health checks whether our version is the same as CLIs version. If not - restart.
 * 2. Wait for a command from the machine session, or any other signal to
 * check for version & restart.
 *   a. Handle the request first
 *   b. Let the request fail, restart and rely on the client retrying the request
 * 
 * I like option 1 a little better.
 * Maybe we can ... wait for it ... have another daemon to make sure 
 * our daemon is always alive and running the latest version.
 * 
 * That seems like an overkill and yet another process to manage - lets not do this :D
 * 
 * TODO: This function should return a state object with
 * clear state - if it is running / or errored out or something else.
 * Not just a boolean.
 * 
 * We can destructure the response on the caller for richer output.
 * For instance when running `happy daemon status` we can show more information.
 */
type DaemonHealth = 'running' | 'absent' | 'indeterminate';

async function inspectDaemonHealth(): Promise<DaemonHealth> {
  const state = await readDaemonState();
  if (!state) {
    return 'absent';
  }

  // Check if the PID is alive
  try {
    process.kill(state.pid, 0);
  } catch {
    logger.debug('[DAEMON RUN] Daemon PID not running, cleaning up state');
    const cleaned = await cleanupDaemonState(state.pid);
    if (!cleaned) {
      logger.debug('[DAEMON RUN] Stale daemon state no longer owns the daemon lock; preserving it for the current owner');
    }
    // The PID was proven dead. Startup may safely continue without ever calling
    // stopDaemon/SIGKILL; the exclusive lock still prevents replacing a newer
    // owner if one appeared during cleanup.
    return 'absent';
  }

  // PID is alive, but on Windows PIDs get reused after reboot.
  // Verify it's actually our daemon by HTTP pinging its control server.
  if (state.httpPort) {
    try {
      const response = await fetch(`http://127.0.0.1:${state.httpPort}/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(2000)
      });
      if (response.ok) {
        return 'running';
      }
      return 'indeterminate';
    } catch (error) {
      // ECONNREFUSED is strong evidence that the live PID was reused and no
      // daemon owns the recorded port. A timeout or other transport failure is
      // not: the daemon may simply be busy. Preserve its state and lock so a
      // child process cannot start a replacement daemon (#1654).
      if (hasErrorCode(error, 'ECONNREFUSED')) {
        logger.debug(`[DAEMON RUN] PID ${state.pid} is alive but no daemon is listening on port ${state.httpPort}, cleaning up stale state`);
        const cleaned = await cleanupDaemonState(state.pid);
        if (!cleaned) {
          // A mismatched/missing lock means the state cannot be safely claimed
          // as stale. In particular, do not fall through to stopDaemon(), which
          // could SIGKILL an unrelated process after PID reuse.
          logger.debug('[DAEMON RUN] Daemon ownership changed during cleanup; refusing unsafe replacement');
        }
        return cleaned ? 'absent' : 'indeterminate';
      }

      logger.debug(`[DAEMON RUN] PID ${state.pid} is alive but its HTTP health check was inconclusive on port ${state.httpPort}; preserving daemon state`);
      return 'indeterminate';
    }
  }

  return 'running';
}

export async function checkIfDaemonRunningAndCleanupStaleState(): Promise<boolean> {
  return (await inspectDaemonHealth()) !== 'absent';
}

export type DaemonStartupState = 'absent' | 'matching' | 'mismatch' | 'indeterminate';

export async function getDaemonStartupState(): Promise<DaemonStartupState> {
  const health = await inspectDaemonHealth();
  if (health !== 'running') return health;

  const state = await readDaemonState();
  if (!state) return 'absent';
  return configuration.currentCliVersion === state.startedWithCliVersion
    ? 'matching'
    : 'mismatch';
}

/**
 * Check if the running daemon version matches the current CLI version.
 * This should work from both the daemon itself & a new CLI process.
 * Works via the daemon.state.json file.
 * 
 * @returns true when the current daemon is safe to keep (matching or
 * indeterminate), false when it is absent or a verified version mismatch.
 */
export async function isDaemonRunningCurrentlyInstalledHappyVersion(): Promise<boolean> {
  logger.debug('[DAEMON CONTROL] Checking if daemon is running same version');
  const startupState = await getDaemonStartupState();
  if (startupState === 'absent') {
    logger.debug('[DAEMON CONTROL] No daemon running, returning false');
    return false;
  }

  if (startupState === 'indeterminate') {
    // A slow/unverified process must not enter the version-mismatch restart
    // path: stopDaemon's fallback is SIGKILL, which is unsafe after PID reuse.
    logger.debug('[DAEMON CONTROL] Daemon health is indeterminate; refusing automatic replacement');
    return true;
  }
  
  // Compare the running daemon's recorded version against THIS CLI invocation's
  // bundled version. Both are read from the same source of truth: the `version`
  // field baked into `dist/` at build time via `import packageJson from '../package.json'`.
  //
  // Previously we read `package.json` fresh from disk on every check, but that
  // produced infinite restart loops (#1107) when `package.json.version` diverged
  // from the bundled version — e.g. when `happy-coder@0.13.1` was published as
  // a deprecation stub that bumped the manifest without rebuilding `dist/`.
  // The daemon would write its bundled version (0.13.0), read 0.13.1 from disk,
  // detect a mismatch, self-restart, and the new daemon would repeat the cycle.
  //
  // Using `configuration.currentCliVersion` instead guarantees the writer and
  // reader agree whenever they're executing the same `dist/` bundle, and still
  // correctly detects real npm upgrades (the new bundle has a new baked version).
  return startupState === 'matching';
}

export async function cleanupDaemonState(expectedPid?: number): Promise<boolean> {
  try {
    const cleaned = await clearDaemonState(expectedPid);
    logger.debug(cleaned
      ? '[DAEMON RUN] Daemon state file removed'
      : '[DAEMON RUN] Daemon state file was not removed because ownership changed');
    return cleaned;
  } catch (error) {
    logger.debug('[DAEMON RUN] Error cleaning up daemon metadata', error);
    return false;
  }
}

export async function stopDaemon(options: { allowForceKill?: boolean } = {}) {
  try {
    const state = await readDaemonState();
    if (!state) {
      logger.debug('No daemon state found');
      return;
    }

    logger.debug(`Stopping daemon with PID ${state.pid}`);

    let stopWasVerified = false;

    // Try HTTP graceful stop. A successful response must identify the exact
    // process named by the state file before a later SIGKILL is ever allowed.
    try {
      const response = await stopDaemonHttp();
      stopWasVerified = response.pid === state.pid;
      if (response.pid !== undefined && !stopWasVerified) {
        logger.debug(`Daemon stop endpoint belongs to PID ${response.pid}, expected ${state.pid}`);
      }

      // Wait for daemon to die
      // Daemon shutdown first gives every owned agent tree time to flush and
      // terminate. Keep this longer than that bounded cleanup window so the
      // verified daemon is not SIGKILLed halfway through reaping its children.
      await waitForProcessDeath(state.pid, 25_000);
      logger.debug('Daemon stopped gracefully via HTTP');
      return;
    } catch (error) {
      logger.debug(options.allowForceKill === false
        ? 'HTTP stop failed during automatic replacement'
        : 'Graceful stop did not complete; force-kill requires a verified daemon identity', error);
    }

    if (options.allowForceKill === false) {
      logger.debug('Automatic daemon replacement will not force-kill an unverified PID');
      return;
    }

    if (!stopWasVerified) {
      logger.debug('Daemon identity was not confirmed by its control endpoint; refusing to force-kill PID');
      return;
    }

    // Force kill
    try {
      process.kill(state.pid, 'SIGKILL');
      logger.debug('Force killed daemon');
    } catch (error) {
      logger.debug('Daemon already dead');
    }
  } catch (error) {
    logger.debug('Error stopping daemon', error);
  }
}

async function waitForProcessDeath(pid: number, timeout: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      process.kill(pid, 0);
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch {
      return; // Process is dead
    }
  }
  throw new Error('Process did not die within timeout');
}
