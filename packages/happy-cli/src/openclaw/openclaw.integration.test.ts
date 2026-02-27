/**
 * OpenClaw End-to-End Integration Test
 *
 * Tests the full message pipeline against the live gateway:
 *   OpenClawBackend → AgentMessage → AcpSessionManager → SessionEnvelope
 *
 * Also tests the daemon spawn path and session lifecycle.
 *
 * Requires: OpenClaw gateway running at ws://127.0.0.1:18789
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import WebSocket from 'ws';
import { OpenClawBackend } from './OpenClawBackend';
import { resetIdentityCache } from './openclawAuth';
import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import type { AgentMessage } from '@/agent/core/AgentBackend';
import type { SessionEnvelope } from '@slopus/happy-wire';
import {
  listDaemonSessions,
  stopDaemonSession,
} from '@/daemon/controlClient';
import { readDaemonState } from '@/persistence';

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? 'ws://127.0.0.1:18789';

function readGatewayToken(): string | undefined {
  try {
    const configPath = join(homedir(), '.openclaw', 'openclaw.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return config?.gateway?.auth?.token;
  } catch {
    return process.env.OPENCLAW_GATEWAY_TOKEN;
  }
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'openclaw-integ-'));
}

async function isGatewayReachable(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(url, { handshakeTimeout: 2000 });
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(result);
    };
    const timeout = setTimeout(() => finish(false), 2500);
    ws.on('open', () => finish(true));
    ws.on('error', () => finish(false));
  });
}

async function shouldRunOpenClawIntegration(): Promise<boolean> {
  if (!(await isGatewayReachable(GATEWAY_URL))) {
    console.log(`[openclaw-test] Skipping: gateway not reachable at ${GATEWAY_URL}`);
    return false;
  }
  const token = readGatewayToken();
  if (!token) {
    console.log('[openclaw-test] Skipping: no gateway token (OPENCLAW_GATEWAY_TOKEN or ~/.openclaw/openclaw.json)');
    return false;
  }
  return true;
}

async function isDaemonRunning(): Promise<boolean> {
  try {
    const state = await readDaemonState();
    return !!state?.httpPort;
  } catch {
    return false;
  }
}

describe.skipIf(!await shouldRunOpenClawIntegration())('OpenClaw integration - full message pipeline', () => {
  let backend: OpenClawBackend;
  let homeDir: string;

  beforeEach(() => {
    homeDir = makeTempDir();
    resetIdentityCache();
  });

  afterEach(async () => {
    await backend?.dispose();
  });

  it('should produce correct SessionEnvelopes for two consecutive prompts', async () => {
    const allMessages: AgentMessage[] = [];
    const allEnvelopes: SessionEnvelope[] = [];
    const sessionManager = new AcpSessionManager();
    let turnStarted = false;

    backend = new OpenClawBackend({
      homeDir,
      gatewayConfig: { url: GATEWAY_URL, token: readGatewayToken() },
      log: (msg) => console.log(`[integ] ${msg}`),
    });

    backend.onMessage((msg) => {
      allMessages.push(msg);

      if (msg.type === 'status' && msg.status === 'running' && !turnStarted) {
        turnStarted = true;
        allEnvelopes.push(...sessionManager.startTurn());
      }
      allEnvelopes.push(...sessionManager.mapMessage(msg));
      if (msg.type === 'status' && msg.status === 'idle') {
        allEnvelopes.push(...sessionManager.endTurn('completed'));
        turnStarted = false;
      }
    });

    const started = await backend.startSession();
    expect(started.sessionId).toBeTruthy();

    // --- Prompt 1: "who are you?" ---
    await backend.sendPrompt(started.sessionId, 'Who are you? Answer in one sentence.');
    await backend.waitForResponseComplete(30000);

    const turn1Messages = [...allMessages];
    const turn1Envelopes = [...allEnvelopes];
    const turn1Statuses = turn1Messages.filter((m) => m.type === 'status');
    const turn1Outputs = turn1Messages.filter((m) => m.type === 'model-output');

    expect(turn1Statuses.some((s) => (s as { status: string }).status === 'running')).toBe(true);
    expect(turn1Statuses.some((s) => (s as { status: string }).status === 'idle')).toBe(true);
    expect(turn1Outputs.length).toBeGreaterThan(0);

    const responseText1 = turn1Outputs
      .map((m) => (m as { textDelta?: string }).textDelta ?? '')
      .join('');
    console.log(`[integ] Response 1 ("who are you?"): "${responseText1}"`);
    expect(responseText1.length).toBeGreaterThan(0);

    const turn1EnvTypes = turn1Envelopes.map((e) => e.ev.t);
    expect(turn1EnvTypes).toContain('turn-start');
    expect(turn1EnvTypes).toContain('text');
    expect(turn1EnvTypes).toContain('turn-end');
    console.log(`[integ] Turn 1: ${turn1Envelopes.length} envelopes: ${turn1EnvTypes.join(', ')}`);

    // --- Prompt 2: "why are you?" ---
    const prevCount = allMessages.length;
    await backend.sendPrompt(started.sessionId, 'Why are you? Answer in one sentence.');
    await backend.waitForResponseComplete(30000);

    const turn2Messages = allMessages.slice(prevCount);
    const turn2Outputs = turn2Messages.filter((m) => m.type === 'model-output');
    const responseText2 = turn2Outputs
      .map((m) => (m as { textDelta?: string }).textDelta ?? '')
      .join('');
    console.log(`[integ] Response 2 ("why are you?"): "${responseText2}"`);
    expect(responseText2.length).toBeGreaterThan(0);

    // Verify we got two complete turns in the envelope stream
    const allEnvTypes = allEnvelopes.map((e) => e.ev.t);
    const turnStarts = allEnvTypes.filter((t) => t === 'turn-start');
    const turnEnds = allEnvTypes.filter((t) => t === 'turn-end');
    expect(turnStarts.length).toBe(2);
    expect(turnEnds.length).toBe(2);
    console.log(`[integ] Total: ${allEnvelopes.length} envelopes, 2 complete turns`);
  }, 60000);
});

describe.skipIf(!await shouldRunOpenClawIntegration())('OpenClaw integration - daemon lifecycle', { timeout: 30000 }, () => {
  it('should spawn openclaw session via daemon and stop it cleanly', async () => {
    const daemonRunning = await isDaemonRunning();
    if (!daemonRunning) {
      console.log('[integ] Skipping daemon test — daemon not running');
      return;
    }

    const token = readGatewayToken();
    if (!token) {
      console.log('[integ] Skipping daemon test — no gateway token');
      return;
    }

    // Spawn openclaw session via daemon HTTP API
    const state = await readDaemonState();
    const port = state!.httpPort;
    const spawnResponse = await fetch(`http://127.0.0.1:${port}/spawn-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        directory: process.cwd(),
        agent: 'openclaw',
        environmentVariables: {
          OPENCLAW_GATEWAY_URL: GATEWAY_URL,
          OPENCLAW_GATEWAY_TOKEN: token,
        },
      }),
    });
    const spawnResult = await spawnResponse.json() as { success: boolean; sessionId: string };
    console.log(`[integ] Spawned session: ${JSON.stringify(spawnResult)}`);
    expect(spawnResult.success).toBe(true);
    expect(spawnResult.sessionId).toBeTruthy();

    // Wait for session to register
    await new Promise((r) => setTimeout(r, 3000));

    // Verify it's tracked by daemon
    const sessions = await listDaemonSessions();
    const openclawSession = sessions.find(
      (s: { happySessionId: string }) => s.happySessionId === spawnResult.sessionId,
    );
    expect(openclawSession).toBeDefined();
    expect(openclawSession.startedBy).toBe('daemon');
    const pid = openclawSession.pid;
    console.log(`[integ] Session tracked: PID=${pid}, sessionId=${spawnResult.sessionId}`);

    // Verify the process is alive
    try {
      process.kill(pid, 0);
      console.log(`[integ] Process PID=${pid} is alive`);
    } catch {
      throw new Error(`Process PID=${pid} is NOT alive — session failed to start`);
    }

    // Stop the session
    const stopped = await stopDaemonSession(spawnResult.sessionId);
    expect(stopped).toBe(true);
    console.log(`[integ] Stopped session: ${spawnResult.sessionId}`);

    // Wait and verify process died
    await new Promise((r) => setTimeout(r, 2000));
    let processAlive = false;
    try {
      process.kill(pid, 0);
      processAlive = true;
    } catch {
      // expected — process should be dead
    }
    expect(processAlive).toBe(false);
    console.log(`[integ] Process PID=${pid} confirmed dead after stop`);

    // Verify session removed from daemon tracking
    const sessionsAfter = await listDaemonSessions();
    const stillTracked = sessionsAfter.find(
      (s: { happySessionId: string }) => s.happySessionId === spawnResult.sessionId,
    );
    expect(stillTracked).toBeUndefined();
    console.log(`[integ] Session removed from daemon tracking`);
  });

  it('should spawn a second session after first is killed', async () => {
    const daemonRunning = await isDaemonRunning();
    if (!daemonRunning) {
      console.log('[integ] Skipping — daemon not running');
      return;
    }

    const token = readGatewayToken();
    if (!token) {
      console.log('[integ] Skipping — no gateway token');
      return;
    }

    const state = await readDaemonState();
    const port = state!.httpPort;

    // First session
    const spawn1 = await fetch(`http://127.0.0.1:${port}/spawn-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        directory: process.cwd(),
        agent: 'openclaw',
        environmentVariables: {
          OPENCLAW_GATEWAY_URL: GATEWAY_URL,
          OPENCLAW_GATEWAY_TOKEN: token,
        },
      }),
    });
    const result1 = await spawn1.json() as { success: boolean; sessionId: string };
    expect(result1.success).toBe(true);
    console.log(`[integ] Session 1: ${result1.sessionId}`);

    await new Promise((r) => setTimeout(r, 3000));

    // Kill first session
    await stopDaemonSession(result1.sessionId);
    await new Promise((r) => setTimeout(r, 1000));

    // Second session
    const spawn2 = await fetch(`http://127.0.0.1:${port}/spawn-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        directory: process.cwd(),
        agent: 'openclaw',
        environmentVariables: {
          OPENCLAW_GATEWAY_URL: GATEWAY_URL,
          OPENCLAW_GATEWAY_TOKEN: token,
        },
      }),
    });
    const result2 = await spawn2.json() as { success: boolean; sessionId: string };
    expect(result2.success).toBe(true);
    console.log(`[integ] Session 2: ${result2.sessionId}`);

    await new Promise((r) => setTimeout(r, 3000));

    // Verify second session is tracked
    const sessions = await listDaemonSessions();
    const session2 = sessions.find(
      (s: { happySessionId: string }) => s.happySessionId === result2.sessionId,
    );
    expect(session2).toBeDefined();
    console.log(`[integ] Session 2 tracked: PID=${session2.pid}`);

    // Clean up
    await stopDaemonSession(result2.sessionId);
    console.log(`[integ] Cleaned up session 2`);
  });
});
