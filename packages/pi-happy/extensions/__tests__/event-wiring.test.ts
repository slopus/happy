import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PiHappyCredentials } from '../credentials';
import type { HappySessionClientLike } from '../offline-stub';
import type {
  PiExtensionApiLike,
  PiHappyEventMap,
  PiHappyExtensionContext,
  PiHappyModelSelectEvent,
} from '../types';
import { ConnectionState } from '../types';

const { mockCreateWithOfflineFallback, mockLoadConfig, mockLoadCredentials, mockLoadSettings, mockAxiosPost } = vi.hoisted(() => ({
  mockCreateWithOfflineFallback: vi.fn(),
  mockLoadConfig: vi.fn(),
  mockLoadCredentials: vi.fn(),
  mockLoadSettings: vi.fn(),
  mockAxiosPost: vi.fn(),
}));

vi.mock('../happy-session-client', () => ({
  HappySessionClient: {
    createWithOfflineFallback: mockCreateWithOfflineFallback,
  },
}));

vi.mock('../config', () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock('../credentials', () => ({
  loadCredentials: mockLoadCredentials,
}));

vi.mock('../settings', () => ({
  loadSettings: mockLoadSettings,
}));

vi.mock('axios', () => ({
  default: {
    post: mockAxiosPost,
  },
}));

import piHappyExtension, {
  PI_HAPPY_CONNECTED_STATUS,
  PI_HAPPY_DISCONNECTED_STATUS,
  PI_HAPPY_NOT_LOGGED_IN_STATUS,
  PI_HAPPY_OFFLINE_STATUS,
  PI_HAPPY_STATUS_KEY,
  PI_HAPPY_SYNC_FAILING_NOTIFICATION,
} from '../index';

type RegisteredHandlers = {
  [K in keyof PiHappyEventMap]?: (event: PiHappyEventMap[K], ctx: PiHappyExtensionContext) => void | Promise<void>;
};

class FakeSessionClient extends EventEmitter implements HappySessionClientLike {
  readonly rpcHandlerManager = {
    registerHandler: vi.fn(),
    unregisterHandler: vi.fn(),
  };

  private userMessageHandler: ((message: any) => void) | null = null;
  private connectionState: ConnectionState;
  private metadata: Record<string, unknown>;
  private agentState: Record<string, unknown> | null;

  readonly sentEnvelopes: any[] = [];
  readonly keepAlive = vi.fn((thinking: boolean, mode?: 'local' | 'remote') => {
    void thinking;
    void mode;
  });
  readonly sendSessionDeath = vi.fn();
  readonly flush = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
  readonly updateLifecycleState = vi.fn(async (state: string) => {
    this.metadata = {
      ...this.metadata,
      lifecycleState: state,
      lifecycleStateSince: Date.now(),
    };
  });
  readonly sendSessionProtocolMessage = vi.fn((envelope: any) => {
    this.sentEnvelopes.push(envelope);
  });
  readonly updateMetadata = vi.fn(async (handler: (metadata: any) => any) => {
    this.metadata = handler(this.metadata);
  });
  readonly updateAgentState = vi.fn(async (handler: (agentState: any) => any) => {
    this.agentState = handler(this.agentState);
  });

  constructor(
    readonly sessionId: string,
    initialState: ConnectionState,
    initialMetadata: Record<string, unknown> = {},
    initialAgentState: Record<string, unknown> | null = null,
  ) {
    super();
    this.connectionState = initialState;
    this.metadata = initialMetadata;
    this.agentState = initialAgentState;
  }

  getMetadata(): Record<string, unknown> {
    return this.metadata;
  }

  getAgentState(): Record<string, unknown> | null {
    return this.agentState;
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  onUserMessage(callback: (message: any) => void): void {
    this.userMessageHandler = callback;
  }

  emitConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    this.emit('connectionState', state);
  }

  deliverUserMessage(text: string): void {
    this.userMessageHandler?.({
      role: 'user',
      content: {
        type: 'text',
        text,
      },
    });
  }
}

function createCredentials(): PiHappyCredentials {
  return {
    token: 'test-token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32),
    },
    contentKeyPair: {
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(64),
    },
  };
}

function createPiApiStub(): {
  pi: PiExtensionApiLike;
  handlers: RegisteredHandlers;
  sendUserMessage: ReturnType<typeof vi.fn>;
  getAllTools: ReturnType<typeof vi.fn>;
  getCommands: ReturnType<typeof vi.fn>;
} {
  const handlers: RegisteredHandlers = {};
  const sendUserMessage = vi.fn();
  const getAllTools = vi.fn(() => [{ name: 'read' }, { name: 'bash' }]);
  const getCommands = vi.fn(() => [{ name: 'help' }, { name: 'compact' }]);
  const flagValues: Record<string, unknown> = {};

  return {
    handlers,
    sendUserMessage,
    getAllTools,
    getCommands,
    pi: {
      on(eventName, handler) {
        handlers[eventName] = handler as never;
      },
      sendUserMessage,
      getAllTools,
      getCommands,
      registerFlag(name, opts) {
        flagValues[name] = opts.default;
      },
      getFlag(name) {
        return flagValues[name];
      },
      registerCommand() {
        // no-op for event wiring tests
      },
    },
  };
}

function createContext(overrides: Partial<PiHappyExtensionContext> = {}): PiHappyExtensionContext {
  return {
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
    },
    cwd: '/workspace/project',
    model: { name: 'gpt-5' },
    isIdle: vi.fn(() => true),
    abort: vi.fn(),
    shutdown: vi.fn(),
    ...overrides,
  };
}

describe('pi-happy event wiring', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockLoadCredentials.mockResolvedValue(createCredentials());
    mockLoadSettings.mockResolvedValue({ machineId: 'machine-123' });
    mockAxiosPost.mockResolvedValue({ data: { status: 'ok' } });
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('creates a Happy session, bridges outbound and inbound events, syncs metadata, and tears down cleanly', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-happy-event-wiring-'));
    tempDirs.push(tempDir);
    const daemonStateFile = join(tempDir, 'daemon.state.json');
    writeFileSync(daemonStateFile, JSON.stringify({ httpPort: 4321 }));

    mockLoadConfig.mockReturnValue({
      serverUrl: 'https://server.test',
      happyHomeDir: tempDir,
      privateKeyFile: join(tempDir, 'access.key'),
      settingsFile: join(tempDir, 'settings.json'),
      daemonStateFile,
    });

    let fakeClient: FakeSessionClient | undefined;
    mockCreateWithOfflineFallback.mockImplementation(async (_credentials, _config, _tag, metadata) => {
      fakeClient = new FakeSessionClient('session-123', ConnectionState.Connected, metadata as Record<string, unknown>);
      return fakeClient;
    });

    const { pi, handlers, sendUserMessage } = createPiApiStub();
    const ctx = createContext();

    piHappyExtension(pi);

    await handlers.session_start?.({}, ctx);

    expect(mockCreateWithOfflineFallback).toHaveBeenCalledTimes(1);
    expect(fakeClient).toBeDefined();
    const client = fakeClient!;
    const [, clientConfig, sessionTag, metadata, agentState] = mockCreateWithOfflineFallback.mock.calls[0]!;
    expect(typeof sessionTag).toBe('string');
    expect(clientConfig).toEqual(expect.objectContaining({
      serverUrl: 'https://server.test',
      cwd: '/workspace/project',
      onAbort: expect.any(Function),
      onShutdown: expect.any(Function),
      onSessionSwap: expect.any(Function),
    }));
    expect(metadata).toMatchObject({
      path: '/workspace/project',
      machineId: 'machine-123',
      flavor: 'pi',
      startedBy: 'terminal',
      hostPid: process.pid,
      happyHomeDir: tempDir,
      happyLibDir: '',
      happyToolsDir: '',
      tools: ['read', 'bash'],
      slashCommands: ['help', 'compact'],
      currentModelCode: 'gpt-5',
    });
    expect(agentState).toEqual({ controlledByUser: false });
    expect((ctx.ui.setStatus as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(PI_HAPPY_STATUS_KEY, PI_HAPPY_CONNECTED_STATUS);

    expect(mockAxiosPost).toHaveBeenCalledWith(
      'http://127.0.0.1:4321/session-started',
      expect.objectContaining({
        sessionId: 'session-123',
        metadata: expect.objectContaining({
          flavor: 'pi',
          machineId: 'machine-123',
          tools: ['read', 'bash'],
          slashCommands: ['help', 'compact'],
        }),
      }),
      expect.objectContaining({ timeout: 5_000 }),
    );

    await handlers.agent_start?.({}, ctx);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(client.keepAlive).toHaveBeenCalledWith(true, 'local');

    await handlers.turn_start?.({}, ctx);
    await handlers.message_update?.({ assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } }, ctx);
    await handlers.message_update?.({ assistantMessageEvent: { type: 'text_delta', delta: ' world' } }, ctx);
    await handlers.tool_execution_start?.({ toolCallId: 'tool-1', toolName: 'bash', args: { command: 'ls -la' } }, ctx);
    await handlers.tool_execution_end?.({ toolCallId: 'tool-1' }, ctx);
    await handlers.message_update?.({ assistantMessageEvent: { type: 'text_delta', delta: 'Done.' } }, ctx);
    await handlers.turn_end?.({
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Done.' }],
      },
      toolResults: [{ toolCallId: 'tool-1' }],
    }, ctx);
    await handlers.agent_end?.({}, ctx);

    expect(client.sentEnvelopes.map(envelope => envelope.ev.t)).toEqual([
      'turn-start',
      'text',
      'tool-call-start',
      'tool-call-end',
      'text',
      'turn-end',
    ]);
    expect(client.sentEnvelopes[1]).toMatchObject({ ev: { t: 'text', text: 'Hello world' } });
    expect(client.sentEnvelopes[5]).toMatchObject({ ev: { t: 'turn-end', status: 'completed' } });
    expect(client.keepAlive).toHaveBeenLastCalledWith(false, 'local');

    const modelSelectEvent: PiHappyModelSelectEvent = { model: { name: 'claude-sonnet-4' } };
    await handlers.model_select?.(modelSelectEvent, ctx);
    expect(client.getMetadata()).toMatchObject({ currentModelCode: 'claude-sonnet-4' });

    (ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
    client.deliverUserMessage('From mobile');
    expect(sendUserMessage).toHaveBeenCalledWith('From mobile');
    expect((ctx.ui.notify as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('📱 Message from Happy', 'info');

    (ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    client.deliverUserMessage('Steer me');
    expect(sendUserMessage).toHaveBeenCalledWith('Steer me', { deliverAs: 'steer' });

    await handlers.session_shutdown?.({}, ctx);
    expect(client.updateLifecycleState).toHaveBeenCalledWith('archived');
    expect(client.sendSessionDeath).toHaveBeenCalledTimes(1);
    expect(client.flush).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
    expect((ctx.ui.setStatus as ReturnType<typeof vi.fn>)).toHaveBeenLastCalledWith(PI_HAPPY_STATUS_KEY, PI_HAPPY_DISCONNECTED_STATUS);

    client.keepAlive.mockClear();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(client.keepAlive).not.toHaveBeenCalled();
  });

  it('archives the previous Happy session and creates a new one on session_switch', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-happy-session-switch-'));
    tempDirs.push(tempDir);
    const daemonStateFile = join(tempDir, 'daemon.state.json');
    writeFileSync(daemonStateFile, JSON.stringify({ httpPort: 7654 }));

    mockLoadConfig.mockReturnValue({
      serverUrl: 'https://server.test',
      happyHomeDir: tempDir,
      privateKeyFile: join(tempDir, 'access.key'),
      settingsFile: join(tempDir, 'settings.json'),
      daemonStateFile,
    });

    const firstClient = new FakeSessionClient('session-1', ConnectionState.Connected, { flavor: 'pi' });
    const secondClient = new FakeSessionClient('session-2', ConnectionState.Connected, { flavor: 'pi' });
    mockCreateWithOfflineFallback
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);

    const { pi, handlers } = createPiApiStub();
    const ctx = createContext();

    piHappyExtension(pi);

    await handlers.session_start?.({}, ctx);
    await handlers.session_switch?.({}, ctx);

    expect(mockCreateWithOfflineFallback).toHaveBeenCalledTimes(2);
    expect(firstClient.updateLifecycleState).toHaveBeenCalledWith('archived');
    expect(firstClient.sendSessionDeath).toHaveBeenCalledTimes(1);
    expect(firstClient.flush).toHaveBeenCalledTimes(1);
    expect(firstClient.close).toHaveBeenCalledTimes(1);

    await handlers.turn_start?.({}, ctx);
    expect(secondClient.sentEnvelopes).toHaveLength(1);
    expect(secondClient.sentEnvelopes[0]).toMatchObject({ ev: { t: 'turn-start' } });

    expect(mockAxiosPost).toHaveBeenCalledTimes(2);
    expect(mockAxiosPost).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:7654/session-started',
      expect.objectContaining({ sessionId: 'session-1' }),
      expect.any(Object),
    );
    expect(mockAxiosPost).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:7654/session-started',
      expect.objectContaining({ sessionId: 'session-2' }),
      expect.any(Object),
    );
    expect((ctx.ui.setStatus as ReturnType<typeof vi.fn>)).toHaveBeenLastCalledWith(PI_HAPPY_STATUS_KEY, PI_HAPPY_CONNECTED_STATUS);
  });

  it('shows not logged in status and skips Happy startup when credentials are unavailable', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-happy-no-creds-'));
    tempDirs.push(tempDir);

    mockLoadConfig.mockReturnValue({
      serverUrl: 'https://server.test',
      happyHomeDir: tempDir,
      privateKeyFile: join(tempDir, 'access.key'),
      settingsFile: join(tempDir, 'settings.json'),
      daemonStateFile: join(tempDir, 'daemon.state.json'),
    });
    mockLoadCredentials.mockResolvedValue(null);

    const { pi, handlers } = createPiApiStub();
    const ctx = createContext();

    piHappyExtension(pi);
    await handlers.session_start?.({}, ctx);

    expect((ctx.ui.setStatus as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(PI_HAPPY_STATUS_KEY, PI_HAPPY_NOT_LOGGED_IN_STATUS);
    expect(mockCreateWithOfflineFallback).not.toHaveBeenCalled();
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('shows offline status initially and notifies the daemon after a recovered live session swap', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-happy-offline-'));
    tempDirs.push(tempDir);
    const daemonStateFile = join(tempDir, 'daemon.state.json');
    writeFileSync(daemonStateFile, JSON.stringify({ httpPort: 8123 }));

    mockLoadConfig.mockReturnValue({
      serverUrl: 'https://server.test',
      happyHomeDir: tempDir,
      privateKeyFile: join(tempDir, 'access.key'),
      settingsFile: join(tempDir, 'settings.json'),
      daemonStateFile,
    });

    const offlineClient = new FakeSessionClient('offline-session-tag', ConnectionState.Offline, { flavor: 'pi' });
    mockCreateWithOfflineFallback.mockResolvedValue(offlineClient);

    const { pi, handlers } = createPiApiStub();
    const ctx = createContext();

    piHappyExtension(pi);
    await handlers.session_start?.({}, ctx);

    expect((ctx.ui.setStatus as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(PI_HAPPY_STATUS_KEY, PI_HAPPY_OFFLINE_STATUS);
    expect(mockAxiosPost).not.toHaveBeenCalled();

    const recoveredClient = new FakeSessionClient('session-live-123', ConnectionState.Connected, { flavor: 'pi' });
    const onSessionSwap = mockCreateWithOfflineFallback.mock.calls[0]?.[1]?.onSessionSwap as ((client: HappySessionClientLike) => Promise<void>) | undefined;
    await onSessionSwap?.(recoveredClient);

    expect(mockAxiosPost).toHaveBeenCalledWith(
      'http://127.0.0.1:8123/session-started',
      expect.objectContaining({ sessionId: 'session-live-123' }),
      expect.any(Object),
    );
  });

  it('captures inbound message bridge failures without crashing and warns once after ten failures', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-happy-inbound-failures-'));
    tempDirs.push(tempDir);

    mockLoadConfig.mockReturnValue({
      serverUrl: 'https://server.test',
      happyHomeDir: tempDir,
      privateKeyFile: join(tempDir, 'access.key'),
      settingsFile: join(tempDir, 'settings.json'),
      daemonStateFile: join(tempDir, 'daemon.state.json'),
    });

    const client = new FakeSessionClient('session-123', ConnectionState.Connected);
    mockCreateWithOfflineFallback.mockResolvedValue(client);

    const { pi, handlers, sendUserMessage } = createPiApiStub();
    sendUserMessage.mockImplementation(() => {
      throw new Error('send failed');
    });
    const ctx = createContext();

    piHappyExtension(pi);
    await handlers.session_start?.({}, ctx);

    for (let index = 0; index < 10; index += 1) {
      client.deliverUserMessage(`From mobile ${index}`);
    }

    const warnings = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls
      .filter(([message, level]) => message === PI_HAPPY_SYNC_FAILING_NOTIFICATION && level === 'warning');

    expect(warnings).toHaveLength(1);
  });

  it('warns once after ten consecutive handler failures without crashing pi event processing', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-happy-failures-'));
    tempDirs.push(tempDir);

    mockLoadConfig.mockReturnValue({
      serverUrl: 'https://server.test',
      happyHomeDir: tempDir,
      privateKeyFile: join(tempDir, 'access.key'),
      settingsFile: join(tempDir, 'settings.json'),
      daemonStateFile: join(tempDir, 'daemon.state.json'),
    });

    const failingClient = new FakeSessionClient('session-123', ConnectionState.Connected);
    failingClient.sendSessionProtocolMessage.mockImplementation(() => {
      throw new Error('boom');
    });
    mockCreateWithOfflineFallback.mockResolvedValue(failingClient);

    const { pi, handlers } = createPiApiStub();
    const ctx = createContext();

    piHappyExtension(pi);
    await handlers.session_start?.({}, ctx);

    for (let index = 0; index < 10; index += 1) {
      await handlers.tool_execution_start?.({
        toolCallId: `tool-${index}`,
        toolName: 'bash',
        args: { command: `echo ${index}` },
      }, ctx);
    }

    const notifications = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls
      .filter(([message]) => message === PI_HAPPY_SYNC_FAILING_NOTIFICATION);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual([PI_HAPPY_SYNC_FAILING_NOTIFICATION, 'warning']);
  });
});
