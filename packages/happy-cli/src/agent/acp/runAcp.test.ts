import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const sessionHandlers = new Map<string, (params: any) => Promise<any> | any>();
  let userMessageHandler: ((message: any) => void) | null = null;
  let killHandler: (() => Promise<void>) | null = null;

  let fileHandler: ((message: any) => void) | null = null;
  const mockSession = {
    onFileEvent: vi.fn((handler: (message: any) => void) => { fileHandler = handler; }),
    downloadAndDecryptAttachment: vi.fn(async (_ref: string) => new Uint8Array([137, 80, 78, 71])),
    onUserMessage: vi.fn((handler: (message: any) => void, onFile?: (message: any) => void) => {
      userMessageHandler = handler;
      if (onFile) mockSession.onFileEvent(onFile);
    }),
    keepAlive: vi.fn(),
    sendSessionProtocolMessage: vi.fn(),
    sendSessionEvent: vi.fn(),
    processorStarting: vi.fn(() => true),
    processorReady: vi.fn(() => true),
    updateMetadata: vi.fn(),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    updateAgentState: vi.fn((handler: (state: Record<string, unknown>) => Record<string, unknown>) => {
      handler({});
    }),
    rpcHandlerManager: {
      registerHandler: vi.fn((name: string, handler: (params: any) => Promise<any> | any) => {
        sessionHandlers.set(name, handler);
      }),
    },
  };

  const backendState = {
    listeners: [] as Array<(message: any) => void>,
    prompts: [] as Array<{ sessionId: string; prompt: string; images?: unknown[] }>,
    setConfigOptionCalls: [] as Array<{ configId: string; value: string }>,
    setModeCalls: [] as string[],
    setModelCalls: [] as string[],
    startSessionMessages: [] as any[],
    startSessionCalls: 0,
    promptError: null as Error | null,
    holdPrompt: null as Promise<void> | null,
    cancelCalls: [] as string[],
    disposeCalls: 0,
    constructorArgs: null as any,
  };

  return {
    mockReadSettings: vi.fn(async () => ({ machineId: 'machine-1', sandboxConfig: undefined })),
    mockApiCreate: vi.fn(),
    mockGetOrCreateMachine: vi.fn(async () => ({})),
    mockGetOrCreateSession: vi.fn(async () => ({ id: 'session-1' })),
    mockSetupOfflineReconnection: vi.fn(),
    mockNotifyDaemonSessionStarted: vi.fn(async () => ({ error: null })),
    mockStartHappyServer: vi.fn(),
    mockProjectPath: vi.fn(() => '/tmp/happy'),
    mockSetBackend: vi.fn(),
    mockKillRegister: vi.fn((_rpc: unknown, handler: () => Promise<void>) => {
      killHandler = handler;
    }),
    mockLoggerDebug: vi.fn(),
    mockConsoleLog: vi.spyOn(console, 'log').mockImplementation(() => {}),
    sessionHandlers,
    getUserMessageHandler: () => userMessageHandler,
    setUserMessageHandler: (handler: ((message: any) => void) | null) => {
      userMessageHandler = handler;
    },
    getKillHandler: () => killHandler,
    setKillHandler: (handler: (() => Promise<void>) | null) => {
      killHandler = handler;
    },
    mockSession,
    getFileHandler: () => fileHandler,
    backendState,
  };
});

vi.mock('@/persistence', async () => {
  const actual = await vi.importActual<typeof import('@/persistence')>('@/persistence');
  return {
    ...actual,
    readSettings: mocks.mockReadSettings,
  };
});

vi.mock('@/api/api', () => ({
  ApiClient: {
    create: mocks.mockApiCreate,
  },
}));

vi.mock('@/daemon/machineMetadata', () => ({
  initialMachineMetadata: { host: 'host', platform: 'darwin', happyCliVersion: 'test', homeDir: '/tmp', happyHomeDir: '/tmp/.happy', happyLibDir: '/tmp/happy' },
}));

vi.mock('@/utils/setupOfflineReconnection', () => ({
  setupOfflineReconnection: mocks.mockSetupOfflineReconnection,
}));

vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonSessionStarted: mocks.mockNotifyDaemonSessionStarted,
}));

vi.mock('@/claude/registerKillSessionHandler', () => ({
  registerKillSessionHandler: mocks.mockKillRegister,
}));

vi.mock('@/claude/utils/startHappyServer', () => ({
  startHappyServer: mocks.mockStartHappyServer,
}));

vi.mock('@/projectPath', () => ({
  projectPath: mocks.mockProjectPath,
}));

vi.mock('@/utils/serverConnectionErrors', () => ({
  connectionState: {
    setBackend: mocks.mockSetBackend,
  },
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: mocks.mockLoggerDebug,
  },
}));

vi.mock('./AcpBackend', () => ({
  AcpBackend: class MockAcpBackend {
    constructor(args: any) {
      mocks.backendState.constructorArgs = args;
    }

    onMessage(handler: (message: any) => void) {
      mocks.backendState.listeners.push(handler);
    }

    offMessage(handler: (message: any) => void) {
      mocks.backendState.listeners = mocks.backendState.listeners.filter((item) => item !== handler);
    }

    async startSession() {
      mocks.backendState.startSessionCalls += 1;
      for (const message of mocks.backendState.startSessionMessages) {
        for (const listener of mocks.backendState.listeners) {
          listener(message);
        }
      }
      return { sessionId: 'acp-session-1' };
    }

    async sendPrompt(sessionId: string, prompt: string, images?: unknown[]) {
      if (images?.length && mocks.backendState.promptError) throw mocks.backendState.promptError;
      mocks.backendState.prompts.push({ sessionId, prompt, ...(images?.length ? { images } : {}) });
      if (prompt === 'busy') await mocks.backendState.holdPrompt;
      for (const listener of mocks.backendState.listeners) {
        listener({ type: 'status', status: 'running' });
        listener({ type: 'model-output', textDelta: 'hello' });
        listener({ type: 'tool-call', toolName: 'ReadFile', args: { path: 'README.md' }, callId: 'tool-1' });
        listener({ type: 'tool-result', toolName: 'ReadFile', result: { ok: true }, callId: 'tool-1' });
        listener({ type: 'status', status: 'idle' });
      }
    }

    async setSessionConfigOption(configId: string, value: string) {
      mocks.backendState.setConfigOptionCalls.push({ configId, value });
      return true;
    }

    async setSessionMode(modeId: string) {
      mocks.backendState.setModeCalls.push(modeId);
      return true;
    }

    async setSessionModel(modelId: string) {
      mocks.backendState.setModelCalls.push(modelId);
      return true;
    }

    async cancel(sessionId: string) {
      mocks.backendState.cancelCalls.push(sessionId);
      for (const listener of mocks.backendState.listeners) {
        listener({ type: 'status', status: 'stopped' });
      }
    }

    async dispose() {
      mocks.backendState.disposeCalls += 1;
    }
  },
}));

import { runAcp } from './runAcp';
import { AcpImagePromptError } from './imagePromptError';
import { createOfflineSessionStub } from '@/utils/offlineSessionStub';

describe('runAcp', () => {
  const stripAnsi = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, '');
  const stripLogPrefix = (line: string) => stripAnsi(line).replace(/^\[\d{2}:\d{2}\] /, '');
  const consoleLines = () => mocks.mockConsoleLog.mock.calls
    .map((args) => args.map((arg) => String(arg)).join(' '))
    .map(stripLogPrefix);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionHandlers.clear();
    mocks.mockSession.downloadAndDecryptAttachment.mockReset().mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
    mocks.setUserMessageHandler(null);
    mocks.setKillHandler(null);
    mocks.backendState.listeners = [];
    mocks.backendState.prompts = [];
    mocks.backendState.setConfigOptionCalls = [];
    mocks.backendState.setModeCalls = [];
    mocks.backendState.setModelCalls = [];
    mocks.backendState.startSessionMessages = [];
    mocks.backendState.startSessionCalls = 0;
    mocks.backendState.promptError = null;
    mocks.backendState.holdPrompt = null;
    mocks.backendState.cancelCalls = [];
    mocks.backendState.disposeCalls = 0;
    mocks.backendState.constructorArgs = null;

    mocks.mockApiCreate.mockResolvedValue({
      getOrCreateMachine: mocks.mockGetOrCreateMachine,
      getOrCreateSession: mocks.mockGetOrCreateSession,
    });
    mocks.mockSetupOfflineReconnection.mockImplementation(() => ({
      session: mocks.mockSession,
      reconnectionHandle: { cancel: vi.fn() },
      isOffline: false,
    }));
    mocks.mockStartHappyServer.mockResolvedValue({
      url: 'http://127.0.0.1:9876',
      stop: vi.fn(),
    });
  });

  it('emits processor readiness only after the user handler is installed and ACP startSession succeeds', async () => {
    const startupLifecycle = {} as any;
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode', command: 'opencode', args: ['--acp'],
      startupLifecycle,
    });

    await vi.waitFor(() => expect(mocks.backendState.startSessionCalls).toBe(1));

    expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    expect(mocks.mockApiCreate).toHaveBeenCalledWith(expect.any(Object), startupLifecycle);
    expect(mocks.mockSession.processorStarting).toHaveBeenCalledTimes(1);
    expect(mocks.mockSession.processorReady).toHaveBeenCalledTimes(1);
    expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
    expect(mocks.mockSession.processorReady.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.mockSession.sendSessionEvent.mock.invocationCallOrder[0]);

    await mocks.getKillHandler()!();
    await runPromise;
  });

  const imageEvent = (ref: string) => ({ content: { data: { ev: {
    t: 'file', ref, name: ref + '.png', size: 3, mimeType: 'image/png', image: { width: 1, height: 1 },
  } } } });
  const startImages = () => runAcp({
    credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
    agentName: 'opencode', command: 'opencode', args: ['acp'],
  });

  it('forwards decrypted images with their owning text despite out-of-order downloads', async () => {
    let finishFirst!: (value: Uint8Array<ArrayBuffer>) => void;
    mocks.mockSession.downloadAndDecryptAttachment.mockImplementation(ref => ref === 'first'
      ? new Promise(resolve => { finishFirst = resolve; }) : Promise.resolve(new Uint8Array([137, 80, 78, 71, 2])));
    const run = startImages();
    try {
      await vi.waitFor(() => expect(mocks.mockSession.onFileEvent).toHaveBeenCalled());
      mocks.getFileHandler()!(imageEvent('first'));
      mocks.getUserMessageHandler()!({ content: { text: 'first text' }, meta: { model: 'a' } });
      mocks.getFileHandler()!(imageEvent('second'));
      mocks.getUserMessageHandler()!({ content: { text: 'second text' }, meta: { model: 'b' } });
      await Promise.resolve();
      expect(mocks.backendState.prompts).toHaveLength(0);
      finishFirst(new Uint8Array([137, 80, 78, 71, 1]));
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(2));
      expect(mocks.backendState.prompts.map(p => [p.prompt, p.images])).toEqual([
        ['first text', [{ data: new Uint8Array([137, 80, 78, 71, 1]), mimeType: 'image/png', name: 'first.png' }]],
        ['second text', [{ data: new Uint8Array([137, 80, 78, 71, 2]), mimeType: 'image/png', name: 'second.png' }]],
      ]);
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it('reports a failed image without sending its text and accepts the next message', async () => {
    mocks.mockSession.downloadAndDecryptAttachment.mockRejectedValueOnce(new Error('download failed'));
    const run = startImages();
    try {
      await vi.waitFor(() => expect(mocks.mockSession.onFileEvent).toHaveBeenCalled());
      mocks.getFileHandler()!(imageEvent('failed'));
      mocks.getUserMessageHandler()!({ content: { text: 'do not send without image' } });
      await vi.waitFor(() => expect(mocks.mockSession.sendSessionProtocolMessage.mock.calls
        .some(([e]) => e.ev.t === 'text' && /image/i.test(e.ev.text))).toBe(true));
      expect(mocks.backendState.prompts).toHaveLength(0);
      mocks.getUserMessageHandler()!({ content: { text: 'next text' } });
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      expect(mocks.backendState.prompts[0].prompt).toBe('next text');
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it('shows an unsupported-model error and keeps the session usable', async () => {
    mocks.backendState.promptError = new AcpImagePromptError('Selected model does not support image input');
    const run = startImages();
    try {
      await vi.waitFor(() => expect(mocks.mockSession.onFileEvent).toHaveBeenCalled());
      mocks.getFileHandler()!(imageEvent('picture'));
      mocks.getUserMessageHandler()!({ content: { text: 'describe picture' } });
      await vi.waitFor(() => expect(mocks.mockSession.sendSessionProtocolMessage.mock.calls
        .some(([e]) => e.ev.t === 'text' && /Selected model does not support image input/.test(e.ev.text))).toBe(true));
      expect(mocks.backendState.disposeCalls).toBe(0);
      mocks.getUserMessageHandler()!({ content: { text: 'next text' } });
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      expect(mocks.backendState.prompts[0].prompt).toBe('next text');
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it('does not discard queued plain text when a same-model image turn is rejected', async () => {
    let release!: () => void;
    mocks.backendState.holdPrompt = new Promise<void>(resolve => { release = resolve; });
    mocks.backendState.promptError = new AcpImagePromptError('Image unsupported');
    const run = startImages();
    try {
      await vi.waitFor(() => expect(mocks.getUserMessageHandler()).toBeTypeOf('function'));
      mocks.getUserMessageHandler()!({ content: { text: 'busy' } });
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      mocks.getFileHandler()!(imageEvent('picture'));
      mocks.getUserMessageHandler()!({ content: { text: 'picture text' } });
      mocks.getUserMessageHandler()!({ content: { text: 'plain text must survive' } });
      await new Promise(resolve => setTimeout(resolve, 20));
      release();
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(2));
      expect(mocks.backendState.prompts[1].prompt).toBe('plain text must survive');
    } finally { release(); await mocks.getKillHandler()!(); await run; }
  });

  it('detects JPEG bytes when a historical image event has no MIME', async () => {
    const jpeg = new Uint8Array([255, 216, 255, 224]);
    mocks.mockSession.downloadAndDecryptAttachment.mockResolvedValueOnce(jpeg);
    const run = startImages();
    try {
      await vi.waitFor(() => expect(mocks.getUserMessageHandler()).toBeTypeOf('function'));
      const event = imageEvent('photo');
      delete (event.content.data.ev as any).mimeType;
      mocks.getFileHandler()!(event);
      mocks.getUserMessageHandler()!({ content: { text: 'describe photo' } });
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      expect(mocks.backendState.prompts[0].images).toEqual([{ data: jpeg, mimeType: 'image/jpeg', name: 'photo.png' }]);
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it('starts offline and binds image handlers after the real session reconnects', async () => {
    mocks.mockSetupOfflineReconnection.mockReturnValueOnce({
      session: createOfflineSessionStub('offline-image-test'),
      reconnectionHandle: { cancel: vi.fn() }, isOffline: true,
    });
    const run = startImages();
    try {
      await vi.waitFor(() => expect(mocks.backendState.startSessionCalls).toBe(1));
      const swap = mocks.mockSetupOfflineReconnection.mock.calls[0][0].onSessionSwap;
      swap(mocks.mockSession);
      expect(mocks.mockSession.onUserMessage).toHaveBeenCalledWith(expect.any(Function), expect.any(Function));
      mocks.getFileHandler()!(imageEvent('after-reconnect'));
      mocks.getUserMessageHandler()!({ content: { text: 'reconnected image' } });
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      expect(mocks.backendState.prompts[0].images).toHaveLength(1);
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it('wires backend messages through mapper into session envelopes', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['--acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Build a test plan' },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.constructorArgs.command).toBe('opencode');
    expect(mocks.backendState.constructorArgs.args).toEqual(['--acp']);
    expect(mocks.backendState.prompts[0]).toEqual({
      sessionId: 'acp-session-1',
      prompt: 'Build a test plan',
    });

    const envelopeTypes = mocks.mockSession.sendSessionProtocolMessage.mock.calls.map(([envelope]) => envelope.ev.t);
    expect(envelopeTypes).toEqual(['turn-start', 'text', 'tool-call-start', 'tool-call-end', 'turn-end']);
    expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
    expect(mocks.mockSession.close).toHaveBeenCalled();
    expect(consoleLines()).toEqual(expect.arrayContaining([
      'Happy Session ID: session-1',
      'Incoming prompt: Build a test plan',
      'Status: running',
      'Outgoing message: "hello"',
      'Tool: ReadFile started (callId=tool-1)',
      'Tool: ReadFile completed (callId=tool-1)',
      'Status: idle',
    ]));
  });

  it('registers abort handler that cancels the ACP backend session', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'gemini',
      command: 'gemini',
      args: ['--experimental-acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });

    const abortHandler = mocks.sessionHandlers.get('abort');
    expect(abortHandler).toBeTypeOf('function');

    await abortHandler!({});
    await vi.waitFor(() => {
      expect(mocks.backendState.cancelCalls).toEqual(['acp-session-1']);
    });

    await mocks.getKillHandler()!();
    await runPromise;
  });

  it('emits thinking messages in default mode', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['--acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    const listener = mocks.backendState.listeners[0];
    const prompts = mocks.backendState.prompts;
    if (!listener) {
      throw new Error('Expected backend listener to be registered');
    }

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Think first' },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    listener({ type: 'event', name: 'thinking', payload: { text: 'Analyzing request' } });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(prompts).toHaveLength(1);
    expect(consoleLines()).toEqual(expect.arrayContaining([
      'Thinking: "Analyzing request"',
    ]));
  });

  it('emits raw backend and envelope logs when verbose is enabled', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
      verbose: true,
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Run the command' },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    const lines = consoleLines();
    expect(lines.some((line) => line.startsWith('Outgoing raw backend message from opencode: '))).toBe(true);
    expect(lines.some((line) => line.startsWith('Incoming raw envelope for opencode: '))).toBe(true);
    expect(lines).toEqual(expect.arrayContaining([
      'Outgoing message: "hello"',
      'Tool: ReadFile started (callId=tool-1)',
    ]));
  });

  it('logs slash commands, modes, and models line by line when verbose is enabled', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'available_commands',
        payload: [
          { name: 'init', description: 'create/update AGENTS.md' },
          { name: 'review', description: 'review uncommitted changes' },
        ],
      },
      {
        type: 'event',
        name: 'modes_update',
        payload: {
          availableModes: [
            { id: 'build', name: 'build', description: 'Executes tools' },
            { id: 'plan', name: 'plan', description: 'Disallows edit tools' },
          ],
          currentModeId: 'build',
        },
      },
      {
        type: 'event',
        name: 'models_update',
        payload: {
          currentModelId: 'gemini-2.5-pro',
          availableModels: [
            { modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
            { modelId: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'gemini',
      command: 'gemini',
      args: ['--experimental-acp'],
      verbose: true,
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    const lines = consoleLines();
    expect(lines).toEqual(expect.arrayContaining([
      'Outgoing slash commands from gemini (2):',
      '  /init - create/update AGENTS.md',
      '  /review - review uncommitted changes',
      'Outgoing modes from gemini (2), current=build:',
      '  mode=build name=build - Executes tools',
      '  mode=plan name=plan - Disallows edit tools',
      'Outgoing models from gemini (2), current=gemini-2.5-pro:',
      '  model=gemini-2.5-pro name=Gemini 2.5 Pro',
      '  model=gemini-2.5-flash name=Gemini 2.5 Flash',
    ]));
  });

  it('exits when backend reports terminal startup status', async () => {
    mocks.backendState.startSessionMessages = [
      { type: 'status', status: 'error', detail: 'spawn opencode ENOENT' },
    ];

    await runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    expect(consoleLines()).toContain('Status: error: spawn opencode ENOENT');
    expect(mocks.mockSession.close).toHaveBeenCalled();
    expect(mocks.backendState.disposeCalls).toBe(1);
  });

  it('updates session metadata with ACP config options (models and operating modes)', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              type: 'select',
              id: 'mode',
              name: 'Mode',
              category: 'mode',
              currentValue: 'code',
              options: [
                { value: 'ask', name: 'Ask', description: 'Q&A mode' },
                { value: 'code', name: 'Code', description: 'Implementation mode' },
              ],
            },
            {
              type: 'select',
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'claude-sonnet',
              options: [
                { value: 'claude-sonnet', name: 'Claude Sonnet', description: 'Balanced model' },
                { value: 'claude-opus', name: 'Claude Opus', description: 'Deep reasoning model' },
              ],
            },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    const metadataHandlers = mocks.mockSession.updateMetadata.mock.calls.map((call) => call[0]);
    const baseMetadata = {
      path: '/repo',
      host: 'host',
      homeDir: '/home/user',
      happyHomeDir: '/home/user/.happy',
      happyLibDir: '/repo/.happy/lib',
      happyToolsDir: '/repo/.happy/tools',
    };
    const appliedMetadata = metadataHandlers.map((handler) => handler(baseMetadata));

    expect(appliedMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currentModelCode: 'claude-sonnet',
          currentOperatingModeCode: 'code',
          models: [
            { code: 'claude-sonnet', value: 'Claude Sonnet', description: 'Balanced model' },
            { code: 'claude-opus', value: 'Claude Opus', description: 'Deep reasoning model' },
          ],
          operatingModes: [
            { code: 'ask', value: 'Ask', description: 'Q&A mode' },
            { code: 'code', value: 'Code', description: 'Implementation mode' },
          ],
        }),
      ]),
    );
  });

  it('switches ACP model and permission mode when requested values match config options', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              type: 'select',
              id: 'permission-mode',
              name: 'Permission Mode',
              category: 'mode',
              currentValue: 'ask',
              options: [
                { value: 'ask', name: 'Ask' },
                { value: 'code', name: 'Code' },
              ],
            },
            {
              type: 'select',
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'claude-sonnet',
              options: [
                { value: 'claude-sonnet', name: 'Claude Sonnet' },
                { value: 'claude-opus', name: 'Claude Opus' },
              ],
            },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Apply settings then run' },
      meta: {
        permissionMode: 'Code',
        model: 'claude-opus',
      },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.setConfigOptionCalls).toEqual([
      { configId: 'permission-mode', value: 'code' },
      { configId: 'model', value: 'claude-opus' },
    ]);
    expect(mocks.backendState.setModeCalls).toEqual([]);
    expect(mocks.backendState.setModelCalls).toEqual([]);
  });

  it('ignores ACP model and permission mode requests when values do not match advertised options', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              type: 'select',
              id: 'permission-mode',
              name: 'Permission Mode',
              category: 'mode',
              currentValue: 'ask',
              options: [
                { value: 'ask', name: 'Ask' },
                { value: 'code', name: 'Code' },
              ],
            },
            {
              type: 'select',
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'claude-sonnet',
              options: [
                { value: 'claude-sonnet', name: 'Claude Sonnet' },
                { value: 'claude-opus', name: 'Claude Opus' },
              ],
            },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Run without switching' },
      meta: {
        permissionMode: 'invalid-mode',
        model: 'invalid-model',
      },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.setConfigOptionCalls).toEqual([]);
    expect(mocks.backendState.setModeCalls).toEqual([]);
    expect(mocks.backendState.setModelCalls).toEqual([]);
  });
});
