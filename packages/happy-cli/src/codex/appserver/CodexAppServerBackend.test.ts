import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerBackend, resolveModel } from './CodexAppServerBackend';
import { Methods } from './types';
import { logger } from '@/ui/logger';

function createBackend(): CodexAppServerBackend {
  return new CodexAppServerBackend({
    cwd: process.cwd(),
    command: 'codex',
  });
}

describe('CodexAppServerBackend.startSession resume routing', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'info').mockImplementation(() => {
      // no-op in tests
    });
    vi.spyOn(logger, 'debug').mockImplementation(() => {
      // no-op in tests
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses thread/resume with path when resumeFile is provided', async () => {
    const backend = new CodexAppServerBackend({
      cwd: process.cwd(),
      command: 'codex',
      resumeFile: '/tmp/rollout-duplicate.jsonl',
    });
    const anyBackend = backend as any;

    const request = vi.fn(async (method: string) => {
      if (method === Methods.INITIALIZE) {
        return { userAgent: 'codex-test' };
      }
      if (method === Methods.THREAD_RESUME) {
        return {
          thread: { id: 'thread-resumed' },
          model: 'codex-mini',
          reasoningEffort: null,
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    anyBackend.peer = {
      spawn: vi.fn(async () => undefined),
      onNotification: vi.fn(),
      onServerRequest: vi.fn(),
      onClose: vi.fn(),
      request,
      notify: vi.fn(),
    };

    await backend.startSession();

    expect(request).toHaveBeenCalledWith(
      Methods.THREAD_RESUME,
      expect.objectContaining({
        path: '/tmp/rollout-duplicate.jsonl',
      })
    );
    expect(request).not.toHaveBeenCalledWith(Methods.THREAD_START, expect.anything());
  });

  it('uses thread/start when neither resumeThreadId nor resumeFile is provided', async () => {
    const backend = createBackend();
    const anyBackend = backend as any;

    const request = vi.fn(async (method: string) => {
      if (method === Methods.INITIALIZE) {
        return { userAgent: 'codex-test' };
      }
      if (method === Methods.THREAD_START) {
        return {
          thread: { id: 'thread-new' },
          model: 'codex-mini',
          reasoningEffort: null,
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    anyBackend.peer = {
      spawn: vi.fn(async () => undefined),
      onNotification: vi.fn(),
      onServerRequest: vi.fn(),
      onClose: vi.fn(),
      request,
      notify: vi.fn(),
    };

    await backend.startSession();

    expect(request).toHaveBeenCalledWith(Methods.THREAD_START, expect.anything());
    expect(request).not.toHaveBeenCalledWith(Methods.THREAD_RESUME, expect.anything());
  });
});

describe('CodexAppServerBackend.waitForResponseComplete', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns immediately when a turn completed before waiting starts', async () => {
    const backend = createBackend();
    const anyBackend = backend as any;

    anyBackend.resetTurnComplete();
    anyBackend.handleNotification(Methods.NOTIFY_TURN_COMPLETED, {
      threadId: 't1',
      turn: { id: 'turn-1', status: 'completed', items: [] },
    });

    await expect(backend.waitForResponseComplete(100)).resolves.toBeUndefined();
  });

  it('does not timeout while progress events continue', async () => {
    const backend = createBackend();
    const anyBackend = backend as any;

    anyBackend.resetTurnComplete();
    const waitPromise = backend.waitForResponseComplete(120);

    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(90);
      anyBackend.handleNotification(Methods.NOTIFY_AGENT_MESSAGE_DELTA, {
        threadId: 't1', turnId: 'turn-1', itemId: 'i1', delta: 'x',
      });
    }

    anyBackend.handleNotification(Methods.NOTIFY_TURN_COMPLETED, {
      threadId: 't1',
      turn: { id: 'turn-1', status: 'completed', items: [] },
    });
    await expect(waitPromise).resolves.toBeUndefined();
  });

  it('does not timeout while approval is pending', async () => {
    const permissionHandler = {
      handleToolCall: vi.fn().mockImplementation(
        () => new Promise(() => {}) // never resolves — simulates user not responding
      ),
    };
    const backend = new CodexAppServerBackend({
      cwd: process.cwd(),
      command: 'codex',
      permissionHandler,
    });
    const anyBackend = backend as any;
    anyBackend.peer = { respond: vi.fn() };

    anyBackend.resetTurnComplete();

    // Simulate a legacy exec approval request arriving
    anyBackend.handleExecApproval(
      { call_id: 'call-1', command: ['ls'], cwd: '/tmp' },
      999
    );

    const waitPromise = backend.waitForResponseComplete(120).then(
      () => 'resolved',
      (error: Error) => error
    );

    await vi.advanceTimersByTimeAsync(500);
    expect(await Promise.race([waitPromise, Promise.resolve('still-waiting')])).toBe('still-waiting');
  });

  it('does not terminate turn on error notification (waits for turn/completed)', async () => {
    const backend = createBackend();
    const anyBackend = backend as any;

    anyBackend.resetTurnComplete();
    const waitPromise = backend.waitForResponseComplete(120).then(
      () => 'resolved',
      (error: Error) => error
    );

    // Error notification should NOT resolve the turn
    anyBackend.handleNotification(Methods.NOTIFY_ERROR, {
      threadId: 't1', turnId: 'turn-1', willRetry: true,
      error: { message: 'Reconnecting... 1/5' },
    });

    // turn/completed resolves it
    anyBackend.handleNotification(Methods.NOTIFY_TURN_COMPLETED, {
      threadId: 't1',
      turn: { id: 'turn-1', status: 'completed', items: [] },
    });
    const result = await waitPromise;
    expect(result).toBe('resolved');
  });
});

describe('CodexAppServerBackend notification handling', () => {
  it('emits model-output on agent message delta', () => {
    const backend = createBackend();
    const messages: any[] = [];
    backend.onMessage((msg) => messages.push(msg));
    const anyBackend = backend as any;

    anyBackend.handleNotification(Methods.NOTIFY_AGENT_MESSAGE_DELTA, {
      threadId: 't1', turnId: 'turn-1', itemId: 'i1', delta: 'Hello',
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: 'model-output', textDelta: 'Hello' });
  });

  it('emits tool-call on item/started with commandExecution', () => {
    const backend = createBackend();
    const messages: any[] = [];
    backend.onMessage((msg) => messages.push(msg));
    const anyBackend = backend as any;

    anyBackend.handleNotification(Methods.NOTIFY_ITEM_STARTED, {
      threadId: 't1', turnId: 'turn-1',
      item: { id: 'cmd-1', type: 'commandExecution', command: 'ls -la', cwd: '/tmp', commandActions: [], status: 'inProgress' },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'tool-call',
      toolName: 'CodexBash',
      callId: 'cmd-1',
      args: { command: 'ls -la', cwd: '/tmp' },
    });
  });

  it('emits tool-result on item/completed with commandExecution', () => {
    const backend = createBackend();
    const messages: any[] = [];
    backend.onMessage((msg) => messages.push(msg));
    const anyBackend = backend as any;

    anyBackend.handleNotification(Methods.NOTIFY_ITEM_COMPLETED, {
      threadId: 't1', turnId: 'turn-1',
      item: { id: 'cmd-1', type: 'commandExecution', command: 'ls', cwd: '/tmp', commandActions: [], status: 'completed', exitCode: 0, aggregatedOutput: 'file.txt' },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'tool-result',
      toolName: 'CodexBash',
      callId: 'cmd-1',
      result: { exit_code: 0 },
    });
  });

  it('emits terminal-output on command output delta', () => {
    const backend = createBackend();
    const messages: any[] = [];
    backend.onMessage((msg) => messages.push(msg));
    const anyBackend = backend as any;

    anyBackend.handleNotification(Methods.NOTIFY_COMMAND_OUTPUT_DELTA, {
      threadId: 't1', turnId: 'turn-1', itemId: 'cmd-1', delta: 'output text',
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: 'terminal-output', data: 'output text' });
  });

  it('handles turn/completed with failed status as error', async () => {
    const backend = createBackend();
    const anyBackend = backend as any;

    anyBackend.resetTurnComplete();

    anyBackend.handleNotification(Methods.NOTIFY_TURN_COMPLETED, {
      threadId: 't1',
      turn: { id: 'turn-1', status: 'failed', items: [], error: { message: 'Rate limited' } },
    });

    await expect(backend.waitForResponseComplete()).rejects.toThrow('Rate limited');
  });

  it('handles turn/completed with interrupted status gracefully', async () => {
    const backend = createBackend();
    const messages: any[] = [];
    backend.onMessage((msg) => messages.push(msg));
    const anyBackend = backend as any;

    anyBackend.resetTurnComplete();
    anyBackend.handleNotification(Methods.NOTIFY_TURN_COMPLETED, {
      threadId: 't1',
      turn: { id: 'turn-1', status: 'interrupted', items: [] },
    });

    await expect(backend.waitForResponseComplete()).resolves.toBeUndefined();
    expect(messages.some((m) => m.type === 'status' && m.detail === 'aborted')).toBe(true);
  });

  it('emits token-count on thread/tokenUsage/updated', () => {
    const backend = createBackend();
    const messages: any[] = [];
    backend.onMessage((msg) => messages.push(msg));
    const anyBackend = backend as any;

    anyBackend.handleNotification(Methods.NOTIFY_THREAD_TOKEN_USAGE, {
      threadId: 't1', turnId: 'turn-1',
      tokenUsage: {
        last: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 200, reasoningOutputTokens: 0, totalTokens: 300 },
        total: { inputTokens: 1000, cachedInputTokens: 500, outputTokens: 2000, reasoningOutputTokens: 100, totalTokens: 3000 },
        modelContextWindow: 128000,
      },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('token-count');
    expect(messages[0].total_token_usage.total_tokens).toBe(3000);
    expect(messages[0].model_context_window).toBe(128000);
  });
});

describe('CodexAppServerBackend v2 item normalization', () => {
  it('normalizes fileChange v2 array changes to v1 map format', () => {
    const backend = createBackend();
    const messages: any[] = [];
    backend.onMessage((msg) => messages.push(msg));
    const anyBackend = backend as any;

    anyBackend.handleNotification(Methods.NOTIFY_ITEM_STARTED, {
      threadId: 't1', turnId: 'turn-1',
      item: {
        id: 'fc-1', type: 'fileChange', status: 'inProgress',
        changes: [
          { path: 'src/foo.ts', kind: { type: 'update' }, diff: '--- a\n+++ b' },
          { path: 'src/bar.ts', kind: { type: 'add' }, diff: '+new file' },
          { path: 'src/old.ts', kind: { type: 'delete' }, diff: '-removed' },
        ],
      },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('patch-apply-begin');
    expect(messages[0].changes).toEqual({
      'src/foo.ts': { modify: true },
      'src/bar.ts': { add: true },
      'src/old.ts': { delete: true },
    });
  });

  it('passes through v1 map-style changes unchanged', () => {
    const backend = createBackend();
    const messages: any[] = [];
    backend.onMessage((msg) => messages.push(msg));
    const anyBackend = backend as any;

    const v1Changes = { 'src/file.ts': { modify: { old_content: 'a', new_content: 'b' } } };
    anyBackend.handleNotification(Methods.NOTIFY_ITEM_STARTED, {
      threadId: 't1', turnId: 'turn-1',
      item: { id: 'fc-2', type: 'fileChange', status: 'inProgress', changes: v1Changes },
    });

    expect(messages[0].changes).toEqual(v1Changes);
  });

  it('forwards query for webSearch when available at STARTED', () => {
    const backend = createBackend();
    const messages: any[] = [];
    backend.onMessage((msg) => messages.push(msg));
    const anyBackend = backend as any;

    anyBackend.handleNotification(Methods.NOTIFY_ITEM_STARTED, {
      threadId: 't1', turnId: 'turn-1',
      item: { id: 'ws-1', type: 'webSearch', query: 'react hooks' },
    });

    expect(messages[0]).toMatchObject({
      type: 'tool-call',
      toolName: 'web_search',
      args: { query: 'react hooks' },
    });
  });

  it('sends empty args for webSearch when query is empty', () => {
    const backend = createBackend();
    const messages: any[] = [];
    backend.onMessage((msg) => messages.push(msg));
    const anyBackend = backend as any;

    anyBackend.handleNotification(Methods.NOTIFY_ITEM_STARTED, {
      threadId: 't1', turnId: 'turn-1',
      item: { id: 'ws-2', type: 'webSearch', query: '' },
    });

    expect(messages[0].args).toEqual({});
  });

  it('forwards commandActions as parsed_cmd for commandExecution', () => {
    const backend = createBackend();
    const messages: any[] = [];
    backend.onMessage((msg) => messages.push(msg));
    const anyBackend = backend as any;

    const actions = [{ type: 'read', command: 'cat src/foo.ts', path: 'src/foo.ts', name: 'src/foo.ts' }];
    anyBackend.handleNotification(Methods.NOTIFY_ITEM_STARTED, {
      threadId: 't1', turnId: 'turn-1',
      item: { id: 'cmd-2', type: 'commandExecution', command: 'cat src/foo.ts', cwd: '/app', commandActions: actions, status: 'inProgress' },
    });

    expect(messages[0].args.parsed_cmd).toEqual(actions);
  });

  it('surfaces error message for failed mcpToolCall on COMPLETED', () => {
    const backend = createBackend();
    const messages: any[] = [];
    backend.onMessage((msg) => messages.push(msg));
    const anyBackend = backend as any;

    anyBackend.handleNotification(Methods.NOTIFY_ITEM_COMPLETED, {
      threadId: 't1', turnId: 'turn-1',
      item: {
        id: 'mcp-1', type: 'mcpToolCall', server: 'linear', tool: 'create_issue',
        arguments: { title: 'test' }, status: 'failed',
        result: null,
        error: { message: 'Connection refused' },
      },
    });

    expect(messages[0]).toMatchObject({
      type: 'tool-result',
      toolName: 'mcp:linear:create_issue',
      callId: 'mcp-1',
      result: { error: 'Connection refused' },
    });
  });

  it('passes through result for successful mcpToolCall on COMPLETED', () => {
    const backend = createBackend();
    const messages: any[] = [];
    backend.onMessage((msg) => messages.push(msg));
    const anyBackend = backend as any;

    const mcpResult = { content: [{ type: 'text', text: 'done' }] };
    anyBackend.handleNotification(Methods.NOTIFY_ITEM_COMPLETED, {
      threadId: 't1', turnId: 'turn-1',
      item: {
        id: 'mcp-2', type: 'mcpToolCall', server: 'linear', tool: 'list_issues',
        arguments: {}, status: 'completed',
        result: mcpResult,
        error: null,
      },
    });

    expect(messages[0]).toMatchObject({
      type: 'tool-result',
      toolName: 'mcp:linear:list_issues',
      callId: 'mcp-2',
      result: mcpResult,
    });
  });
});

describe('CodexAppServerBackend approval request parsing', () => {
  it('accepts snake_case call_id for exec approval requests', async () => {
    const permissionHandler = {
      handleToolCall: vi.fn().mockResolvedValue({ decision: 'approved' }),
    };
    const backend = new CodexAppServerBackend({
      cwd: process.cwd(),
      command: 'codex',
      permissionHandler,
    });
    const anyBackend = backend as any;
    const respond = vi.fn();
    anyBackend.peer = { respond };

    anyBackend.handleExecApproval(
      {
        call_id: 'exec-call-1',
        command: ['ls', '-la'],
        cwd: '/tmp',
        reason: 'command failed; retry without sandbox?',
      },
      123
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
      'exec-call-1',
      'CodexBash',
      {
        command: ['ls', '-la'],
        cwd: '/tmp',
        reason: 'command failed; retry without sandbox?',
      }
    );
    expect(respond).toHaveBeenCalledWith(123, { decision: 'approved' });
  });

  it('denies exec approval requests that do not include a call id', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const permissionHandler = {
      handleToolCall: vi.fn().mockResolvedValue({ decision: 'approved' }),
    };
    const backend = new CodexAppServerBackend({
      cwd: process.cwd(),
      command: 'codex',
      permissionHandler,
    });
    const anyBackend = backend as any;
    const respond = vi.fn();
    anyBackend.peer = { respond };

    anyBackend.handleExecApproval({ command: ['ls'], cwd: '/tmp' }, 456);

    expect(permissionHandler.handleToolCall).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(456, { decision: 'denied' });
    warnSpy.mockRestore();
  });

  it('handles v2 command execution approval', async () => {
    const permissionHandler = {
      handleToolCall: vi.fn().mockResolvedValue({ decision: 'approved' }),
    };
    const backend = new CodexAppServerBackend({
      cwd: process.cwd(),
      command: 'codex',
      permissionHandler,
    });
    const anyBackend = backend as any;
    const respond = vi.fn();
    anyBackend.peer = { respond };

    anyBackend.handleServerRequest(Methods.COMMAND_EXECUTION_APPROVAL, {
      threadId: 't1', turnId: 'turn-1', itemId: 'cmd-1',
      command: 'rm -rf /tmp/test', cwd: '/home',
      reason: 'destructive command',
    }, 100);

    await Promise.resolve();
    await Promise.resolve();

    expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
      'cmd-1', 'CodexBash',
      expect.objectContaining({ command: ['rm -rf /tmp/test'] })
    );
    expect(respond).toHaveBeenCalledWith(100, { decision: 'accept' });
  });

  it('handles v2 file change approval', async () => {
    const permissionHandler = {
      handleToolCall: vi.fn().mockResolvedValue({ decision: 'approved' }),
    };
    const backend = new CodexAppServerBackend({
      cwd: process.cwd(),
      command: 'codex',
      permissionHandler,
    });
    const anyBackend = backend as any;
    const respond = vi.fn();
    anyBackend.peer = { respond };

    anyBackend.handleServerRequest(Methods.FILE_CHANGE_APPROVAL, {
      threadId: 't1', turnId: 'turn-1', itemId: 'patch-1',
      reason: 'write outside workspace',
    }, 200);

    await Promise.resolve();
    await Promise.resolve();

    expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
      'patch-1', 'CodexPatch',
      expect.objectContaining({ reason: 'write outside workspace' })
    );
    expect(respond).toHaveBeenCalledWith(200, { decision: 'accept' });
  });

  it('declines MCP elicitation by default', () => {
    const backend = createBackend();
    const anyBackend = backend as any;
    const respond = vi.fn();
    anyBackend.peer = { respond };

    anyBackend.handleServerRequest(Methods.MCP_ELICITATION, {
      serverName: 'test', threadId: 't1',
      mode: 'form', message: 'Enter API key', requestedSchema: {},
    }, 42);

    expect(respond).toHaveBeenCalledWith(42, { action: 'decline' });
  });
});

describe('resolveModel', () => {
  it('strips -fast suffix and sets isFast', () => {
    expect(resolveModel('o4-mini-fast')).toEqual({ model: 'o4-mini', isFast: true });
  });

  it('leaves non-fast models unchanged', () => {
    expect(resolveModel('o4-mini')).toEqual({ model: 'o4-mini', isFast: false });
  });

  it('handles null model', () => {
    expect(resolveModel(null)).toEqual({ model: null, isFast: false });
  });

  it('handles undefined model', () => {
    expect(resolveModel(undefined)).toEqual({ model: null, isFast: false });
  });

  it('does not strip -fast from middle of model name', () => {
    expect(resolveModel('fast-model')).toEqual({ model: 'fast-model', isFast: false });
  });
});

describe('buildThreadParams', () => {
  it('passes serviceTier directly when model has -fast suffix', () => {
    const backend = new CodexAppServerBackend({
      cwd: process.cwd(),
      command: 'codex',
      model: 'o4-mini-fast',
    });
    const params = (backend as any).buildThreadParams();
    expect(params.model).toBe('o4-mini');
    expect(params.serviceTier).toBe('fast');
  });

  it('does not set serviceTier for non-fast models', () => {
    const backend = new CodexAppServerBackend({
      cwd: process.cwd(),
      command: 'codex',
      model: 'o4-mini',
    });
    const params = (backend as any).buildThreadParams();
    expect(params.model).toBe('o4-mini');
    expect(params.serviceTier).toBeUndefined();
  });

  it('preserves reasoning effort in config', () => {
    const backend = new CodexAppServerBackend({
      cwd: process.cwd(),
      command: 'codex',
      model: 'o4-mini-fast',
      reasoningEffort: 'high',
    });
    const params = (backend as any).buildThreadParams();
    expect(params.model).toBe('o4-mini');
    expect(params.serviceTier).toBe('fast');
    expect(params.config?.model_reasoning_effort).toBe('high');
  });
});
