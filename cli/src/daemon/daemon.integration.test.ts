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
import { spawn } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import { readFile } from 'fs/promises';
import { configuration } from '@/configuration';
import { 
  listDaemonSessions, 
  stopDaemonSession, 
  spawnDaemonSession, 
  stopDaemonHttp, 
  notifyDaemonSessionStarted 
} from '@/daemon/controlClient';
import { getDaemonState } from '@/persistence';
import { Metadata } from '@/api/types';

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

// Start daemon helper
// Store the daemon child process globally so we can kill it in afterAll
let daemonChild: any = null;

async function startDaemon(): Promise<{ pid: number }> {
  return new Promise((resolve, reject) => {
    // Clean environment without Vitest's process.exit interception
    const cleanEnv: Record<string, string | undefined> = {
      ...process.env,
      NODE_ENV: undefined,  // Remove NODE_ENV=test
      VITEST: undefined,    // Remove VITEST env var
      // Keep necessary env vars
      HAPPY_HOME_DIR: process.env.HAPPY_HOME_DIR,
      HAPPY_SERVER_URL: process.env.HAPPY_SERVER_URL,
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      SHELL: process.env.SHELL
    };
    
    // Remove undefined values
    Object.keys(cleanEnv).forEach(key => {
      if (cleanEnv[key] === undefined) {
        delete cleanEnv[key];
      }
    });
    
    const child = spawn('yarn', ['tsx', 'src/index.ts', 'daemon', 'start-sync'], {
      cwd: process.cwd(),
      env: cleanEnv,  // Use clean environment
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false  // Keep it attached for testing
    });

    // Store globally for cleanup
    daemonChild = child;

    let resolved = false;

    // Capture output for debugging
    child.stdout?.on('data', (data) => {
      console.log('[DAEMON STDOUT]', data.toString());
    });

    child.stderr?.on('data', (data) => {
      console.log('[DAEMON STDERR]', data.toString());
    });

    // Wait for daemon to write metadata and be ready
    setTimeout(async () => {
      if (!resolved) {
        try {
          await waitFor(async () => existsSync(configuration.daemonStateFile), 10000);
          resolved = true;
          // Return the actual child PID since start-sync runs in foreground
          resolve({ pid: child.pid! });
        } catch (error) {
          resolved = true;
          reject(error);
        }
      }
    }, 500);

    child.on('error', (error) => {
      if (!resolved) {
        resolved = true;
        reject(error);
      }
    });

    child.on('exit', (code, signal) => {
      console.log(`[DAEMON EXIT] code=${code}, signal=${signal}`);
    });
  });
}

// Check if dev server is running
async function isServerHealthy(): Promise<boolean> {
  try {
    const response = await fetch('http://localhost:3005/', { 
      signal: AbortSignal.timeout(1000) 
    });
    return response.ok;
  } catch {
    return false;
  }
}

describe.skipIf(!await isServerHealthy())('Daemon Integration Tests', () => {
  let daemonPid: number;

  beforeEach(async () => {
    // First ensure no daemon is running by checking PID in metadata file
    if (existsSync(configuration.daemonStateFile)) {
      try {
        const metadata = JSON.parse(await readFile(configuration.daemonStateFile, 'utf8'));
        // Try to kill the daemon based on PID in metadata
        try {
          process.kill(metadata.pid, 'SIGKILL');
        } catch {
          // Process already dead
        }
      } catch {
        // Couldn't read metadata
      }
      // Clean up metadata file
      try {
        unlinkSync(configuration.daemonStateFile);
      } catch {
        // Ignore
      }
    }
    
    // Start fresh daemon for this test
    const daemon = await startDaemon();
    daemonPid = daemon.pid;
    console.log(`[TEST] Daemon started for test: PID=${daemonPid}`);
  });

  afterEach(async () => {
    // Stop the daemon after each test
    if (daemonChild) {
      console.log('[TEST] Stopping daemon after test...');
      daemonChild.kill('SIGTERM');
      
      // Give it a moment to cleanup
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Force kill if still running
      try {
        daemonChild.kill('SIGKILL');
      } catch {
        // Already dead
      }
      
      daemonChild = null;
    }
    
    // Clean up state file
    if (existsSync(configuration.daemonStateFile)) {
      try {
        unlinkSync(configuration.daemonStateFile);
      } catch {
        // Ignore
      }
    }
    
    // Give a moment between tests
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  it('should list sessions (initially empty)', async () => {
    const sessions = await listDaemonSessions();
    expect(sessions).toEqual([]);
  });

  it('should handle session-started webhook from terminal session', async () => {
    // Simulate a terminal-started session reporting to daemon
    const mockMetadata: Metadata = {
      path: '/test/path',
      host: 'test-host',
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

  it('should spawn a new session via HTTP', async () => {
    const response = await spawnDaemonSession('/tmp', 'spawned-test-456');

    expect(response).toHaveProperty('success', true);
    expect(response).toHaveProperty('pid');

    // Verify session is tracked
    const sessions = await listDaemonSessions();
    const spawnedSession = sessions.find(
      (s: any) => s.pid === response.pid
    );
    
    expect(spawnedSession).toBeDefined();
    expect(spawnedSession.startedBy).toBe('daemon');
    
    // Clean up - stop the spawned session
    expect(spawnedSession.happySessionId).toBeDefined();
    await stopDaemonSession(spawnedSession.happySessionId);
  });

  it('should stop a specific session', async () => {
    // First spawn a session
    const spawnResponse = await spawnDaemonSession('/tmp');
    
    expect(spawnResponse.success).toBe(true);
    const pid = spawnResponse.pid;

    // Give session time to initialize and report via webhook
    await new Promise(resolve => setTimeout(resolve, 1000));

    // List sessions to get the actual session ID
    let sessions = await listDaemonSessions();
    let spawnedSession = sessions.find((s: any) => s.pid === pid);
    expect(spawnedSession).toBeDefined();
    expect(spawnedSession.happySessionId).toBeDefined();

    // Stop the session using its ACTUAL session ID
    const success = await stopDaemonSession(spawnedSession.happySessionId);
    expect(success).toBe(true);

    // Give time for process to die
    await new Promise(resolve => setTimeout(resolve, 500));

    // Verify session is removed
    sessions = await listDaemonSessions();
    let hasSession = sessions.some((s: any) => s.pid === pid);
    expect(hasSession).toBe(false);
  });

  it('should handle daemon stop request gracefully', async () => {
    // This test verifies the stop endpoint works
    
    await stopDaemonHttp();

    // Wait for daemon to actually stop
    await waitFor(async () => {
      try {
        await listDaemonSessions();
        return false; // Still responding
      } catch {
        return true; // Not responding
      }
    }, 2000);

    // Verify metadata file is cleaned up
    await waitFor(async () => !existsSync(configuration.daemonStateFile), 1000);
    
    // The afterEach will clean up and beforeEach will start fresh for next test
  });

  it('should track both daemon-spawned and terminal sessions', async () => {
    // Add a terminal session
    await notifyDaemonSessionStarted('terminal-session-aaa', {
      path: '/test/path',
      host: 'test-host',
      hostPid: 88888,
      startedBy: 'terminal',
      machineId: 'test-machine'
    });

    // Spawn a daemon session
    const spawnResponse = await spawnDaemonSession('/tmp', 'daemon-session-bbb');

    // List all sessions
    const sessions = await listDaemonSessions();
    expect(sessions).toHaveLength(2);

    // Verify we have one of each type
    const terminalSession = sessions.find(
      (s: any) => s.happySessionId === 'terminal-session-aaa'
    );
    const daemonSession = sessions.find(
      (s: any) => s.pid === spawnResponse.pid
    );

    expect(terminalSession).toBeDefined();
    expect(terminalSession.startedBy).toBe('happy directly - likely by user from terminal');
    
    expect(daemonSession).toBeDefined();
    expect(daemonSession.startedBy).toBe('daemon');

    // Clean up spawned session
    await stopDaemonSession('daemon-session-bbb');
  });

  it('should update session metadata when webhook is called', async () => {
    // Spawn a session
    const spawnResponse = await spawnDaemonSession('/tmp');
    const pid = spawnResponse.pid;

    // Call webhook with updated metadata  
    await notifyDaemonSessionStarted('updated-session-xyz', {
      path: '/test/path',
      host: 'test-host',
      hostPid: pid,
      startedBy: 'daemon',
      machineId: 'test-machine-updated'
    });

    // Verify webhook was processed (session ID updated)
    const sessions = await listDaemonSessions();
    const session = sessions.find((s: any) => s.pid === pid);
    expect(session.happySessionId).toBe('updated-session-xyz');

    // Clean up
    await stopDaemonSession('updated-session-xyz');
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
      expect(res.pid).toBeDefined();
    });

    // Collect PIDs for tracking
    const spawnedPids = results.map(r => r.pid);

    // Give sessions time to report via webhook
    await new Promise(resolve => setTimeout(resolve, 1000));

    // List should show all sessions
    const sessions = await listDaemonSessions();
    const daemonSessions = sessions.filter(
      (s: any) => s.startedBy === 'daemon' && spawnedPids.includes(s.pid)
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
    daemonChild.kill('SIGKILL');
    
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
  });

  it('should die with cleanup logs when SIGTERM is sent', async () => {
    // SIGTERM test - daemon should cleanup gracefully
    const logsDir = configuration.logsDir;
    const { readFileSync, readdirSync } = await import('fs');
    
    // Get current log files
    const logFiles = readdirSync(logsDir).filter(f => f.endsWith('-daemon.log')).sort();
    const currentLogFile = logFiles[logFiles.length - 1];
    const logPath = `${logsDir}/${currentLogFile}`;
    
    // Send SIGTERM to daemon (graceful shutdown)
    daemonChild.kill('SIGTERM');
    
    // Wait for graceful shutdown
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Check if process is dead
    let isDead = false;
    try {
      process.kill(daemonPid, 0);
    } catch {
      isDead = true;
    }
    expect(isDead).toBe(true);
    
    // Read the log file to check for cleanup messages
    const logContent = readFileSync(logPath, 'utf8');
    
    // Should contain cleanup messages
    expect(logContent).toContain('SIGTERM');
    expect(logContent).toContain('cleanup');
    
    console.log('[TEST] Daemon terminated gracefully with SIGTERM - cleanup logs written');
  });
});