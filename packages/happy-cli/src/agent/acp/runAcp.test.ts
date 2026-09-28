import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TITLE_INSTRUCTION } from '@/utils/titlePrompt';

const mocks = vi.hoisted(() => {
  const sessionHandlers = new Map<string, (params: any) => Promise<any> | any>();
  let userMessageHandler: ((message: any) => void) | null = null;
  let killHandler: (() => Promise<void>) | null = null;

  const mockSession = {
    on: vi.fn(),
    onUserMessage: vi.fn((handler: (message: any) => void) => {
      userMessageHandler = handler;
    }),
    keepAlive: vi.fn(),
    /** Default to a titled session so existing prompt assertions stay verbatim. */
    hasTitle: vi.fn(() => true),
    sendSessionProtocolMessage: vi.fn(),
    sendSessionEvent: vi.fn(),
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
    prompts: [] as Array<{ sessionId: string; prompt: string }>,
    setConfigOptionCalls: [] as Array<{ configId: string; value: string }>,
    setModeCalls: [] as string[],
    setModelCalls: [] as string[],
    startSessionMessages: [] as any[],
    startSessionCalls: 0,
    cancelCalls: [] as string[],
    disposeCalls: 0,
    constructorArgs: null as any,
    /** When set, sendPrompt emits nothing so the turn looks silent. */
    silentPrompt: false,
    /**
     * When set, sendPrompt stays pending until cancel — matching real ACP,
     * where the session/prompt RPC only settles once the turn ends.
     */
    hangPromptUntilCancel: false,
    resolveHangingPrompt: null as (() => void) | null,
    /** Lifecycle events in order, for the standalone drain tests. */
    order: [] as string[],
    exit: null as { code: number | null; signal: string | null; forced: boolean } | null,
    /** When set, the next backend is the real AcpBackend driving a real agent process. */
    realBackend: false,
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

vi.mock('@/daemon/run', () => ({
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
    BASH_STREAM_AGENT_TOOL_NAME: 'mcp__happy__bash_stream',
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
    debugLargeJson: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('./AcpBackend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./AcpBackend')>();
  return {
  AcpBackend: class MockAcpBackend {
    constructor(args: any) {
      mocks.backendState.constructorArgs = args;
      if (mocks.backendState.realBackend) {
        return new actual.AcpBackend(args) as any;
      }
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

    async sendPrompt(sessionId: string, prompt: string) {
      mocks.backendState.prompts.push({ sessionId, prompt });
      if (mocks.backendState.hangPromptUntilCancel) {
        await new Promise<void>((resolve) => {
          mocks.backendState.resolveHangingPrompt = resolve;
        });
        return;
      }
      if (mocks.backendState.silentPrompt) {
        return;
      }
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

    endInput() {
      mocks.backendState.order.push('input-ended');
      // The fake agent ends on its own when its input closes.
      mocks.backendState.exit = { code: 0, signal: null, forced: false };
    }

    processExit() {
      return mocks.backendState.exit;
    }

    processId() {
      return mocks.backendState.startSessionCalls > 0 ? 4242 : undefined;
    }

    async cancel(sessionId: string) {
      mocks.backendState.cancelCalls.push(sessionId);
      mocks.backendState.order.push('turn-cancelled');
      // The real AcpBackend awaits the cancel RPC before emitting, so emitting
      // synchronously here would let 'stopped' pre-empt the caller's own
      // post-cancel bookkeeping and exercise a path production never takes.
      await Promise.resolve();
      if (mocks.backendState.resolveHangingPrompt) {
        // A real cancel crosses the network, so the hung prompt settles on a
        // later macrotask — after Node has already checked for unhandled
        // rejections — not in the same microtask drain as the watchdog firing.
        await new Promise((resolve) => setTimeout(resolve, 0));
        mocks.backendState.resolveHangingPrompt();
        mocks.backendState.resolveHangingPrompt = null;
      }
      for (const listener of mocks.backendState.listeners) {
        listener({ type: 'status', status: 'stopped' });
      }
    }

    async dispose() {
      mocks.backendState.disposeCalls += 1;
      mocks.backendState.order.push(mocks.backendState.exit ? 'disposed-after-exit' : 'disposed-live');
    }
  },
  };
});

import { runAcp } from './runAcp';

describe('runAcp', () => {
  const stripAnsi = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, '');
  const stripLogPrefix = (line: string) => stripAnsi(line).replace(/^\[\d{2}:\d{2}\] /, '');
  const consoleLines = () => mocks.mockConsoleLog.mock.calls
    .map((args) => args.map((arg) => String(arg)).join(' '))
    .map(stripLogPrefix);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionHandlers.clear();
    mocks.setUserMessageHandler(null);
    mocks.setKillHandler(null);
    mocks.backendState.listeners = [];
    mocks.backendState.prompts = [];
    mocks.backendState.setConfigOptionCalls = [];
    mocks.backendState.setModeCalls = [];
    mocks.backendState.setModelCalls = [];
    mocks.backendState.startSessionMessages = [];
    mocks.backendState.startSessionCalls = 0;
    mocks.backendState.cancelCalls = [];
    mocks.backendState.disposeCalls = 0;
    mocks.backendState.constructorArgs = null;
    mocks.backendState.silentPrompt = false;
    mocks.backendState.hangPromptUntilCancel = false;
    mocks.backendState.resolveHangingPrompt = null;
    mocks.backendState.order = [];
    mocks.backendState.exit = null;
    mocks.backendState.realBackend = false;

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

  describe('chat title instruction', () => {
    async function promptOnce(hasTitle: boolean): Promise<string> {
      mocks.mockSession.hasTitle.mockReturnValue(hasTitle);
      const runPromise = runAcp({
        credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
        agentName: 'grok',
        command: 'grok',
        args: ['agent', 'stdio'],
      });

      await vi.waitFor(() => {
        expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
      });
      mocks.getUserMessageHandler()!({
        role: 'user',
        content: { type: 'text', text: 'Fix the login bug' },
      });
      await vi.waitFor(() => {
        expect(mocks.backendState.prompts).toHaveLength(1);
      });
      await mocks.getKillHandler()!();
      await runPromise;

      return mocks.backendState.prompts[0].prompt;
    }

    it('shouldAppendChangeTitleInstructionWhenSessionHasNoTitle', async () => {
      const prompt = await promptOnce(false);

      expect(prompt).toContain('Fix the login bug');
      expect(prompt).toContain('mcp__happy__change_title');
      expect(prompt).toContain(TITLE_INSTRUCTION);
    });

    it('shouldLeavePromptUntouchedWhenSessionAlreadyHasTitle', async () => {
      const prompt = await promptOnce(true);

      expect(prompt).toBe('Fix the login bug');
    });
  });

  it('launches the Happy MCP bridge through node, which Windows agents can spawn without a shell', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'grok',
      command: 'grok',
      args: ['agent', 'stdio'],
    });
    await vi.waitFor(() => expect(mocks.backendState.startSessionCalls).toBe(1));
    await mocks.getKillHandler()!();
    await runPromise;

    // A .mjs path is not an executable on Windows (os error 193); node runs it everywhere.
    expect(mocks.backendState.constructorArgs.mcpServers.happy).toEqual({
      command: process.execPath,
      args: ['--no-warnings', '--no-deprecation', '/tmp/happy/bin/happy-mcp.mjs', '--url', 'http://127.0.0.1:9876'],
    });
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

  it('cancels the backend when a turn goes silent for the inactivity window', async () => {
    mocks.backendState.silentPrompt = true;
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['--acp'],
      turnInactivityTimeoutMs: 250,
    });
    // The runner tears itself down once the turn fails; capture why.
    const settled = runPromise.then(() => null).catch((error: Error) => error);

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });
    mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text: 'hang please' } });

    // The old wall-clock timer rejected the turn while leaving the agent running.
    await vi.waitFor(() => {
      expect(mocks.backendState.cancelCalls).toContain('acp-session-1');
    });

    // The turn must fail *as inactivity*, not as a side effect of the cancel.
    expect((await settled)?.message).toContain('produced no activity');
  });

  it('keeps a slow turn alive while the backend keeps reporting activity', async () => {
    mocks.backendState.silentPrompt = true;
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['--acp'],
      turnInactivityTimeoutMs: 1000,
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });
    mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text: 'long but alive' } });
    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    // Total elapsed time exceeds the window, but no single gap does.
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      for (const listener of mocks.backendState.listeners) {
        listener({ type: 'model-output', textDelta: `chunk-${i}` });
      }
    }

    expect(mocks.backendState.cancelCalls).not.toContain('acp-session-1');

    // Killing mid-turn rejects the still-pending turn; that is the shutdown path.
    await mocks.getKillHandler()!();
    await runPromise.catch(() => { });
  });

  // In real ACP the session/prompt RPC spans the whole turn, so when the
  // watchdog fires the runner is still suspended at `await sendPrompt` and no
  // handler is attached to the turn promise yet. Rejecting it there used to
  // surface as an unhandled rejection, which crashes the process (skipping all
  // finally-cleanup) instead of failing the turn.
  it('fails the turn without an unhandled rejection when the prompt RPC outlives the watchdog', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      mocks.backendState.hangPromptUntilCancel = true;
      const runPromise = runAcp({
        credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
        agentName: 'opencode',
        command: 'opencode',
        args: ['--acp'],
        turnInactivityTimeoutMs: 250,
      });
      const settled = runPromise.then(() => null).catch((error: Error) => error);

      await vi.waitFor(() => {
        expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
      });
      mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text: 'hang forever' } });

      expect((await settled)?.message).toContain('produced no activity');
      // Let Node deliver any pending unhandledRejection events.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('keeps a turn alive while an approval awaits the user', async () => {
    mocks.backendState.silentPrompt = true;
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['--acp'],
      turnInactivityTimeoutMs: 300,
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });
    mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text: 'needs approval' } });
    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    // ACP resolves approvals inside this call, so it stays pending exactly as
    // long as the user takes to answer. That wait is not provider inactivity.
    const decision = mocks.backendState.constructorArgs.permissionHandler
      .handleToolCall('tool-1', 'Bash', { command: 'ls' });
    void decision.catch(() => { });

    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(mocks.backendState.cancelCalls).not.toContain('acp-session-1');

    await mocks.getKillHandler()!();
    await runPromise.catch(() => { });
  });

  it('records grok sessions under their own flavor rather than generic acp', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'grok',
      command: 'grok',
      args: ['agent', 'stdio'],
    });

    await vi.waitFor(() => {
      expect(mocks.mockGetOrCreateSession).toHaveBeenCalled();
    });

    // The mock is declared without a parameter signature, so its recorded call
    // args widen to an empty tuple; read them through the real payload shape.
    const [payload] = mocks.mockGetOrCreateSession.mock.calls[0] as unknown as [{ metadata: { flavor: string } }];
    expect(payload.metadata.flavor).toBe('grok');

    await mocks.getKillHandler()!();
    await runPromise;
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
  describe('runAcp under a Windows standalone drain (W0-5f)', () => {
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
    const storage = (order: string[]) => ({
      tracksShutdownStorage: true,
      canFreezeInboundMessagesForShutdown: () => true,
      freezeInboundMessagesForShutdown: vi.fn(() => { order.push('inbound-frozen'); return true; }),
      flushForShutdown: vi.fn(async () => { order.push('storage-flushed'); return { stored: true as const, revision: 1 }; }),
      isStorageConfirmationCurrent: () => true,
    });
    async function withStorage<T>(work: (order: string[]) => Promise<T>): Promise<T> {
      const order = mocks.backendState.order;
      const extra = storage(order);
      Object.assign(mocks.mockSession, extra);
      mocks.mockSession.close.mockImplementation(async () => { order.push('session-closed'); });
      try { return await work(order); } finally {
        for (const key of Object.keys(extra)) delete (mocks.mockSession as Record<string, unknown>)[key];
        mocks.mockSession.close.mockImplementation(async () => {});
      }
    }

    it('refuses a standalone launch the daemon did not start, before creating an API client', async () => {
      const { StandaloneLaunchControl } = await import('@/daemon/standaloneLaunchControl');
      const parent = await StandaloneLaunchControl.open('acp-terminal-instance');
      try {
        await expect(runAcp({ credentials, agentName: 'opencode', command: 'opencode', args: ['acp'], startedBy: 'terminal',
          standaloneLaunch: parent.reserve('acp-terminal-launch') })).rejects.toThrow(/daemon-started/);
        expect(mocks.mockApiCreate).not.toHaveBeenCalled();
      } finally { await parent.close(); }
    });

    it('drains an idle agent through the real launch channel: freeze, input EOF, storage proof, then cleanup', async () => {
      const { StandaloneLaunchControl } = await import('@/daemon/standaloneLaunchControl');
      const parent = await StandaloneLaunchControl.open('acp-idle-instance');
      const bootstrap = parent.reserve('acp-idle-launch');
      try {
        await withStorage(async (order) => {
          const runPromise = runAcp({ credentials, agentName: 'opencode', command: 'opencode', args: ['acp'], startedBy: 'daemon', standaloneLaunch: bootstrap });
          await vi.waitFor(() => expect(mocks.backendState.startSessionCalls).toBe(1));
          expect(mocks.mockSetupOfflineReconnection).toHaveBeenCalledWith(expect.objectContaining({ sessionOptions: { trackShutdownStorage: true } }));
          const proof = await parent.drain(bootstrap.launchId, new AbortController().signal, { remainingMs: () => 30_000 });
          expect(proof).toEqual({ stored: true, releaseAcknowledged: true });
          await runPromise;
          expect(order).toEqual(['inbound-frozen', 'input-ended', 'storage-flushed', 'disposed-after-exit', 'session-closed']);
        });
      } finally { await parent.close(); }
    });

    it('stops on SIGTERM through the same path as a kill, instead of dying mid-decision', async () => {
      const { StandaloneLaunchControl } = await import('@/daemon/standaloneLaunchControl');
      const parent = await StandaloneLaunchControl.open('acp-signal-instance');
      const before = process.listenerCount('SIGTERM');
      try {
        await withStorage(async () => {
          const runPromise = runAcp({ credentials, agentName: 'opencode', command: 'opencode', args: ['acp'], startedBy: 'daemon', standaloneLaunch: parent.reserve('acp-signal-launch') });
          await vi.waitFor(() => expect(mocks.backendState.startSessionCalls).toBe(1));
          expect(process.listenerCount('SIGTERM')).toBe(before + 1);
          process.emit('SIGTERM', 'SIGTERM');
          await expect(runPromise).resolves.toBeUndefined();
          expect(mocks.backendState.disposeCalls).toBe(1);
          expect(process.listenerCount('SIGTERM')).toBe(before);
        });
      } finally { await parent.close(); }
    });

    it('cancels a running turn before closing the input, and ends that turn as cancelled rather than failed', async () => {
      const { StandaloneLaunchControl } = await import('@/daemon/standaloneLaunchControl');
      const parent = await StandaloneLaunchControl.open('acp-busy-instance');
      const bootstrap = parent.reserve('acp-busy-launch');
      mocks.backendState.hangPromptUntilCancel = true;
      try {
        await withStorage(async (order) => {
          const runPromise = runAcp({ credentials, agentName: 'grok', command: 'grok', args: ['agent', 'stdio'], startedBy: 'daemon', standaloneLaunch: bootstrap });
          await vi.waitFor(() => expect(mocks.getUserMessageHandler()).toBeTypeOf('function'));
          mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text: 'long work' } });
          await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
          const proof = await parent.drain(bootstrap.launchId, new AbortController().signal, { remainingMs: () => 30_000 });
          expect(proof).toEqual({ stored: true, releaseAcknowledged: true });
          await expect(runPromise).resolves.toBeUndefined();
          expect(order).toEqual(['inbound-frozen', 'turn-cancelled', 'input-ended', 'storage-flushed', 'disposed-after-exit', 'session-closed']);
          const turnEnds = mocks.mockSession.sendSessionProtocolMessage.mock.calls
            .map(([envelope]: any[]) => envelope?.ev).filter((ev: any) => ev?.t === 'turn-end');
          expect(turnEnds.map((ev: any) => ev.status)).toEqual(['cancelled']);
        });
      } finally { await parent.close(); }
    });

    it('finishes the drain when a real agent exits on input EOF without answering the cancelled prompt', async () => {
      const { StandaloneLaunchControl } = await import('@/daemon/standaloneLaunchControl');
      const parent = await StandaloneLaunchControl.open('acp-eof-instance');
      const bootstrap = parent.reserve('acp-eof-launch');
      const agent = fileURLToPath(new URL('./__fixtures__/fakeAcpAgent.mjs', import.meta.url));
      mocks.backendState.realBackend = true;
      vi.stubEnv('FAKE_ACP_HOLD_PROMPT', '1');
      try {
        await withStorage(async () => {
          const runPromise = runAcp({ credentials, agentName: 'grok', command: process.execPath, args: [agent], startedBy: 'daemon', standaloneLaunch: bootstrap });
          await vi.waitFor(() => expect(mocks.getUserMessageHandler()).toBeTypeOf('function'), { timeout: 10_000 });
          mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text: 'long work' } });
          await vi.waitFor(() => expect(mocks.mockSession.keepAlive).toHaveBeenCalledWith(true, 'remote'), { timeout: 10_000 });
          const proof = await parent.drain(bootstrap.launchId, new AbortController().signal, { remainingMs: () => 30_000 });
          expect(proof).toEqual({ stored: true, releaseAcknowledged: true });
          await expect(runPromise).resolves.toBeUndefined();
          const turnEnds = mocks.mockSession.sendSessionProtocolMessage.mock.calls
            .map(([envelope]: any[]) => envelope?.ev).filter((ev: any) => ev?.t === 'turn-end');
          expect(turnEnds.map((ev: any) => ev.status)).toEqual(['cancelled']);
        });
      } finally {
        vi.unstubAllEnvs();
        await parent.close();
      }
    }, 40_000);
  });
});
