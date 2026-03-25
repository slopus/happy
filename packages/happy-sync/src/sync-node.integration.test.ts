/**
 * Level 1: Sync Engine Integration Tests
 *
 * Tests SyncNode transport + encryption with a real happy-server (standalone
 * mode with PGlite). No LLM. Runs in seconds.
 *
 * Setup: Boot a real happy-server, create two SyncNode instances — one acting
 * as producer (CLI-side), one acting as consumer (app-side). Feed synthetic
 * messages through one, verify they arrive on the other.
 *
 * Default behavior:
 * - Boots a standalone happy-server on a temporary PGlite database
 * - Creates a fresh auth token via the real `/v1/auth` route
 *
 * Optional overrides:
 * - `HAPPY_TEST_SERVER_URL` + `HAPPY_TEST_TOKEN` to reuse an existing server
 * - `HAPPY_TEST_SERVER_PORT` to change the auto-boot port
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import nacl from 'tweetnacl';
import { SyncNode, SyncNodeTokenClaimsSchema, type SyncNodeToken } from './sync-node';
import { type KeyMaterial, encryptMessage, getRandomBytes, libsodiumEncryptForPublicKey } from './encryption';
import type { MessageWithParts, SessionID, MessageID, PartID } from './protocol';

// ─── Config ──────────────────────────────────────────────────────────────────

const TEST_PORT = process.env.HAPPY_TEST_SERVER_PORT ?? '34105';
const SERVER_URL = process.env.HAPPY_TEST_SERVER_URL ?? `http://127.0.0.1:${TEST_PORT}`;
const SERVER_DIR = fileURLToPath(new URL('../../happy-server', import.meta.url));
let AUTH_TOKEN = process.env.HAPPY_TEST_TOKEN ?? '';
let serverProcess: ChildProcess | null = null;
let testDataDir: string | null = null;
let serverLog = '';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

    const data = await response.json() as {
        session?: {
            id?: string;
        };
    };

    if (!data.session?.id) {
        throw new Error('Encrypted session create route did not return a session id');
    }

    return data.session.id as SessionID;
}

function makeUserMessage(id: string, sessionId: SessionID): MessageWithParts {
    return {
        info: {
            id: `msg_${id}` as MessageID,
            sessionID: sessionId,
            role: 'user' as const,
            time: { created: Date.now() },
            agent: 'claude',
            model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
        },
        parts: [{
            id: `prt_${id}` as PartID,
            sessionID: sessionId,
            messageID: `msg_${id}` as MessageID,
            type: 'text' as const,
            text: `Test message ${id}`,
        }],
    };
}

function makeAssistantMessage(
    id: string,
    parentId: string,
    sessionId: SessionID,
): MessageWithParts {
    return {
        info: {
            id: `msg_${id}` as MessageID,
            sessionID: sessionId,
            role: 'assistant' as const,
            time: { created: Date.now() },
            parentID: `msg_${parentId}` as MessageID,
            modelID: 'claude-sonnet-4-20250514',
            providerID: 'anthropic',
            agent: 'claude',
            path: { cwd: '/test', root: '/test' },
            cost: 0.001,
            tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{
            id: `prt_${id}_start` as PartID,
            sessionID: sessionId,
            messageID: `msg_${id}` as MessageID,
            type: 'step-start' as const,
        }, {
            id: `prt_${id}_text` as PartID,
            sessionID: sessionId,
            messageID: `msg_${id}` as MessageID,
            type: 'text' as const,
            text: `Response to ${parentId}`,
        }, {
            id: `prt_${id}_end` as PartID,
            sessionID: sessionId,
            messageID: `msg_${id}` as MessageID,
            type: 'step-finish' as const,
            reason: 'end_turn',
            cost: 0.001,
            tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        }],
    };
}

function makeBlockedToolMessage(
    id: string,
    parentId: string,
    sessionId: SessionID,
    blockType: 'permission' | 'question' = 'permission',
): MessageWithParts {
    const block = blockType === 'permission'
        ? {
            type: 'permission' as const,
            id: `perm_${id}`,
            permission: 'Write',
            patterns: ['/test.ts'],
            always: ['Write'],
            metadata: {},
        }
        : {
            type: 'question' as const,
            id: `q_${id}`,
            questions: [{
                question: 'Which framework?',
                header: 'Framework',
                options: [
                    { label: 'Vitest', description: 'Fast' },
                    { label: 'Jest', description: 'Popular' },
                ],
            }],
        };

    return {
        info: {
            id: `msg_${id}` as MessageID,
            sessionID: sessionId,
            role: 'assistant' as const,
            time: { created: Date.now() },
            parentID: `msg_${parentId}` as MessageID,
            modelID: 'claude-sonnet-4-20250514',
            providerID: 'anthropic',
            agent: 'claude',
            path: { cwd: '/test', root: '/test' },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{
            id: `prt_${id}_tool` as PartID,
            sessionID: sessionId,
            messageID: `msg_${id}` as MessageID,
            type: 'tool' as const,
            callID: `call_${id}`,
            tool: blockType === 'permission' ? 'Write' : 'AskUser',
            state: {
                status: 'blocked' as const,
                input: {},
                title: blockType === 'permission' ? 'Write file' : 'Ask user',
                time: { start: Date.now() },
                block,
            },
        }],
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Level 1: Sync Engine Integration', () => {
    let keyMaterial: KeyMaterial;

    beforeAll(async () => {
        await startStandaloneServer();
        keyMaterial = makeKeyMaterial();
    }, 30000);

    afterAll(async () => {
        await stopStandaloneServer();
    });

    describe('Session hydration', () => {
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
                expect(hydrated).toBeDefined();
                expect(hydrated?.directory).toBe('/hydration-test');
                expect(hydrated?.projectID).toBe('hydration-project');
                expect(hydrated?.title).toBe('Hydration test');

                consumer.disconnect();
            } finally {
                creator.disconnect();
            }
        });

        it('account-scoped connect hydrates sessions encrypted with distinct per-session data keys', async () => {
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
                    },
                },
                agentState: {
                    controlledByUser: false,
                },
            });

            const producer = new SyncNode(
                SERVER_URL,
                await makeSessionToken(sessionId as string),
                sessionKeyMaterial,
            );
            const consumer = new SyncNode(
                SERVER_URL,
                makeAccountToken(),
                makeKeyMaterial(),
                {
                    resolveSessionKeyMaterial: makeSessionKeyResolver(contentKeyPair),
                },
            );

            try {
                await consumer.connect();

                const hydrated = consumer.listSessions().find((session) => session.id === sessionId);
                expect(hydrated).toBeDefined();
                expect(hydrated?.directory).toBe('/encrypted-hydration');
                expect(hydrated?.projectID).toBe('encrypted-project');
                expect(hydrated?.title).toBe('Encrypted hydration');

                await producer.sendMessage(sessionId, makeUserMessage('encrypted_rt1', sessionId));
                await consumer.fetchMessages(sessionId);

                const sessionState = consumer.state.sessions.get(sessionId as string);
                expect(sessionState?.metadata).toEqual({ host: 'integration-host' });
                expect(sessionState?.agentState).toEqual({ controlledByUser: false });
                expect(sessionState?.messages.some((message) => message.info.id === 'msg_encrypted_rt1')).toBe(true);
            } finally {
                producer.disconnect();
                consumer.disconnect();
            }
        });
    });

    describe('Message round-trip', () => {
        it('sends a MessageWithParts through producer, arrives intact on consumer via fetch', async () => {
            const producer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
            const consumer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                const sessionId = await producer.createSession({
                    directory: '/test',
                    projectID: 'test-project',
                    title: 'Round-trip test',
                });

                const msg = makeUserMessage('roundtrip1', sessionId);
                await producer.sendMessage(sessionId, msg);

                await consumer.fetchMessages(sessionId);
                const session = consumer.state.sessions.get(sessionId as string);
                expect(session).toBeDefined();
                expect(session!.messages.length).toBeGreaterThanOrEqual(1);

                const received = session!.messages.find(m => m.info.id === msg.info.id);
                expect(received).toBeDefined();
                expect(received!.info.role).toBe('user');
                expect(received!.parts[0].type).toBe('text');
            } finally {
                producer.disconnect();
                consumer.disconnect();
            }
        });
    });

    describe('Encryption', () => {
        it('ciphertext on server is not plaintext', async () => {
            const node = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                const sessionId = await node.createSession({
                    directory: '/test',
                    projectID: 'test-project',
                    title: 'Encryption test',
                });

                const msg = makeUserMessage('enc1', sessionId);
                await node.sendMessage(sessionId, msg);

                // Fetch raw from server via HTTP
                const res = await fetch(`${SERVER_URL}/v3/sessions/${sessionId}/messages`, {
                    headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` },
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
    });

    describe('Seq ordering', () => {
        it('messages arrive in send order with monotonically increasing seq', async () => {
            const node = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                const sessionId = await node.createSession({
                    directory: '/test',
                    projectID: 'test-project',
                    title: 'Seq ordering test',
                });

                for (let i = 0; i < 5; i++) {
                    await node.sendMessage(sessionId, makeUserMessage(`seq_${i}`, sessionId));
                }

                const reader = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
                await reader.fetchMessages(sessionId);

                const session = reader.state.sessions.get(sessionId as string);
                expect(session).toBeDefined();
                expect(session!.messages.length).toBe(5);

                for (let i = 0; i < session!.messages.length; i++) {
                    expect(session!.messages[i].info.id).toBe(`msg_seq_${i}`);
                }

                reader.disconnect();
            } finally {
                node.disconnect();
            }
        });
    });

    describe('Dedup', () => {
        it('same localId sent twice does not create duplicate', async () => {
            const node = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                const sessionId = await node.createSession({
                    directory: '/test',
                    projectID: 'test-project',
                    title: 'Dedup test',
                });

                const msg = makeUserMessage('dedup1', sessionId);
                await node.sendMessage(sessionId, msg);
                // Send same message again — should dedup
                await node.sendMessage(sessionId, msg);

                const reader = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
                await reader.fetchMessages(sessionId);

                const session = reader.state.sessions.get(sessionId as string);
                expect(session).toBeDefined();
                // Messages dedup by message ID, so only 1 instance
                const matching = session!.messages.filter(m => m.info.id === 'msg_dedup1');
                expect(matching.length).toBe(1);

                reader.disconnect();
            } finally {
                node.disconnect();
            }
        });
    });

    describe('Pagination', () => {
        it('50+ messages fetch correctly via cursor pagination', async () => {
            const node = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                const sessionId = await node.createSession({
                    directory: '/test',
                    projectID: 'test-project',
                    title: 'Pagination test',
                });

                // Send 55 messages
                for (let i = 0; i < 55; i++) {
                    await node.sendMessage(sessionId, makeUserMessage(`page_${String(i).padStart(3, '0')}`, sessionId));
                }

                const reader = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
                await reader.fetchMessages(sessionId);

                const session = reader.state.sessions.get(sessionId as string);
                expect(session).toBeDefined();
                expect(session!.messages.length).toBe(55);

                reader.disconnect();
            } finally {
                node.disconnect();
            }
        }, 30000);
    });

    describe('Batching', () => {
        it('outbox flushes multiple messages in one POST when available', async () => {
            const node = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                const sessionId = await node.createSession({
                    directory: '/test',
                    projectID: 'test-project',
                    title: 'Batching test',
                });

                // Queue multiple messages rapidly without awaiting each
                const promises = [];
                for (let i = 0; i < 5; i++) {
                    promises.push(node.sendMessage(sessionId, makeUserMessage(`batch_${i}`, sessionId)));
                }
                await Promise.all(promises);

                // Verify all messages arrived
                const reader = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
                await reader.fetchMessages(sessionId);

                const session = reader.state.sessions.get(sessionId as string);
                expect(session).toBeDefined();
                expect(session!.messages.length).toBe(5);

                for (let i = 0; i < 5; i++) {
                    expect(session!.messages[i].info.id).toBe(`msg_batch_${i}`);
                }

                reader.disconnect();
            } finally {
                node.disconnect();
            }
        });
    });

    describe('Real-time push', () => {
        it('new-session push populates SessionInfo from metadata', async () => {
            const producer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
            const consumer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                await consumer.connect();

                const sessionId = await producer.createSession({
                    directory: '/realtime-session',
                    projectID: 'realtime-project',
                    title: 'Realtime session',
                });

                await waitForCondition(() => consumer.listSessions().some((session) => session.id === sessionId), 5000);

                const hydrated = consumer.listSessions().find((session) => session.id === sessionId);
                expect(hydrated).toBeDefined();
                expect(hydrated?.directory).toBe('/realtime-session');
                expect(hydrated?.projectID).toBe('realtime-project');
                expect(hydrated?.title).toBe('Realtime session');
            } finally {
                producer.disconnect();
                consumer.disconnect();
            }
        });

        it('new-session push resolves encrypted metadata via the session key resolver', async () => {
            const contentKeyPair = makeContentKeyPair();
            const consumer = new SyncNode(
                SERVER_URL,
                makeAccountToken(),
                makeKeyMaterial(),
                {
                    resolveSessionKeyMaterial: makeSessionKeyResolver(contentKeyPair),
                },
            );

            try {
                await consumer.connect();

                const sessionId = await createLegacyEncryptedSession({
                    tag: `encrypted-realtime-${Date.now()}`,
                    sessionKeyMaterial: makeKeyMaterial(),
                    contentPublicKey: contentKeyPair.publicKey,
                    sessionMetadata: {
                        session: {
                            directory: '/encrypted-realtime',
                            projectID: 'encrypted-realtime-project',
                            title: 'Encrypted realtime session',
                            parentID: null,
                        },
                        metadata: {
                            host: 'realtime-host',
                        },
                    },
                });

                await waitForCondition(() => consumer.listSessions().some((session) => session.id === sessionId), 5000);

                const hydrated = consumer.listSessions().find((session) => session.id === sessionId);
                expect(hydrated).toBeDefined();
                expect(hydrated?.directory).toBe('/encrypted-realtime');
                expect(hydrated?.projectID).toBe('encrypted-realtime-project');
                expect(hydrated?.title).toBe('Encrypted realtime session');
                expect(consumer.state.sessions.get(sessionId as string)?.metadata).toEqual({ host: 'realtime-host' });
            } finally {
                consumer.disconnect();
            }
        });

        it('Socket.IO new-message triggers immediate state update on consumer', async () => {
            const producer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
            const consumer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                await consumer.connect();

                const sessionId = await producer.createSession({
                    directory: '/test',
                    projectID: 'test-project',
                    title: 'Real-time test',
                });

                // Consumer listens
                let received = false;
                consumer.onMessage(sessionId, () => { received = true; });

                // Producer sends
                await producer.sendMessage(sessionId, makeUserMessage('rt1', sessionId));

                // Wait for push
                await waitForCondition(() => received, 5000);
                expect(received).toBe(true);
            } finally {
                producer.disconnect();
                consumer.disconnect();
            }
        });

        it('fetchMessages can hydrate history without replaying message listeners', async () => {
            const producer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
            const consumer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                const sessionId = await producer.createSession({
                    directory: '/test',
                    projectID: 'test-project',
                    title: 'Silent hydration test',
                });

                await producer.sendMessage(sessionId, makeUserMessage('silent1', sessionId));

                let received = false;
                consumer.onMessage(sessionId, () => { received = true; });

                await consumer.fetchMessages(sessionId, undefined, {
                    notifyListeners: false,
                });

                const session = consumer.state.sessions.get(sessionId as string);
                expect(session?.messages).toHaveLength(1);
                expect(received).toBe(false);
            } finally {
                producer.disconnect();
                consumer.disconnect();
            }
        });
    });

    describe('Reconnect', () => {
        it('disconnect consumer, send messages, reconnect, verify all arrive', async () => {
            const producer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
            const consumer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                const sessionId = await producer.createSession({
                    directory: '/test',
                    projectID: 'test-project',
                    title: 'Reconnect test',
                });

                // Consumer disconnects
                consumer.disconnect();

                // Producer sends while consumer is disconnected
                await producer.sendMessage(sessionId, makeUserMessage('recon1', sessionId));
                await producer.sendMessage(sessionId, makeUserMessage('recon2', sessionId));

                // Consumer reconnects and fetches
                await consumer.fetchMessages(sessionId);

                const session = consumer.state.sessions.get(sessionId as string);
                expect(session).toBeDefined();
                expect(session!.messages.length).toBe(2);
            } finally {
                producer.disconnect();
                consumer.disconnect();
            }
        });
    });

    describe('Session isolation', () => {
        it('messages to different sessions do not leak', async () => {
            const node = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                const session1 = await node.createSession({
                    directory: '/test1',
                    projectID: 'test-project',
                    title: 'Session 1',
                });
                const session2 = await node.createSession({
                    directory: '/test2',
                    projectID: 'test-project',
                    title: 'Session 2',
                });

                await node.sendMessage(session1, makeUserMessage('iso1', session1));
                await node.sendMessage(session2, makeUserMessage('iso2', session2));

                const reader = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
                await reader.fetchMessages(session1);
                await reader.fetchMessages(session2);

                const s1 = reader.state.sessions.get(session1 as string);
                const s2 = reader.state.sessions.get(session2 as string);

                expect(s1!.messages.length).toBe(1);
                expect(s2!.messages.length).toBe(1);
                expect(s1!.messages[0].info.id).toBe('msg_iso1');
                expect(s2!.messages[0].info.id).toBe('msg_iso2');

                reader.disconnect();
            } finally {
                node.disconnect();
            }
        });
    });

    describe('Permission state round-trip', () => {
        it('blocked tool with permission survives full encrypt → store → fetch → decrypt cycle', async () => {
            const node = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                const sessionId = await node.createSession({
                    directory: '/test',
                    projectID: 'test-project',
                    title: 'Permission round-trip',
                });

                const blockedMsg = makeBlockedToolMessage('perm1', 'user1', sessionId, 'permission');
                await node.sendMessage(sessionId, blockedMsg);

                const reader = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
                await reader.fetchMessages(sessionId);

                const session = reader.state.sessions.get(sessionId as string);
                expect(session).toBeDefined();
                expect(session!.messages.length).toBe(1);

                const msg = session!.messages[0];
                const toolPart = msg.parts.find(p => p.type === 'tool');
                expect(toolPart).toBeDefined();
                if (toolPart?.type === 'tool') {
                    expect(toolPart.state.status).toBe('blocked');
                    if (toolPart.state.status === 'blocked') {
                        expect(toolPart.state.block.type).toBe('permission');
                    }
                }

                reader.disconnect();
            } finally {
                node.disconnect();
            }
        });
    });

    describe('Control message round-trip', () => {
        it('runtime-config changes survive transport and merge into the latest active config', async () => {
            const producer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
            const consumer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                await consumer.connect();
                const sessionId = await producer.createSession({
                    directory: '/control-runtime',
                    projectID: 'test-project',
                    title: 'Control runtime config',
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

                await consumer.fetchMessages(sessionId);

                const session = consumer.state.sessions.get(sessionId as string)!;
                expect(session.controlMessages.filter(message => message.type === 'runtime-config-change')).toHaveLength(2);
                expect(session.runtimeConfig?.permissionMode).toBe('read-only');
                expect(session.runtimeConfig?.model).toBe('gpt-5.4');
                expect(session.runtimeConfig?.appendSystemPrompt).toBe('Stay concise.');
            } finally {
                producer.disconnect();
                consumer.disconnect();
            }
        });

        it('permission request/response control messages derive pending permissions and resolve them', async () => {
            const producer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
            const consumer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                await consumer.connect();
                const sessionId = await producer.createSession({
                    directory: '/control-permission',
                    projectID: 'test-project',
                    title: 'Control permission',
                });

                await producer.sendPermissionRequest(sessionId, {
                    callID: 'call_control_perm',
                    tool: 'Write',
                    patterns: ['/control-permission.txt'],
                    input: { path: '/control-permission.txt', content: 'hello' },
                });

                await consumer.fetchMessages(sessionId);

                const pendingPermission = consumer.state.sessions.get(sessionId as string)!.permissions[0];
                expect(pendingPermission).toBeDefined();
                expect(pendingPermission.block.permission).toBe('Write');
                expect(pendingPermission.resolved).toBe(false);

                await consumer.approvePermission(sessionId, pendingPermission.permissionId, {
                    decision: 'always',
                    allowTools: ['Write'],
                });

                await producer.fetchMessages(sessionId);
                await consumer.fetchMessages(sessionId);

                const producerSession = producer.state.sessions.get(sessionId as string)!;
                const response = producerSession.controlMessages.find(
                    (message): message is Extract<typeof message, { type: 'permission-response' }> =>
                        message.type === 'permission-response',
                );
                expect(response?.callID).toBe('call_control_perm');
                expect(response?.decision).toBe('always');

                const consumerPermission = consumer.state.sessions.get(sessionId as string)!.permissions[0];
                expect(consumerPermission.resolved).toBe(true);
            } finally {
                producer.disconnect();
                consumer.disconnect();
            }
        });

        it('abort requests arrive via onSessionMessage but do not trigger onMessage listeners', async () => {
            const producer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
            const consumer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                await consumer.connect();
                const sessionId = await producer.createSession({
                    directory: '/control-abort',
                    projectID: 'test-project',
                    title: 'Control abort',
                });

                let conversationMessages = 0;
                let abortRequests = 0;
                consumer.onMessage(sessionId, () => {
                    conversationMessages += 1;
                });
                consumer.onSessionMessage(sessionId, (message) => {
                    if (!('info' in message) && message.type === 'abort-request') {
                        abortRequests += 1;
                    }
                });

                await producer.sendAbortRequest(sessionId, {
                    source: 'user',
                    reason: 'Stop the current turn',
                });

                await waitForCondition(() => abortRequests === 1);
                expect(conversationMessages).toBe(0);

                const session = consumer.state.sessions.get(sessionId as string)!;
                expect(session.controlMessages.some(message => message.type === 'abort-request')).toBe(true);
            } finally {
                producer.disconnect();
                consumer.disconnect();
            }
        });

        it('session-end control messages mark the session completed', async () => {
            const producer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
            const consumer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                await consumer.connect();
                const sessionId = await producer.createSession({
                    directory: '/control-session-end',
                    projectID: 'test-project',
                    title: 'Control session end',
                });

                await producer.sendSessionEnd(sessionId, {
                    reason: 'completed',
                });

                await consumer.fetchMessages(sessionId);

                const session = consumer.state.sessions.get(sessionId as string)!;
                expect(session.controlMessages.some(message => message.type === 'session-end')).toBe(true);
                expect(session.status).toEqual({ type: 'completed' });
            } finally {
                producer.disconnect();
                consumer.disconnect();
            }
        });
    });

    describe('Question state round-trip', () => {
        it('blocked question survives full cycle', async () => {
            const node = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                const sessionId = await node.createSession({
                    directory: '/test',
                    projectID: 'test-project',
                    title: 'Question round-trip',
                });

                const questionMsg = makeBlockedToolMessage('q1', 'user1', sessionId, 'question');
                await node.sendMessage(sessionId, questionMsg);

                const reader = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
                await reader.fetchMessages(sessionId);

                const session = reader.state.sessions.get(sessionId as string);
                expect(session).toBeDefined();

                const msg = session!.messages[0];
                const toolPart = msg.parts.find(p => p.type === 'tool');
                expect(toolPart).toBeDefined();
                if (toolPart?.type === 'tool') {
                    expect(toolPart.state.status).toBe('blocked');
                    if (toolPart.state.status === 'blocked') {
                        expect(toolPart.state.block.type).toBe('question');
                        if (toolPart.state.block.type === 'question') {
                            expect(toolPart.state.block.questions).toHaveLength(1);
                            expect(toolPart.state.block.questions[0].question).toBe('Which framework?');
                        }
                    }
                }

                reader.disconnect();
            } finally {
                node.disconnect();
            }
        });
    });

    describe('Concurrent sessions', () => {
        it('two session-scoped nodes for different sessions, messages do not leak', async () => {
            const accountNode = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                const session1 = await accountNode.createSession({
                    directory: '/test1',
                    projectID: 'test-project',
                    title: 'Concurrent 1',
                });
                const session2 = await accountNode.createSession({
                    directory: '/test2',
                    projectID: 'test-project',
                    title: 'Concurrent 2',
                });

                const node1 = new SyncNode(SERVER_URL, await makeSessionToken(session1 as string), keyMaterial);
                const node2 = new SyncNode(SERVER_URL, await makeSessionToken(session2 as string), keyMaterial);

                await node1.sendMessage(session1, makeUserMessage('conc1', session1));
                await node2.sendMessage(session2, makeUserMessage('conc2', session2));

                await node1.fetchMessages(session1);
                await node2.fetchMessages(session2);

                const s1 = node1.state.sessions.get(session1 as string);
                const s2 = node2.state.sessions.get(session2 as string);

                expect(s1!.messages.length).toBe(1);
                expect(s2!.messages.length).toBe(1);
                expect(s1!.messages[0].info.id).toBe('msg_conc1');
                expect(s2!.messages[0].info.id).toBe('msg_conc2');

                node1.disconnect();
                node2.disconnect();
            } finally {
                accountNode.disconnect();
            }
        });
    });

    describe('Account-scoped operations', () => {
        it('create, list, stop sessions via account-scoped node', async () => {
            const node = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                const sessionId = await node.createSession({
                    directory: '/test',
                    projectID: 'test-project',
                    title: 'Lifecycle test',
                });

                expect(sessionId).toBeTruthy();

                const sessions = node.listSessions();
                expect(sessions.length).toBeGreaterThanOrEqual(1);
                expect(sessions.some(s => s.id === sessionId)).toBe(true);

                await node.stopSession(sessionId);

                const session = node.state.sessions.get(sessionId as string);
                expect(session?.status).toEqual({ type: 'completed' });
            } finally {
                node.disconnect();
            }
        });
    });

    describe('Session-scoped restriction', () => {
        it('session-scoped node cannot access other sessions', async () => {
            const accountNode = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                const session1 = await accountNode.createSession({
                    directory: '/test1',
                    projectID: 'test-project',
                    title: 'Scope test 1',
                });
                const session2 = await accountNode.createSession({
                    directory: '/test2',
                    projectID: 'test-project',
                    title: 'Scope test 2',
                });

                const scopedNode = new SyncNode(
                    SERVER_URL,
                    await makeSessionToken(session1 as string),
                    keyMaterial,
                );

                // Should succeed for session1
                await scopedNode.sendMessage(session1, makeUserMessage('scope1', session1));

                // Should throw for session2
                await expect(
                    scopedNode.sendMessage(session2, makeUserMessage('scope2', session2)),
                ).rejects.toThrow('Session-scoped token cannot access session');

                scopedNode.disconnect();
            } finally {
                accountNode.disconnect();
            }
        });

        it('server enforces session-scoped token claims', async () => {
            const accountNode = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                const session1 = await accountNode.createSession({
                    directory: '/server-scope-1',
                    projectID: 'test-project',
                    title: 'Server scope 1',
                });
                const session2 = await accountNode.createSession({
                    directory: '/server-scope-2',
                    projectID: 'test-project',
                    title: 'Server scope 2',
                });

                const scopedToken = await makeSessionToken(session1 as string);
                const headers = {
                    Authorization: `Bearer ${scopedToken.raw}`,
                    'Content-Type': 'application/json',
                };

                const ownSessionResponse = await fetch(`${SERVER_URL}/v3/sessions/${session1}/messages`, {
                    headers,
                });
                expect(ownSessionResponse.status).toBe(200);

                const otherSessionResponse = await fetch(`${SERVER_URL}/v3/sessions/${session2}/messages`, {
                    headers,
                });
                expect(otherSessionResponse.status).toBe(403);

                const listSessionsResponse = await fetch(`${SERVER_URL}/v1/sessions`, {
                    headers,
                });
                expect(listSessionsResponse.status).toBe(403);

                const createSessionResponse = await fetch(`${SERVER_URL}/v1/sessions`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        directory: '/forbidden-create',
                        projectID: 'test-project',
                        title: 'Should fail',
                    }),
                });
                expect(createSessionResponse.status).toBe(403);

                const stopSessionResponse = await fetch(`${SERVER_URL}/v1/sessions/${session1}/stop`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({}),
                });
                expect(stopSessionResponse.status).toBe(403);
            } finally {
                accountNode.disconnect();
            }
        });
    });

    describe('Session state cache (Amendment 3)', () => {
        it('metadata blob fields are extracted into typed SessionState cache', async () => {
            const producer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
            const consumer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                await producer.connect();
                await consumer.connect();

                const sessionId = await producer.createSession({
                    directory: '/cache-test',
                    projectID: 'cache-project',
                    title: 'Cache test session',
                });

                // Update metadata with session-level fields
                await producer.updateMetadata(sessionId, (current: Record<string, unknown>) => ({
                    ...current,
                    flavor: 'claude',
                    lifecycleState: 'running',
                    currentModelCode: 'claude-sonnet-4-20250514',
                    summary: { text: 'Test summary' },
                }));

                // Verify producer-side cache is populated
                const producerSession = producer.state.sessions.get(sessionId as string);
                expect(producerSession?.agentType).toBe('claude');
                expect(producerSession?.lifecycleState).toBe('running');
                expect(producerSession?.modelID).toBe('claude-sonnet-4-20250514');
                expect(producerSession?.summary).toBe('Test summary');

                // Wait for consumer to receive the update-session push
                await waitForCondition(() => {
                    const s = consumer.state.sessions.get(sessionId as string);
                    return s?.agentType === 'claude';
                }, 5000);

                const consumerSession = consumer.state.sessions.get(sessionId as string);
                expect(consumerSession?.agentType).toBe('claude');
                expect(consumerSession?.lifecycleState).toBe('running');
                expect(consumerSession?.modelID).toBe('claude-sonnet-4-20250514');
                expect(consumerSession?.summary).toBe('Test summary');
            } finally {
                producer.disconnect();
                consumer.disconnect();
            }
        });

        it('agentState controlledByUser is extracted into typed cache', async () => {
            const producer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                await producer.connect();

                const sessionId = await producer.createSession({
                    directory: '/agent-state-cache',
                    projectID: 'test-project',
                    title: 'Agent state cache test',
                });

                // Initially controlledByUser is undefined
                const before = producer.state.sessions.get(sessionId as string);
                expect(before?.controlledByUser).toBeUndefined();

                // Set controlledByUser via agentState
                await producer.updateAgentState(sessionId, (current: Record<string, unknown>) => ({
                    ...current,
                    controlledByUser: true,
                }));

                const after = producer.state.sessions.get(sessionId as string);
                expect(after?.controlledByUser).toBe(true);
            } finally {
                producer.disconnect();
            }
        });

        it('lifecycle transitions update the cache', async () => {
            const producer = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);

            try {
                await producer.connect();

                const sessionId = await producer.createSession({
                    directory: '/lifecycle-cache',
                    projectID: 'test-project',
                    title: 'Lifecycle cache test',
                });

                // Default is 'running'
                const initial = producer.state.sessions.get(sessionId as string);
                expect(initial?.lifecycleState).toBe('running');

                // Transition to archived
                await producer.updateMetadata(sessionId, (current: Record<string, unknown>) => ({
                    ...current,
                    lifecycleState: 'archived',
                }));

                const archived = producer.state.sessions.get(sessionId as string);
                expect(archived?.lifecycleState).toBe('archived');
            } finally {
                producer.disconnect();
            }
        });

        it('session list provides cache fields without fetching messages', async () => {
            const contentKeyPair = makeContentKeyPair();
            const sessionKeyMaterial = makeKeyMaterial();

            // Create session with metadata via the legacy path (simulating a CLI)
            const sessionId = await createLegacyEncryptedSession({
                tag: `cache-list-${Date.now()}`,
                sessionKeyMaterial,
                contentPublicKey: contentKeyPair.publicKey,
                sessionMetadata: {
                    session: {
                        directory: '/cache-list-test',
                        projectID: 'cache-list-project',
                        title: 'Cache list test',
                        parentID: null,
                    },
                    metadata: {
                        flavor: 'codex',
                        lifecycleState: 'running',
                        currentModelCode: 'codex-mini-latest',
                    },
                },
                agentState: {
                    controlledByUser: false,
                },
            });

            // Consumer fetches session list (no message fetch)
            const consumer = new SyncNode(
                SERVER_URL,
                makeAccountToken(),
                makeKeyMaterial(),
                { resolveSessionKeyMaterial: makeSessionKeyResolver(contentKeyPair) },
            );

            try {
                await consumer.connect();

                const session = consumer.state.sessions.get(sessionId as string);
                expect(session).toBeDefined();

                // Cache fields are populated from metadata blob
                expect(session?.agentType).toBe('codex');
                expect(session?.lifecycleState).toBe('running');
                expect(session?.modelID).toBe('codex-mini-latest');

                // controlledByUser from agentState blob
                expect(session?.controlledByUser).toBe(false);

                // Messages are NOT fetched — should be empty
                expect(session?.messages).toHaveLength(0);
            } finally {
                consumer.disconnect();
            }
        });
    });
});
