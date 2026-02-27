import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import WebSocket from 'ws';
import { OpenClawSocket } from './OpenClawSocket';
import { buildDeviceAuthPayload, loadOrCreateDeviceIdentity, resetIdentityCache, signPayload, base64UrlDecode } from './openclawAuth';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

// Configure SHA-512 for verification in tests (@noble/ed25519 v3)
ed.hashes.sha512 = (message: Uint8Array) => sha512(message);

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
  return mkdtempSync(join(tmpdir(), 'openclaw-test-'));
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

describe('openclawAuth', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = makeTempDir();
    resetIdentityCache();
  });

  it('should generate and persist device identity', async () => {
    const identity1 = await loadOrCreateDeviceIdentity(homeDir);
    expect(identity1.deviceId).toBeTruthy();
    expect(identity1.publicKey).toBeTruthy();
    expect(identity1.privateKey).toBeTruthy();
    expect(identity1.deviceId.length).toBe(64); // SHA-256 hex

    // Second call should return same identity (cached)
    const identity2 = await loadOrCreateDeviceIdentity(homeDir);
    expect(identity2.deviceId).toBe(identity1.deviceId);

    // After clearing cache, should load from file
    resetIdentityCache();
    const identity3 = await loadOrCreateDeviceIdentity(homeDir);
    expect(identity3.deviceId).toBe(identity1.deviceId);
  });

  it('should build correct v2 payload', () => {
    const payload = buildDeviceAuthPayload({
      deviceId: 'abc123',
      clientId: 'node-host',
      clientMode: 'backend',
      role: 'operator',
      scopes: ['operator.admin'],
      signedAtMs: 1700000000000,
      token: null,
      nonce: 'testnonce',
    });
    expect(payload).toBe('v2|abc123|node-host|backend|operator|operator.admin|1700000000000||testnonce');
  });

  it('should include token in v2 payload when provided', () => {
    const payload = buildDeviceAuthPayload({
      deviceId: 'abc123',
      clientId: 'node-host',
      clientMode: 'backend',
      role: 'operator',
      scopes: ['operator.admin', 'operator.approvals'],
      signedAtMs: 1700000000000,
      token: 'mytoken',
      nonce: 'testnonce',
    });
    expect(payload).toBe('v2|abc123|node-host|backend|operator|operator.admin,operator.approvals|1700000000000|mytoken|testnonce');
  });

  it('should produce valid Ed25519 signatures', async () => {
    const identity = await loadOrCreateDeviceIdentity(homeDir);
    const testPayload = 'v2|test|node-host|backend|operator|operator.admin|1700000000000||nonce123';
    const signature = await signPayload(identity.privateKey, testPayload);

    expect(signature).toBeTruthy();
    expect(signature.length).toBeGreaterThan(0);

    // Verify signature is valid
    const sigBytes = base64UrlDecode(signature);
    const pubKeyBytes = base64UrlDecode(identity.publicKey);
    const msgBytes = new TextEncoder().encode(testPayload);
    const valid = await ed.verify(sigBytes, msgBytes, pubKeyBytes);
    expect(valid).toBe(true);
  });
});

describe.skipIf(!await shouldRunOpenClawIntegration())('OpenClawSocket - live gateway', () => {
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

    // Should have received deltas and final (started may arrive before listener is attached)
    const states = events.map((e) => e.state);
    expect(states).toContain('final');
    expect(states.some((s) => s === 'delta' || s === 'started')).toBe(true);

    // Extract text from the final message — content is in message.content, not delta field
    const finalEvent = events.find((e) => e.state === 'final');
    const finalPayload = finalEvent?.raw as { message?: { content?: Array<{ type: string; text?: string }> | string } };
    const content = finalPayload?.message?.content;
    let fullText = '';
    if (typeof content === 'string') {
      fullText = content;
    } else if (Array.isArray(content)) {
      fullText = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    }
    console.log(`[test] Response: ${fullText}`);
    expect(fullText.length).toBeGreaterThan(0);
  }, 90000);
});
