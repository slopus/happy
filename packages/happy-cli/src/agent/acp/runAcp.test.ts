import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const sessionHandlers = new Map<string, (params: any) => Promise<any> | any>();
  let userMessageHandler: ((message: any) => void) | null = null;
  let killHandler: (() => Promise<void>) | null = null;

  let fileHandler: ((message: any) => void) | null = null;
  let agentState: Record<string, any> = {};
  const metadataListeners = new Set<(metadata: any) => void>();
  const connectedListeners = new Set<() => void>();
  const mockSession = {
    sessionId: 'session-1',
    getMetadata: vi.fn(() => null as any),
    getCurrentRootTurnId: vi.fn(() => undefined as string | undefined),
    acknowledgeCancelledUserInput: vi.fn(),
    hasPendingUserInputs: vi.fn(() => false),
    on: vi.fn((name: string, callback: any) => { if (name === 'metadata-updated') metadataListeners.add(callback); if (name === 'connected') connectedListeners.add(callback); }),
    off: vi.fn((name: string, callback: any) => { if (name === 'metadata-updated') metadataListeners.delete(callback); if (name === 'connected') connectedListeners.delete(callback); }),
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
    reportDelegationReady: vi.fn(),
    canRetireDelegation: vi.fn(() => false),
    beginDelegationRetirement: vi.fn(),
    declareDelegationSupport: vi.fn(),
    updateMetadata: vi.fn(),
    updateMetadataAndAwait: vi.fn(async (_handler: (metadata: any) => any) => {}),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    updateAgentState: vi.fn((handler: (state: Record<string, unknown>) => Record<string, unknown>) => {
      agentState = handler(agentState);
    }),
    rpcHandlerManager: {
      registerHandler: vi.fn((name: string, handler: (params: any) => Promise<any> | any) => {
        sessionHandlers.set(name, handler);
      }),
    },
  };

  const backendState = {
    listeners: [] as Array<(message: any) => void>,
    prompts: [] as Array<{ sessionId: string; prompt: string; rawPrompt: string; images?: unknown[] }>,
    configResponse: null as null | ((id: string, value: string) => any),
    setConfigOptionCalls: [] as Array<{ configId: string; value: string }>,
    setModeCalls: [] as string[],
    setModelCalls: [] as string[],
    startSessionMessages: [] as any[],
    startSessionCalls: 0,
    holdStartup: null as Promise<void> | null,
    promptError: null as Error | null,
    holdPrompt: null as Promise<void> | null,
    holdConfig: null as Promise<void> | null,
    promptRunning: false,
    cancelCalls: [] as string[],
    cancelError: null as Error | null,
    onCancel: null as (() => Promise<void>) | null,
    cancelOutcome: 'cancelled' as 'cancelled' | 'end_turn',
    disposeCalls: 0,
    constructorArgs: null as any,
    delegatedLaunch: null as null | { parentSessionId: string; taskId: string },
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
    metadataListeners,
    connectedListeners,
    getAgentState: () => agentState,
    resetAgentState: () => { agentState = {}; },
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

vi.mock('@/daemon/delegationLaunchContext', () => ({ delegationLaunchContext: () => mocks.backendState.delegatedLaunch }));

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

vi.mock('./AcpBackend', async (importOriginal) => ({
  ...await importOriginal<typeof import('./AcpBackend')>(),
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
      if (mocks.backendState.holdStartup) await mocks.backendState.holdStartup;
      for (const message of mocks.backendState.startSessionMessages) {
        for (const listener of mocks.backendState.listeners) {
          listener(message);
        }
      }
      return { sessionId: 'acp-session-1' };
    }

    async sendPrompt(sessionId: string, prompt: string, images?: unknown[]) {
      if (images?.length && mocks.backendState.promptError) throw mocks.backendState.promptError;
      const userPrompt = prompt.split('\n\n<happy-delegation-discovery>')[0];
      mocks.backendState.prompts.push({ sessionId, prompt: userPrompt, rawPrompt: prompt, ...(images?.length ? { images } : {}) });
      mocks.backendState.promptRunning = true;
      if (userPrompt.startsWith('busy')) await mocks.backendState.holdPrompt;
      for (const listener of mocks.backendState.listeners) {
        listener({ type: 'status', status: 'running' });
        listener({ type: 'model-output', textDelta: 'hello' });
        listener({ type: 'tool-call', toolName: 'ReadFile', args: { path: 'README.md' }, callId: 'tool-1' });
        listener({ type: 'tool-result', toolName: 'ReadFile', result: { ok: true }, callId: 'tool-1' });
        listener({ type: 'status', status: 'idle' });
      }
      mocks.backendState.promptRunning = false;
    }

    async setSessionConfigOption(configId: string, value: string) {
      mocks.backendState.setConfigOptionCalls.push({ configId, value });
      if (mocks.backendState.holdConfig) await mocks.backendState.holdConfig;
      const update = mocks.backendState.configResponse?.(configId, value);
      if (update) for (const listener of mocks.backendState.listeners) listener(update);
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
      if (mocks.backendState.cancelError) throw mocks.backendState.cancelError;
      const wasRunning = mocks.backendState.promptRunning;
      await mocks.backendState.onCancel?.();
      if (wasRunning && mocks.backendState.cancelOutcome === 'cancelled') {
        for (const listener of mocks.backendState.listeners) listener({ type: 'event', name: 'prompt_cancelled', payload: {} });
      }
    }

    async dispose() {
      mocks.backendState.disposeCalls += 1;
    }
  },
}));

import { runAcp } from './runAcp';
import { normalizeAcpPermissionRequest } from './AcpBackend';
import { DefaultTransport } from '@/agent/transport';
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
    mocks.mockSession.canRetireDelegation.mockReturnValue(false);
    mocks.resetAgentState();
    mocks.metadataListeners.clear();
    mocks.connectedListeners.clear();
    mocks.mockSession.updateMetadata.mockReset();
    mocks.mockSession.getMetadata.mockReset().mockReturnValue({ flavor: 'antigravity', hostPid: process.pid });
    mocks.mockSession.updateMetadataAndAwait.mockReset().mockImplementation(async handler => {
      mocks.mockSession.getMetadata.mockReturnValue(handler(mocks.mockSession.getMetadata()));
    });
    mocks.mockSession.getCurrentRootTurnId.mockReset().mockImplementation(() => {
      let turnId: string | undefined;
      for (const [envelope] of mocks.mockSession.sendSessionProtocolMessage.mock.calls as any[]) {
        if (envelope.ev.t === 'turn-start') turnId = envelope.turn;
        if (envelope.ev.t === 'turn-end') turnId = undefined;
      }
      return turnId;
    });
    mocks.sessionHandlers.clear();
    mocks.mockSession.downloadAndDecryptAttachment.mockReset().mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
    mocks.setUserMessageHandler(null);
    mocks.setKillHandler(null);
    mocks.backendState.listeners = [];
    mocks.backendState.prompts = [];
    mocks.backendState.setConfigOptionCalls = [];
    mocks.backendState.configResponse = null;
    mocks.backendState.setModeCalls = [];
    mocks.backendState.setModelCalls = [];
    mocks.backendState.startSessionMessages = [];
    mocks.backendState.startSessionCalls = 0;
    mocks.backendState.holdStartup = null;
    mocks.backendState.promptError = null;
    mocks.backendState.holdPrompt = null;
    mocks.backendState.holdConfig = null;
    mocks.backendState.promptRunning = false;
    mocks.backendState.cancelCalls = [];
    mocks.backendState.cancelError = null;
    mocks.backendState.onCancel = null;
    mocks.backendState.cancelOutcome = 'cancelled';
    mocks.backendState.disposeCalls = 0;
    mocks.backendState.constructorArgs = null;
    mocks.backendState.delegatedLaunch = null;

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

  it.each(['antigravity', 'opencode'])('retains daemon conversation lineage before creating/reporting the %s session', async agentName => {
    vi.stubEnv('HAPPY_FORKED_FROM_SESSION_ID', 'original-source');
    vi.stubEnv('HAPPY_FORKED_FROM_MESSAGE_ID', 'rewind-point');
    vi.stubEnv('HAPPY_CROSS_AGENT_REQUEST_ID', 'immutable-switch-request');
    const response = { id: 'session-1', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy', seq: 0, metadataVersion: 1, agentStateVersion: 1 };
    mocks.mockGetOrCreateSession.mockResolvedValueOnce(response);
    const run = runAcp({ credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName, command: '/fixture/agent', args: ['--acp'], startedBy: 'daemon' });
    try {
      await vi.waitFor(() => expect(mocks.backendState.startSessionCalls).toBe(1));
      const lineage = { parentSessionId: 'original-source', forkedFromMessageId: 'rewind-point', crossAgentRequestId: 'immutable-switch-request' };
      expect(mocks.mockGetOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining(lineage) }));
      expect(mocks.mockNotifyDaemonSessionStarted).toHaveBeenCalledWith('session-1', expect.objectContaining(lineage), expect.any(Object));
      expect(process.env.HAPPY_CROSS_AGENT_REQUEST_ID).toBeUndefined();
    } finally { await mocks.getKillHandler()!(); await run; vi.unstubAllEnvs(); }
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

  it.each(['antigravity', 'opencode', 'gemini'])('selects the AGY schema profile only for the injected antigravity bridge: %s', async agentName => {
    const run = runAcp({ credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName, command: '/test/agent', args: ['acp'] });
    try {
      await vi.waitFor(() => expect(mocks.backendState.startSessionCalls).toBe(1));
      expect(mocks.backendState.constructorArgs.mcpServers).toEqual({ happy: {
        command: '/tmp/happy/bin/happy-mcp.mjs',
        args: ['--url', 'http://127.0.0.1:9876', ...(agentName === 'antigravity' ? ['--schema-profile', 'antigravity'] : [])],
      } });
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it('publishes the native ACP options and returns the exact persistent scope chosen by the client', async () => {
    const run = runAcp({ credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'antigravity', command: '/test/agy', args: ['acp'] });
    try {
      await vi.waitFor(() => expect(mocks.backendState.startSessionCalls).toBe(1));
      const pending = mocks.backendState.constructorArgs.permissionHandler.handleToolCall('native-call', 'execute', { CommandLine: 'pwd' }, [
        { optionId: 'once', kind: 'allow_once', name: '本次允许' },
        { optionId: 'remember', kind: 'allow_always', name: '记住此命令' },
      ]);
      const state = mocks.mockSession.updateAgentState.mock.calls.map(([update]) => update({} as any))
        .find(state => Object.values((state.requests ?? {}) as object).some((request: any) => request.tool === 'execute')) as any;
      const id = Object.keys(state.requests)[0];
      expect(state.requests[id].permissionOptions).toEqual([
        { id: 'once', kind: 'allow_once', name: '本次允许' },
        { id: 'remember', kind: 'allow_always', name: '记住此命令' },
      ]);
      await mocks.sessionHandlers.get('permission')!({ id, approved: true, decision: 'approved_for_session', optionId: 'remember' });
      await expect(pending).resolves.toEqual({ decision: 'approved_for_session', optionId: 'remember' });
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it('applies an explicit agy full-access setting to pending and subsequent requests, then restores confirmation', async () => {
    const run = runAcp({ credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'antigravity', command: '/test/agy', args: ['acp'] });
    try {
      await vi.waitFor(() => expect(mocks.backendState.startSessionCalls).toBe(1));
      const handler = mocks.backendState.constructorArgs.permissionHandler;
      const pending = handler.handleToolCall('before', 'execute', { CommandLine: 'pwd' });
      const setMode = mocks.sessionHandlers.get('setPermissionMode');
      expect(setMode).toBeTypeOf('function');
      await expect(setMode!({ mode: 'bypassPermissions' })).resolves.toBe(true);
      await expect(pending).resolves.toEqual({ decision: 'approved' });
      await expect(handler.handleToolCall('after', 'execute', { CommandLine: 'pwd' })).resolves.toEqual({ decision: 'approved' });
      await expect(setMode!({ mode: 'default' })).resolves.toBe(true);
      mocks.getUserMessageHandler()!({ content: { text: 'stale queued mode' }, meta: { permissionMode: 'bypassPermissions' } });
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      let resolved = false;
      const next = handler.handleToolCall('confirm-again', 'execute', { CommandLine: 'pwd' }).then(() => { resolved = true; });
      await Promise.resolve();
      expect(resolved).toBe(false);
      await expect(setMode!({ mode: 'invalid' })).rejects.toThrow();
      await setMode!({ mode: 'bypassPermissions' });
      await next;
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it('does not mark an ambiguous ACP approval as granted and rebinds live controls after a session swap', async () => {
    const run = runAcp({ credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'antigravity', command: '/test/agy', args: ['acp'] });
    try {
      await vi.waitFor(() => expect(mocks.backendState.startSessionCalls).toBe(1));
      const pending = mocks.backendState.constructorArgs.permissionHandler.handleToolCall('ambiguous', 'execute', {}, [
        { optionId: 'scope-a', kind: 'allow_once', name: 'A' }, { optionId: 'scope-b', kind: 'allow_once', name: 'B' },
      ]);
      const id = Object.keys(mocks.getAgentState().requests)[0];
      await mocks.sessionHandlers.get('permission')!({ id, approved: true });
      await expect(pending).resolves.toEqual({ decision: 'abort' });
      expect(mocks.getAgentState().completedRequests[id].status).toBe('denied');
      const handlers = new Map<string, any>();
      const nextSession = { ...mocks.mockSession, rpcHandlerManager: { registerHandler: (name: string, handler: any) => handlers.set(name, handler) } };
      const oldListener = [...mocks.metadataListeners][0];
      mocks.mockSetupOfflineReconnection.mock.calls[0][0].onSessionSwap(nextSession);
      expect(handlers.get('setPermissionMode')).toBeTypeOf('function');
      expect(mocks.metadataListeners.size).toBe(1);
      const writes = mocks.mockSession.updateMetadata.mock.calls.length;
      oldListener({ flavor: 'antigravity' });
      expect(mocks.mockSession.updateMetadata).toHaveBeenCalledTimes(writes);
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it('restores worker-owned approval state after another metadata writer drops it, without changing the policy or looping', async () => {
    let metadata: any = { flavor: 'antigravity', hostPid: process.pid, capabilities: { regenerateTitle: true } };
    mocks.mockSession.updateMetadata.mockImplementation(apply => { metadata = apply(metadata); });
    mocks.mockSession.getMetadata.mockImplementation(() => metadata);
    const run = runAcp({ credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'antigravity', command: '/test/agy', args: ['acp'] });
    const changedElsewhere = (next: any) => {
      metadata = next;
      for (const listener of mocks.metadataListeners) listener(next);
    };
    try {
      await vi.waitFor(() => expect(mocks.backendState.startSessionCalls).toBe(1));
      await mocks.sessionHandlers.get('setPermissionMode')!({ mode: 'bypassPermissions' });
      changedElsewhere({ flavor: 'antigravity', hostPid: process.pid, name: 'kept title', lastUserMessageAt: 42, capabilities: { regenerateTitle: true } });
      expect(metadata).toMatchObject({ name: 'kept title', lastUserMessageAt: 42,
        capabilities: { regenerateTitle: true, acpPermissionPolicy: true }, acpPermissionMode: 'bypassPermissions' });
      await mocks.sessionHandlers.get('setPermissionMode')!({ mode: 'default' });
      changedElsewhere({ ...metadata, acpPermissionMode: 'bypassPermissions' });
      expect(metadata.acpPermissionMode).toBe('default');
      const writes = mocks.mockSession.updateMetadata.mock.calls.length;
      changedElsewhere(metadata);
      expect(mocks.mockSession.updateMetadata).toHaveBeenCalledTimes(writes);
      changedElsewhere({ ...metadata, acpPermissionMode: undefined, lifecycleState: 'archiveRequested' });
      expect(mocks.mockSession.updateMetadata).toHaveBeenCalledTimes(writes);
    } finally { await mocks.getKillHandler()!(); await run; }
    expect(mocks.metadataListeners.size).toBe(0);
    expect(mocks.connectedListeners.size).toBe(0);
  });

  it('rechecks the active approval policy once per reconnect even if the local metadata still looks healthy', async () => {
    const run = runAcp({ credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'antigravity', command: '/test/agy', args: ['acp'] });
    try {
      await vi.waitFor(() => expect(mocks.backendState.startSessionCalls).toBe(1));
      await mocks.sessionHandlers.get('setPermissionMode')!({ mode: 'default' });
      expect(mocks.connectedListeners.size).toBe(1);
      const writes = mocks.mockSession.updateMetadata.mock.calls.length;
      for (const listener of mocks.connectedListeners) listener();
      expect(mocks.mockSession.updateMetadata).toHaveBeenCalledTimes(writes + 1);
      const healthy = { flavor: 'antigravity', acpPermissionMode: 'default', capabilities: { acpPermissionPolicy: true } };
      const reconcile = mocks.mockSession.updateMetadata.mock.calls.at(-1)![0];
      expect(reconcile(healthy)).not.toBe(healthy);
      expect(reconcile({ flavor: 'antigravity', name: 'remote title', acpPermissionMode: 'bypassPermissions' }))
        .toMatchObject({ name: 'remote title', acpPermissionMode: 'default', capabilities: { acpPermissionPolicy: true } });
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it('does not treat pre-turn remote full access as consent or let a replaced worker restore its former policy', async () => {
    let metadata: any = { flavor: 'antigravity', hostPid: process.pid };
    mocks.mockSession.getMetadata.mockImplementation(() => metadata);
    mocks.mockSession.updateMetadata.mockImplementation(apply => { metadata = apply(metadata); });
    const run = runAcp({ credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'antigravity', command: '/test/agy', args: ['acp'] });
    try {
      await vi.waitFor(() => expect(mocks.backendState.startSessionCalls).toBe(1));
      metadata = { ...metadata, acpPermissionMode: 'bypassPermissions' };
      for (const listener of mocks.metadataListeners) listener(metadata);
      expect(metadata.acpPermissionMode).toBeUndefined();
      mocks.getUserMessageHandler()!({ content: { text: 'explicit first selection' }, meta: { permissionMode: 'bypassPermissions', permissionModeExplicit: true } });
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      expect(metadata.acpPermissionMode).toBe('bypassPermissions');
      metadata = { ...metadata, hostPid: process.pid + 1, acpPermissionMode: 'default' };
      const writes = mocks.mockSession.updateMetadata.mock.calls.length;
      for (const listener of mocks.metadataListeners) listener(metadata);
      expect(mocks.mockSession.updateMetadata).toHaveBeenCalledTimes(writes);
      await expect(mocks.sessionHandlers.get('setPermissionMode')!({ mode: 'bypassPermissions' })).rejects.toThrow('worker changed');
      metadata = null;
      for (const listener of mocks.metadataListeners) listener(metadata);
      expect(mocks.mockSession.updateMetadata).toHaveBeenCalledTimes(writes);
      await expect(mocks.sessionHandlers.get('setPermissionMode')!({ mode: 'bypassPermissions' })).rejects.toThrow('worker changed');
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it('does not turn a pre-turn metadata echo into full access without an explicit selection', async () => {
    const run = runAcp({ credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'antigravity', command: '/test/agy', args: ['acp'] });
    try {
      await vi.waitFor(() => expect(mocks.backendState.startSessionCalls).toBe(1));
      mocks.getUserMessageHandler()!({ content: { text: 'echoed metadata' }, meta: { permissionMode: 'bypassPermissions' } });
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      const pending = mocks.backendState.constructorArgs.permissionHandler.handleToolCall('echo-check', 'execute', { CommandLine: 'pwd' });
      expect(Object.keys(mocks.getAgentState().requests)).toHaveLength(1);
      await mocks.sessionHandlers.get('setPermissionMode')!({ mode: 'bypassPermissions' });
      await expect(pending).resolves.toMatchObject({ decision: 'approved' });
    } finally { await mocks.getKillHandler()!(); await run; }
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

  it('keeps Antigravity identity instead of restoring it as a generic ACP session', async () => {
    const run = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'antigravity', command: '/test/agy', args: ['acp'],
    });
    await vi.waitFor(() => expect(mocks.getUserMessageHandler()).toBeTypeOf('function'));
    try {
      expect(mocks.mockGetOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ flavor: 'antigravity' }),
      }));
      expect(mocks.backendState.constructorArgs).toMatchObject({ command: '/test/agy', args: ['acp'] });
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
      rawPrompt: 'Build a test plan',
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

  it.each([undefined, 'model'])('retains legacy modes and model fallback with model category %s', async (category) => {
    mocks.backendState.startSessionMessages = [
      { type: 'event', name: 'config_options_update', payload: { configOptions: [
        { type: 'select', id: 'model', name: 'Model', ...(category ? { category } : {}), currentValue: 'base-model', options: [
          { value: 'base-model', name: 'Base model' },
        ] },
      ] } },
      { type: 'event', name: 'models_update', payload: { currentModelId: 'legacy-model', availableModels: [{ modelId: 'legacy-model', name: 'Legacy model' }] } },
      { type: 'event', name: 'modes_update', payload: { currentModeId: 'legacy-mode', availableModes: [{ id: 'legacy-mode', name: 'Legacy mode' }] } },
    ];
    const run = runAcp({ credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } }, agentName: 'custom', command: '/test/agent', args: [] });
    await vi.waitFor(() => expect(mocks.getUserMessageHandler()).toBeTypeOf('function'));
    try {
      const metadata = mocks.mockSession.updateMetadata.mock.calls.reduce<Record<string, unknown>>((current, [apply]) => apply(current), {});
      expect(metadata.models).toEqual([{ code: category ? 'base-model' : 'legacy-model', value: category ? 'Base model' : 'Legacy model' }]);
      expect(metadata.operatingModes).toEqual([{ code: 'legacy-mode', value: 'Legacy mode' }]);
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it('applies model then its refreshed effort before prompting Antigravity', async () => {
    const config = (model: string, levels: string[], effort: string) => ({ type: 'event', name: 'config_options_update', payload: { configOptions: [
      { type: 'select', id: 'model', category: 'model', name: 'Model', currentValue: model, options: ['neon', 'argon'].map(value => ({ value, name: value })) },
      { type: 'select', id: 'thought_level', category: 'thought_level', name: 'Thinking Level', currentValue: effort, options: levels.map(value => ({ value, name: value })) },
    ] } });
    mocks.backendState.startSessionMessages = [config('neon', ['high', 'xhigh'], 'xhigh')];
    mocks.backendState.configResponse = (id: string, value: string) => config('argon', ['low', 'medium', 'high'], id === 'thought_level' ? value : 'medium');
    const run = runAcp({ credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } }, agentName: 'antigravity', command: '/test/agy', args: ['acp'] });
    await vi.waitFor(() => expect(mocks.backendState.startSessionCalls).toBe(1));
    try {
      const result = await mocks.sessionHandlers.get('setAcpConfig')!({ model: 'argon' });
      expect(result.configOptions.find((option: any) => option.category === 'thought_level').options.map((x: any) => x.value)).toEqual(['low', 'medium', 'high']);
      await expect(mocks.sessionHandlers.get('setAcpConfig')!({ effort: 'xhigh' })).rejects.toThrow('Unsupported reasoning effort');
      mocks.getUserMessageHandler()!({ content: { text: 'hi' }, meta: { model: 'argon', effort: 'high' } });
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      expect(mocks.backendState.setConfigOptionCalls).toEqual([{ configId: 'model', value: 'argon' }, { configId: 'thought_level', value: 'high' }]);
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it('keeps selectable config catalogs when Antigravity also publishes legacy model IDs', async () => {
    mocks.backendState.startSessionMessages = [
      { type: 'event', name: 'config_options_update', payload: { configOptions: [
        { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: 'gemini-4-neon', options: [
          { value: 'gemini-4-neon', name: 'Gemini 4 Neon' }, { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
        ] },
        { type: 'select', id: 'mode', name: 'Mode', category: 'mode', currentValue: 'default', options: [
          { value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' },
        ] },
      ] } },
      { type: 'event', name: 'current_mode_update', payload: { currentModeId: 'plan' } },
      { type: 'event', name: 'models_update', payload: { currentModelId: 'gemini-4-neon-high', availableModels: [
        { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
      ] } },
      { type: 'event', name: 'modes_update', payload: { currentModeId: 'legacy', availableModes: [
        { id: 'legacy', name: 'Legacy mode' },
      ] } },
    ];
    const run = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'antigravity', command: '/test/agy', args: ['acp'],
    });
    await vi.waitFor(() => expect(mocks.getUserMessageHandler()).toBeTypeOf('function'));
    try {
      const metadata = mocks.mockSession.updateMetadata.mock.calls.reduce<Record<string, unknown>>((current, [apply]) => apply(current), { flavor: 'antigravity' });
      expect(metadata.models).toEqual([{ code: 'gemini-4-neon', value: 'Gemini 4 Neon', supportedEffortLevels: [] }, { code: 'gemini-3.8-flash', value: 'Gemini 3.8 Flash' }]);
      expect(metadata.currentModelCode).toBe('gemini-4-neon');
      expect(metadata.currentOperatingModeCode).toBe('plan');
      expect(metadata.operatingModes).toEqual([{ code: 'default', value: 'Default' }, { code: 'plan', value: 'Plan' }]);
      mocks.backendState.configResponse = (id, value) => ({ ...mocks.backendState.startSessionMessages[0], payload: { configOptions: mocks.backendState.startSessionMessages[0].payload.configOptions.map((option: any) => option.id === id ? { ...option, currentValue: value } : option) } });
      mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text: 'Use the selected model' }, meta: { model: 'gemini-3.8-flash' } });
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      expect(mocks.backendState.setConfigOptionCalls).toContainEqual({ configId: 'model', value: 'gemini-3.8-flash' });
    } finally { await mocks.getKillHandler()!(); await run; }
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

  const delegationConfig = (model = 'gemini-4-argon', effort = 'medium', extraModels: Array<{ value: string; name: string }> = []) => ({
    type: 'event', name: 'config_options_update', payload: { configOptions: [
      { type: 'select', id: 'model', category: 'model', name: 'Model', currentValue: model, options: [
        { value: 'gemini-4-argon', name: 'Gemini 4 Argon' }, { value: 'gemini-4-neon', name: 'Gemini 4 Neon' }, ...extraModels,
      ] },
      { type: 'select', id: 'thought_level', category: 'thought_level', name: 'Thinking', currentValue: effort, options: [
        { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' },
      ] },
    ] },
  });
  const runDelegationWorker = (delegated = true) => {
    mocks.backendState.delegatedLaunch = delegated ? { parentSessionId: 'parent', taskId: 'task' } : null;
    mocks.mockSession.getMetadata.mockReturnValue({ flavor: 'antigravity', hostPid: process.pid,
      ...(delegated ? { parentSessionId: 'parent', delegatedTask: { parentSessionId: 'parent', taskId: 'task' } } : {}) });
    return runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'antigravity', command: '/test/agy', args: ['acp'],
    });
  };
  const endStatuses = () => mocks.mockSession.sendSessionProtocolMessage.mock.calls
    .map(([envelope]: any[]) => envelope.ev).filter(ev => ev.t === 'turn-end').map(ev => ev.status);
  const emitBackend = (event: any) => { for (const listener of mocks.backendState.listeners) listener(event); };

  const savedRole = { id: 'writer', name: 'Writer', description: 'Write supplied facts', agent: 'codex', autoDelegate: false, createdAt: 1, updatedAt: 2 };
  const savedRoleRequest = { action: 'update', roleId: 'writer', patch: { name: 'Writer' } };
  const savedRoleEvents = () => mocks.mockSession.sendSessionProtocolMessage.mock.calls
    .map(([envelope]: any[]) => envelope).filter(envelope => envelope.ev.t === 'tool-call-end' && envelope.ev.mcpAppResult);

  it('registers the role observer only for AGY and publishes its actual successful completion in the original root turn', async () => {
    let finish!: () => void;
    mocks.backendState.holdPrompt = new Promise(resolve => { finish = resolve; });
    const run = runDelegationWorker(false);
    try {
      await vi.waitFor(() => expect(mocks.mockSession.processorReady).toHaveBeenCalled());
      const observer = mocks.mockStartHappyServer.mock.calls[0][1].observeRoleSave;
      expect(observer).toBeTypeOf('function');
      expect(observer('session-1', savedRoleRequest)).toBeUndefined();
      mocks.getUserMessageHandler()!({ content: { text: 'busy role save' } });
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      expect(observer('wrong-parent', savedRoleRequest)).toBeUndefined();
      const receive = observer('session-1', savedRoleRequest);
      expect(receive).toBeTypeOf('function');
      await receive(savedRole);
      expect(savedRoleEvents()).toHaveLength(1);
      expect(savedRoleEvents()[0]).toMatchObject({ turn: mocks.mockSession.getCurrentRootTurnId(), ev: {
        mcpAppResult: { structuredContent: { success: true, role: savedRole } },
      } });
      finish(); await vi.waitFor(() => expect(endStatuses()).toEqual(['completed']));
      await receive({ ...savedRole, updatedAt: 3 });
      expect(savedRoleEvents()).toHaveLength(1);
    } finally { finish(); await vi.waitFor(() => expect(endStatuses()).toHaveLength(1)); await mocks.getKillHandler()!(); await run; }
  });

  it('does not register the trusted observer for other ACP executors', async () => {
    const run = runAcp({ credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode', command: 'opencode', args: ['acp'] });
    try {
      await vi.waitFor(() => expect(mocks.mockSession.processorReady).toHaveBeenCalled());
      expect(mocks.mockStartHappyServer.mock.calls[0][1]).not.toHaveProperty('observeRoleSave');
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it.each(['session-swap', 'session-roundtrip', 'worker', 'worker-roundtrip', 'archive', 'turn-end'])('fences a pending saved-role confirmation after %s', async change => {
    let finish!: () => void;
    mocks.backendState.holdPrompt = new Promise(resolve => { finish = resolve; });
    const run = runDelegationWorker(false);
    try {
      await vi.waitFor(() => expect(mocks.mockSession.processorReady).toHaveBeenCalled());
      mocks.getUserMessageHandler()!({ content: { text: 'busy pending save' } });
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      const receive = mocks.mockStartHappyServer.mock.calls[0][1].observeRoleSave('session-1', savedRoleRequest);
      expect(receive).toBeTypeOf('function');
      if (change.startsWith('session-')) {
        const replacement = { ...mocks.mockSession, sessionId: 'session-2' };
        const swap = mocks.mockSetupOfflineReconnection.mock.calls[0][0].onSessionSwap;
        swap(replacement);
        if (change === 'session-roundtrip') swap(mocks.mockSession);
      } else if (change.startsWith('worker')) {
        const original = mocks.mockSession.getMetadata();
        const changed = { ...original, hostPid: process.pid + 1 };
        mocks.mockSession.getMetadata.mockReturnValue(changed);
        for (const listener of mocks.metadataListeners) listener(changed);
        if (change === 'worker-roundtrip') {
          mocks.mockSession.getMetadata.mockReturnValue(original);
          for (const listener of mocks.metadataListeners) listener(original);
        }
      } else if (change === 'archive') {
        mocks.mockSession.getMetadata.mockReturnValue({ ...mocks.mockSession.getMetadata(), lifecycleState: 'archiveRequested' });
      } else { finish(); await vi.waitFor(() => expect(endStatuses()).toEqual(['completed'])); }
      await receive(savedRole);
      expect(savedRoleEvents()).toHaveLength(0);
    } finally { finish(); await vi.waitFor(() => expect(endStatuses()).toHaveLength(1)); await mocks.getKillHandler()!(); await run; }
  });

  it('invalidates both callback and native receipts as soon as cancellation is requested, before native ACK', async () => {
    let finish!: () => void; let acknowledge!: () => void;
    mocks.backendState.holdPrompt = new Promise(resolve => { finish = resolve; });
    mocks.backendState.onCancel = () => new Promise(resolve => { acknowledge = resolve; });
    const run = runDelegationWorker(false);
    let cancel: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(mocks.mockSession.processorReady).toHaveBeenCalled());
      mocks.getUserMessageHandler()!({ content: { text: 'busy cancelling save' } });
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      const receive = mocks.mockStartHappyServer.mock.calls[0][1].observeRoleSave('session-1', savedRoleRequest);
      emitBackend({ type: 'tool-call', toolName: 'mcp__happy__agent_roles', callId: 'native-role', args: savedRoleRequest });
      cancel = mocks.sessionHandlers.get('abort')!({});
      await receive(savedRole);
      emitBackend({ type: 'tool-result', toolName: 'other', callId: 'native-role', result: { success: true, role: savedRole } });
      expect(savedRoleEvents()).toHaveLength(0);
      acknowledge(); await cancel;
    } finally {
      mocks.backendState.onCancel = null; acknowledge?.(); await cancel;
      finish(); await mocks.getKillHandler()!(); await run;
    }
  });

  it('declares AGY delegation only after its three handlers are registered', async () => {
    mocks.mockSession.declareDelegationSupport.mockImplementationOnce(() => {
      expect([...mocks.sessionHandlers.keys()]).toEqual(expect.arrayContaining(['delegation-context', 'delegation-prepare', 'delegation-abort']));
    });
    const run = runDelegationWorker(false);
    try {
      await vi.waitFor(() => expect(mocks.mockSession.processorReady).toHaveBeenCalled());
      expect(mocks.mockSession.declareDelegationSupport).toHaveBeenCalledExactlyOnceWith('antigravity');
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it('suspends only the active root deadline during a real delegation wait and ignores its stale release after completion', async () => {
    let finishNative!: () => void;
    mocks.backendState.holdPrompt = new Promise(resolve => { finishNative = resolve; });
    const run = runDelegationWorker(false);
    void run.catch(() => {});
    let stopped = false;
    try {
      await vi.waitFor(() => expect(mocks.mockSession.processorReady).toHaveBeenCalled());
      const onDelegationWait = mocks.mockStartHappyServer.mock.calls[0][1].onDelegationWait;
      onDelegationWait()(); // An idle request has no root budget to pause.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      mocks.getUserMessageHandler()!({ localId: 'parent-task', content: { text: 'busy' } });
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(60_000);
      const release = onDelegationWait();
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(endStatuses()).toEqual([]);
      finishNative();
      await vi.waitFor(() => expect(endStatuses()).toEqual(['completed']));
      release();
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(endStatuses()).toEqual(['completed']);
      expect(mocks.backendState.disposeCalls).toBe(0);
      await mocks.getKillHandler()!();
      await run;
      stopped = true;
    } finally {
      finishNative();
      if (!stopped) { await mocks.getKillHandler()!(); await run.catch(() => {}); }
      vi.clearAllTimers(); vi.useRealTimers();
    }
  });

  it('keeps the ordinary five minute deadline for a delegated child even if it attempts another delegation', async () => {
    let finishNative!: () => void;
    mocks.backendState.holdPrompt = new Promise(resolve => { finishNative = resolve; });
    const run = runDelegationWorker();
    void run.catch(() => {});
    try {
      await vi.waitFor(() => expect(mocks.mockSession.processorReady).toHaveBeenCalled());
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      mocks.getUserMessageHandler()!({ localId: 'delegation:task:v1', content: { text: 'busy' }, meta: { delegation: {} } });
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      const release = mocks.mockStartHappyServer.mock.calls[0][1].onDelegationWait();
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      finishNative();
      await expect(run).rejects.toThrow('Timed out waiting for antigravity');
      expect(endStatuses()).toEqual(['failed']);
      release();
    } finally {
      finishNative();
      await mocks.getKillHandler()!(); await run.catch(() => {});
      vi.clearAllTimers(); vi.useRealTimers();
    }
  });

  it.each([false, true])('injects role discovery once for a parent and never for a delegated child=%s', async delegatedChild => {
    mocks.backendState.delegatedLaunch = delegatedChild ? { parentSessionId: 'parent', taskId: 'task' } : null;
    if (delegatedChild) mocks.mockNotifyDaemonSessionStarted.mockImplementationOnce(async () => {
      expect(mocks.sessionHandlers.has('delegation-context')).toBe(true);
      expect(mocks.sessionHandlers.has('delegation-prepare')).toBe(true);
      expect(mocks.sessionHandlers.has('delegation-abort')).toBe(true);
      expect(mocks.backendState.startSessionCalls).toBe(0);
      return { error: null };
    });
    const run = runDelegationWorker(delegatedChild);
    try {
      await vi.waitFor(() => expect(mocks.getUserMessageHandler()).toBeTypeOf('function'));
      mocks.getUserMessageHandler()!({ content: { text: 'first task' } });
      await vi.waitFor(() => expect(endStatuses()).toEqual(['completed']));
      expect(mocks.backendState.prompts[0].rawPrompt.includes('agent_roles with action="list"')).toBe(!delegatedChild);
      mocks.getUserMessageHandler()!({ content: { text: 'second task' } });
      await vi.waitFor(() => expect(endStatuses()).toEqual(['completed', 'completed']));
      expect(mocks.backendState.prompts[1].rawPrompt).toBe('second task');
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it.each(['agent_roles', 'delegate_task', 'read_delegated_task', 'cancel_delegated_task'])('auto-approves native AGY Happy %s through normalization and transport with only the offered single-use grant', async name => {
    const run = runDelegationWorker();
    try {
      await vi.waitFor(() => expect(mocks.backendState.constructorArgs).not.toBeNull());
      const normalized = normalizeAcpPermissionRequest({
        sessionId: 'native',
        toolCall: { toolCallId: `native-${name}`, kind: 'other', title: `Run mcp_happy_${name}`, rawInput: { action: 'list' } },
        options: [
          { optionId: 'reject', kind: 'reject_once', name: '拒绝' },
          { optionId: 'remember', kind: 'allow_always', name: '始终允许' },
          { optionId: 'once', kind: 'allow_once', name: '允许本次' },
        ],
      });
      const toolName = new DefaultTransport('antigravity').determineToolName(normalized.toolName, normalized.toolCallId, normalized.input,
        { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 });
      const result = mocks.backendState.constructorArgs.permissionHandler.handleToolCall(normalized.toolCallId, toolName, normalized.input, normalized.options);
      const pendingIds = Object.keys(mocks.getAgentState().requests ?? {});
      // Release a regression's pending request before asserting so cleanup cannot hang.
      if (pendingIds[0]) await mocks.sessionHandlers.get('permission')!({ id: pendingIds[0], approved: false, decision: 'denied', optionId: 'reject' });
      expect(pendingIds).toEqual([]);
      await expect(result).resolves.toEqual({ decision: 'approved', optionId: 'once' });
      expect(Object.values(mocks.getAgentState().completedRequests)).toContainEqual(expect.objectContaining({
        tool: `mcp_happy_${name}`, arguments: { action: 'list' }, status: 'approved', optionId: 'once',
      }));
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it.each([
    { kind: 'other', title: 'Run mcp_other_delegate_task' },
    { kind: 'other', title: 'Run mcp_happy_fake_delegate_task' },
    { kind: 'other', title: 'Run mcp_happy_delegate_task_extra' },
    { kind: 'other', title: 'Run mcp_happy_delete_file' },
    { kind: 'other', title: 'Run mcp_happy_delegate_task\n' },
    { kind: 'other', title: 'Run mcp_happy_delegate_task; rm -rf /' },
    { kind: 'other', title: 'Please Run mcp_happy_delegate_task' },
    { kind: 'execute', title: 'Run mcp_happy_delegate_task' },
    { kind: 'read', title: 'Run mcp_happy_delegate_task' },
    { kind: 'other', toolName: 'mcp__other__delegate_task', title: 'Run mcp_happy_delegate_task' },
    { kind: 'other', toolName: 'mcp__happy__delegate_task_extra', title: 'Run mcp_happy_delegate_task' },
    { kind: 'other', toolName: '', title: 'Run mcp_happy_delegate_task' },
    { kind: 'other', title: 'run mcp_happy_delegate_task' },
  ])('keeps an untrusted native identity pending: %j', async toolCall => {
    const run = runDelegationWorker();
    try {
      await vi.waitFor(() => expect(mocks.backendState.constructorArgs).not.toBeNull());
      const normalized = normalizeAcpPermissionRequest({ sessionId: 'native', toolCall: { toolCallId: 'native-unknown', ...toolCall, rawInput: {
        CommandLine: 'rm -rf /', toolName: 'mcp_happy_delegate_task', title: 'Run mcp_happy_delegate_task',
      } }, options: [{ optionId: 'reject', kind: 'reject_once', name: '拒绝' }, { optionId: 'once', kind: 'allow_once', name: '允许' }] } as any);
      const toolName = new DefaultTransport('antigravity').determineToolName(normalized.toolName, normalized.toolCallId, normalized.input,
        { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 });
      const result = mocks.backendState.constructorArgs.permissionHandler.handleToolCall(normalized.toolCallId, toolName, normalized.input, normalized.options);
      const pendingIds = Object.keys(mocks.getAgentState().requests ?? {});
      expect(pendingIds).toHaveLength(1);
      expect(mocks.getAgentState().completedRequests ?? {}).toEqual({});
      await mocks.sessionHandlers.get('permission')!({ id: pendingIds[0], approved: false, decision: 'denied', optionId: 'reject' });
      await expect(result).resolves.toEqual({ decision: 'denied', optionId: 'reject' });
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it.each(['agent_roles', 'delegate_task', 'read_delegated_task', 'cancel_delegated_task'].flatMap(name =>
    [name, `happy__${name}`, `mcp__happy__${name}`, `mcp_happy_${name}`]))('auto-approves the exact Happy delegation tool %s', async name => {
    const run = runDelegationWorker();
    try {
      await vi.waitFor(() => expect(mocks.backendState.constructorArgs).not.toBeNull());
      const permission = mocks.backendState.constructorArgs.permissionHandler;
      const result = permission.handleToolCall(`call-${name}`, name, {});
      const pendingIds = Object.keys(mocks.getAgentState().requests ?? {});
      if (pendingIds[0]) await mocks.sessionHandlers.get('permission')!({ id: pendingIds[0], approved: false, decision: 'denied' });
      expect(pendingIds).toEqual([]);
      await expect(result).resolves.toEqual({ decision: 'approved' });
      expect(mocks.getAgentState().requests).toEqual({});
      expect(Object.values(mocks.getAgentState().completedRequests)).toContainEqual(expect.objectContaining({ tool: name, status: 'approved' }));
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it.each(['none', 'rejected', 'ignored'] as const)('retires a verified idle child and closes every resource when archive acknowledgement is %s', async failureMode => {
    const failedArchive = failureMode !== 'none';
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const run = runDelegationWorker();
    try {
      await vi.waitFor(() => expect(mocks.mockSession.processorReady).toHaveBeenCalled());
      expect(mocks.sessionHandlers.has('delegation-retire')).toBe(true);
      mocks.mockSession.canRetireDelegation.mockReturnValue(true);
      if (failureMode === 'rejected') mocks.mockSession.updateMetadataAndAwait.mockRejectedValue(new Error('archive acknowledgement failed'));
      if (failureMode === 'ignored') mocks.mockSession.updateMetadataAndAwait.mockResolvedValue(undefined);
      expect(await mocks.sessionHandlers.get('delegation-retire')!({ hostPid: process.pid, localId: 'delegation:task:1:request' })).toEqual({ retiring: true });
      expect(mocks.mockSession.beginDelegationRetirement).toHaveBeenCalledOnce();
      await expect(mocks.sessionHandlers.get('delegation-prepare')!({ permissionMode: 'default' })).rejects.toThrow('worker changed or ended');
      mocks.getUserMessageHandler()!({ content: { text: 'must not start after retirement' } });
      await run;
      expect(mocks.backendState.prompts).toEqual([]);
      expect(mocks.backendState.cancelCalls).toEqual([]);
      expect(mocks.backendState.disposeCalls).toBe(1);
      if (!failedArchive) expect(mocks.mockSession.getMetadata().lifecycleState).toBe('archived');
      expect(mocks.mockSession.sendSessionDeath).toHaveBeenCalledOnce();
      expect(mocks.mockSession.close).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(failedArchive ? 1 : 0);
    } finally { if (!mocks.backendState.disposeCalls) { await mocks.getKillHandler()!(); await run; } exit.mockRestore(); }
  });

  it.each(['gemini-4-neon', 'Gemini 4 Neon', 'gemini 4 neon', 'Neon'])('prepares the advertised native model for %s and confirms refreshed effort', async requested => {
    mocks.backendState.startSessionMessages = [delegationConfig()];
    let actualModel = 'gemini-4-argon';
    let actualEffort = 'medium';
    mocks.backendState.configResponse = (id, value) => {
      if (id === 'model') actualModel = value;
      if (id === 'thought_level') actualEffort = value;
      return delegationConfig(actualModel, actualEffort);
    };
    const run = runDelegationWorker();
    try {
      await vi.waitFor(() => expect(mocks.sessionHandlers.has('delegation-prepare')).toBe(true));
      const prepare = mocks.sessionHandlers.get('delegation-prepare')!;
      expect(await prepare({ model: requested, effort: 'High', permissionMode: 'bypassPermissions' })).toEqual({ model: 'gemini-4-neon', effort: 'high' });
      expect(await mocks.sessionHandlers.get('delegation-context')!({})).toMatchObject({ agent: 'antigravity', permissionMode: 'bypassPermissions', hostPid: process.pid, lifecycleState: 'running' });
      await prepare({ model: requested, permissionMode: 'default' });
      expect(await mocks.sessionHandlers.get('delegation-context')!({})).toMatchObject({ permissionMode: 'default' });
      expect(mocks.backendState.setConfigOptionCalls).toEqual([{ configId: 'model', value: 'gemini-4-neon' }, { configId: 'thought_level', value: 'high' }]);
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it('prepares the actual native current model and effort when overrides are omitted', async () => {
    mocks.backendState.startSessionMessages = [delegationConfig('gemini-4-neon', 'high')];
    const run = runDelegationWorker();
    try {
      await vi.waitFor(() => expect(mocks.mockSession.processorReady).toHaveBeenCalled());
      expect(await mocks.sessionHandlers.get('delegation-prepare')!({ permissionMode: 'default' })).toEqual({ model: 'gemini-4-neon', effort: 'high' });
      expect(mocks.backendState.setConfigOptionCalls).toEqual([]);
      expect(mocks.mockSession.getMetadata()).toMatchObject({ currentModelCode: 'gemini-4-neon', currentThoughtLevelCode: 'high' });
      expect(mocks.backendState.prompts).toHaveLength(0);
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it('returns the refreshed native effort default after switching only the model', async () => {
    mocks.backendState.startSessionMessages = [delegationConfig('gemini-4-argon', 'high')];
    mocks.backendState.configResponse = (_id, value) => delegationConfig(value, 'medium');
    const run = runDelegationWorker();
    try {
      await vi.waitFor(() => expect(mocks.mockSession.processorReady).toHaveBeenCalled());
      expect(await mocks.sessionHandlers.get('delegation-prepare')!({ model: 'Neon', permissionMode: 'default' })).toEqual({ model: 'gemini-4-neon', effort: 'medium' });
      expect(mocks.backendState.setConfigOptionCalls).toEqual([{ configId: 'model', value: 'gemini-4-neon' }]);
      expect(mocks.backendState.prompts).toHaveLength(0);
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it('returns no effort when the native current model advertises no effort configuration', async () => {
    const config = delegationConfig();
    config.payload.configOptions = config.payload.configOptions.filter(option => option.category !== 'thought_level');
    mocks.backendState.startSessionMessages = [config];
    const run = runDelegationWorker();
    try {
      await vi.waitFor(() => expect(mocks.mockSession.processorReady).toHaveBeenCalled());
      const prepare = mocks.sessionHandlers.get('delegation-prepare')!;
      expect(await prepare({ permissionMode: 'default' })).toEqual({ model: 'gemini-4-argon' });
      await expect(prepare({ effort: 'high', permissionMode: 'default' })).rejects.toThrow('Unknown reasoning effort');
      expect(mocks.backendState.setConfigOptionCalls).toEqual([]);
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it.each(['model', 'effort'])('rejects an unavailable native current %s instead of guessing a default', async missing => {
    mocks.backendState.startSessionMessages = [delegationConfig(missing === 'model' ? 'unobserved' : 'gemini-4-argon', missing === 'effort' ? 'unobserved' : 'medium')];
    const run = runDelegationWorker();
    try {
      await vi.waitFor(() => expect(mocks.mockSession.processorReady).toHaveBeenCalled());
      await expect(mocks.sessionHandlers.get('delegation-prepare')!({ permissionMode: 'default' })).rejects.toThrow(/Current native .* configuration is unavailable/);
      expect(mocks.backendState.setConfigOptionCalls).toEqual([]);
      expect(mocks.backendState.prompts).toHaveLength(0);
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it('waits for native startup and the advertised catalog with one readiness promise', async () => {
    let start!: () => void;
    mocks.backendState.holdStartup = new Promise(resolve => { start = resolve; });
    const run = runDelegationWorker();
    try {
      await vi.waitFor(() => expect(mocks.backendState.startSessionCalls).toBe(1));
      let prepared = false;
      const result = mocks.sessionHandlers.get('delegation-prepare')!({ permissionMode: 'default' }).then((value: unknown) => { prepared = true; return value; });
      await Promise.resolve();
      expect(prepared).toBe(false);
      expect(mocks.backendState.setConfigOptionCalls).toEqual([]);
      expect(mocks.mockSession.reportDelegationReady).not.toHaveBeenCalled();
      start();
      await vi.waitFor(() => expect(mocks.mockSession.processorReady).toHaveBeenCalled());
      expect(prepared).toBe(false);
      expect(mocks.mockSession.reportDelegationReady).not.toHaveBeenCalled();
      emitBackend(delegationConfig());
      expect(await result).toEqual({ model: 'gemini-4-argon', effort: 'medium' });
      expect(mocks.mockSession.reportDelegationReady).toHaveBeenCalledOnce();
      emitBackend(delegationConfig());
      expect(mocks.mockSession.reportDelegationReady).toHaveBeenCalledOnce();
    } finally { start(); await mocks.getKillHandler()!(); await run; }
  });

  it.each(['ordinary', 'application', 'other-worker', 'other-task'])('rejects %s session ownership before preparing configuration', async kind => {
    mocks.backendState.startSessionMessages = [delegationConfig()];
    const run = runDelegationWorker(kind !== 'ordinary');
    try {
      await vi.waitFor(() => expect(mocks.mockSession.processorReady).toHaveBeenCalled());
      const current = mocks.mockSession.getMetadata();
      if (kind === 'application') current.application = { appId: 'app', bindingId: 'binding' };
      if (kind === 'other-worker') current.hostPid = process.pid + 1;
      if (kind === 'other-task') current.delegatedTask.taskId = 'unrelated';
      await expect(mocks.sessionHandlers.get('delegation-prepare')!({ model: 'Argon', permissionMode: 'bypassPermissions' })).rejects.toThrow(/bound delegated|Application-bound|worker changed/);
      expect(mocks.mockSession.updateMetadataAndAwait).not.toHaveBeenCalled();
      expect(mocks.backendState.setConfigOptionCalls).toEqual([]);
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it('waits for the metadata CAS acknowledgement and rejects a missing readback', async () => {
    mocks.backendState.startSessionMessages = [delegationConfig()];
    let acknowledge!: () => void;
    const ack = new Promise<void>(resolve => { acknowledge = resolve; });
    mocks.mockSession.updateMetadataAndAwait.mockImplementation(async handler => {
      await ack;
      mocks.mockSession.getMetadata.mockReturnValue(handler(mocks.mockSession.getMetadata()));
    });
    const run = runDelegationWorker();
    try {
      await vi.waitFor(() => expect(mocks.mockSession.processorReady).toHaveBeenCalled());
      let confirmed = false;
      const result = mocks.sessionHandlers.get('delegation-prepare')!({ model: 'Argon', permissionMode: 'bypassPermissions' }).then((value: unknown) => { confirmed = true; return value; });
      await vi.waitFor(() => expect(mocks.mockSession.updateMetadataAndAwait).toHaveBeenCalled());
      expect(confirmed).toBe(false);
      acknowledge();
      expect(await result).toEqual({ model: 'gemini-4-argon', effort: 'medium' });
      expect(mocks.mockSession.getMetadata()).toMatchObject({ currentModelCode: 'gemini-4-argon', currentThoughtLevelCode: 'medium', acpPermissionMode: 'bypassPermissions' });
      mocks.mockSession.updateMetadataAndAwait.mockImplementation(async () => {});
      await expect(mocks.sessionHandlers.get('delegation-prepare')!({ model: 'Argon', permissionMode: 'default' })).rejects.toThrow('metadata was not acknowledged');
    } finally { acknowledge(); await mocks.getKillHandler()!(); await run; }
  });

  it('refuses ownership changes while a metadata CAS is in flight', async () => {
    mocks.backendState.startSessionMessages = [delegationConfig()];
    let acknowledge!: () => void;
    const ack = new Promise<void>(resolve => { acknowledge = resolve; });
    mocks.mockSession.updateMetadataAndAwait.mockImplementation(async handler => { await ack; mocks.mockSession.getMetadata.mockReturnValue(handler(mocks.mockSession.getMetadata())); });
    const run = runDelegationWorker();
    try {
      await vi.waitFor(() => expect(mocks.mockSession.processorReady).toHaveBeenCalled());
      const result = mocks.sessionHandlers.get('delegation-prepare')!({ model: 'Argon', permissionMode: 'bypassPermissions' });
      await vi.waitFor(() => expect(mocks.mockSession.updateMetadataAndAwait).toHaveBeenCalled());
      mocks.mockSession.getMetadata().hostPid = process.pid + 1;
      acknowledge();
      await expect(result).rejects.toThrow('worker changed or became busy');
      expect(mocks.mockSession.getMetadata().acpPermissionMode).toBeUndefined();
    } finally { acknowledge(); await mocks.getKillHandler()!(); await run; }
  });

  it('rebinds all delegation RPCs to the replacement session and rejects stale handlers', async () => {
    mocks.backendState.startSessionMessages = [delegationConfig()];
    const run = runDelegationWorker();
    try {
      await vi.waitFor(() => expect(mocks.mockSession.processorReady).toHaveBeenCalled());
      const staleContext = mocks.sessionHandlers.get('delegation-context')!;
      const stalePrepare = mocks.sessionHandlers.get('delegation-prepare')!;
      const staleRetire = mocks.sessionHandlers.get('delegation-retire')!;
      const freshHandlers = new Map<string, any>();
      const replacement = { ...mocks.mockSession, sessionId: 'session-2', getMetadata: vi.fn(() => ({ ...mocks.mockSession.getMetadata() })),
        declareDelegationSupport: vi.fn(() => {
          expect([...freshHandlers.keys()]).toEqual(expect.arrayContaining(['delegation-context', 'delegation-prepare', 'delegation-abort']));
        }),
        rpcHandlerManager: { registerHandler: vi.fn((name: string, handler: any) => freshHandlers.set(name, handler)) },
        updateMetadataAndAwait: vi.fn(async (handler: any) => { replacement.getMetadata.mockReturnValue(handler(replacement.getMetadata())); }) };
      mocks.mockSetupOfflineReconnection.mock.calls[0][0].onSessionSwap(replacement);
      expect(mocks.mockStartHappyServer.mock.calls[0][1].currentDelegationSessionId()).toBe('session-2');
      expect([...freshHandlers.keys()]).toEqual(expect.arrayContaining(['delegation-context', 'delegation-prepare', 'delegation-abort', 'delegation-retire']));
      expect(replacement.declareDelegationSupport).toHaveBeenCalledExactlyOnceWith('antigravity');
      await expect(staleContext({})).rejects.toThrow('worker changed');
      await expect(stalePrepare({ model: 'Argon', permissionMode: 'default' })).rejects.toThrow('worker changed');
      await expect(staleRetire({ hostPid: process.pid, localId: 'delegation:task:1:request' })).rejects.toThrow('ownership changed');
      expect(await freshHandlers.get('delegation-prepare')({ model: 'Argon', permissionMode: 'default' })).toEqual({ model: 'gemini-4-argon', effort: 'medium' });
      expect(replacement.updateMetadataAndAwait).toHaveBeenCalledOnce();
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it('rejects ambiguous, unknown, unsupported and unacknowledged native configuration', async () => {
    mocks.backendState.startSessionMessages = [delegationConfig('gemini-4-argon', 'medium', [{ value: 'gemini-4-neon-pro', name: 'Gemini 4 Neon Pro' }])];
    const run = runDelegationWorker();
    try {
      await vi.waitFor(() => expect(mocks.mockSession.processorReady).toHaveBeenCalled());
      const prepare = mocks.sessionHandlers.get('delegation-prepare')!;
      await expect(prepare({ model: 'Neon', permissionMode: 'default' })).rejects.toThrow('Ambiguous model');
      await expect(prepare({ model: 'missing', permissionMode: 'default' })).rejects.toThrow('Unknown model');
      await expect(prepare({ model: 'Argon', effort: 'xhigh', permissionMode: 'default' })).rejects.toThrow('Unknown reasoning effort');
      await expect(prepare({ model: 'gemini-4-neon', permissionMode: 'default' })).rejects.toThrow('Model change was not confirmed');
      await expect(prepare({ model: 'Argon', effort: 'high', permissionMode: 'default' })).rejects.toThrow('Failed to confirm reasoning effort');
      mocks.mockSession.getCurrentRootTurnId.mockReturnValue('stale-root-turn');
      await expect(prepare({ model: 'Argon', permissionMode: 'default' })).rejects.toThrow('Session must be idle');
      expect(mocks.backendState.prompts).toHaveLength(0);
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it('inherits and resets the effective appended task instructions for an ACP parent', async () => {
    const run = runDelegationWorker();
    try {
      await vi.waitFor(() => expect(mocks.getUserMessageHandler()).toBeTypeOf('function'));
      mocks.getUserMessageHandler()!({ content: { text: 'task' }, meta: { appendSystemPrompt: 'Only edit the scoped worktree.' } });
      await vi.waitFor(() => expect(endStatuses()).toEqual(['completed']));
      const context = mocks.mockStartHappyServer.mock.calls[0][1].delegationContext;
      expect(context()).toMatchObject({ permissionMode: 'default', appendSystemPrompt: 'Only edit the scoped worktree.' });
      expect(await mocks.sessionHandlers.get('delegation-context')!({})).toMatchObject({ appendSystemPrompt: 'Only edit the scoped worktree.' });
      mocks.getUserMessageHandler()!({ content: { text: 'reset' }, meta: { appendSystemPrompt: null } });
      await vi.waitFor(() => expect(endStatuses()).toHaveLength(2));
      expect(context()).not.toHaveProperty('appendSystemPrompt');
    } finally { await mocks.getKillHandler()!(); await run; }
  });

  it('cancels only the matching queued localId and leaves the current user turn and other input intact', async () => {
    let release!: () => void;
    mocks.backendState.holdPrompt = new Promise(resolve => { release = resolve; });
    const run = runDelegationWorker();
    try {
      await vi.waitFor(() => expect(mocks.getUserMessageHandler()).toBeTypeOf('function'));
      mocks.getUserMessageHandler()!({ localId: 'current-user', content: { text: 'busy' } });
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      mocks.getUserMessageHandler()!({ localId: 'delegation:task:queued', content: { text: 'remove this' }, meta: { delegation: {} } });
      mocks.getUserMessageHandler()!({ localId: 'queued-user', content: { text: 'keep this' } });
      await new Promise(resolve => setImmediate(resolve));
      const abort = mocks.sessionHandlers.get('delegation-abort')!;
      expect(await abort({ localId: 'delegation:task:queued' })).toEqual({ queuedCancelled: true });
      expect(mocks.mockSession.acknowledgeCancelledUserInput).toHaveBeenCalledExactlyOnceWith('delegation:task:queued');
      await expect(abort({ localId: 'delegation:task:missing' })).rejects.toThrow('does not match');
      expect(mocks.backendState.cancelCalls).toHaveLength(0);
      release();
      await vi.waitFor(() => expect(endStatuses()).toEqual(['completed', 'completed']));
      expect(mocks.backendState.prompts.map(prompt => prompt.prompt)).toEqual(['busy', 'keep this']);
    } finally { release(); await mocks.getKillHandler()!(); await run; }
  });

  it('waits for exact current-turn cancellation and keeps the ACP worker usable for a revision', async () => {
    let release!: () => void;
    mocks.backendState.holdPrompt = new Promise(resolve => { release = resolve; });
    mocks.backendState.onCancel = async () => { await mocks.backendState.holdPrompt; };
    const run = runDelegationWorker();
    try {
      await vi.waitFor(() => expect(mocks.getUserMessageHandler()).toBeTypeOf('function'));
      mocks.getUserMessageHandler()!({ localId: 'delegation:task:v1', content: { text: 'busy' }, meta: { delegation: {} } });
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      const turnId = mocks.mockSession.getCurrentRootTurnId();
      const abort = mocks.sessionHandlers.get('delegation-abort')!;
      await expect(abort({ localId: 'delegation:task:other', expectedTurnId: turnId })).rejects.toThrow('does not match');
      await expect(abort({ localId: 'delegation:task:v1', expectedTurnId: 'different' })).rejects.toThrow('does not match');
      expect(mocks.backendState.cancelCalls).toHaveLength(0);
      let cancelled = false;
      const result = abort({ localId: 'delegation:task:v1', expectedTurnId: turnId }).then((value: unknown) => { cancelled = true; return value; });
      await Promise.resolve();
      expect(cancelled).toBe(false);
      expect(endStatuses()).toEqual([]);
      release();
      expect(await result).toEqual({ cancelled: true });
      await vi.waitFor(() => expect(endStatuses()).toEqual(['cancelled']));
      expect(mocks.backendState.disposeCalls).toBe(0);
      mocks.getUserMessageHandler()!({ localId: 'delegation:task:v2', content: { text: 'revise the same task' }, meta: { delegation: {} } });
      await vi.waitFor(() => expect(endStatuses()).toEqual(['cancelled', 'completed']));
    } finally { release(); mocks.backendState.onCancel = null; await mocks.getKillHandler()!(); await run; }
  });

  it('propagates native cancellation failure without marking the current turn cancelled', async () => {
    let release!: () => void;
    mocks.backendState.holdPrompt = new Promise(resolve => { release = resolve; });
    mocks.backendState.cancelError = new Error('native cancel failed');
    const run = runDelegationWorker();
    try {
      await vi.waitFor(() => expect(mocks.getUserMessageHandler()).toBeTypeOf('function'));
      mocks.getUserMessageHandler()!({ localId: 'delegation:task:v1', content: { text: 'busy' } });
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      await expect(mocks.sessionHandlers.get('delegation-abort')!({ localId: 'delegation:task:v1', expectedTurnId: mocks.mockSession.getCurrentRootTurnId() })).rejects.toThrow('native cancel failed');
      expect(endStatuses()).toEqual([]);
      release();
      await vi.waitFor(() => expect(endStatuses()).toEqual(['completed']));
      expect(mocks.backendState.disposeCalls).toBe(0);
    } finally { release(); mocks.backendState.cancelError = null; await mocks.getKillHandler()!(); await run; }
  });

  it('preserves a natural completion racing with cancellation instead of reporting a false cancelled turn', async () => {
    let release!: () => void;
    mocks.backendState.holdPrompt = new Promise(resolve => { release = resolve; });
    mocks.backendState.onCancel = async () => { await mocks.backendState.holdPrompt; };
    mocks.backendState.cancelOutcome = 'end_turn';
    const run = runDelegationWorker();
    try {
      await vi.waitFor(() => expect(mocks.getUserMessageHandler()).toBeTypeOf('function'));
      mocks.getUserMessageHandler()!({ localId: 'delegation:task:v1', content: { text: 'busy' }, meta: { delegation: {} } });
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      const result = mocks.sessionHandlers.get('delegation-abort')!({ localId: 'delegation:task:v1', expectedTurnId: mocks.mockSession.getCurrentRootTurnId() });
      release();
      expect(await result).toEqual({ cancelled: false });
      await vi.waitFor(() => expect(endStatuses()).toEqual(['completed']));
      expect(mocks.backendState.disposeCalls).toBe(0);
    } finally { release(); mocks.backendState.onCancel = null; await mocks.getKillHandler()!(); await run; }
  });

  it('confirms cancellation before native prompting and never sends the cancelled input', async () => {
    mocks.backendState.startSessionMessages = [delegationConfig()];
    mocks.backendState.configResponse = (_id, value) => delegationConfig(value);
    let configure!: () => void;
    mocks.backendState.holdConfig = new Promise(resolve => { configure = resolve; });
    const run = runDelegationWorker();
    try {
      await vi.waitFor(() => expect(mocks.mockSession.processorReady).toHaveBeenCalled());
      mocks.getUserMessageHandler()!({ localId: 'delegation:task:v1', content: { text: 'must never run' }, meta: { model: 'gemini-4-neon', delegation: {} } });
      await vi.waitFor(() => expect(mocks.backendState.setConfigOptionCalls).toHaveLength(1));
      expect(await mocks.sessionHandlers.get('delegation-abort')!({ localId: 'delegation:task:v1', expectedTurnId: mocks.mockSession.getCurrentRootTurnId() })).toEqual({ cancelled: true });
      configure();
      await vi.waitFor(() => expect(endStatuses()).toEqual(['cancelled']));
      expect(mocks.backendState.prompts).toHaveLength(0);
    } finally { configure(); await mocks.getKillHandler()!(); await run; }
  });

  it('rejects cancellation of a mixed root input batch or another delegated task', async () => {
    let start!: () => void;
    let release!: () => void;
    mocks.backendState.holdStartup = new Promise(resolve => { start = resolve; });
    mocks.backendState.holdPrompt = new Promise(resolve => { release = resolve; });
    const run = runDelegationWorker();
    try {
      await vi.waitFor(() => expect(mocks.getUserMessageHandler()).toBeTypeOf('function'));
      mocks.getUserMessageHandler()!({ localId: 'delegation:task:v1', content: { text: 'busy' } });
      mocks.getUserMessageHandler()!({ localId: 'unrelated-user', content: { text: 'other input' } });
      await new Promise(resolve => setImmediate(resolve));
      start();
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      const abort = mocks.sessionHandlers.get('delegation-abort')!;
      await expect(abort({ localId: 'delegation:other:v1', expectedTurnId: mocks.mockSession.getCurrentRootTurnId() })).rejects.toThrow('does not own');
      await expect(abort({ localId: 'delegation:task:v1', expectedTurnId: mocks.mockSession.getCurrentRootTurnId() })).rejects.toThrow('does not match');
      expect(mocks.backendState.cancelCalls).toHaveLength(0);
      release();
      await vi.waitFor(() => expect(endStatuses()).toEqual(['completed']));
    } finally { start(); release(); await mocks.getKillHandler()!(); await run; }
  });

  it('refuses to cancel a local input before its root identity is confirmed', async () => {
    let release!: () => void;
    mocks.backendState.holdPrompt = new Promise(resolve => { release = resolve; });
    const run = runDelegationWorker();
    try {
      await vi.waitFor(() => expect(mocks.getUserMessageHandler()).toBeTypeOf('function'));
      mocks.getUserMessageHandler()!({ localId: 'delegation:task:v1', content: { text: 'busy' } });
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      mocks.mockSession.getCurrentRootTurnId.mockReturnValue(undefined);
      await expect(mocks.sessionHandlers.get('delegation-abort')!({ localId: 'delegation:task:v1' })).rejects.toThrow('does not match');
      expect(mocks.backendState.cancelCalls).toHaveLength(0);
      release();
      await vi.waitFor(() => expect(endStatuses()).toEqual(['completed']));
    } finally { release(); await mocks.getKillHandler()!(); await run; }
  });

  it.each(['stopped', 'error'])('preserves fatal lifecycle behavior for an ordinary backend %s', async status => {
    const run = runDelegationWorker();
    await vi.waitFor(() => expect(mocks.mockSession.processorReady).toHaveBeenCalled());
    emitBackend({ type: 'status', status, detail: 'backend exited unexpectedly' });
    await run;
    expect(mocks.backendState.disposeCalls).toBe(1);
    expect(mocks.mockSession.sendSessionDeath).toHaveBeenCalled();
    await expect(mocks.sessionHandlers.get('delegation-prepare')!({ model: 'Neon', permissionMode: 'default' })).rejects.toThrow('worker changed or ended');
  });

  it.each(['stopped', 'error'])('fails the active root and exits when the native backend reports %s', async status => {
    let release!: () => void;
    mocks.backendState.holdPrompt = new Promise(resolve => { release = resolve; });
    const run = runDelegationWorker();
    void run.catch(() => {});
    await vi.waitFor(() => expect(mocks.getUserMessageHandler()).toBeTypeOf('function'));
    mocks.getUserMessageHandler()!({ localId: 'active-user', content: { text: 'busy' } });
    await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
    emitBackend({ type: 'status', status, detail: 'backend died during prompt' });
    release();
    await expect(run).rejects.toThrow('backend died during prompt');
    expect(endStatuses()).toEqual(['failed']);
    expect(mocks.backendState.disposeCalls).toBe(1);
  });
});
