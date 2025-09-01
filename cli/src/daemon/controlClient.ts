/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { logger } from '@/ui/logger';
import { clearDaemonState, readDaemonState } from '@/persistence';
import { Metadata } from '@/api/types';
import { projectPath } from '@/projectPath';
import { readFileSync } from 'fs';
import { join } from 'path';
import { configuration } from '@/configuration';

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

export async function notifyDaemonSessionStarted(
  sessionId: string,
  metadata: Metadata
): Promise<{ error?: string } | any> {
  return await daemonPost('/session-started', {
    sessionId,
    metadata
  });
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

export async function stopDaemonHttp(): Promise<void> {
  await daemonPost('/stop');
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

  // Check if the daemon is running
  try {
    process.kill(state.pid, 0);
    return true;
  } catch {
    logger.debug('[DAEMON RUN] Daemon PID not running, cleaning up state');
    await cleanupDaemonState();
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
  
  try {
    // Read package.json on demand from disk - so we are guaranteed to get the latest version
    const packageJsonPath = join(projectPath(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const currentCliVersion = packageJson.version;
    
    logger.debug(`[DAEMON CONTROL] Current CLI version: ${currentCliVersion}, Daemon started with version: ${state.startedWithCliVersion}`);
    return currentCliVersion === state.startedWithCliVersion;
    
    // PREVIOUS IMPLEMENTATION - Keeping this commented in case we need it
    // Kirill does not understand how the upgrade of npm packages happen and whether 
    // we will get a new path or not when happy-coder is upgraded globally.
    // If reading package.json doesn't work correctly after npm upgrades, 
    // we can revert to spawning a process (but should add timeout and cleanup!)
    /*
    const { spawnHappyCLI } = await import('@/utils/spawnHappyCLI');
    const happyProcess = spawnHappyCLI(['--version'], { stdio: 'pipe' });
    let version: string | null = null;
    happyProcess.stdout?.on('data', (data) => {
      version = data.toString().trim();
    });
    await new Promise(resolve => happyProcess.stdout?.on('close', resolve));
    logger.debug(`[DAEMON CONTROL] Current CLI version: ${version}, Daemon started with version: ${state.startedWithCliVersion}`);
    return version === state.startedWithCliVersion;
    */
  } catch (error) {
    logger.debug('[DAEMON CONTROL] Error checking daemon version', error);
    return false;
  }
}

export async function cleanupDaemonState(): Promise<void> {
  try {
    await clearDaemonState();
    logger.debug('[DAEMON RUN] Daemon state file removed');
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

    logger.debug(`Stopping daemon with PID ${state.pid}`);

    // Try HTTP graceful stop
    try {
      await stopDaemonHttp();

      // Wait for daemon to die
      await waitForProcessDeath(state.pid, 2000);
      logger.debug('Daemon stopped gracefully via HTTP');
      return;
    } catch (error) {
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