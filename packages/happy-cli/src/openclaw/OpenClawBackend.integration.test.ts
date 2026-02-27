import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import WebSocket from 'ws';
import { OpenClawBackend } from './OpenClawBackend';
import { resetIdentityCache } from './openclawAuth';
import type { AgentMessage } from '@/agent/core/AgentBackend';

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
  return mkdtempSync(join(tmpdir(), 'openclaw-backend-test-'));
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

describe.skipIf(!await shouldRunOpenClawIntegration())('OpenClawBackend - live gateway', () => {
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

    // Should have status:running, model-output deltas, and status:idle
    const statuses = messages.filter((m) => m.type === 'status').map((m) => (m as { status: string }).status);
    expect(statuses).toContain('running');
    expect(statuses).toContain('idle');

    const outputs = messages.filter((m) => m.type === 'model-output');
    expect(outputs.length).toBeGreaterThan(0);

    const fullText = outputs
      .map((m) => (m as { textDelta?: string }).textDelta ?? '')
      .join('');
    console.log(`[backend-test] Full response: ${fullText}`);
    expect(fullText.toLowerCase()).toContain('backend test ok');
  }, 60000);
});
