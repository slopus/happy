import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { Session } from './session';

let readlineAnswer = 'n';
vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (answer: string) => void) => cb(readlineAnswer),
    close: () => {},
  }),
}));

const mockClaudeLocal = vi.fn();
vi.mock('./claudeLocal', () => ({
  claudeLocal: mockClaudeLocal,
}));

const mockCreateSessionScanner = vi.fn();
vi.mock('./utils/sessionScanner', () => ({
  createSessionScanner: mockCreateSessionScanner,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('claudeLocalLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readlineAnswer = 'n';
  });

  it('surfaces Claude process errors to the UI', async () => {
    const sendSessionEvent = vi.fn();
    const client = {
      keepAlive: vi.fn(),
      updateMetadata: vi.fn(),
      rpcHandlerManager: { registerHandler: vi.fn() },
      sendClaudeSessionMessage: vi.fn(),
      sendSessionEvent,
      peekPendingMessageQueueV1Preview: vi.fn(() => ({ count: 0, preview: [] })),
      discardPendingMessageQueueV1All: vi.fn().mockResolvedValue(0),
    } as any;

    const session = new Session({
      api: {} as any,
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: null,
      mcpServers: {},
      messageQueue: new MessageQueue2<any>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
    });

    mockCreateSessionScanner.mockResolvedValue({
      cleanup: vi.fn(async () => {}),
      onNewSession: vi.fn(),
    });

    mockClaudeLocal
      .mockImplementationOnce(async () => {
        throw new Error('boom');
      })
      .mockImplementationOnce(async () => {});

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const result = await claudeLocalLauncher(session);

    expect(result).toBe('exit');
    expect(sendSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message',
        message: expect.any(String),
      }),
    );

    session.cleanup();
  });

  it('surfaces transcript missing warnings to the UI', async () => {
    const sendSessionEvent = vi.fn();
    const client = {
      keepAlive: vi.fn(),
      updateMetadata: vi.fn(),
      rpcHandlerManager: { registerHandler: vi.fn() },
      sendClaudeSessionMessage: vi.fn(),
      sendSessionEvent,
      peekPendingMessageQueueV1Preview: vi.fn(() => ({ count: 0, preview: [] })),
      discardPendingMessageQueueV1All: vi.fn().mockResolvedValue(0),
    } as any;

    const session = new Session({
      api: {} as any,
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: null,
      mcpServers: {},
      messageQueue: new MessageQueue2<any>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
    });

    mockCreateSessionScanner.mockImplementation(async (opts: any) => {
      opts.onTranscriptMissing?.({ sessionId: 'sess_1', filePath: '/tmp/sess_1.jsonl' });
      return {
        cleanup: vi.fn(async () => {}),
        onNewSession: vi.fn(),
      };
    });

    mockClaudeLocal.mockImplementationOnce(async () => {});

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const result = await claudeLocalLauncher(session);

    expect(result).toBe('exit');
    expect(sendSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message',
        message: expect.any(String),
      }),
    );

    session.cleanup();
  });

  it('passes transcriptPath to sessionScanner when already known', async () => {
    const sendSessionEvent = vi.fn();
    const client = {
      keepAlive: vi.fn(),
      updateMetadata: vi.fn(),
      rpcHandlerManager: { registerHandler: vi.fn() },
      sendClaudeSessionMessage: vi.fn(),
      sendSessionEvent,
      peekPendingMessageQueueV1Preview: vi.fn(() => ({ count: 0, preview: [] })),
      discardPendingMessageQueueV1All: vi.fn().mockResolvedValue(0),
    } as any;

    const session = new Session({
      api: {} as any,
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: null,
      mcpServers: {},
      messageQueue: new MessageQueue2<any>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
    });

    // Simulate a session started in remote mode where hook already provided transcript_path
    session.onSessionFound('sess_1', { transcript_path: '/alt/sess_1.jsonl' } as any);

    mockCreateSessionScanner.mockResolvedValue({
      cleanup: vi.fn(async () => {}),
      onNewSession: vi.fn(),
    });

    mockClaudeLocal.mockImplementationOnce(async () => {});

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const result = await claudeLocalLauncher(session);

    expect(result).toBe('exit');
    expect(mockCreateSessionScanner).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess_1',
        transcriptPath: '/alt/sess_1.jsonl',
      }),
    );

    session.cleanup();
  });

  it('clears sessionId and transcriptPath before spawning a local resume session', async () => {
    const sendSessionEvent = vi.fn();
    const handlersByMethod: Record<string, any[]> = {};
    const client = {
      keepAlive: vi.fn(),
      updateMetadata: vi.fn(),
      rpcHandlerManager: {
        registerHandler: vi.fn((method: string, handler: any) => {
          handlersByMethod[method] = handlersByMethod[method] || [];
          handlersByMethod[method].push(handler);
        }),
      },
      sendClaudeSessionMessage: vi.fn(),
      sendSessionEvent,
      peekPendingMessageQueueV1Preview: vi.fn(() => ({ count: 0, preview: [] })),
      discardPendingMessageQueueV1All: vi.fn().mockResolvedValue(0),
    } as any;

    const session = new Session({
      api: {} as any,
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: null,
      mcpServers: {},
      messageQueue: new MessageQueue2<any>(() => 'mode'),
      onModeChange: () => { },
      hookSettingsPath: '/tmp/hooks.json',
    });

    // Simulate an existing session we are about to resume locally.
    session.onSessionFound('sess_0', { transcript_path: '/tmp/sess_0.jsonl' } as any);

    mockCreateSessionScanner.mockResolvedValue({
      cleanup: vi.fn(async () => { }),
      onNewSession: vi.fn(),
    });

    let optsSessionId: string | null | undefined;
    let sessionIdAtSpawn: string | null | undefined;
    let transcriptPathAtSpawn: string | null | undefined;

    mockClaudeLocal.mockImplementationOnce(async (opts: any) => {
      optsSessionId = opts.sessionId;
      sessionIdAtSpawn = session.sessionId;
      transcriptPathAtSpawn = session.transcriptPath;

      await new Promise<void>((resolve) => {
        if (opts.abort?.aborted) return resolve();
        opts.abort?.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');

    const launcherPromise = claudeLocalLauncher(session);

    // Wait for handlers to register
    while (!handlersByMethod.switch?.length) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // Hook reports the real active session shortly after spawn (resume forks).
    session.onSessionFound('sess_1', { transcript_path: '/tmp/sess_1.jsonl' } as any);

    const switchHandler = handlersByMethod.switch[0];
    expect(await switchHandler({ to: 'remote' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');

    expect(optsSessionId).toBe('sess_0');
    expect(sessionIdAtSpawn).toBeNull();
    expect(transcriptPathAtSpawn).toBeNull();

    expect(mockCreateSessionScanner).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess_0',
        transcriptPath: '/tmp/sess_0.jsonl',
      }),
    );

    session.cleanup();
  });

  it('respects switch RPC params and returns boolean', async () => {
    const sendSessionEvent = vi.fn();
    const handlersByMethod: Record<string, any[]> = {};
    const client = {
      keepAlive: vi.fn(),
      updateMetadata: vi.fn(),
      rpcHandlerManager: {
        registerHandler: vi.fn((method: string, handler: any) => {
          handlersByMethod[method] = handlersByMethod[method] || [];
          handlersByMethod[method].push(handler);
        }),
      },
      sendClaudeSessionMessage: vi.fn(),
      sendSessionEvent,
      peekPendingMessageQueueV1Preview: vi.fn(() => ({ count: 0, preview: [] })),
      discardPendingMessageQueueV1All: vi.fn().mockResolvedValue(0),
    } as any;

    const session = new Session({
      api: {} as any,
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: null,
      mcpServers: {},
      messageQueue: new MessageQueue2<any>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
    });

    // Avoid switch waiting on hook data in test; simulate known session.
    session.onSessionFound('sess_1', { transcript_path: '/tmp/sess_1.jsonl' } as any);

    mockCreateSessionScanner.mockResolvedValue({
      cleanup: vi.fn(async () => {}),
      onNewSession: vi.fn(),
    });

    // Block until aborted
    mockClaudeLocal.mockImplementationOnce(async (opts: any) => {
      await new Promise<void>((resolve) => {
        if (opts.abort?.aborted) return resolve();
        opts.abort?.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');

    const launcherPromise = claudeLocalLauncher(session);

    // Wait for handlers to register
    while (!handlersByMethod.switch?.length) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const switchHandler = handlersByMethod.switch[0];
    expect(await switchHandler({ to: 'local' })).toBe(false);

    // Switching to remote should abort and exit local launcher
    expect(await switchHandler({ to: 'remote' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');

    session.cleanup();
  });

  it('declines remote→local switch when queued messages exist and user does not confirm discard', async () => {
    const sendSessionEvent = vi.fn();
    const client = {
      keepAlive: vi.fn(),
      updateMetadata: vi.fn(),
      rpcHandlerManager: { registerHandler: vi.fn() },
      sendClaudeSessionMessage: vi.fn(),
      sendSessionEvent,
      peekPendingMessageQueueV1Preview: vi.fn(() => ({ count: 0, preview: [] })),
      discardPendingMessageQueueV1All: vi.fn().mockResolvedValue(0),
    } as any;

    const session = new Session({
      api: {} as any,
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: null,
      mcpServers: {},
      messageQueue: new MessageQueue2<any>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
    });

    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    session.queue.push('hello from app', { permissionMode: 'default' });

    mockCreateSessionScanner.mockResolvedValue({
      cleanup: vi.fn(async () => {}),
      onNewSession: vi.fn(),
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const result = await claudeLocalLauncher(session);

    expect(result).toBe('switch');
    expect(mockClaudeLocal).not.toHaveBeenCalled();

    session.cleanup();
  });

  it('discards queued messages when user confirms, then continues into local mode', async () => {
    const sendSessionEvent = vi.fn();
    const client = {
      keepAlive: vi.fn(),
      updateMetadata: vi.fn(),
      rpcHandlerManager: { registerHandler: vi.fn() },
      sendClaudeSessionMessage: vi.fn(),
      sendSessionEvent,
      peekPendingMessageQueueV1Preview: vi.fn(() => ({ count: 0, preview: [] })),
      discardPendingMessageQueueV1All: vi.fn().mockResolvedValue(0),
    } as any;

    const session = new Session({
      api: {} as any,
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: null,
      mcpServers: {},
      messageQueue: new MessageQueue2<any>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
    });

    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    readlineAnswer = 'y';
    session.queue.push('hello from app', { permissionMode: 'default' });

    mockCreateSessionScanner.mockResolvedValue({
      cleanup: vi.fn(async () => {}),
      onNewSession: vi.fn(),
    });

    mockClaudeLocal.mockImplementationOnce(async () => {});

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const result = await claudeLocalLauncher(session);

    expect(result).toBe('exit');
    expect(session.queue.size()).toBe(0);
    expect(sendSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message',
        message: expect.any(String),
      }),
    );

    session.cleanup();
  });
});
