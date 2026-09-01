/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { logger } from '@/ui/logger';
import { clearDaemonState, readDaemonState, type DaemonLockHandle, type DaemonLocallyPersistedState } from '@/persistence';
import { Metadata } from '@/api/types';
import { configuration } from '@/configuration';

async function daemonPost(
  path: string,
  body?: any,
  targetState?: DaemonLocallyPersistedState,
): Promise<{ error?: string } | any> {
  const state = targetState ?? await readDaemonState();
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

export async function stopDaemonHttp(state: DaemonLocallyPersistedState): Promise<void> {
  const result = await daemonPost(
    '/stop',
    state.ownerToken ? { expectedOwnerToken: state.ownerToken } : {},
    state,
  );
  if (result?.error) {
    throw new Error(result.error);
  }
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
export async function readRunningDaemonStateAndCleanupStaleState(): Promise<DaemonLocallyPersistedState | null> {
  const state = await readDaemonState();
  if (!state) {
    return null;
  }

  // Check if the PID is alive
  try {
    process.kill(state.pid, 0);
  } catch (probeError: any) {
    if (probeError?.code === 'ESRCH') {
      logger.debug('[DAEMON RUN] Daemon PID not running, cleaning up state');
      await cleanupDaemonState(state);
      return null;
    }
    logger.debug('[DAEMON RUN] Daemon PID could not be probed; preserving ownership state', probeError);
    return state;
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
        return state;
      }
      logger.debug(`[DAEMON RUN] PID ${state.pid} responded with HTTP ${response.status} on port ${state.httpPort}; preserving ownership after an inconclusive health check`);
      return state;
    } catch (error) {
      logger.debug(`[DAEMON RUN] PID ${state.pid} is alive but HTTP health check failed on port ${state.httpPort}; preserving ownership after an inconclusive health check`, error);
      return state;
    }
  }

  return state;
}

export async function checkIfDaemonRunningAndCleanupStaleState(): Promise<boolean> {
  return (await readRunningDaemonStateAndCleanupStaleState()) !== null;
}

/**
 * Check if the running daemon version matches the current CLI version.
 * This should work from both the daemon itself & a new CLI process.
 * Works via the daemon.state.json file.
 * 
 * @returns true if versions match, false if versions differ or no daemon running
 */
export async function isDaemonRunningCurrentlyInstalledHappyVersion(): Promise<boolean> {
  logger.debug('[DAEMON CONTROL] Checking if daemon is running same version');
  const state = await readRunningDaemonStateAndCleanupStaleState();
  if (!state) {
    logger.debug('[DAEMON CONTROL] No daemon running, returning false');
    return false;
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
  const currentCliVersion = configuration.currentCliVersion;
  logger.debug(`[DAEMON CONTROL] Current CLI version: ${currentCliVersion}, Daemon started with version: ${state.startedWithCliVersion}`);
  return currentCliVersion === state.startedWithCliVersion;
}

export async function cleanupDaemonState(expectedOwner: DaemonLockHandle | DaemonLocallyPersistedState): Promise<void> {
  try {
    await clearDaemonState(expectedOwner);
    logger.debug(`[DAEMON RUN] Daemon state cleanup completed for PID ${expectedOwner.pid}`);
  } catch (error) {
    logger.debug('[DAEMON RUN] Error cleaning up daemon metadata', error);
  }
}

export async function stopDaemon(expectedState?: DaemonLocallyPersistedState) {
  try {
    const state = expectedState ?? await readRunningDaemonStateAndCleanupStaleState();
    if (!state) {
      logger.debug('Daemon identity could not be verified; refusing to stop an unrelated process');
      return;
    }
    if (!state.ownerToken) {
      const stableBefore = await readDaemonState();
      if (!sameLegacyDaemonSnapshot(state, stableBefore)) {
        logger.warn('Legacy daemon ownership changed before identity verification; refusing automatic stop.');
        return;
      }
      const evidence = await daemonPost('/list', {}, state);
      if (!isLegacyDaemonListEvidence(evidence)) {
        logger.warn('Legacy daemon did not provide positive HTTP identity evidence; refusing automatic stop.');
        return;
      }
      const stableAfter = await readDaemonState();
      if (!sameLegacyDaemonSnapshot(state, stableAfter)) {
        logger.warn('Legacy daemon ownership changed during identity verification; refusing automatic stop.');
        return;
      }
    }

    logger.debug(`Stopping daemon with PID ${state.pid}`);

    // Try HTTP graceful stop
    try {
      await stopDaemonHttp(state);

      // Wait for daemon to die
      await waitForProcessDeath(state.pid, 2000);
      logger.debug('Daemon stopped gracefully via HTTP');
      return;
    } catch (error) {
      // A PID plus failed HTTP identity is not enough evidence to send a kill
      // signal on Windows, where PIDs are routinely reused after reboot.
      logger.debug('HTTP stop failed; refusing to force kill an unverified PID', error);
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
    } catch (error: any) {
      if (error?.code === 'ESRCH') {
        return; // Process is affirmatively dead
      }
      throw error;
    }
  }
  throw new Error('Process did not die within timeout');
}

function isLegacyDaemonListEvidence(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !Array.isArray((value as any).children)) {
    return false;
  }
  return (value as any).children.every((child: unknown) => {
    if (!child || typeof child !== 'object') return false;
    const candidate = child as Record<string, unknown>;
    return typeof candidate.startedBy === 'string'
      && typeof candidate.happySessionId === 'string'
      && Number.isSafeInteger(candidate.pid)
      && (candidate.pid as number) > 0;
  });
}

function sameLegacyDaemonSnapshot(
  expected: DaemonLocallyPersistedState,
  observed: DaemonLocallyPersistedState | null,
): boolean {
  return observed !== null
    && !observed.ownerToken
    && observed.pid === expected.pid
    && observed.httpPort === expected.httpPort
    && observed.startTime === expected.startTime
    && observed.startedWithCliVersion === expected.startedWithCliVersion;
}
