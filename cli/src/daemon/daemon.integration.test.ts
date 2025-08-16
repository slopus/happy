/**
 * Integration tests for daemon HTTP control system
 * 
 * Tests the full flow of daemon startup, session tracking, and shutdown
 * Uses the same .env as dev:local-server for consistency
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import axios from 'axios';

const HAPPY_CLI_PATH = path.join(__dirname, '../../');
const DAEMON_METADATA_PATH = path.join(process.env.HAPPY_HOME_DIR || path.join(process.env.HOME!, '.happy-dev'), 'daemon-metadata.json');

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
  if (existsSync(DAEMON_METADATA_PATH)) {
    try {
      const metadata = JSON.parse(await readFile(DAEMON_METADATA_PATH, 'utf8'));
      process.kill(metadata.pid, 'SIGKILL');
    } catch (e) {
      // Ignore errors
    }
    // Clean up metadata file
    try {
      unlinkSync(DAEMON_METADATA_PATH);
    } catch (e) {
      // Ignore
    }
  }
}

// Start daemon helper
async function startDaemon(): Promise<{ pid: number; httpPort: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('yarn', ['tsx', 'src/index.ts', 'daemon', 'start'], {
      cwd: HAPPY_CLI_PATH,
      env: {
        ...process.env,
        HAPPY_HOME_DIR: process.env.HAPPY_HOME_DIR || path.join(process.env.HOME!, '.happy-dev'),
        HAPPY_SERVER_URL: process.env.HAPPY_SERVER_URL || 'http://localhost:3005'
      },
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
          await waitFor(async () => existsSync(DAEMON_METADATA_PATH), 3000);
          const metadata = JSON.parse(await readFile(DAEMON_METADATA_PATH, 'utf8'));
          resolved = true;
          resolve({ pid: metadata.pid, httpPort: metadata.httpPort });
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

describe('Daemon HTTP Control Integration', () => {
  let daemonPid: number;
  let daemonPort: number;
  let httpClient: ReturnType<typeof axios.create>;

  beforeAll(async () => {
    // Clean up any existing daemon
    await killDaemon();
    
    // Start daemon
    const daemon = await startDaemon();
    daemonPid = daemon.pid;
    daemonPort = daemon.httpPort;
    
    // Create HTTP client
    httpClient = axios.create({
      baseURL: `http://127.0.0.1:${daemonPort}`,
      timeout: 1000
    });
    
    console.log(`Daemon started: PID=${daemonPid}, Port=${daemonPort}`);
  });

  afterAll(async () => {
    // Stop daemon via HTTP
    try {
      await httpClient.post('/stop');
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
    const response = await httpClient.post('/list');
    expect(response.status).toBe(200);
    expect(response.data).toHaveProperty('children');
    expect(response.data.children).toEqual([]);
  });

  it('should handle session-started webhook from terminal session', async () => {
    // Simulate a terminal-started session reporting to daemon
    const mockMetadata = {
      hostPid: 99999,
      startedBy: 'terminal',
      machineId: 'test-machine-123',
      startTime: Date.now()
    };

    const response = await httpClient.post('/session-started', {
      sessionId: 'test-session-123',
      metadata: mockMetadata
    });

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ status: 'ok' });

    // Verify session is tracked
    const listResponse = await httpClient.post('/list');
    expect(listResponse.data.children).toHaveLength(1);
    
    const tracked = listResponse.data.children[0];
    expect(tracked.startedBy).toBe('happy directly - likely by user from terminal');
    expect(tracked.happySessionId).toBe('test-session-123');
    expect(tracked.pid).toBe(99999);
  });

  it('should spawn a new session via HTTP', async () => {
    const response = await httpClient.post('/spawn-session', {
      directory: '/tmp',
      sessionId: 'spawned-test-456'
    });

    expect(response.status).toBe(200);
    expect(response.data).toHaveProperty('success', true);
    expect(response.data).toHaveProperty('pid');

    // Verify session is tracked
    const listResponse = await httpClient.post('/list');
    const spawnedSession = listResponse.data.children.find(
      (s: any) => s.pid === response.data.pid
    );
    
    expect(spawnedSession).toBeDefined();
    expect(spawnedSession.startedBy).toBe('daemon');
    
    // Clean up - stop the spawned session
    if (spawnedSession?.happySessionId) {
      await httpClient.post('/stop-session', { 
        sessionId: spawnedSession.happySessionId 
      });
    } else {
      // Force kill by PID if no session ID
      try {
        process.kill(response.data.pid, 'SIGTERM');
      } catch {
        // Ignore
      }
    }
  });

  it('should stop a specific session', async () => {
    // First spawn a session
    const spawnResponse = await httpClient.post('/spawn-session', {
      directory: '/tmp',
      sessionId: 'to-stop-789'
    });
    
    expect(spawnResponse.data.success).toBe(true);
    const pid = spawnResponse.data.pid;

    // Give session time to initialize
    await new Promise(resolve => setTimeout(resolve, 500));

    // List should show the session
    let listResponse = await httpClient.post('/list');
    let hasSession = listResponse.data.children.some((s: any) => s.pid === pid);
    expect(hasSession).toBe(true);

    // Stop the session
    const stopResponse = await httpClient.post('/stop-session', {
      sessionId: 'to-stop-789'
    });
    
    expect(stopResponse.data).toHaveProperty('success');

    // Give time for process to die
    await new Promise(resolve => setTimeout(resolve, 500));

    // Verify session is removed
    listResponse = await httpClient.post('/list');
    hasSession = listResponse.data.children.some((s: any) => s.pid === pid);
    expect(hasSession).toBe(false);
  });

  it('should handle daemon stop request gracefully', async () => {
    // This test verifies the stop endpoint works
    // We'll test it but then restart the daemon for other tests
    
    const response = await httpClient.post('/stop');
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ status: 'stopping' });

    // Wait for daemon to actually stop
    await waitFor(async () => {
      try {
        await httpClient.post('/list');
        return false; // Still responding
      } catch {
        return true; // Not responding
      }
    }, 2000);

    // Verify metadata file is cleaned up
    await waitFor(async () => !existsSync(DAEMON_METADATA_PATH), 1000);
    
    // Restart daemon for afterAll cleanup
    const daemon = await startDaemon();
    daemonPid = daemon.pid;
    daemonPort = daemon.httpPort;
    httpClient = axios.create({
      baseURL: `http://127.0.0.1:${daemonPort}`,
      timeout: 1000
    });
  });

  it('should track both daemon-spawned and terminal sessions', async () => {
    // Add a terminal session
    await httpClient.post('/session-started', {
      sessionId: 'terminal-session-aaa',
      metadata: {
        hostPid: 88888,
        startedBy: 'terminal',
        machineId: 'test-machine'
      }
    });

    // Spawn a daemon session
    const spawnResponse = await httpClient.post('/spawn-session', {
      directory: '/tmp',
      sessionId: 'daemon-session-bbb'
    });

    // List all sessions
    const listResponse = await httpClient.post('/list');
    expect(listResponse.data.children).toHaveLength(2);

    // Verify we have one of each type
    const terminalSession = listResponse.data.children.find(
      (s: any) => s.happySessionId === 'terminal-session-aaa'
    );
    const daemonSession = listResponse.data.children.find(
      (s: any) => s.pid === spawnResponse.data.pid
    );

    expect(terminalSession).toBeDefined();
    expect(terminalSession.startedBy).toBe('happy directly - likely by user from terminal');
    
    expect(daemonSession).toBeDefined();
    expect(daemonSession.startedBy).toBe('daemon');

    // Clean up spawned session
    await httpClient.post('/stop-session', { sessionId: 'daemon-session-bbb' });
  });

  it('should update session metadata when webhook is called', async () => {
    // Spawn a session without initial metadata
    const spawnResponse = await httpClient.post('/spawn-session', {
      directory: '/tmp'
    });

    const pid = spawnResponse.data.pid;

    // Session should be tracked but without full metadata
    let listResponse = await httpClient.post('/list');
    let session = listResponse.data.children.find((s: any) => s.pid === pid);
    expect(session).toBeDefined();
    expect(session.happySessionId).toBeUndefined();

    // Simulate the session calling back with its metadata
    await httpClient.post('/session-started', {
      sessionId: 'updated-session-xyz',
      metadata: {
        hostPid: pid,
        startedBy: 'daemon',
        machineId: 'test-machine-updated'
      }
    });

    // Check updated metadata
    listResponse = await httpClient.post('/list');
    session = listResponse.data.children.find((s: any) => s.pid === pid);
    expect(session.happySessionId).toBe('updated-session-xyz');
    expect(session.happySessionMetadataFromLocalWebhook).toBeDefined();

    // Clean up
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Ignore
    }
  });

  it('should handle concurrent session operations', async () => {
    // Spawn multiple sessions concurrently
    const promises = [];
    for (let i = 0; i < 3; i++) {
      promises.push(
        httpClient.post('/spawn-session', {
          directory: '/tmp',
          sessionId: `concurrent-${i}`
        })
      );
    }

    const results = await Promise.all(promises);
    
    // All should succeed
    results.forEach(res => {
      expect(res.data.success).toBe(true);
      expect(res.data.pid).toBeDefined();
    });

    // List should show all sessions
    const listResponse = await httpClient.post('/list');
    const concurrentSessions = listResponse.data.children.filter(
      (s: any) => s.happySessionId?.startsWith('concurrent-')
    );
    expect(concurrentSessions.length).toBeGreaterThanOrEqual(3);

    // Stop all concurrent sessions
    const stopPromises = [];
    for (let i = 0; i < 3; i++) {
      stopPromises.push(
        httpClient.post('/stop-session', {
          sessionId: `concurrent-${i}`
        })
      );
    }
    await Promise.all(stopPromises);
  });
});