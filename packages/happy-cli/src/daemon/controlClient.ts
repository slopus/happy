/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { logger } from '@/ui/logger';
import { clearDaemonState, readDaemonState, type DaemonLocallyPersistedState } from '@/persistence';
import { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';
import { readFile } from 'node:fs/promises';

function postToControlServer(state: DaemonLocallyPersistedState, path: string, body: unknown, timeout: number) {
  // The sole legacy request is a graceful stop during upgrade. Never retry without auth.
  const legacyStop = state.controlToken === undefined && path === '/stop';
  if (!Number.isInteger(state.httpPort) || state.httpPort < 1 || state.httpPort > 65535 ||
      (!legacyStop && (typeof state.controlToken !== 'string' || !/^[a-f0-9]{64}$/.test(state.controlToken)))) {
    throw new Error('Missing authenticated daemon state');
  }
  return fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
    method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...(!legacyStop && { Authorization: `Bearer ${state.controlToken}` }) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
}

async function daemonPost(path: string, body?: any, timeoutMs?: number): Promise<{ error?: string } | any> {
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
    const timeout = timeoutMs ?? (process.env.HAPPY_DAEMON_HTTP_TIMEOUT ? parseInt(process.env.HAPPY_DAEMON_HTTP_TIMEOUT) : 10_000);
    const response = await postToControlServer(state, path, body ?? {}, timeout);
    
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

/** Cloud/RPC readiness, distinct from the local control server's health. */
export type DaemonConnectionStatus = { machineId: string; cliVersion: string; serverUrl: string; connected: boolean };

export async function getDaemonConnectionStatus(timeoutMs = 1000): Promise<DaemonConnectionStatus | null> {
  const result = await daemonPost('/status', undefined, Math.max(1, timeoutMs));
  return typeof result?.machineId === 'string' && typeof result?.connected === 'boolean'
    && typeof result?.cliVersion === 'string' && typeof result?.serverUrl === 'string'
    ? { machineId: result.machineId, cliVersion: result.cliVersion, serverUrl: result.serverUrl, connected: result.connected }
    : null;
}

export async function stopDaemonSession(sessionId: string): Promise<boolean> {
  const result = await daemonPost('/stop-session', { sessionId });
  return result.success || false;
}

export async function spawnDaemonSession(directory: string, sessionId?: string,
  options?: Pick<SpawnSessionOptions, 'agent' | 'environmentVariables'>): Promise<any> {
  const result = await daemonPost('/spawn-session', { directory, sessionId, ...options });
  return result;
}

export async function stopDaemonHttp(): Promise<void> {
  const result = await daemonPost('/stop');
  if (result.status !== 'stopping') throw new Error('Daemon did not accept the stop request');
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
export async function checkIfDaemonRunningAndCleanupStaleState(): Promise<boolean> {
  const state = await readDaemonState();
  if (!state) {
    return false;
  }

  // Check if the PID is alive
  if (!isProcessAlive(state.pid)) {
    logger.debug('[DAEMON RUN] Daemon PID not running, cleaning up state');
    await cleanupDaemonState();
    return false;
  }

  // PID is alive, but on Windows PIDs get reused after reboot.
  // Verify it's actually our daemon by HTTP pinging its control server.
  if (!state.controlToken || !state.httpPort) return false;
  try {
    const response = await postToControlServer(state, '/list', {}, 5000);
    return response.ok;
  } catch {
    // A timeout does not prove death. Keep the live owner's lock and state.
    logger.debug(`[DAEMON RUN] PID ${state.pid} is alive but HTTP health check failed`);
    return false;
  }
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
  const runningDaemon = await checkIfDaemonRunningAndCleanupStaleState();
  if (!runningDaemon) {
    logger.debug('[DAEMON CONTROL] No daemon running, returning false');
    return false;
  }

  const state = await readDaemonState();
  if (!state) {
    logger.debug('[DAEMON CONTROL] No daemon state found, returning false');
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

export async function cleanupDaemonState(): Promise<void> {
  try {
    await clearDaemonState();
    logger.debug('[DAEMON RUN] Daemon state file removed');
  } catch (error) {
    logger.debug('[DAEMON RUN] Error cleaning up daemon metadata', error);
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw new Error(`Cannot verify daemon PID ${pid}`);
  }
}

export async function stopDaemon(): Promise<void> {
  const state = await readDaemonState();
  if (!state) {
    // A daemon can hold the lock before publishing its listener or during shutdown.
    let lock: string;
    try { lock = await readFile(configuration.daemonLockFile, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('Cannot verify daemon lock');
    }
    const pid = Number(lock.trim());
    if (Number.isSafeInteger(pid) && pid > 0 && !isProcessAlive(pid)) return;
    throw new Error('Daemon lock exists without control state; retry when daemon startup or shutdown completes');
  }
  if (!isProcessAlive(state.pid)) return;
  // Use one state snapshot for both the request and exit confirmation. Never signal a possibly reused PID.
  try {
    const response = await postToControlServer(state, '/stop', {}, 10_000);
    const ack = response.ok ? await response.json() : null;
    if (!ack || typeof ack !== 'object' || !('status' in ack) || ack.status !== 'stopping') throw new Error();
  } catch {
    throw new Error('Could not confirm the daemon accepted the stop request. Check daemon status and retry.');
  }
  const deadline = Date.now() + 5000;
  while (isProcessAlive(state.pid)) {
    if (Date.now() >= deadline) throw new Error('Daemon acknowledged stop but its exit could not be confirmed');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}