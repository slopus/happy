/**
 * OpenClaw Integration Tests
 *
 * All gateway-dependent tests live in this single file so they run
 * sequentially within vitest (one file = one thread) and don't race
 * for the shared OpenClaw gateway session.
 *
 * Groups:
 *   1. OpenClawSocket  — connect, list sessions, send message
 *   2. OpenClawBackend — connect, send prompt, receive model output
 *   3. Full pipeline   — Backend → AgentMessage → AcpSessionManager → SessionEnvelope
 *   4. Daemon lifecycle — spawn/stop sessions via daemon HTTP API
 *
 * Requires: OpenClaw gateway running at ws://127.0.0.1:18789
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import WebSocket from 'ws';
import { OpenClawSocket } from './OpenClawSocket';
import { OpenClawBackend } from './OpenClawBackend';
import { resetIdentityCache } from './openclawAuth';
import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import type { AgentMessage } from '@/agent/core/AgentBackend';
import type { SessionEnvelope } from '@/legacy/sessionProtocol';
import { getIntegrationEnv } from '@/testing/currentIntegrationEnv';
import {
  listDaemonSessions,
  stopDaemonSession,
} from '@/daemon/controlClient';
import { readDaemonState } from '@/persistence';

// ── Shared helpers ──────────────────────────────────────────────────────────

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? 'ws://127.0.0.1:18789';
const integrationEnv = getIntegrationEnv();

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

function extractOpenClawText(content: Array<{ type: string; text?: string }> | string | undefined): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
}

function isUpstreamAgentFailure(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes('agent failed before reply')
    || normalized.includes('oauth token refresh failed')
    || normalized.includes('re-authenticate');
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

const gatewayAvailable = await shouldRunOpenClawIntegration();

// ── 1. OpenClawSocket ───────────────────────────────────────────────────────

describe.skipIf(!gatewayAvailable)('OpenClawSocket - live gateway', () => {
  let socket: OpenClawSocket;
  let homeDir: string;

  beforeEach(() => {
    homeDir = makeTempDir();
    resetIdentityCache();
  });

  afterEach(() => {
    socket?.dispose();
  });

  it('should connect to the local gateway and list sessions', async () => {
    socket = new OpenClawSocket({
      homeDir,
      log: (msg) => console.log(`[test] ${msg}`),
    });

    const connected = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timed out')), 15000);
      socket.onStatusChange((status, error) => {
        if (status === 'connected') {
          clearTimeout(timeout);
          resolve();
        } else if (status === 'error') {
          clearTimeout(timeout);
          reject(new Error(`Connection error: ${error}`));
        } else if (status === 'pairing_required') {
          clearTimeout(timeout);
          reject(new Error('Device pairing required — approve via: openclaw devices list'));
        }
      });
    });

    socket.connect({ url: GATEWAY_URL, token: readGatewayToken() });
    await connected;

    expect(socket.isConnected()).toBe(true);
    expect(socket.getMainSessionKey()).toBeTruthy();
    expect(socket.getDeviceId()).toBeTruthy();

    // List sessions
    const sessions = await socket.listSessions();
    expect(Array.isArray(sessions)).toBe(true);
    console.log(`[test] Found ${sessions.length} sessions`);

    // Health check
    const healthy = await socket.healthCheck();
    expect(healthy).toBe(true);
  }, 20000);

  it('should send a message and receive streaming response', async () => {
    socket = new OpenClawSocket({
      homeDir,
      log: (msg) => console.log(`[test] ${msg}`),
    });

    const connected = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timed out')), 15000);
      socket.onStatusChange((status, error) => {
        if (status === 'connected') {
          clearTimeout(timeout);
          resolve();
        } else if (status === 'error') {
          clearTimeout(timeout);
          reject(new Error(`Connection error: ${error}`));
        } else if (status === 'pairing_required') {
          clearTimeout(timeout);
          reject(new Error('Device pairing required'));
        }
      });
    });

    socket.connect({ url: GATEWAY_URL, token: readGatewayToken() });
    await connected;

    const sessionKey = socket.getMainSessionKey()!;
    expect(sessionKey).toBeTruthy();

    // Collect streaming events
    const events: Array<{ state: string; raw: unknown }> = [];
    const responseComplete = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Response timed out')), 60000);
      socket.onEvent((event, payload) => {
        if (event !== 'chat') return;
        const chatEvent = payload as { state: string; sessionKey?: string; errorMessage?: string };
        events.push({ state: chatEvent.state, raw: payload });

        if (chatEvent.state === 'final') {
          clearTimeout(timeout);
          resolve();
        } else if (chatEvent.state === 'error') {
          clearTimeout(timeout);
          reject(new Error(`Chat error: ${chatEvent.errorMessage}`));
        }
      });
    });

    // Send a simple message
    const result = await socket.sendMessage(sessionKey, 'Say exactly: "hello from happy test". Nothing else.');
    expect(result.runId).toBeTruthy();
    console.log(`[test] Sent message, runId: ${result.runId}`);

    await responseComplete;

    // Healthy upstream runs stream started/delta/final. If the local gateway is up but the
    // upstream provider is unauthenticated, we still get a terminal final message with the
    // surfaced failure text; that still proves the socket transport path works.
    const states = events.map((e) => e.state);
    if (!states.includes('final') && events.length === 0) {
      console.log('[test] Skipping: model backend did not produce output (model may be offline)');
      return;
    }
    expect(states).toContain('final');

    // Extract text from the final message — content is in message.content, not delta field
    const finalEvent = events.find((e) => e.state === 'final');
    const finalPayload = finalEvent?.raw as { message?: { content?: Array<{ type: string; text?: string }> | string } };
    const fullText = extractOpenClawText(finalPayload?.message?.content);
    console.log(`[test] Response: ${fullText}`);
    expect(fullText.length).toBeGreaterThan(0);

    if (!isUpstreamAgentFailure(fullText)) {
      expect(states.some((s) => s === 'delta' || s === 'started')).toBe(true);
      expect(fullText.toLowerCase()).toContain('hello from happy test');
    }
  }, 90000);
});

// ── 2. OpenClawBackend ──────────────────────────────────────────────────────

describe.skipIf(!gatewayAvailable)('OpenClawBackend - live gateway', () => {
  let backend: OpenClawBackend;
  let homeDir: string;

  beforeEach(() => {
    homeDir = makeTempDir();
    resetIdentityCache();
  });

  afterEach(async () => {
    await backend?.dispose();
  });

  it('should connect, send prompt, and receive model-output messages', async () => {
    const messages: AgentMessage[] = [];

    backend = new OpenClawBackend({
      homeDir,
      gatewayConfig: {
        url: GATEWAY_URL,
        token: readGatewayToken(),
      },
      log: (msg) => console.log(`[backend-test] ${msg}`),
    });

    backend.onMessage((msg) => {
      messages.push(msg);
    });

    const started = await backend.startSession();
    expect(started.sessionId).toBeTruthy();
    expect(backend.getDeviceId()).toBeTruthy();

    await backend.sendPrompt(started.sessionId, 'Say exactly: "backend test ok". Nothing else.');
    await backend.waitForResponseComplete(60000);

    const outputs = messages.filter((m) => m.type === 'model-output');
    if (outputs.length === 0) {
      console.log('[backend-test] Skipping: model backend did not produce output (model may be offline)');
      return;
    }

    // Should have status:running, model-output deltas, and status:idle
    const statuses = messages.filter((m) => m.type === 'status').map((m) => (m as { status: string }).status);
    expect(statuses).toContain('running');
    expect(statuses).toContain('idle');
    expect(outputs.length).toBeGreaterThan(0);

    const fullText = outputs
      .map((m) => (m as { textDelta?: string }).textDelta ?? '')
      .join('');
    console.log(`[backend-test] Full response: ${fullText}`);
    expect(fullText.length).toBeGreaterThan(0);
    if (!isUpstreamAgentFailure(fullText)) {
      expect(fullText.toLowerCase()).toContain('backend test ok');
    }
  }, 60000);
});

// ── 3. Full message pipeline ────────────────────────────────────────────────

describe.skipIf(!gatewayAvailable)('OpenClaw integration - full message pipeline', () => {
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

    if (turn1Outputs.length === 0) {
      console.log('[integ] Skipping: model backend did not produce output (model may be offline)');
      return;
    }

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

// ── 4. Daemon lifecycle ─────────────────────────────────────────────────────

describe.skipIf(!gatewayAvailable)('OpenClaw integration - daemon lifecycle', { timeout: 30000 }, () => {
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

    const state = await readDaemonState();
    const port = state!.httpPort;
    const spawnResponse = await fetch(`http://127.0.0.1:${port}/spawn-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        directory: integrationEnv.projectPath,
        agent: 'openclaw',
        environmentVariables: {
          OPENCLAW_GATEWAY_URL: GATEWAY_URL,
          OPENCLAW_GATEWAY_TOKEN: token,
        },
      }),
    });
    const spawnResult = await spawnResponse.json() as { success: boolean; sessionId: string };
    expect(spawnResult.success).toBe(true);
    expect(spawnResult.sessionId).toBeTruthy();

    await new Promise((r) => setTimeout(r, 3000));

    const sessions = await listDaemonSessions();
    const openclawSession = sessions.find(
      (s: { happySessionId: string }) => s.happySessionId === spawnResult.sessionId,
    );
    expect(openclawSession).toBeDefined();
    expect(openclawSession.startedBy).toBe('daemon');
    const pid = openclawSession.pid;

    try {
      process.kill(pid, 0);
    } catch {
      throw new Error(`Process PID=${pid} is NOT alive — session failed to start`);
    }

    const stopped = await stopDaemonSession(spawnResult.sessionId);
    expect(stopped).toBe(true);

    await new Promise((r) => setTimeout(r, 2000));
    let processAlive = false;
    try { process.kill(pid, 0); processAlive = true; } catch {}
    expect(processAlive).toBe(false);

    const sessionsAfter = await listDaemonSessions();
    const stillTracked = sessionsAfter.find(
      (s: { happySessionId: string }) => s.happySessionId === spawnResult.sessionId,
    );
    expect(stillTracked).toBeUndefined();
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

    const spawn1 = await fetch(`http://127.0.0.1:${port}/spawn-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        directory: integrationEnv.projectPath,
        agent: 'openclaw',
        environmentVariables: {
          OPENCLAW_GATEWAY_URL: GATEWAY_URL,
          OPENCLAW_GATEWAY_TOKEN: token,
        },
      }),
    });
    const result1 = await spawn1.json() as { success: boolean; sessionId: string };
    expect(result1.success).toBe(true);
    await new Promise((r) => setTimeout(r, 3000));

    await stopDaemonSession(result1.sessionId);
    await new Promise((r) => setTimeout(r, 1000));

    const spawn2 = await fetch(`http://127.0.0.1:${port}/spawn-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        directory: integrationEnv.projectPath,
        agent: 'openclaw',
        environmentVariables: {
          OPENCLAW_GATEWAY_URL: GATEWAY_URL,
          OPENCLAW_GATEWAY_TOKEN: token,
        },
      }),
    });
    const result2 = await spawn2.json() as { success: boolean; sessionId: string };
    expect(result2.success).toBe(true);
    await new Promise((r) => setTimeout(r, 3000));

    const sessions = await listDaemonSessions();
    const session2 = sessions.find(
      (s: { happySessionId: string }) => s.happySessionId === result2.sessionId,
    );
    expect(session2).toBeDefined();

    await stopDaemonSession(result2.sessionId);
  });
});
