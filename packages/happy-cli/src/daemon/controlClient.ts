/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { logger } from '@/ui/logger';
import { clearDaemonState, readDaemonState, readDaemonStateSnapshot, writeDaemonStateIfUnchanged } from '@/persistence';
import { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import { initializeScopeReportSigner, SCOPE_REPORT_HEADER } from './sessionWriteScopeReports';
import {
    MANAGED_REPORT_CAPABILITY_HEADER,
    type ManagedReportKind,
} from './launch/managedReportCapability';
import {
    createManagedReportSigner,
    MANAGED_REPORT_FD_ENV,
    type ManagedReportSigner,
} from './launch/managedReportCredential';

/** How long one report's capability is good for. Minted per report. */
const MANAGED_REPORT_CAPABILITY_TTL_MS = 60_000;

/**
 * This launch's report signer, resolved once.
 *
 * The control server refuses a managed lifecycle report that no launch vouched
 * for: the loopback bearer is readable by the agent's own tools, so it proves
 * "something on this host" and nothing about *which* launch is reporting.
 * The launcher hands this child a per-launch secret on its own inherited
 * descriptor, and this is where the report is signed with it.
 *
 * Resolved lazily and cached, because the descriptor is consumed by the first
 * read. `null` is the ordinary spawn: no descriptor, nothing to sign, and the
 * control server is not asking.
 */
let reportSigner: Promise<ManagedReportSigner | null> | null = null;
/**
 * Whether this process was launched as a managed child at all.
 *
 * Read before the signer consumes the variable, because "no credential" and
 * "not managed" are different answers: the first must refuse to report, the
 * second is an ordinary spawn that never had one.
 */
let managedChild: boolean | null = null;
const isManagedChild = () => managedChild === true;
/** Monotonic per-process. The registry refuses a repeated or lower value. */
let reportSeq = 0;

function managedReportSigner() {
    // Captured before the signer consumes the variable, and lazily rather than
    // at import: what matters is whether this process was launched managed,
    // asked at the first moment anything needs to know.
    managedChild ??= process.env[MANAGED_REPORT_FD_ENV] !== undefined;
    reportSigner ??= createManagedReportSigner(process.env).catch((error) => {
        // A launch that cannot sign will be refused by the control server, and
        // that refusal is the honest outcome — reports do not fall back to
        // unsigned. Only the shape of the failure is kept.
        logger.debug(`[CONTROL CLIENT] managed report signer unavailable: ${(error as Error)?.name ?? 'unknown'}`);
        return null;
    });
    return reportSigner;
}

/**
 * A managed lifecycle report: the launch's own address, the launch's own
 * capability, and nothing of the daemon's.
 *
 * The ordinary path cannot be used here. It finds the daemon by reading the
 * daemon's state file — `0600`, owned by the daemon's uid — and then proves it
 * is alive with `kill(pid, 0)`. A managed child runs as a **different uid**, so
 * the read fails and the signal is `EPERM`: a provider that had to go that way
 * could not report at all.
 *
 * It also must not: that file carries the daemon-wide bearer, and handing it to
 * a process the agent influences would let the agent's own tools forge another
 * Run's session. On a managed runtime the control server does not ask for that
 * bearer on these two paths — the per-launch capability is the whole
 * credential, so the child never needs the secret it must not have.
 *
 * **A report that cannot be signed is not sent.** Sending it unsigned would be
 * refused anyway, but it would put the session's own metadata on the wire for a
 * launch that could not prove it owns it.
 */
async function managedReportPost(
  signer: ManagedReportSigner,
  path: string,
  body: unknown,
  reportKind: ManagedReportKind,
): Promise<{ error?: string } | any> {
  reportSeq += 1;
  const capability = signer.sign({
    kind: reportKind,
    seq: reportSeq,
    // The window the registry already bounds this launch by; a capability that
    // outlives the launch is one that outlives its reason to exist.
    expiresAt: Date.now() + MANAGED_REPORT_CAPABILITY_TTL_MS,
    // The whole body: the signature says this launch made *this* report, not
    // merely that it made one.
    body: body ?? {},
  });
  try {
    const timeout = process.env.HAPPY_DAEMON_HTTP_TIMEOUT ? parseInt(process.env.HAPPY_DAEMON_HTTP_TIMEOUT) : 10_000;
    const response = await fetch(`${signer.reportBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MANAGED_REPORT_CAPABILITY_HEADER]: capability,
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      const errorMessage = `Request failed: ${path}, HTTP ${response.status}`;
      logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
      return { error: errorMessage };
    }
    return await response.json();
  } catch (error) {
    // The launch's address and capability are not echoed into the message.
    const errorMessage = `Request failed: ${path}, ${error instanceof Error ? error.name : 'Unknown error'}`;
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return { error: errorMessage };
  }
}

async function daemonPost(
  path: string,
  body?: any,
  /** Set for the two managed lifecycle reports, which must be signed. */
  reportKind?: ManagedReportKind,
): Promise<{ error?: string } | any> {
  if (reportKind) {
    const signer = await managedReportSigner();
    if (signer) return managedReportPost(signer, path, body, reportKind);
    if (isManagedChild()) {
      /*
       * A managed child whose credential could not be read. There is no
       * unsigned fallback: the report would be refused, and sending it anyway
       * puts this session's metadata on the wire without the launch that owns
       * it being able to say so.
       */
      const errorMessage = `Request failed: ${path}, managed report credential unavailable`;
      logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
      return { error: errorMessage };
    }
  }
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
      headers: {
        'Content-Type': 'application/json',
        // ADR-061: the control server rejects every request without this —
        // absent on a state file from before the auth rollout, in which case
        // the server's 401 surfaces through the existing `!response.ok` path.
        ...(state.controlSecret ? { Authorization: `Bearer ${state.controlSecret}` } : {}),
        ...(reportKind ? await scopeReportHeaders(reportKind, body || {}) : {}),
      },
      body: JSON.stringify(body || {}),
      // Mostly increased for stress test
      signal: AbortSignal.timeout(timeout)
    });
    
    if (!response.ok) {
      const errorMessage = `Request failed: ${path}, HTTP ${response.status}`;
      logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
      return {
        error: errorMessage, status: response.status
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
async function scopeReportHeaders(kind: ManagedReportKind, body: unknown): Promise<Record<string, string>> {
  const signer = await initializeScopeReportSigner();
  return signer ? { [SCOPE_REPORT_HEADER]: signer(kind, body) } : {};
}
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
    result = await daemonPost('/session-started', payload, 'session-started');
    if (!result?.error) {
      return result;
    }
    if (Date.now() >= deadline) {
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, SESSION_STARTED_RETRY_INTERVAL_MS));
  }
}

export async function notifyDaemonSessionRuntime(
  sessionId: string,
  runtime: {
    reportSeq?: number;
    thinking?: boolean;
    hasOpenToolCall?: boolean;
    pendingUserInput?: boolean;
    lastUserInteractionAt?: number;
    lastTurnEndAt?: number;
    assistantTurns?: number;
    providerTokens?: number;
    launchedBackgroundJob?: boolean;
    lastProcessedSeq?: number;
    mode?: 'local' | 'remote';
  }
): Promise<{ error?: string } | any> {
  // Announce our own PID on every report. `daemonPost` re-reads daemon.state.json
  // each call, so this report reaches whichever daemon is current — including one
  // that replaced the daemon that spawned us and therefore has no record of this
  // session. hostPid is what lets that daemon adopt us instead of dropping the
  // report; taking the PID from a persisted record instead would risk acting on a
  // recycled PID.
  return daemonPost('/session-runtime', { sessionId, ...runtime, hostPid: process.pid }, 'session-runtime');
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

export class DaemonStopRefused extends Error {}

export async function stopDaemonHttp(): Promise<void> {
  const result = await daemonPost('/stop');
  // A responding server refused shutdown: never convert this into a force kill.
  if (result?.error) {
    if (result.status >= 400) throw new DaemonStopRefused(result.error);
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
export async function checkIfDaemonRunningAndCleanupStaleState(): Promise<boolean> {
  const { state, raw } = await readDaemonStateSnapshot();
  if (!state) {
    return false;
  }

  // Check if the PID is alive
  try {
    process.kill(state.pid, 0);
  } catch {
    logger.debug('[DAEMON RUN] Daemon PID not running, marking state as crashed');
    // Guarded write: `ensureDaemonRunning()` calls us every 100ms while a daemon is
    // coming up, so the daemon may have claimed the file between our read and here.
    // An unguarded write would resurrect the dead pid over its state, and its next
    // heartbeat would read a foreign pid and shut it down.
    const marked = writeDaemonStateIfUnchanged(raw, { ...state, state: 'crashed', stateReason: 'Daemon PID not running' });
    if (!marked) {
      logger.debug('[DAEMON RUN] Daemon state file changed while we were checking it, leaving it to its owner');
    }
    return false;
  }

  // PID is alive, but on Windows PIDs get reused after reboot.
  // Verify it's actually our daemon by HTTP pinging its control server.
  if (state.httpPort) {
    try {
      const response = await fetch(`http://127.0.0.1:${state.httpPort}/list`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(state.controlSecret ? { Authorization: `Bearer ${state.controlSecret}` } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(2000)
      });
      if (response.ok) {
        return true;
      }
    } catch {
      // HTTP check failed - the PID is not our daemon (likely reused by OS after reboot)
      logger.debug(`[DAEMON RUN] PID ${state.pid} is alive but HTTP health check failed on port ${state.httpPort}, cleaning up stale state`);
      await cleanupDaemonState();
      return false;
    }
  }

  return true;
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
    // clearDaemonState marks the file stopped and keeps it — the tracked
    // session records are what a replacement daemon recovers from. Saying
    // "removed" here sent a 2026-08-23 investigation looking for a phantom
    // writer that had put the file back.
    logger.debug('[DAEMON RUN] Daemon state marked stopped and lock released');
  } catch (error) {
    logger.debug('[DAEMON RUN] Error cleaning up daemon metadata', error);
  }
}

export async function stopDaemon() {
  try {
    const state = await readDaemonState();
    if (!state) {
      logger.debug('No daemon state found');
      return;
    }
    if (state.state === 'stopped' || state.state === 'crashed') {
      logger.debug(`Daemon state is ${state.state}, nothing to stop`);
      return;
    }

    logger.debug(`Stopping daemon with PID ${state.pid}`);

    // Try HTTP graceful stop
    try {
      await stopDaemonHttp();

      // Wait for daemon to die
      await waitForProcessDeath(state.pid, 2000);
      logger.debug('Daemon stopped gracefully via HTTP');
      return;
    } catch (error) {
      if (error instanceof DaemonStopRefused) throw error;
      logger.debug('HTTP stop failed, will force kill', error);
    }

    // Force kill
    try {
      process.kill(state.pid, 'SIGKILL');
      logger.debug('Force killed daemon');
    } catch (error) {
      logger.debug('Daemon already dead');
    }
  } catch (error) {
    if (error instanceof DaemonStopRefused) throw error;
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
