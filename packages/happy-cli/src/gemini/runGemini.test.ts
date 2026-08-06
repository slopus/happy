import { beforeEach, describe, expect, it, vi } from 'vitest';

type Scenario = 'abort' | 'error' | 'complete';

const mocks = vi.hoisted(() => ({
  scenario: 'complete' as Scenario,
  backendMessageHandler: null as ((message: any) => void) | null,
  queue: [] as Array<any>,
  agentMessages: [] as Array<any>,
  rpcHandlers: new Map<string, (...args: any[]) => any>(),
  sessionEvents: [] as Array<any>,
}));

const backend = {
  startSession: vi.fn(async () => ({ sessionId: 'gemini-session' })),
  sendPrompt: vi.fn(async () => {
    mocks.backendMessageHandler?.({ type: 'status', status: 'running' });

    if (mocks.scenario === 'abort') {
      await mocks.rpcHandlers.get('abort')?.({});
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }

    if (mocks.scenario === 'error') {
      mocks.backendMessageHandler?.({
        type: 'status',
        status: 'error',
        detail: 'backend failed',
      });
      throw new Error('backend failed');
    }

    mocks.backendMessageHandler?.({ type: 'status', status: 'idle' });
  }),
  cancel: vi.fn(async () => {}),
  onMessage: vi.fn((handler: (message: any) => void) => {
    mocks.backendMessageHandler = handler;
  }),
  waitForResponseComplete: vi.fn(async () => {}),
  dispose: vi.fn(async () => {}),
};

const session = {
  sessionId: 'happy-session',
  onUserMessage: vi.fn(),
  keepAlive: vi.fn(),
  sendAgentMessage: vi.fn((_provider: string, message: any) => {
    mocks.agentMessages.push(message);
  }),
  sendSessionEvent: vi.fn((event: any) => {
    mocks.sessionEvents.push(event);
  }),
  getMetadata: vi.fn(() => ({})),
  updateMetadata: vi.fn(),
  sendSessionDeath: vi.fn(),
  flush: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  rpcHandlerManager: {
    registerHandler: vi.fn((name: string, handler: (...args: any[]) => any) => {
      mocks.rpcHandlers.set(name, handler);
    }),
  },
};

vi.mock('ink', () => ({ render: vi.fn() }));
vi.mock('@/api/api', () => ({
  ApiClient: {
    create: vi.fn(async () => ({
      getOrCreateMachine: vi.fn(async () => ({})),
      getVendorToken: vi.fn(async () => null),
      getOrCreateSession: vi.fn(async () => null),
      push: vi.fn(() => ({ sendSessionNotification: vi.fn() })),
    })),
  },
}));
vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    getLogPath: vi.fn(() => '/tmp/happy-gemini-test.log'),
  },
}));
vi.mock('@/persistence', () => ({
  readSettings: vi.fn(async () => ({ machineId: 'machine-1' })),
}));
vi.mock('@/utils/createSessionMetadata', () => ({
  createSessionMetadata: vi.fn(() => ({ state: {}, metadata: {} })),
}));
vi.mock('@/daemon/run', () => ({ initialMachineMetadata: {} }));
vi.mock('@/utils/MessageQueue2', () => ({
  MessageQueue2: class {
    push() {}
    reset() {
      mocks.queue = [];
    }
    size() {
      return mocks.queue.length;
    }
    async waitForMessagesAndGetAsString() {
      return mocks.queue.shift() ?? null;
    }
  },
}));
vi.mock('@/projectPath', () => ({ projectPath: vi.fn(() => '/tmp/happy') }));
vi.mock('@/claude/utils/startHappyServer', () => ({
  startHappyServer: vi.fn(async () => ({ url: 'http://127.0.0.1:1', stop: vi.fn() })),
}));
vi.mock('@/daemon/controlClient', () => ({ notifyDaemonSessionStarted: vi.fn() }));
vi.mock('@/claude/registerKillSessionHandler', () => ({ registerKillSessionHandler: vi.fn() }));
vi.mock('@/utils/serverConnectionErrors', () => ({
  connectionState: { setBackend: vi.fn() },
}));
vi.mock('@/utils/setupOfflineReconnection', () => ({
  setupOfflineReconnection: vi.fn(() => ({
    session,
    reconnectionHandle: { cancel: vi.fn() },
  })),
}));
vi.mock('@/title/sessionTitleWorker', () => ({ registerSessionTitleWorker: vi.fn() }));
vi.mock('@/agent/factories/gemini', () => ({
  createGeminiBackend: vi.fn(() => ({
    backend,
    model: 'gemini-test',
    modelSource: 'test',
  })),
}));
vi.mock('@/gemini/utils/permissionHandler', () => ({
  GeminiPermissionHandler: class {
    setPermissionMode() {}
    reset() {}
    updateSession() {}
  },
}));
vi.mock('@/gemini/utils/reasoningProcessor', () => ({
  GeminiReasoningProcessor: class {
    processChunk() {}
    complete() {}
    abort() {}
  },
}));
vi.mock('@/gemini/utils/diffProcessor', () => ({
  GeminiDiffProcessor: class {
    processToolResult() {}
    processFsEdit() {}
    reset() {}
  },
}));
vi.mock('@/gemini/utils/config', () => ({
  readGeminiLocalConfig: vi.fn(() => ({})),
  saveGeminiModelToConfig: vi.fn(),
  getInitialGeminiModel: vi.fn(() => 'gemini-test'),
}));

import { runGemini } from './runGemini';

const lifecycleMessages = () => mocks.agentMessages.filter((message) => (
  message.type === 'task_started'
  || message.type === 'task_complete'
  || message.type === 'turn_aborted'
));

async function runScenario(scenario: Scenario) {
  mocks.scenario = scenario;
  mocks.queue = [{
    message: 'hello',
    mode: { permissionMode: 'default', originalUserMessage: 'hello' },
    isolate: false,
    hash: 'mode-1',
  }];

  await runGemini({ credentials: { token: 'test-token' } as any });
  return lifecycleMessages();
}

describe('runGemini turn lifecycle', () => {
  beforeEach(() => {
    mocks.backendMessageHandler = null;
    mocks.queue = [];
    mocks.agentMessages = [];
    mocks.rpcHandlers.clear();
    mocks.sessionEvents = [];
    vi.clearAllMocks();
  });

  it('keeps user abort cancelled after the per-turn finally block', async () => {
    const events = await runScenario('abort');

    expect(events.map((event) => [event.type, event.status])).toEqual([
      ['task_started', undefined],
      ['turn_aborted', 'cancelled'],
    ]);
    expect(events[1].id).toBe(events[0].id);
  });

  it('keeps backend errors failed after the per-turn finally block', async () => {
    const events = await runScenario('error');

    expect(events.map((event) => [event.type, event.status])).toEqual([
      ['task_started', undefined],
      ['turn_aborted', 'failed'],
    ]);
    expect(events[1].id).toBe(events[0].id);
  });

  it('emits completed only for a normally finished turn', async () => {
    const events = await runScenario('complete');

    expect(events.map((event) => [event.type, event.status])).toEqual([
      ['task_started', undefined],
      ['task_complete', undefined],
    ]);
    expect(events[1].id).toBe(events[0].id);
  });
});
