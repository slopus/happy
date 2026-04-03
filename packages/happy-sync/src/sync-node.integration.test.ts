import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { SyncNode, SyncNodeTokenClaimsSchema, type SyncNodeToken } from './sync-node';
import type { SessionMessage } from './acpx-types';
import {
  encryptMessage,
  getRandomBytes,
  libsodiumEncryptForPublicKey,
  type KeyMaterial,
} from './encryption';
import type { SessionID } from './sync-types';

const TEST_PORT = process.env.HAPPY_TEST_SERVER_PORT ?? '34105';
const SERVER_URL = process.env.HAPPY_TEST_SERVER_URL ?? `http://127.0.0.1:${TEST_PORT}`;
const SERVER_DIR = fileURLToPath(new URL('../../happy-server', import.meta.url));
let AUTH_TOKEN = process.env.HAPPY_TEST_TOKEN ?? '';
let serverProcess: ChildProcess | null = null;
let testDataDir: string | null = null;
let serverLog = '';

function makeAccountToken(): SyncNodeToken {
  return {
    raw: AUTH_TOKEN,
    claims: {
      scope: { type: 'account' as const, userId: 'test-user' },
      permissions: ['read', 'write', 'admin'],
    },
  };
}

async function makeSessionToken(sessionId: string): Promise<SyncNodeToken> {
  const response = await fetch(`${SERVER_URL}/v1/sessions/${sessionId}/token`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    throw new Error(`Failed to mint session token: ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as {
    token: string;
    claims: unknown;
  };

  return {
    raw: data.token,
    claims: SyncNodeTokenClaimsSchema.parse(data.claims),
  };
}

function makeKeyMaterial(): KeyMaterial {
  return {
    key: getRandomBytes(32),
    variant: 'dataKey',
  };
}

function makeContentKeyPair() {
  return nacl.box.keyPair();
}

function encodeSessionDataKey(sessionKey: Uint8Array, recipientPublicKey: Uint8Array): string {
  const encrypted = libsodiumEncryptForPublicKey(sessionKey, recipientPublicKey);
  const bundle = new Uint8Array(encrypted.length + 1);
  bundle[0] = 0;
  bundle.set(encrypted, 1);
  return Buffer.from(bundle).toString('base64');
}

function decryptSessionDataKey(encryptedDataKey: string, recipientSecretKey: Uint8Array): Uint8Array | null {
  const bundle = Buffer.from(encryptedDataKey, 'base64');
  if (bundle[0] !== 0) {
    return null;
  }

  const encrypted = bundle.subarray(1);
  const ephemeralPublicKey = encrypted.subarray(0, 32);
  const nonce = encrypted.subarray(32, 56);
  const ciphertext = encrypted.subarray(56);
  const decrypted = nacl.box.open(ciphertext, nonce, ephemeralPublicKey, recipientSecretKey);
  return decrypted ? new Uint8Array(decrypted) : null;
}

function makeSessionKeyResolver(contentKeyPair: { secretKey: Uint8Array }) {
  return async ({
    encryptedDataKey,
    defaultKeyMaterial,
  }: {
    encryptedDataKey: string | null;
    defaultKeyMaterial: KeyMaterial;
  }): Promise<KeyMaterial | null> => {
    if (!encryptedDataKey) {
      return defaultKeyMaterial;
    }

    const decrypted = decryptSessionDataKey(encryptedDataKey, contentKeyPair.secretKey);
    if (!decrypted) {
      return null;
    }

    return {
      key: decrypted,
      variant: 'dataKey',
    };
  };
}

async function createLegacyEncryptedSession(opts: {
  tag: string;
  sessionKeyMaterial: KeyMaterial;
  contentPublicKey: Uint8Array;
  sessionMetadata: {
    session: {
      directory: string;
      projectID: string;
      title: string;
      parentID: string | null;
    };
    metadata?: unknown;
  };
  agentState?: unknown;
}): Promise<SessionID> {
  const response = await fetch(`${SERVER_URL}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tag: opts.tag,
      metadata: encryptMessage(opts.sessionKeyMaterial, opts.sessionMetadata),
      agentState: opts.agentState
        ? encryptMessage(opts.sessionKeyMaterial, opts.agentState)
        : null,
      dataEncryptionKey: encodeSessionDataKey(opts.sessionKeyMaterial.key, opts.contentPublicKey),
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create encrypted session: ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as { session?: { id?: string } };
  if (!data.session?.id) {
    throw new Error('Encrypted session create route did not return a session id');
  }

  return data.session.id as SessionID;
}

function makeUserMessage(id: string): SessionMessage {
  return {
    User: {
      id: `msg_${id}`,
      content: [{ Text: `Test message ${id}` }],
    },
  };
}

function makeTodoMessage(): SessionMessage {
  return {
    Agent: {
      content: [{
        ToolUse: {
          id: 'tu_todo',
          name: 'TodoWrite',
          raw_input: '{"todos":[]}',
          input: {},
          is_input_complete: true,
        },
      }],
      tool_results: {
        tu_todo: {
          tool_use_id: 'tu_todo',
          tool_name: 'TodoWrite',
          is_error: false,
          content: {
            Text: '{"todos":[{"content":"Add due dates","status":"pending","priority":"high"},{"content":"Export to JSON","status":"completed"}]}',
          },
        },
      },
    },
  };
}

function waitForCondition(
  check: () => boolean,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for condition'));
      }
    }, intervalMs);
  });
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed (${command} ${args.join(' ')}):\n${output}`));
    });
  });
}

async function waitForServerReady(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${url}/v1/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: '', challenge: '', signature: '' }),
      });
      if (response.status >= 400) {
        return;
      }
    } catch {
      // Server is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for test server at ${url}\n${serverLog}`);
}

function toBase64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

async function createAuthToken(url: string): Promise<string> {
  const keyPair = nacl.sign.keyPair();
  const challenge = randomBytes(32);
  const signature = nacl.sign.detached(challenge, keyPair.secretKey);

  const response = await fetch(`${url}/v1/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: toBase64(keyPair.publicKey),
      challenge: toBase64(challenge),
      signature: toBase64(signature),
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create test auth token: ${response.status} ${await response.text()}\n${serverLog}`);
  }

  const data = await response.json() as { token?: string };
  if (!data.token) {
    throw new Error('Auth endpoint did not return a token');
  }
  return data.token;
}

async function startStandaloneServer(): Promise<void> {
  if (AUTH_TOKEN) {
    return;
  }

  testDataDir = await mkdtemp(join(tmpdir(), 'happy-sync-integration-'));
  const env = {
    ...process.env,
    PORT: TEST_PORT,
    DATA_DIR: testDataDir,
    PGLITE_DIR: join(testDataDir, 'pglite'),
    METRICS_ENABLED: 'false',
  };

  await runCommand('npx', ['tsx', '--env-file=.env.dev', './sources/standalone.ts', 'migrate'], SERVER_DIR, env);

  const child = spawn('npx', ['tsx', '--env-file=.env.dev', './sources/standalone.ts', 'serve'], {
    cwd: SERVER_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess = child;
  child.stdout?.on('data', (chunk) => {
    serverLog += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    serverLog += String(chunk);
  });

  await waitForServerReady(SERVER_URL);
  AUTH_TOKEN = await createAuthToken(SERVER_URL);
}

async function stopStandaloneServer(): Promise<void> {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      serverProcess?.once('exit', () => resolve());
      setTimeout(resolve, 3000);
    });
  }

  if (testDataDir) {
    await rm(testDataDir, { recursive: true, force: true });
  }
}

describe('Level 1: Sync Engine Integration', () => {
  let keyMaterial: KeyMaterial;

  beforeAll(async () => {
    await startStandaloneServer();
    keyMaterial = makeKeyMaterial();
  }, 30000);

  afterAll(async () => {
    await stopStandaloneServer();
  });

  it('account-scoped connect hydrates existing sessions from the server', async () => {
    const creator = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

    try {
      const sessionId = await creator.createSession({
        directory: '/hydration-test',
        projectID: 'hydration-project',
        title: 'Hydration test',
      });

      const consumer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
      await consumer.connect();

      const hydrated = consumer.listSessions().find((session) => session.id === sessionId);
      expect(hydrated?.directory).toBe('/hydration-test');
      expect(hydrated?.projectID).toBe('hydration-project');
      expect(hydrated?.title).toBe('Hydration test');

      consumer.disconnect();
    } finally {
      creator.disconnect();
    }
  });

  it('hydrates sessions encrypted with distinct per-session data keys', async () => {
    const contentKeyPair = makeContentKeyPair();
    const sessionKeyMaterial = makeKeyMaterial();
    const sessionId = await createLegacyEncryptedSession({
      tag: `encrypted-hydration-${Date.now()}`,
      sessionKeyMaterial,
      contentPublicKey: contentKeyPair.publicKey,
      sessionMetadata: {
        session: {
          directory: '/encrypted-hydration',
          projectID: 'encrypted-project',
          title: 'Encrypted hydration',
          parentID: null,
        },
        metadata: {
          host: 'integration-host',
          lifecycleState: 'running',
        },
      },
      agentState: {
        controlledByUser: false,
      },
    });

    const consumer = new SyncNode(
      SERVER_URL,
      makeAccountToken(),
      makeKeyMaterial(),
      { resolveSessionKeyMaterial: makeSessionKeyResolver(contentKeyPair) },
    );

    try {
      await consumer.connect();

      const hydrated = consumer.listSessions().find((session) => session.id === sessionId);
      expect(hydrated?.directory).toBe('/encrypted-hydration');
      expect(consumer.state.sessions.get(sessionId as string)?.metadata).toEqual({
        host: 'integration-host',
        lifecycleState: 'running',
      });
      expect(consumer.state.sessions.get(sessionId as string)?.controlledByUser).toBe(false);
    } finally {
      consumer.disconnect();
    }
  });

  it('sends a raw SessionMessage through producer and consumer receives it via fetch', async () => {
    const producer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
    const consumer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

    try {
      const sessionId = await producer.createSession({
        directory: '/round-trip',
        projectID: 'test-project',
        title: 'Round-trip test',
      });

      const msg = makeUserMessage('roundtrip1');
      await producer.sendMessage(sessionId, msg);

      await consumer.fetchMessages(sessionId);
      const session = consumer.state.sessions.get(sessionId as string);
      expect(session?.messages).toContainEqual(msg);
    } finally {
      producer.disconnect();
      consumer.disconnect();
    }
  });

  it('stores ciphertext on the server without plaintext content', async () => {
    const node = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

    try {
      const sessionId = await node.createSession({
        directory: '/ciphertext-test',
        projectID: 'test-project',
        title: 'Ciphertext test',
      });

      await node.sendMessage(sessionId, makeUserMessage('enc1'));

      const res = await fetch(`${SERVER_URL}/v3/sessions/${sessionId}/messages`, {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      });
      const data = await res.json() as { messages: Array<{ content: unknown }> };

      expect(data.messages.length).toBeGreaterThan(0);
      const rawContent = JSON.stringify(data.messages[0].content);
      expect(rawContent).not.toContain('Test message enc1');
      expect(rawContent).toContain('encrypted');
    } finally {
      node.disconnect();
    }
  });

  it('reads pending permissions from metadata updates and resolves them via metadata CAS', async () => {
    const producer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
    const consumer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

    try {
      await producer.connect();
      await consumer.connect();

      const sessionId = await producer.createSession({
        directory: '/metadata-permission',
        projectID: 'test-project',
        title: 'Metadata permission',
      });

      await producer.sendPermissionRequest(sessionId, {
        callID: 'call_permission_1',
        tool: 'Write',
        patterns: ['/metadata-permission.txt'],
        input: { path: '/metadata-permission.txt', content: 'hello' },
      });

      await waitForCondition(() => {
        const session = consumer.state.sessions.get(sessionId as string);
        return Boolean(session?.permissions.length);
      });

      const pending = consumer.state.sessions.get(sessionId as string)!.permissions[0];
      expect(pending.permissionId).toBeDefined();
      expect(pending.resolved).toBe(false);
      expect(consumer.state.sessions.get(sessionId as string)?.status).toEqual({ type: 'blocked', reason: 'permission' });

      await consumer.approvePermission(sessionId, pending.permissionId, {
        decision: 'always',
        allowTools: ['Write'],
      });

      await waitForCondition(() => {
        const session = producer.state.sessions.get(sessionId as string);
        return Boolean(session?.permissions[0]?.resolved);
      });

      expect(producer.state.sessions.get(sessionId as string)?.permissions[0]?.resolved).toBe(true);
      expect(consumer.state.sessions.get(sessionId as string)?.permissions[0]?.resolved).toBe(true);
    } finally {
      producer.disconnect();
      consumer.disconnect();
    }
  });

  it('derives runtime config from metadata updates', async () => {
    const producer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
    const consumer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

    try {
      await producer.connect();
      await consumer.connect();

      const sessionId = await producer.createSession({
        directory: '/runtime-config',
        projectID: 'test-project',
        title: 'Runtime config',
      });

      await producer.sendRuntimeConfigChange(sessionId, {
        source: 'user',
        permissionMode: 'read-only',
      });
      await producer.sendRuntimeConfigChange(sessionId, {
        source: 'user',
        model: 'gpt-5.4',
        appendSystemPrompt: 'Stay concise.',
      });

      await waitForCondition(() => {
        const session = consumer.state.sessions.get(sessionId as string);
        return session?.runtimeConfig?.model === 'gpt-5.4';
      });

      const session = consumer.state.sessions.get(sessionId as string)!;
      expect(session.runtimeConfig?.permissionMode).toBe('read-only');
      expect(session.runtimeConfig?.model).toBe('gpt-5.4');
      expect(session.runtimeConfig?.appendSystemPrompt).toBe('Stay concise.');
    } finally {
      producer.disconnect();
      consumer.disconnect();
    }
  });

  it('derives completed status from archived lifecycle metadata', async () => {
    const producer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
    const consumer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

    try {
      await producer.connect();
      await consumer.connect();

      const sessionId = await producer.createSession({
        directory: '/session-end',
        projectID: 'test-project',
        title: 'Session end',
      });

      await producer.sendSessionEnd(sessionId, { reason: 'completed' });

      await waitForCondition(() => consumer.state.sessions.get(sessionId as string)?.status.type === 'completed');
      expect(consumer.state.sessions.get(sessionId as string)?.lifecycleState).toBe('archived');
      expect(consumer.state.sessions.get(sessionId as string)?.status).toEqual({ type: 'completed' });
    } finally {
      producer.disconnect();
      consumer.disconnect();
    }
  });

  it('derives todos from acpx tool results after full encrypt-store-fetch cycle', async () => {
    const producer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
    const consumer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

    try {
      const sessionId = await producer.createSession({
        directory: '/todo-roundtrip',
        projectID: 'test-project',
        title: 'Todo round-trip',
      });

      await producer.sendMessage(sessionId, makeTodoMessage());
      await consumer.fetchMessages(sessionId);

      expect(consumer.state.sessions.get(sessionId as string)?.todos).toEqual([
        { content: 'Add due dates', status: 'pending', priority: 'high' },
        { content: 'Export to JSON', status: 'completed', priority: 'medium' },
      ]);
    } finally {
      producer.disconnect();
      consumer.disconnect();
    }
  });

  it('enforces session-scoped token restrictions', async () => {
    const accountNode = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

    try {
      const session1 = await accountNode.createSession({
        directory: '/scoped-one',
        projectID: 'test-project',
        title: 'Scoped one',
      });
      const session2 = await accountNode.createSession({
        directory: '/scoped-two',
        projectID: 'test-project',
        title: 'Scoped two',
      });

      const scopedNode = new SyncNode(
        SERVER_URL,
        await makeSessionToken(session1 as string),
        keyMaterial,
      );

      await scopedNode.fetchMessages(session1);
      await expect(scopedNode.fetchMessages(session2)).rejects.toThrow(
        `Session-scoped token cannot access session ${session2}`,
      );
    } finally {
      accountNode.disconnect();
    }
  });
});
