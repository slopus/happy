/**
 * Integration tests for daemon HTTP control system
 * 
 * Tests the full flow of daemon startup, session tracking, and shutdown
 * 
 * IMPORTANT: These tests MUST be run with the integration test environment:
 * yarn test:integration-test-env
 * 
 * DO NOT run with regular 'npm test' or 'yarn test' - it will use the wrong environment
 * and the daemon will not work properly!
 * 
 * The integration test environment uses .env.integration-test which sets:
 * - HAPPY_HOME_DIR=~/.happy-dev-test (DIFFERENT from dev's ~/.happy-dev!)
 * - HAPPY_SERVER_URL=http://localhost:3005 (local dev server)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawn } from 'child_process';
import { existsSync, unlinkSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import path, { join } from 'path';
import { configuration } from '@/configuration';
import { 
  listDaemonSessions, 
  stopDaemonSession, 
  spawnDaemonSession, 
  stopDaemonHttp, 
  notifyDaemonSessionStarted, 
  stopDaemon
} from '@/daemon/controlClient';
import { readDaemonState, clearDaemonState } from '@/persistence';
import { Metadata } from '@/api/types';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { getLatestDaemonLog } from '@/ui/logger';

// Utility to wait for condition
async function waitFor(
  condition: () => Promise<boolean>,
  timeout = 5000,
  interval = 100
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error('Timeout waiting for condition');
}

// Check if dev server is running and properly configured
async function isServerHealthy(): Promise<boolean> {
  try {
    // First check if server responds
    const response = await fetch('http://localhost:3005/', { 
      signal: AbortSignal.timeout(1000) 
    });
    if (!response.ok) {
      console.log('[TEST] Server health check failed: root endpoint not OK');
      return false;
    }
    
    // Check if we have test credentials
    const testCredentials = existsSync(join(configuration.happyHomeDir, 'access.key'));
    if (!testCredentials) {
      console.log('[TEST] No test credentials found in', configuration.happyHomeDir);
      console.log('[TEST] Run "happy auth login" with HAPPY_HOME_DIR=~/.happy-dev-test first');
      return false;
    }
    
    return true;
  } catch (error) {
    console.log('[TEST] Server not reachable:', error);
    return false;
  }
}

describe.skipIf(!await isServerHealthy())('Daemon Integration Tests', { timeout: 20_000 }, () => {
  let daemonPid: number;

  beforeEach(async () => {
    // First ensure no daemon is running by checking PID in metadata file
    await stopDaemon()
    
    // Start fresh daemon for this test
    // This will return and start a background process - we don't need to wait for it
    void spawnHappyCLI(['daemon', 'start'], {
      stdio: 'ignore'
    });
    
    // Wait for daemon to write its state file (it needs to auth, setup, and start server)
    await waitFor(async () => {
      const state = await readDaemonState();
      return state !== null;
    }, 10_000, 250); // Wait up to 10 seconds, checking every 250ms
    
    const daemonState = await readDaemonState();
    if (!daemonState) {
      throw new Error('Daemon failed to start within timeout');
    }
    daemonPid = daemonState.pid;

    console.log(`[TEST] Daemon started for test: PID=${daemonPid}`);
    console.log(`[TEST] Daemon log file: ${daemonState?.daemonLogPath}`);
  });

  afterEach(async () => {
    await stopDaemon()
  });

  it('should list sessions (initially empty)', async () => {
    const sessions = await listDaemonSessions();
    expect(sessions).toEqual([]);
  });

  it('should track session-started webhook from terminal session', async () => {
    // Simulate a terminal-started session reporting to daemon
    const mockMetadata: Metadata = {
      path: '/test/path',
      host: 'test-host',
      homeDir: '/test/home',
      happyHomeDir: '/test/happy-home',
      happyLibDir: '/test/happy-lib',
      happyToolsDir: '/test/happy-tools',
      hostPid: 99999,
      startedBy: 'terminal',
      machineId: 'test-machine-123'
    };

    await notifyDaemonSessionStarted('test-session-123', mockMetadata);

    // Verify session is tracked
    const sessions = await listDaemonSessions();
    expect(sessions).toHaveLength(1);
    
    const tracked = sessions[0];
    expect(tracked.startedBy).toBe('happy directly - likely by user from terminal');
    expect(tracked.happySessionId).toBe('test-session-123');
    expect(tracked.pid).toBe(99999);
  });

  it('should spawn & stop a session via HTTP (not testing RPC route, but similar enough)', async () => {
    const response = await spawnDaemonSession('/tmp', 'spawned-test-456');

    expect(response).toHaveProperty('success', true);
    expect(response).toHaveProperty('sessionId');

    // Verify session is tracked
    const sessions = await listDaemonSessions();
    const spawnedSession = sessions.find(
      (s: any) => s.happySessionId === response.sessionId
    );
    
    expect(spawnedSession).toBeDefined();
    expect(spawnedSession.startedBy).toBe('daemon');
    
    // Clean up - stop the spawned session
    expect(spawnedSession.happySessionId).toBeDefined();
    await stopDaemonSession(spawnedSession.happySessionId);
  });

  it('stress test: spawn / stop', { timeout: 60_000 }, async () => {
    const promises = [];
    const sessionCount = 20;
    for (let i = 0; i < sessionCount; i++) {
      promises.push(spawnDaemonSession('/tmp'));
    }

    // Wait for all sessions to be spawned
    const results = await Promise.all(promises);
    const sessionIds = results.map(r => r.sessionId);

    const sessions = await listDaemonSessions();
    expect(sessions).toHaveLength(sessionCount);

    // Stop all sessions
    const stopResults = await Promise.all(sessionIds.map(sessionId => stopDaemonSession(sessionId)));
    expect(stopResults.every(r => r), 'Not all sessions reported stopped').toBe(true);

    // Verify all sessions are stopped
    const emptySessions = await listDaemonSessions();
    expect(emptySessions).toHaveLength(0);
  });

  it('should handle daemon stop request gracefully', async () => {    
    await stopDaemonHttp();

    // Verify metadata file is cleaned up
    await waitFor(async () => !existsSync(configuration.daemonStateFile), 1000);
  });

  it('should track both daemon-spawned and terminal sessions', async () => {
    // Spawn a real happy process that looks like it was started from terminal
    const terminalHappyProcess = spawnHappyCLI([
      '--happy-starting-mode', 'remote',
      '--started-by', 'terminal'
    ], {
      cwd: '/tmp',
      detached: true,
      stdio: 'ignore'
    });
    if (!terminalHappyProcess || !terminalHappyProcess.pid) {
      throw new Error('Failed to spawn terminal happy process');
    }
    // Give time to start & report itself
    await new Promise(resolve => setTimeout(resolve, 5_000));

    // Spawn a daemon session
    const spawnResponse = await spawnDaemonSession('/tmp', 'daemon-session-bbb');

    // List all sessions
    const sessions = await listDaemonSessions();
    expect(sessions).toHaveLength(2);

    // Verify we have one of each type
    const terminalSession = sessions.find(
      (s: any) => s.pid === terminalHappyProcess.pid
    );
    const daemonSession = sessions.find(
      (s: any) => s.happySessionId === spawnResponse.sessionId
    );

    expect(terminalSession).toBeDefined();
    expect(terminalSession.startedBy).toBe('happy directly - likely by user from terminal');
    
    expect(daemonSession).toBeDefined();
    expect(daemonSession.startedBy).toBe('daemon');

    // Clean up both sessions
    await stopDaemonSession('terminal-session-aaa');
    await stopDaemonSession(daemonSession.happySessionId);
    
    // Also kill the terminal process directly to be sure
    try {
      terminalHappyProcess.kill('SIGTERM');
    } catch (e) {
      // Process might already be dead
    }
  });

  it('should update session metadata when webhook is called', async () => {
    // Spawn a session
    const spawnResponse = await spawnDaemonSession('/tmp');

    // Verify webhook was processed (session ID updated)
    const sessions = await listDaemonSessions();
    const session = sessions.find((s: any) => s.happySessionId === spawnResponse.sessionId);
    expect(session).toBeDefined();

    // Clean up
    await stopDaemonSession(spawnResponse.sessionId);
  });

  it('should not allow starting a second daemon', async () => {
    // Daemon is already running from beforeEach
    // Try to start another daemon
    const secondChild = spawn('yarn', ['tsx', 'src/index.ts', 'daemon', 'start-sync'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    secondChild.stdout?.on('data', (data) => {
      output += data.toString();
    });
    secondChild.stderr?.on('data', (data) => {
      output += data.toString();
    });

    // Wait for the second daemon to exit
    await new Promise<void>((resolve) => {
      secondChild.on('exit', () => resolve());
    });

    // Should report that daemon is already running
    expect(output).toContain('already running');
  });

  it('should handle concurrent session operations', async () => {
    // Spawn multiple sessions concurrently
    const promises = [];
    for (let i = 0; i < 3; i++) {
      promises.push(
        spawnDaemonSession('/tmp')
      );
    }

    const results = await Promise.all(promises);
    
    // All should succeed
    results.forEach(res => {
      expect(res.success).toBe(true);
      expect(res.sessionId).toBeDefined();
    });

    // Collect session IDs for tracking
    const spawnedSessionIds = results.map(r => r.sessionId);

    // Give sessions time to report via webhook
    await new Promise(resolve => setTimeout(resolve, 1000));

    // List should show all sessions
    const sessions = await listDaemonSessions();
    const daemonSessions = sessions.filter(
      (s: any) => s.startedBy === 'daemon' && spawnedSessionIds.includes(s.happySessionId)
    );
    expect(daemonSessions.length).toBeGreaterThanOrEqual(3);

    // Stop all spawned sessions
    for (const session of daemonSessions) {
      expect(session.happySessionId).toBeDefined();
      await stopDaemonSession(session.happySessionId);
    }
  });

  it('should die with logs when SIGKILL is sent', async () => {
    // SIGKILL test - daemon should die immediately
    const logsDir = configuration.logsDir;
    const { readdirSync } = await import('fs');
    
    // Get initial log files
    const initialLogs = readdirSync(logsDir).filter(f => f.endsWith('-daemon.log'));
    
    // Send SIGKILL to daemon (force kill)
    process.kill(daemonPid, 'SIGKILL');
    
    // Wait for process to die
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Check if process is dead
    let isDead = false;
    try {
      process.kill(daemonPid, 0);
    } catch {
      isDead = true;
    }
    expect(isDead).toBe(true);
    
    // Check that log file exists (it was created when daemon started)
    const finalLogs = readdirSync(logsDir).filter(f => f.endsWith('-daemon.log'));
    expect(finalLogs.length).toBeGreaterThanOrEqual(initialLogs.length);
    
    // The daemon won't have time to write cleanup logs with SIGKILL
    console.log('[TEST] Daemon killed with SIGKILL - no cleanup logs expected');
    
    // Clean up state file manually since daemon couldn't do it
    await clearDaemonState();
  });

  it('should die with cleanup logs when SIGTERM is sent', async () => {
    // SIGTERM test - daemon should cleanup gracefully
    const logFile = await getLatestDaemonLog();
    if (!logFile) {
      throw new Error('No log file found');
    }
    
    // Send SIGTERM to daemon (graceful shutdown)
    process.kill(daemonPid, 'SIGTERM');
    
    // Wait for graceful shutdown
    await new Promise(resolve => setTimeout(resolve, 4_000));
    
    // Check if process is dead
    let isDead = false;
    try {
      process.kill(daemonPid, 0);
    } catch {
      isDead = true;
    }
    expect(isDead).toBe(true);
    
    // Read the log file to check for cleanup messages
    const logContent = readFileSync(logFile.path, 'utf8');
    
    // Should contain cleanup messages
    expect(logContent).toContain('SIGTERM');
    expect(logContent).toContain('cleanup');
    
    console.log('[TEST] Daemon terminated gracefully with SIGTERM - cleanup logs written');
    
    // Clean up state file if it still exists (should have been cleaned by SIGTERM handler)
    await clearDaemonState();
  });

  /**
   * Version mismatch detection test - control flow:
   * 
   * 1. Test starts daemon with original version (e.g., 0.9.0-6) compiled into dist/
   * 2. Test modifies package.json to new version (e.g., 0.0.0-integration-test-*)
   * 3. Test runs `yarn build` to recompile with new version
   * 4. Daemon's heartbeat (every 30s) reads package.json and compares to its compiled version
   * 5. Daemon detects mismatch: package.json != configuration.currentCliVersion
   * 6. Daemon spawns new daemon via spawnHappyCLI(['daemon', 'start'])
   * 7. New daemon starts, reads daemon.state.json, sees old version != its compiled version
   * 8. New daemon calls stopDaemon() to kill old daemon, then takes over
   * 
   * This simulates what happens during `npm upgrade happy-coder`:
   * - Running daemon has OLD version loaded in memory (configuration.currentCliVersion)
   * - npm replaces node_modules/happy-coder/ with NEW version files
   * - package.json on disk now has NEW version
   * - Daemon reads package.json, detects mismatch, triggers self-update
   * - Key difference: npm atomically replaces the entire module directory, while
   *   our test must carefully rebuild to avoid missing entrypoint errors
   * 
   * Critical timing constraints:
   * - Heartbeat must be long enough (30s) for yarn build to complete before daemon tries to spawn
   * - If heartbeat fires during rebuild, spawn fails (dist/index.mjs missing) and test fails
   * - pkgroll doesn't reliably update compiled version, must use full yarn build
   * - Test modifies package.json BEFORE rebuild to ensure new version is compiled in
   * 
   * Common failure modes:
   * - Heartbeat too short: daemon tries to spawn while dist/ is being rebuilt
   * - Using pkgroll alone: doesn't update compiled configuration.currentCliVersion
   * - Modifying package.json after daemon starts: triggers immediate version check on startup
   */
  it('[takes 1 minute to run] should detect version mismatch and kill old daemon', { timeout: 100_000 }, async () => {
    // Read current package.json to get version
    const packagePath = path.join(process.cwd(), 'package.json');
    const packageJsonOriginalRawText = readFileSync(packagePath, 'utf8');
    const originalPackage = JSON.parse(packageJsonOriginalRawText);
    const originalVersion = originalPackage.version;
    const testVersion = `0.0.0-integration-test-should-be-auto-cleaned-up-${Math.floor(Math.random() * 100000).toString().padStart(5, '0')}`;

    expect(originalVersion, 'Your current cli version was not cleaned up from previous test it seems').not.toBe(testVersion);
    
    // Modify package.json version
    const modifiedPackage = { ...originalPackage, version: testVersion };
    writeFileSync(packagePath, JSON.stringify(modifiedPackage, null, 2));

    try {
      // Get initial daemon state
      const initialState = await readDaemonState();
      expect(initialState).toBeDefined();
      expect(initialState!.startedWithCliVersion).toBe(originalVersion);
      const initialPid = initialState!.pid;

      // Re-build the CLI - so it will import the new package.json in its configuartion.ts
      // and think it is a new version
      // We are not using yarn build here because it cleans out dist/
      // and we want to avoid that, 
      // otherwise daemon will spawn a non existing happy js script.
      // We need to remove index, but not the other files, otherwise some of our code might fail when called from within the daemon.
      execSync('yarn build', { stdio: 'ignore' });
      
      console.log(`[TEST] Current daemon running with version ${originalVersion}, PID: ${initialPid}`);
      
      console.log(`[TEST] Changed package.json version to ${testVersion}`);

      // The daemon should automatically detect the version mismatch and restart itself
      // We check once per minute, wait for a little longer than that
      await new Promise(resolve => setTimeout(resolve, parseInt(process.env.HAPPY_DAEMON_HEARTBEAT_INTERVAL || '30000') + 10_000));

      // Check that the daemon is running with the new version
      const finalState = await readDaemonState();
      expect(finalState).toBeDefined();
      expect(finalState!.startedWithCliVersion).toBe(testVersion);
      expect(finalState!.pid).not.toBe(initialPid);
      console.log('[TEST] Daemon version mismatch detection successful');
    } finally {
      // CRITICAL: Restore original package.json version
      writeFileSync(packagePath, packageJsonOriginalRawText);
      console.log(`[TEST] Restored package.json version to ${originalVersion}`);

      // Lets rebuild it so we keep it as we found it
      execSync('yarn build', { stdio: 'ignore' });
    }
  });

  // TODO: Add a test to see if a corrupted file will work
  
  // TODO: Test npm uninstall scenario - daemon should gracefully handle when happy-coder is uninstalled
  // Current behavior: daemon tries to spawn new daemon on version mismatch but dist/index.mjs is gone
  // Expected: daemon should detect missing entrypoint and either exit cleanly or at minimum not respawn infinitely
});