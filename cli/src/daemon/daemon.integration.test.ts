/**
 * Integration tests for daemon HTTP control system
 * 
 * Tests the full flow of daemon startup, session tracking, and shutdown
 * Uses the same .env as dev:local-server for consistency
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, test } from 'vitest';
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

// Kill daemon helper
async function killDaemon(): Promise<void> {
  if (existsSync(configuration.daemonStateFile)) {
    try {
      const metadata = JSON.parse(await readFile(configuration.daemonStateFile, 'utf8'));
      process.kill(metadata.pid, 'SIGKILL');
    } catch (e) {
      // Ignore errors
    }
    // Clean up metadata file
    try {
      unlinkSync(configuration.daemonStateFile);
    } catch (e) {
      // Ignore
    }
  }
}

// Start daemon helper
async function startDaemon(): Promise<{ pid: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('yarn', ['tsx', 'src/index.ts', 'daemon', 'start'], {
      cwd: process.cwd(),
      env: process.env,  // Child inherits all env vars including HAPPY_HOME_DIR
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let resolved = false;

    // Capture output for debugging
    child.stdout?.on('data', (data) => {
      console.log('[DAEMON STDOUT]', data.toString());
    });

    child.stderr?.on('data', (data) => {
      console.log('[DAEMON STDERR]', data.toString());
    });

    // Wait for daemon to write metadata
    setTimeout(async () => {
      if (!resolved) {
        try {
          await waitFor(async () => existsSync(configuration.daemonStateFile), 10000);
          const metadata = JSON.parse(await readFile(configuration.daemonStateFile, 'utf8'));
          resolved = true;
          resolve({ pid: metadata.pid });
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

  beforeAll(async () => {
    // Clean up any existing daemon
    await killDaemon();
    
    // Start daemon
    const daemon = await startDaemon();
    daemonPid = daemon.pid;
    
    console.log(`Daemon started: PID=${daemonPid}`);
  });

  afterAll(async () => {
    // Stop daemon via HTTP
    try {
      await stopDaemonHttp();
      // Wait for daemon to die
      await waitFor(async () => {
        try {
          process.kill(daemonPid, 0);
          return false; // Still alive
        } catch {
          return true; // Dead
        }
      }, 3000);
    } catch (error) {
      // Force kill if HTTP stop failed
      console.log('Force killing daemon after test');
      await killDaemon();
    }
  });

  beforeEach(async () => {
    // Give time between tests
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
    // We'll test it but then restart the daemon for other tests
    
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
    
    // Restart daemon for afterAll cleanup
    const daemon = await startDaemon();
    daemonPid = daemon.pid;
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
});