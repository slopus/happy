import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { Session } from './session';

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
  });

  it('surfaces Claude process errors to the UI', async () => {
    const sendSessionEvent = vi.fn();
    const client = {
      keepAlive: vi.fn(),
      updateMetadata: vi.fn(),
      rpcHandlerManager: { registerHandler: vi.fn() },
      sendClaudeSessionMessage: vi.fn(),
      sendSessionEvent,
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
    expect(sendSessionEvent).toHaveBeenCalledWith({
      type: 'message',
      message: expect.stringContaining('Claude process error:'),
    });
    expect(sendSessionEvent).toHaveBeenCalledWith({
      type: 'message',
      message: expect.stringContaining('boom'),
    });

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
    expect(sendSessionEvent).toHaveBeenCalledWith({
      type: 'message',
      message: expect.stringContaining('transcript'),
    });

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
});
