import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEnvelope, UserMessage } from '@slopus/happy-wire';
import {
  decodeBase64,
  decrypt,
  decryptBoxBundle,
  deriveContentKeyPair,
  encodeBase64,
  encrypt,
  getRandomBytes,
} from 'happy-agent/encryption';

import type {
  PiHappyCredentials,
  PiHappyDataKeyCredentials,
  PiHappyLegacyCredentials,
} from '../credentials';
import {
  HappySessionClient,
  type HappySession,
  type HappySessionAgentState,
  type HappySessionMetadata,
} from '../happy-session-client';
import { OfflineHappySessionStub } from '../offline-stub';
import { ConnectionState } from '../types';

const { mockIo, mockAxiosGet, mockAxiosPost } = vi.hoisted(() => ({
  mockIo: vi.fn(),
  mockAxiosGet: vi.fn(),
  mockAxiosPost: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

vi.mock('axios', () => {
  const axiosLike = {
    get: mockAxiosGet,
    post: mockAxiosPost,
    isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: unknown })?.isAxiosError),
  };

  return {
    default: axiosLike,
  };
});

type Handler = (...args: any[]) => void;

function createMockSocket() {
  const handlers: Record<string, Handler[]> = {};
  const managerHandlers: Record<string, Handler[]> = {};

  const socket = {
    connected: false,
    connect: vi.fn(() => {
      socket.connected = true;
    }),
    on: vi.fn((event: string, handler: Handler) => {
      handlers[event] ??= [];
      handlers[event].push(handler);
      return socket;
    }),
    emit: vi.fn((event: string, ...args: unknown[]) => {
      if (event === 'ping') {
        const callback = args[0];
        if (typeof callback === 'function') {
          callback();
        }
      }
    }),
    emitWithAck: vi.fn(async () => ({ result: 'error' as const })),
    close: vi.fn(() => {
      socket.connected = false;
    }),
    volatile: {
      emit: vi.fn(),
    },
    io: {
      on: vi.fn((event: string, handler: Handler) => {
        managerHandlers[event] ??= [];
        managerHandlers[event].push(handler);
      }),
    },
  };

  return {
    socket,
    emit(event: string, ...args: unknown[]) {
      for (const handler of handlers[event] ?? []) {
        handler(...args);
      }
    },
    emitManager(event: string, ...args: unknown[]) {
      for (const handler of managerHandlers[event] ?? []) {
        handler(...args);
      }
    },
  };
}

async function waitFor(check: () => void, timeoutMs: number = 2_000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      check();
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  throw lastError;
}

function makeLegacyCredentials(): PiHappyLegacyCredentials {
  const secret = getRandomBytes(32);
  return {
    token: 'test-token',
    encryption: {
      type: 'legacy',
      secret,
    },
    contentKeyPair: deriveContentKeyPair(secret),
  };
}

function makeDataKeyCredentials(): {
  credentials: PiHappyDataKeyCredentials;
  contentKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
} {
  const secret = getRandomBytes(32);
  const contentKeyPair = deriveContentKeyPair(secret);
  return {
    credentials: {
      token: 'test-token',
      encryption: {
        type: 'dataKey',
        publicKey: contentKeyPair.publicKey,
        machineKey: getRandomBytes(32),
      },
    },
    contentKeyPair,
  };
}

function makeMetadata(overrides: Partial<HappySessionMetadata> = {}): HappySessionMetadata {
  return {
    path: '/tmp/project',
    host: 'localhost',
    homeDir: '/Users/steve',
    happyHomeDir: '/Users/steve/.happy',
    happyLibDir: '',
    happyToolsDir: '',
    ...overrides,
  };
}

function makeSession(overrides: Partial<HappySession> = {}): HappySession {
  return {
    id: 'session-123',
    seq: 0,
    encryptionKey: getRandomBytes(32),
    encryptionVariant: 'legacy',
    metadata: makeMetadata(),
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 0,
    ...overrides,
  };
}

function encryptContent(
  session: HappySession,
  content: unknown,
): string {
  return encodeBase64(encrypt(session.encryptionKey, session.encryptionVariant, content));
}

describe('HappySessionClient', () => {
  let socketControl: ReturnType<typeof createMockSocket>;

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    socketControl = createMockSocket();
    mockIo.mockReturnValue(socketControl.socket);
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  it('creates a session with encrypted metadata and data-key session key', async () => {
    const { credentials, contentKeyPair } = makeDataKeyCredentials();
    const metadata = makeMetadata({ name: 'pi session' });
    const state: HappySessionAgentState = { controlledByUser: false };

    mockAxiosPost.mockImplementationOnce(async (_url: string, body: any) => ({
      data: {
        session: {
          id: 'created-session',
          seq: 7,
          metadata: body.metadata,
          metadataVersion: 2,
          agentState: body.agentState,
          agentStateVersion: 3,
        },
      },
    }));

    const client = await HappySessionClient.create(credentials, {
      serverUrl: 'https://server.test',
      cwd: '/tmp/project',
    }, 'tag-123', metadata, state);

    expect(client).toBeInstanceOf(HappySessionClient);
    expect(mockAxiosPost).toHaveBeenCalledWith(
      'https://server.test/v1/sessions',
      expect.objectContaining({
        tag: 'tag-123',
        metadata: expect.any(String),
        agentState: expect.any(String),
        dataEncryptionKey: expect.any(String),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );

    const requestBody = mockAxiosPost.mock.calls[0][1];
    const decryptedSessionKey = decryptBoxBundle(
      decodeBase64(requestBody.dataEncryptionKey).slice(1),
      contentKeyPair.secretKey,
    );

    expect(decryptedSessionKey).toEqual((client as any).encryptionKey);
    expect((client as any).encryptionVariant).toBe('dataKey');
    expect(client?.getMetadata()).toMatchObject(metadata);
    expect(client?.getAgentState()).toEqual(state);

    await client?.close();
  });

  it('encrypts outbound session protocol messages and routes fetched user messages', async () => {
    const credentials = makeLegacyCredentials();
    const session = makeSession();
    const client = new HappySessionClient(credentials, 'https://server.test', session, {
      cwd: '/tmp/project',
    });

    const envelope: SessionEnvelope = {
      id: 'env-1',
      time: Date.now(),
      role: 'agent',
      turn: 'turn-1',
      ev: { t: 'text', text: 'hello from pi' },
    };

    mockAxiosPost.mockResolvedValueOnce({
      data: {
        messages: [{ id: 'msg-1', seq: 1, localId: 'local-1', createdAt: 1, updatedAt: 1 }],
      },
    });

    client.sendSessionProtocolMessage(envelope);

    await waitFor(() => {
      expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    });

    const postedMessage = mockAxiosPost.mock.calls[0][1].messages[0];
    const decryptedOutgoing = decrypt(
      session.encryptionKey,
      session.encryptionVariant,
      decodeBase64(postedMessage.content),
    );

    expect(decryptedOutgoing).toEqual({
      role: 'session',
      content: envelope,
      meta: { sentFrom: 'cli' },
    });

    const receivedUserMessage: UserMessage = {
      role: 'user',
      content: {
        type: 'text',
        text: 'hello from mobile',
      },
    };
    const onUserMessage = vi.fn();
    client.onUserMessage(onUserMessage);

    mockAxiosGet.mockResolvedValueOnce({
      data: {
        messages: [{
          id: 'msg-2',
          seq: 2,
          content: {
            t: 'encrypted',
            c: encryptContent(session, receivedUserMessage),
          },
          localId: null,
          createdAt: 2,
          updatedAt: 2,
        }],
        hasMore: false,
      },
    });

    (client as any).lastSeq = 1;
    await (client as any).fetchMessages();

    expect(onUserMessage).toHaveBeenCalledWith(receivedUserMessage);
    expect((client as any).lastSeq).toBe(2);

    await client.close();
  });

  it('flushes the outbox in batches of at most 50 messages with latest batches first', async () => {
    const client = new HappySessionClient(makeLegacyCredentials(), 'https://server.test', makeSession(), {
      cwd: '/tmp/project',
    });

    (client as any).pendingOutbox = Array.from({ length: 55 }, (_, index) => ({
      content: `encrypted-${index}`,
      localId: `local-${index}`,
    }));

    mockAxiosPost
      .mockResolvedValueOnce({
        data: {
          messages: Array.from({ length: 50 }, (_, index) => ({
            id: `msg-${index + 6}`,
            seq: index + 6,
            localId: `local-${index + 5}`,
            createdAt: index + 6,
            updatedAt: index + 6,
          })),
        },
      })
      .mockResolvedValueOnce({
        data: {
          messages: Array.from({ length: 5 }, (_, index) => ({
            id: `msg-${index + 1}`,
            seq: index + 1,
            localId: `local-${index}`,
            createdAt: index + 1,
            updatedAt: index + 1,
          })),
        },
      });

    await (client as any).flushOutbox();

    expect(mockAxiosPost).toHaveBeenCalledTimes(2);
    expect(mockAxiosPost.mock.calls[0][1].messages).toHaveLength(50);
    expect(mockAxiosPost.mock.calls[1][1].messages).toHaveLength(5);
    expect(mockAxiosPost.mock.calls[0][1].messages[0].localId).toBe('local-5');
    expect(mockAxiosPost.mock.calls[1][1].messages[0].localId).toBe('local-0');
    expect((client as any).pendingOutbox).toHaveLength(0);
    expect((client as any).lastSeq).toBe(55);

    await client.close();
  });

  it('emits keepalive pings over the socket', async () => {
    const client = new HappySessionClient(makeLegacyCredentials(), 'https://server.test', makeSession(), {
      cwd: '/tmp/project',
    });

    client.keepAlive(true, 'remote');

    expect(socketControl.socket.volatile.emit).toHaveBeenCalledWith(
      'session-alive',
      expect.objectContaining({
        sid: 'session-123',
        thinking: true,
        mode: 'remote',
      }),
    );

    await client.close();
  });

  it('returns an offline stub when startup happens without network connectivity', async () => {
    const metadata = makeMetadata();
    mockAxiosPost.mockRejectedValueOnce({ code: 'ECONNREFUSED' });

    const client = await HappySessionClient.createWithOfflineFallback(makeLegacyCredentials(), {
      serverUrl: 'https://server.test',
      cwd: '/tmp/project',
      initialReconnectDelayMs: 60_000,
    }, 'offline-tag', metadata, null);

    expect(client).toBeInstanceOf(OfflineHappySessionStub);
    expect(client.sessionId).toBe('offline-offline-tag');
    expect(client.getConnectionState()).toBe(ConnectionState.Offline);

    await expect(client.updateLifecycleState('archived')).resolves.toBeUndefined();
    expect(client.getMetadata()).toMatchObject({ lifecycleState: 'archived' });

    await client.close();
  });

  it('swaps in a real client when offline reconnection succeeds later and preserves offline metadata/state changes', async () => {
    vi.useFakeTimers();

    const metadata = makeMetadata();
    const onSessionSwap = vi.fn();

    mockAxiosPost
      .mockRejectedValueOnce({ code: 'ECONNREFUSED' })
      .mockImplementationOnce(async (_url: string, body: any) => ({
        data: {
          session: {
            id: 'reconnected-session',
            seq: 1,
            metadata: body.metadata,
            metadataVersion: 1,
            agentState: body.agentState,
            agentStateVersion: body.agentState ? 1 : 0,
          },
        },
      }));

    const client = await HappySessionClient.createWithOfflineFallback(makeLegacyCredentials(), {
      serverUrl: 'https://server.test',
      cwd: '/tmp/project',
      initialReconnectDelayMs: 100,
      healthCheck: vi.fn(async () => undefined),
      onSessionSwap,
    }, 'reconnect-tag', metadata, null);

    expect(client).toBeInstanceOf(OfflineHappySessionStub);

    await client.updateLifecycleState('archived');
    await client.updateAgentState(() => ({ controlledByUser: true }));

    await vi.advanceTimersByTimeAsync(100);
    await waitFor(() => {
      expect(onSessionSwap).toHaveBeenCalledTimes(1);
      expect(onSessionSwap.mock.calls[0][0]).toBeInstanceOf(HappySessionClient);
    });

    const recovered = onSessionSwap.mock.calls[0][0] as HappySessionClient;
    expect(recovered.getMetadata()).toMatchObject({ lifecycleState: 'archived' });
    expect(recovered.getAgentState()).toEqual({ controlledByUser: true });

    await client.close();
  });

  it('retains the recovered live client even when onSessionSwap is omitted', async () => {
    vi.useFakeTimers();

    mockAxiosPost
      .mockRejectedValueOnce({ code: 'ECONNREFUSED' })
      .mockImplementationOnce(async (_url: string, body: any) => ({
        data: {
          session: {
            id: 'reconnected-session',
            seq: 1,
            metadata: body.metadata,
            metadataVersion: 1,
            agentState: body.agentState,
            agentStateVersion: body.agentState ? 1 : 0,
          },
        },
      }));

    const client = await HappySessionClient.createWithOfflineFallback(makeLegacyCredentials(), {
      serverUrl: 'https://server.test',
      cwd: '/tmp/project',
      initialReconnectDelayMs: 100,
      healthCheck: vi.fn(async () => undefined),
    }, 'reconnect-tag', makeMetadata(), null);

    expect(client).toBeInstanceOf(OfflineHappySessionStub);
    expect(client.sessionId).toBe('offline-reconnect-tag');

    await vi.advanceTimersByTimeAsync(100);
    await waitFor(() => {
      expect(client.sessionId).toBe('reconnected-session');
      expect(client.getConnectionState()).toBe(ConnectionState.Connecting);
    });

    socketControl.socket.emit.mockClear();
    client.sendSessionDeath();
    expect(socketControl.socket.emit).toHaveBeenCalledWith(
      'session-end',
      expect.objectContaining({ sid: 'reconnected-session' }),
    );

    await client.close();
  });

  it('tracks connection state across connect, disconnect, and reconnect attempts', async () => {
    const client = new HappySessionClient(makeLegacyCredentials(), 'https://server.test', makeSession(), {
      cwd: '/tmp/project',
    });

    const seenStates: ConnectionState[] = [];
    client.on('connectionState', state => {
      seenStates.push(state);
    });

    expect(client.getConnectionState()).toBe(ConnectionState.Connecting);

    socketControl.emit('connect');
    expect(client.getConnectionState()).toBe(ConnectionState.Connected);

    socketControl.emit('disconnect', 'transport close');
    expect(client.getConnectionState()).toBe(ConnectionState.Disconnected);

    socketControl.emitManager('reconnect_attempt');
    expect(client.getConnectionState()).toBe(ConnectionState.Connecting);

    socketControl.emit('connect');
    expect(client.getConnectionState()).toBe(ConnectionState.Connected);

    expect(seenStates).toEqual([
      ConnectionState.Connected,
      ConnectionState.Disconnected,
      ConnectionState.Connecting,
      ConnectionState.Connected,
    ]);

    await client.close();
  });
});
