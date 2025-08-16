import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { stopDaemon, isDaemonRunning, getDaemonState } from './utils';
import { listDaemonSessions, stopDaemonSession, spawnDaemonSession } from './controlClient';
import { spawn } from 'child_process';
import { join } from 'path';
import { configuration } from '@/configuration';
import { existsSync, unlinkSync } from 'fs';
import { readFile } from 'fs/promises';
import { readCredentials } from '@/persistence/persistence';
import { projectPath } from '@/projectPath';

// Helper to start daemon via CLI (true integration test)
async function startDaemonViaCLI(): Promise<void> {
  // Use the built binary just like production
  const happyBinPath = join(projectPath(), 'bin', 'happy.mjs');
  const child = spawn(happyBinPath, ['daemon', 'start'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout?.on('data', (data) => output += data.toString());
  child.stderr?.on('data', (data) => output += data.toString());

  // Wait for the daemon start command to complete
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', reject);
  });

  if (exitCode !== 0) {
    console.error('Daemon start output:', output);
    throw new Error(`Daemon start command failed with code ${exitCode}: ${output}`);
  }

  // The daemon start command should have spawned a detached daemon
  // Give it a moment to initialize and write state file
  await new Promise(r => setTimeout(r, 1000));
  
  // Verify daemon actually started
  if (!existsSync(configuration.daemonStateFile)) {
    throw new Error('Daemon state file not created');
  }
  
  if (!await isDaemonRunning()) {
    throw new Error('Daemon did not start successfully');
  }
}

describe('Daemon HTTP Control', () => {
  beforeAll(async () => {
    // This test requires auth to be set up in ~/.happy-dev
    // Run with: yarn test:local src/daemon/daemon.test.ts
    // The test:local command loads .env.dev-local-server which sets HAPPY_HOME_DIR=~/.happy-dev
    
    const creds = await readCredentials();
    if (!creds) {
      throw new Error('No credentials found in ~/.happy-dev. Run "yarn dev:local-server" first to authenticate');
    }
    
    if (await isDaemonRunning()) {
      throw new Error('Daemon already running - stop it before running tests');
    }
  }, 30000);

  afterEach(async () => {
    // ALWAYS stop daemon after each test
    await stopDaemon();
    const stillRunning = await isDaemonRunning();
    expect(stillRunning).toBe(false);
  });

  it('starts daemon with HTTP server', async () => {
    await startDaemonViaCLI();
    
    const state = await getDaemonState();
    expect(state).toBeTruthy();
    expect(state!.httpPort).toBeGreaterThan(0);
  }, 15000);

  it('lists empty sessions initially', async () => {
    await startDaemonViaCLI();
    
    const sessions = await listDaemonSessions();
    expect(sessions).toEqual([]);
  }, 15000);

  it('tracks externally started sessions', async () => {
    await startDaemonViaCLI();
    const state = await getDaemonState();
    
    // Start a happy session manually using the binary
    const happyBinPath = join(projectPath(), 'bin', 'happy.mjs');
    const child = spawn(happyBinPath, [
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
  }, 10000);

  it('spawns sessions via HTTP', async () => {
    await startDaemonViaCLI();
    
    const result = await spawnDaemonSession(process.cwd());
    expect(result.success).toBe(true);
    expect(result.pid).toBeGreaterThan(0);
    
    const sessions = await listDaemonSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].startedBy).toBe('daemon');
    
    // Wait for the spawned session to call webhook and get its happySessionId
    let sessionId: string | undefined;
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      const updatedSessions = await listDaemonSessions();
      console.log(`Attempt ${i}: Found ${updatedSessions.length} sessions, happySessionId:`, updatedSessions[0]?.happySessionId);
      if (updatedSessions[0]?.happySessionId) {
        sessionId = updatedSessions[0].happySessionId;
        console.log(`✅ WEBHOOK WORKED! Found sessionId: ${sessionId}`);
        break;
      }
    }
    
    expect(sessionId).toBeDefined();
    
    // Clean up spawned session using its actual sessionId
    await stopDaemonSession(sessionId!);
    
    // Give it a moment to clean up
    await new Promise(r => setTimeout(r, 500));
    
    // Verify cleanup
    const sessionsAfter = await listDaemonSessions();
    expect(sessionsAfter.length).toBe(0);
  }, 15000);

  it('stops daemon via HTTP', async () => {
    await startDaemonViaCLI();
    
    await stopDaemon();
    expect(await isDaemonRunning()).toBe(false);
  }, 15000);

  it('daemon kills children on shutdown', async () => {
    await startDaemonViaCLI();
    
    // Spawn a session
    const result = await spawnDaemonSession(process.cwd());
    expect(result.success).toBe(true);
    const childPid = result.pid;
    
    // Stop daemon - should kill child
    await stopDaemon();
    
    // Wait a bit for child to die
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Check if child is dead
    let childAlive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      childAlive = false;
    }
    expect(childAlive).toBe(false);
  }, 10000);
});