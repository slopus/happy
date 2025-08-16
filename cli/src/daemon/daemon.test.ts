import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { startDaemon, stopDaemon, isDaemonRunning, getDaemonMetadata } from './run';
import { listDaemonSessions, stopDaemonSession, spawnDaemonSession } from './controlClient';
import { spawn } from 'child_process';
import { join } from 'path';

describe('Daemon HTTP Control', () => {
  beforeAll(async () => {
    // Use same env as dev:local-server
    process.env.HAPPY_SERVER_URL = process.env.HAPPY_SERVER_URL || 'http://localhost:3005';
    
    if (await isDaemonRunning()) {
      throw new Error('Daemon already running - stop it before running tests');
    }
  });

  afterEach(async () => {
    // ALWAYS stop daemon after each test
    await stopDaemon();
    const stillRunning = await isDaemonRunning();
    expect(stillRunning).toBe(false);
  });

  it('starts daemon with HTTP server', async () => {
    await startDaemon();
    
    const metadata = await getDaemonMetadata();
    expect(metadata).toBeTruthy();
    expect(metadata!.httpPort).toBeGreaterThan(0);
  });

  it('lists empty sessions initially', async () => {
    await startDaemon();
    
    const sessions = await listDaemonSessions();
    expect(sessions).toEqual([]);
  });

  it('tracks externally started sessions', async () => {
    await startDaemon();
    const metadata = await getDaemonMetadata();
    
    // Start a happy session manually
    const happyPath = join(process.cwd(), 'bin', 'happy.mjs');
    const child = spawn(happyPath, [
      '--started-by', 'terminal'
    ], {
      cwd: process.cwd(),
      detached: false,
      stdio: 'ignore'
    });
    
    // Wait a bit for session to register
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const sessions = await listDaemonSessions();
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0].startedBy).toBe('happy directly - likely by user from terminal');
    
    // Clean up
    child.kill();
    await new Promise(resolve => setTimeout(resolve, 500));
  }, 10000);

  it('spawns sessions via HTTP', async () => {
    await startDaemon();
    
    const result = await spawnDaemonSession(process.cwd());
    expect(result.success).toBe(true);
    expect(result.pid).toBeGreaterThan(0);
    
    // Wait for session to register
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const sessions = await listDaemonSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].startedBy).toBe('daemon');
    
    // Stop the session
    const sessionId = sessions[0].happySessionId || `PID-${sessions[0].pid}`;
    const stopped = await stopDaemonSession(sessionId);
    expect(stopped).toBe(true);
    
    // Verify it's gone
    const sessionsAfter = await listDaemonSessions();
    expect(sessionsAfter.length).toBe(0);
  }, 10000);

  it('stops daemon via HTTP', async () => {
    await startDaemon();
    
    await stopDaemon();
    expect(await isDaemonRunning()).toBe(false);
  });

  it('daemon kills children on shutdown', async () => {
    await startDaemon();
    
    // Spawn a session
    const result = await spawnDaemonSession(process.cwd());
    expect(result.success).toBe(true);
    const childPid = result.pid;
    
    // Wait for session to register
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Stop daemon
    await stopDaemon();
    
    // Check child is dead
    let childAlive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      childAlive = false;
    }
    expect(childAlive).toBe(false);
  }, 10000);
});