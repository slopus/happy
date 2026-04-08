import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildWidgetLines,
  ConnectionUIManager,
  createConnectionStats,
  formatUptime,
  getConnectionStatusLabel,
  NOTIFICATION_MOBILE_MESSAGE,
  NOTIFICATION_RECONNECTED,
  NOTIFICATION_SYNC_FAILING,
  PI_HAPPY_STATUS_KEY,
  PI_HAPPY_WIDGET_KEY,
  STATUS_CONNECTED,
  STATUS_CONNECTING,
  STATUS_DISCONNECTED,
  STATUS_NOT_LOGGED_IN,
  STATUS_OFFLINE,
  STATUS_RECONNECTING,
  truncateSessionId,
} from '../ui';
import { ConnectionState } from '../types';
import type { PiHappyUiLike } from '../types';
import type { HappySessionClientLike } from '../offline-stub';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockUI(): PiHappyUiLike & {
  setStatus: ReturnType<typeof vi.fn>;
  setWidget: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
} {
  return {
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    notify: vi.fn(),
    theme: {
      fg: (color: string, text: string) => text,
      bold: (text: string) => text,
    },
  };
}

class FakeClient extends EventEmitter {
  constructor(
    readonly sessionId: string,
    private state: ConnectionState = ConnectionState.Connected,
  ) {
    super();
  }

  getConnectionState(): ConnectionState {
    return this.state;
  }

  setConnectionState(state: ConnectionState): void {
    this.state = state;
    this.emit('connectionState', state);
  }
}

// ---------------------------------------------------------------------------
// getConnectionStatusLabel
// ---------------------------------------------------------------------------

describe('getConnectionStatusLabel', () => {
  it('returns Connected label', () => {
    expect(getConnectionStatusLabel(ConnectionState.Connected)).toBe(STATUS_CONNECTED);
  });

  it('returns Reconnecting label for Connecting', () => {
    expect(getConnectionStatusLabel(ConnectionState.Connecting)).toBe(STATUS_RECONNECTING);
  });

  it('returns Offline label', () => {
    expect(getConnectionStatusLabel(ConnectionState.Offline)).toBe(STATUS_OFFLINE);
  });

  it('returns Disconnected label', () => {
    expect(getConnectionStatusLabel(ConnectionState.Disconnected)).toBe(STATUS_DISCONNECTED);
  });
});

// ---------------------------------------------------------------------------
// truncateSessionId
// ---------------------------------------------------------------------------

describe('truncateSessionId', () => {
  it('does not truncate short IDs', () => {
    expect(truncateSessionId('abc')).toBe('abc');
    expect(truncateSessionId('12-chars-ok!')).toBe('12-chars-ok!');
  });

  it('truncates long IDs to first 8 chars + ellipsis', () => {
    expect(truncateSessionId('abcdefgh12345678')).toBe('abcdefgh…');
    expect(truncateSessionId('session-very-long-id-123')).toBe('session-…');
  });
});

// ---------------------------------------------------------------------------
// formatUptime
// ---------------------------------------------------------------------------

describe('formatUptime', () => {
  it('formats seconds', () => {
    expect(formatUptime(0)).toBe('0s');
    expect(formatUptime(5_000)).toBe('5s');
    expect(formatUptime(59_000)).toBe('59s');
  });

  it('formats minutes and seconds', () => {
    expect(formatUptime(60_000)).toBe('1m 0s');
    expect(formatUptime(90_000)).toBe('1m 30s');
    expect(formatUptime(3_540_000)).toBe('59m 0s');
  });

  it('formats hours and minutes', () => {
    expect(formatUptime(3_600_000)).toBe('1h 0m');
    expect(formatUptime(3_660_000)).toBe('1h 1m');
    expect(formatUptime(7_200_000)).toBe('2h 0m');
  });

  it('handles negative durations', () => {
    expect(formatUptime(-1000)).toBe('0s');
  });
});

// ---------------------------------------------------------------------------
// createConnectionStats
// ---------------------------------------------------------------------------

describe('createConnectionStats', () => {
  it('initializes with zero counts and null connectedSince', () => {
    const stats = createConnectionStats();
    expect(stats.messagesSent).toBe(0);
    expect(stats.messagesReceived).toBe(0);
    expect(stats.connectedSince).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildWidgetLines
// ---------------------------------------------------------------------------

describe('buildWidgetLines', () => {
  it('builds two lines with session ID, state, uptime, and message counts', () => {
    const stats = createConnectionStats();
    stats.messagesSent = 5;
    stats.messagesReceived = 3;
    stats.connectedSince = 1000;

    const lines = buildWidgetLines('session-abc123456789', stats, ConnectionState.Connected, 61_000);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('session-…');
    expect(lines[0]).toContain(STATUS_CONNECTED);
    expect(lines[1]).toContain('1m 0s');
    expect(lines[1]).toContain('Sent: 5');
    expect(lines[1]).toContain('Recv: 3');
  });

  it('shows dash for uptime when not connected', () => {
    const stats = createConnectionStats();
    const lines = buildWidgetLines('sess-123', stats, ConnectionState.Disconnected);

    expect(lines[1]).toContain('Uptime: —');
  });

  it('shows dash for uptime when connectedSince is null even if connected', () => {
    const stats = createConnectionStats();
    stats.connectedSince = null;
    const lines = buildWidgetLines('sess-123', stats, ConnectionState.Connected);

    expect(lines[1]).toContain('Uptime: —');
  });
});

// ---------------------------------------------------------------------------
// ConnectionUIManager
// ---------------------------------------------------------------------------

describe('ConnectionUIManager', () => {
  let ui: ReturnType<typeof createMockUI>;
  let manager: ConnectionUIManager;

  beforeEach(() => {
    vi.useFakeTimers();
    ui = createMockUI();
    manager = new ConnectionUIManager(true, ui);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('attach / detach', () => {
    it('sets status and widget on attach', () => {
      const client = new FakeClient('session-abc');
      manager.attach(client as unknown as HappySessionClientLike);

      expect(ui.setStatus).toHaveBeenCalledWith(PI_HAPPY_STATUS_KEY, STATUS_CONNECTED);
      expect(ui.setWidget).toHaveBeenCalledWith(PI_HAPPY_WIDGET_KEY, expect.any(Array));
    });

    it('records connectedSince when client is already connected', () => {
      const client = new FakeClient('session-abc', ConnectionState.Connected);
      manager.attach(client as unknown as HappySessionClientLike);

      expect(manager.stats.connectedSince).toBeGreaterThan(0);
    });

    it('clears UI on detach', () => {
      const client = new FakeClient('session-abc');
      manager.attach(client as unknown as HappySessionClientLike);
      ui.setStatus.mockClear();
      ui.setWidget.mockClear();

      manager.detach();

      expect(ui.setStatus).toHaveBeenCalledWith(PI_HAPPY_STATUS_KEY, STATUS_DISCONNECTED);
      expect(ui.setWidget).toHaveBeenCalledWith(PI_HAPPY_WIDGET_KEY, undefined);
    });

    it('stops the widget refresh loop on detach', () => {
      const client = new FakeClient('session-abc');
      manager.attach(client as unknown as HappySessionClientLike);
      ui.setWidget.mockClear();

      manager.detach();
      vi.advanceTimersByTime(20_000);

      // Only the detach clear call, no interval updates
      expect(ui.setWidget).toHaveBeenCalledTimes(1);
      expect(ui.setWidget).toHaveBeenCalledWith(PI_HAPPY_WIDGET_KEY, undefined);
    });
  });

  describe('connection state tracking', () => {
    it('updates status when client transitions to Connecting', () => {
      const client = new FakeClient('session-abc', ConnectionState.Connected);
      manager.attach(client as unknown as HappySessionClientLike);
      ui.setStatus.mockClear();

      client.setConnectionState(ConnectionState.Connecting);

      expect(ui.setStatus).toHaveBeenCalledWith(PI_HAPPY_STATUS_KEY, STATUS_RECONNECTING);
    });

    it('updates status when client transitions to Disconnected', () => {
      const client = new FakeClient('session-abc', ConnectionState.Connected);
      manager.attach(client as unknown as HappySessionClientLike);
      ui.setStatus.mockClear();

      client.setConnectionState(ConnectionState.Disconnected);

      expect(ui.setStatus).toHaveBeenCalledWith(PI_HAPPY_STATUS_KEY, STATUS_DISCONNECTED);
    });

    it('clears connectedSince when transitioning to Disconnected', () => {
      const client = new FakeClient('session-abc', ConnectionState.Connected);
      manager.attach(client as unknown as HappySessionClientLike);
      expect(manager.stats.connectedSince).not.toBeNull();

      client.setConnectionState(ConnectionState.Disconnected);

      expect(manager.stats.connectedSince).toBeNull();
    });

    it('sets connectedSince when transitioning to Connected from Disconnected', () => {
      const client = new FakeClient('session-abc', ConnectionState.Disconnected);
      manager.attach(client as unknown as HappySessionClientLike);
      expect(manager.stats.connectedSince).toBeNull();

      client.setConnectionState(ConnectionState.Connected);

      expect(manager.stats.connectedSince).not.toBeNull();
    });
  });

  describe('notifications', () => {
    it('notifies reconnection when transitioning from Offline to Connected', () => {
      const client = new FakeClient('session-abc', ConnectionState.Offline);
      manager.attach(client as unknown as HappySessionClientLike);
      ui.notify.mockClear();

      client.setConnectionState(ConnectionState.Connected);

      expect(ui.notify).toHaveBeenCalledWith(NOTIFICATION_RECONNECTED, 'info');
    });

    it('notifies reconnection when transitioning from Disconnected to Connected', () => {
      const client = new FakeClient('session-abc', ConnectionState.Disconnected);
      manager.attach(client as unknown as HappySessionClientLike);
      ui.notify.mockClear();

      client.setConnectionState(ConnectionState.Connected);

      expect(ui.notify).toHaveBeenCalledWith(NOTIFICATION_RECONNECTED, 'info');
    });

    it('does not notify reconnection when already Connected', () => {
      const client = new FakeClient('session-abc', ConnectionState.Connected);
      manager.attach(client as unknown as HappySessionClientLike);
      ui.notify.mockClear();

      // Simulate a no-op transition (shouldn't happen in practice)
      client.emit('connectionState', ConnectionState.Connected);

      // No notification expected for Connected → Connected
      const reconnectCalls = ui.notify.mock.calls.filter(
        (call) => call[0] === NOTIFICATION_RECONNECTED,
      );
      expect(reconnectCalls).toHaveLength(0);
    });

    it('notifyMobileMessage emits correct notification', () => {
      manager.notifyMobileMessage();
      expect(ui.notify).toHaveBeenCalledWith(NOTIFICATION_MOBILE_MESSAGE, 'info');
    });

    it('notifySyncFailing emits warning', () => {
      manager.notifySyncFailing();
      expect(ui.notify).toHaveBeenCalledWith(NOTIFICATION_SYNC_FAILING, 'warning');
    });

    it('notifyReconnected emits info', () => {
      manager.notifyReconnected();
      expect(ui.notify).toHaveBeenCalledWith(NOTIFICATION_RECONNECTED, 'info');
    });
  });

  describe('message tracking', () => {
    it('increments sent count', () => {
      expect(manager.stats.messagesSent).toBe(0);
      manager.recordSent();
      manager.recordSent();
      expect(manager.stats.messagesSent).toBe(2);
    });

    it('increments received count', () => {
      expect(manager.stats.messagesReceived).toBe(0);
      manager.recordReceived();
      expect(manager.stats.messagesReceived).toBe(1);
    });

    it('resetStats clears counters', () => {
      manager.recordSent();
      manager.recordSent();
      manager.recordReceived();
      manager.stats.connectedSince = 12345;

      manager.resetStats();

      expect(manager.stats.messagesSent).toBe(0);
      expect(manager.stats.messagesReceived).toBe(0);
      expect(manager.stats.connectedSince).toBeNull();
    });
  });

  describe('widget refresh loop', () => {
    it('refreshes widget every 10 seconds', () => {
      const client = new FakeClient('session-abc', ConnectionState.Connected);
      manager.attach(client as unknown as HappySessionClientLike);
      const initialCallCount = ui.setWidget.mock.calls.length;

      vi.advanceTimersByTime(10_000);
      expect(ui.setWidget.mock.calls.length).toBe(initialCallCount + 1);

      vi.advanceTimersByTime(10_000);
      expect(ui.setWidget.mock.calls.length).toBe(initialCallCount + 2);
    });
  });

  describe('updateSessionId', () => {
    it('updates the session ID used in the widget', () => {
      const client = new FakeClient('old-session', ConnectionState.Connected);
      manager.attach(client as unknown as HappySessionClientLike);

      manager.updateSessionId('new-session-id-12345');
      expect(manager.getSessionId()).toBe('new-session-id-12345');

      // Verify widget refreshed with new ID
      const lastWidgetCall = ui.setWidget.mock.calls.at(-1);
      expect(lastWidgetCall?.[0]).toBe(PI_HAPPY_WIDGET_KEY);
      expect(lastWidgetCall?.[1]?.[0]).toContain('new-sess…');
    });
  });

  describe('setStatusDirect', () => {
    it('sets arbitrary status text', () => {
      manager.setStatusDirect(STATUS_NOT_LOGGED_IN);
      expect(ui.setStatus).toHaveBeenCalledWith(PI_HAPPY_STATUS_KEY, STATUS_NOT_LOGGED_IN);
    });
  });

  describe('with hasUI=false', () => {
    it('does not call any UI methods', () => {
      const noUI = createMockUI();
      const noUIManager = new ConnectionUIManager(false, noUI);
      const client = new FakeClient('session-abc', ConnectionState.Connected);

      noUIManager.attach(client as unknown as HappySessionClientLike);
      noUIManager.notifyMobileMessage();
      noUIManager.notifyReconnected();
      noUIManager.notifySyncFailing();
      noUIManager.setStatusDirect('test');

      expect(noUI.setStatus).not.toHaveBeenCalled();
      expect(noUI.setWidget).not.toHaveBeenCalled();
      expect(noUI.notify).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Commands: status
// ---------------------------------------------------------------------------

describe('handleStatusCommand', () => {
  // Import dynamically to avoid vi.mock collisions with the main event-wiring test
  it('formats and displays status info', async () => {
    const { handleStatusCommand } = await import('../commands/status');
    const ui = createMockUI();

    const uiManager = new ConnectionUIManager(true, ui);
    const client = new FakeClient('session-xyz-123', ConnectionState.Connected);
    uiManager.attach(client as unknown as HappySessionClientLike);
    uiManager.recordSent();
    uiManager.recordSent();
    uiManager.recordReceived();

    const statusUI = createMockUI();
    handleStatusCommand(
      uiManager,
      { serverUrl: 'https://example.com', happyHomeDir: '/home/.happy', privateKeyFile: '', settingsFile: '', daemonStateFile: '' },
      { machineId: 'machine-abc' },
      true,
      { hasUI: true, ui: statusUI },
    );

    expect(statusUI.notify).toHaveBeenCalledTimes(1);
    const notifyText = statusUI.notify.mock.calls[0]?.[0] as string;
    expect(notifyText).toContain('Logged in');
    expect(notifyText).toContain('https://example.com');
    expect(notifyText).toContain('session-xyz-123');
    expect(notifyText).toContain('sent=2');
    expect(notifyText).toContain('received=1');
    expect(notifyText).toContain('machine-abc');
  });

  it('shows not authenticated when no credentials', async () => {
    const { handleStatusCommand, formatStatusLines, gatherStatusInfo } = await import('../commands/status');

    const info = gatherStatusInfo(null, null, null, false);
    expect(info.authenticated).toBe(false);

    const lines = formatStatusLines(info);
    expect(lines[0]).toContain('Not logged in');
  });
});

// ---------------------------------------------------------------------------
// Commands: connect / disconnect (gatherStatusInfo / formatStatusLines tested above)
// ---------------------------------------------------------------------------

describe('handleDisconnectCommand', () => {
  it('gracefully closes the session and clears client', async () => {
    const { handleDisconnectCommand } = await import('../commands/connect');
    const ui = createMockUI();
    const uiManager = new ConnectionUIManager(true, ui);

    const fakeClient = {
      sessionId: 'session-1',
      updateLifecycleState: vi.fn(async () => {}),
      sendSessionDeath: vi.fn(),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      getConnectionState: () => ConnectionState.Connected,
      getMetadata: () => ({}),
      getAgentState: () => null,
    };

    let storedClient: any = fakeClient;
    const deps = {
      pi: {
        on: vi.fn(),
        sendUserMessage: vi.fn(),
        getAllTools: () => [],
        getCommands: () => [],
        registerFlag: vi.fn(),
        getFlag: vi.fn(),
        registerCommand: vi.fn(),
      },
      uiManager,
      getClient: () => storedClient,
      setClient: (c: any) => { storedClient = c; },
      getConfig: () => null,
      setConfig: vi.fn(),
      getSettings: () => null,
      setSettings: vi.fn(),
      getCredentials: () => null,
      setCredentials: vi.fn(),
      setAuthenticated: vi.fn(),
      onClientReady: vi.fn(),
    };

    await handleDisconnectCommand(deps, { hasUI: true, ui: createMockUI() });

    expect(fakeClient.updateLifecycleState).toHaveBeenCalledWith('archived');
    expect(fakeClient.sendSessionDeath).toHaveBeenCalledTimes(1);
    expect(fakeClient.flush).toHaveBeenCalledTimes(1);
    expect(fakeClient.close).toHaveBeenCalledTimes(1);
    expect(storedClient).toBeNull();
  });

  it('notifies when no active session exists', async () => {
    const { handleDisconnectCommand } = await import('../commands/connect');
    const uiManager = new ConnectionUIManager(true, createMockUI());
    const ctxUI = createMockUI();

    const deps = {
      pi: {
        on: vi.fn(),
        sendUserMessage: vi.fn(),
        getAllTools: () => [],
        getCommands: () => [],
        registerFlag: vi.fn(),
        getFlag: vi.fn(),
        registerCommand: vi.fn(),
      },
      uiManager,
      getClient: () => null,
      setClient: vi.fn(),
      getConfig: () => null,
      setConfig: vi.fn(),
      getSettings: () => null,
      setSettings: vi.fn(),
      getCredentials: () => null,
      setCredentials: vi.fn(),
      setAuthenticated: vi.fn(),
      onClientReady: vi.fn(),
    };

    await handleDisconnectCommand(deps, { hasUI: true, ui: ctxUI });

    expect(ctxUI.notify).toHaveBeenCalledWith(
      expect.stringContaining('No active session'),
      'info',
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: flag and commands wired in piHappyExtension
// ---------------------------------------------------------------------------

describe('piHappyExtension with UI, flag, and commands', () => {
  const { mockCreateWithOfflineFallback, mockLoadConfig, mockLoadCredentials, mockLoadSettings } = vi.hoisted(() => ({
    mockCreateWithOfflineFallback: vi.fn(),
    mockLoadConfig: vi.fn(),
    mockLoadCredentials: vi.fn(),
    mockLoadSettings: vi.fn(),
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
      post: vi.fn(async () => ({ data: { status: 'ok' } })),
    },
  }));

  // Need to import after mocking
  let piHappyExtension: typeof import('../index').default;
  let PI_HAPPY_STATUS_KEY_IMPORT: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    const mod = await import('../index');
    piHappyExtension = mod.default;
    PI_HAPPY_STATUS_KEY_IMPORT = mod.PI_HAPPY_STATUS_KEY;

    mockLoadCredentials.mockResolvedValue({
      token: 'test-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
      contentKeyPair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
    });
    mockLoadSettings.mockResolvedValue({ machineId: 'machine-1' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createPiStub() {
    type Handler = (event: any, ctx: any) => void | Promise<void>;
    type CommandHandler = (args: string, ctx: any) => void | Promise<void>;

    const handlers: Record<string, Handler> = {};
    const commands: Record<string, { description: string; handler: CommandHandler }> = {};
    const flags: Record<string, { description: string; type: string; default?: unknown }> = {};
    const flagValues: Record<string, unknown> = {};

    return {
      handlers,
      commands,
      flags,
      flagValues,
      pi: {
        on(eventName: string, handler: Handler) {
          handlers[eventName] = handler;
        },
        sendUserMessage: vi.fn(),
        getAllTools: () => [{ name: 'read' }],
        getCommands: () => [{ name: 'help' }],
        registerFlag(name: string, opts: any) {
          flags[name] = opts;
          flagValues[name] = opts.default;
        },
        getFlag(name: string): unknown {
          return flagValues[name];
        },
        registerCommand(name: string, opts: any) {
          commands[name] = opts;
        },
      },
    };
  }

  function createCtx(overrides: Record<string, unknown> = {}) {
    return {
      hasUI: true,
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn(),
        theme: {
          fg: (_c: string, t: string) => t,
          bold: (t: string) => t,
        },
      },
      cwd: '/project',
      model: { name: 'claude-4' },
      isIdle: vi.fn(() => true),
      abort: vi.fn(),
      shutdown: vi.fn(),
      ...overrides,
    };
  }

  it('registers --no-happy flag', () => {
    const { pi, flags } = createPiStub();
    piHappyExtension(pi as any);

    expect(flags['no-happy']).toBeDefined();
    expect(flags['no-happy'].type).toBe('boolean');
    expect(flags['no-happy'].default).toBe(false);
  });

  it('registers happy-status, happy-disconnect, and happy-connect commands', () => {
    const { pi, commands } = createPiStub();
    piHappyExtension(pi as any);

    expect(commands['happy-status']).toBeDefined();
    expect(commands['happy-disconnect']).toBeDefined();
    expect(commands['happy-connect']).toBeDefined();
    expect(commands['happy-status'].description).toContain('status');
  });

  it('skips session_start when --no-happy is true', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-happy-nohappy-'));

    try {
      mockLoadConfig.mockReturnValue({
        serverUrl: 'https://server.test',
        happyHomeDir: tempDir,
        privateKeyFile: join(tempDir, 'access.key'),
        settingsFile: join(tempDir, 'settings.json'),
        daemonStateFile: join(tempDir, 'daemon.state.json'),
      });

      const { pi, handlers, flagValues } = createPiStub();
      piHappyExtension(pi as any);

      // Set flag AFTER piHappyExtension (registerFlag sets default=false)
      flagValues['no-happy'] = true;
      const ctx = createCtx();

      await handlers.session_start?.({}, ctx);

      expect(mockCreateWithOfflineFallback).not.toHaveBeenCalled();
      expect(mockLoadCredentials).not.toHaveBeenCalled();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('skips session_switch and session_shutdown when disabled', async () => {
    const { pi, handlers, flagValues } = createPiStub();
    piHappyExtension(pi as any);

    // Set flag AFTER piHappyExtension (registerFlag sets default=false)
    flagValues['no-happy'] = true;
    const ctx = createCtx();

    // Start the session (will be disabled)
    await handlers.session_start?.({}, ctx);

    // These should be no-ops
    await handlers.session_switch?.({}, ctx);
    await handlers.session_shutdown?.({}, ctx);

    expect(mockCreateWithOfflineFallback).not.toHaveBeenCalled();
  });

  it('sets widget with session info on connected session', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-happy-widget-'));

    try {
      mockLoadConfig.mockReturnValue({
        serverUrl: 'https://server.test',
        happyHomeDir: tempDir,
        privateKeyFile: join(tempDir, 'access.key'),
        settingsFile: join(tempDir, 'settings.json'),
        daemonStateFile: join(tempDir, 'daemon.state.json'),
      });

      const fakeClient = new FakeClient('session-xyz-longid', ConnectionState.Connected);
      mockCreateWithOfflineFallback.mockResolvedValue(fakeClient);

      const { pi, handlers } = createPiStub();
      piHappyExtension(pi as any);
      const ctx = createCtx();

      await handlers.session_start?.({}, ctx);

      // Check that setWidget was called
      expect(ctx.ui.setWidget).toHaveBeenCalled();
      const widgetCalls = (ctx.ui.setWidget as ReturnType<typeof vi.fn>).mock.calls;
      const lastWidgetCall = widgetCalls.at(-1);
      expect(lastWidgetCall?.[0]).toBe('happy-session');
      expect(lastWidgetCall?.[1]).toEqual(expect.arrayContaining([
        expect.stringContaining('session-…'),
      ]));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('tracks sent message counts through envelope sends', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-happy-msgcount-'));

    try {
      mockLoadConfig.mockReturnValue({
        serverUrl: 'https://server.test',
        happyHomeDir: tempDir,
        privateKeyFile: join(tempDir, 'access.key'),
        settingsFile: join(tempDir, 'settings.json'),
        daemonStateFile: join(tempDir, 'daemon.state.json'),
      });

      const sentEnvelopes: any[] = [];
      const fakeClient = new EventEmitter() as any;
      fakeClient.sessionId = 'session-123';
      fakeClient.getConnectionState = () => ConnectionState.Connected;
      fakeClient.getMetadata = () => ({});
      fakeClient.getAgentState = () => null;
      fakeClient.keepAlive = vi.fn();
      fakeClient.sendSessionProtocolMessage = vi.fn((e: any) => sentEnvelopes.push(e));
      fakeClient.onUserMessage = vi.fn();
      fakeClient.rpcHandlerManager = {
        registerHandler: vi.fn(),
        unregisterHandler: vi.fn(),
      };
      fakeClient.on = EventEmitter.prototype.on.bind(fakeClient);

      mockCreateWithOfflineFallback.mockResolvedValue(fakeClient);

      const { pi, handlers } = createPiStub();
      piHappyExtension(pi as any);
      const ctx = createCtx();

      await handlers.session_start?.({}, ctx);

      // Send some events that produce envelopes
      await handlers.turn_start?.({}, ctx);
      await handlers.message_update?.({ assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } }, ctx);
      await handlers.turn_end?.({
        message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Hello' }] },
        toolResults: [],
      }, ctx);

      // Envelopes sent: turn-start, text, turn-end → 3
      expect(sentEnvelopes.length).toBeGreaterThanOrEqual(3);

      // Verify widget includes Sent count
      const widgetCalls = (ctx.ui.setWidget as ReturnType<typeof vi.fn>).mock.calls;
      const lastWidget = widgetCalls.at(-1)?.[1];
      if (Array.isArray(lastWidget)) {
        const statsLine = lastWidget.find((line: string) => line.includes('Sent:'));
        expect(statsLine).toBeDefined();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('/happy-status command shows status info', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-happy-cmdstatus-'));

    try {
      mockLoadConfig.mockReturnValue({
        serverUrl: 'https://server.test',
        happyHomeDir: tempDir,
        privateKeyFile: join(tempDir, 'access.key'),
        settingsFile: join(tempDir, 'settings.json'),
        daemonStateFile: join(tempDir, 'daemon.state.json'),
      });

      const fakeClient = new FakeClient('session-for-status', ConnectionState.Connected);
      mockCreateWithOfflineFallback.mockResolvedValue(fakeClient);

      const { pi, handlers, commands } = createPiStub();
      piHappyExtension(pi as any);
      const ctx = createCtx();

      await handlers.session_start?.({}, ctx);

      // Call the status command
      const cmdCtx = createCtx();
      await commands['happy-status'].handler('', cmdCtx);

      expect(cmdCtx.ui.notify).toHaveBeenCalledTimes(1);
      const text = (cmdCtx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      expect(text).toContain('Logged in');
      expect(text).toContain('https://server.test');
      expect(text).toContain('session-for-status');
      expect(text).toContain('machine-1');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('/happy-connect tells user if disabled', async () => {
    const { pi, handlers, commands, flagValues } = createPiStub();
    piHappyExtension(pi as any);

    // Set flag AFTER piHappyExtension (registerFlag sets default=false)
    flagValues['no-happy'] = true;
    const ctx = createCtx();
    await handlers.session_start?.({}, ctx);

    const cmdCtx = createCtx();
    await commands['happy-connect'].handler('', cmdCtx);

    expect(cmdCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('--no-happy'),
      'info',
    );
  });
});
