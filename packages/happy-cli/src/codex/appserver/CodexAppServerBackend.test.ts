import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerBackend, isTurnProgressEvent } from './CodexAppServerBackend';
import { logger } from '@/ui/logger';

function createBackend(): CodexAppServerBackend {
  return new CodexAppServerBackend({
    cwd: process.cwd(),
    command: 'codex',
  });
}

describe('isTurnProgressEvent', () => {
  it('marks real progress events as progress', () => {
    expect(isTurnProgressEvent('agent_message_delta')).toBe(true);
    expect(isTurnProgressEvent('exec_command_begin')).toBe(true);
  });

  it('ignores noisy events', () => {
    expect(isTurnProgressEvent('token_count')).toBe(false);
    expect(isTurnProgressEvent('terminal_interaction')).toBe(false);
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
    anyBackend.handleCodexEvent({ type: 'task_complete' });

    await expect(backend.waitForResponseComplete(100)).resolves.toBeUndefined();
  });

  it('does not timeout while progress events continue', async () => {
    const backend = createBackend();
    const anyBackend = backend as any;

    anyBackend.resetTurnComplete();
    const waitPromise = backend.waitForResponseComplete(120);

    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(90);
      anyBackend.handleCodexEvent({ type: 'agent_message_delta', delta: 'x' });
    }

    anyBackend.handleCodexEvent({ type: 'task_complete' });
    await expect(waitPromise).resolves.toBeUndefined();
  });

  it('times out when only non-progress events are received', async () => {
    const backend = createBackend();
    const anyBackend = backend as any;

    anyBackend.resetTurnComplete();
    const waitPromise = backend.waitForResponseComplete(120).then(
      () => null,
      (error: Error) => error
    );

    for (let i = 0; i < 4; i++) {
      anyBackend.handleCodexEvent({ type: 'token_count', info: {} });
      await vi.advanceTimersByTimeAsync(40);
    }
    await vi.advanceTimersByTimeAsync(120);

    const err = await waitPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('idle timeout');
    expect((err as Error).message).toContain('lastProgressEvent=turn_start');
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

    // Simulate an exec approval request arriving — adds to pendingApprovals
    anyBackend.handleExecApproval(
      { call_id: 'call-1', command: ['ls'], cwd: '/tmp' },
      999
    );

    const waitPromise = backend.waitForResponseComplete(120).then(
      () => 'resolved',
      (error: Error) => error
    );

    // Advance well past the idle timeout — should NOT timeout
    await vi.advanceTimersByTimeAsync(500);

    // Still pending (no task_complete yet, no timeout)
    expect(await Promise.race([waitPromise, Promise.resolve('still-waiting')])).toBe('still-waiting');
  });

  it('resumes idle timeout after approval is resolved', async () => {
    let resolveApproval!: (v: { decision: string }) => void;
    const permissionHandler = {
      handleToolCall: vi.fn().mockImplementation(
        () => new Promise((resolve) => { resolveApproval = resolve; })
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

    // Approval request arrives
    anyBackend.handleExecApproval(
      { call_id: 'call-1', command: ['ls'], cwd: '/tmp' },
      999
    );

    const waitPromise = backend.waitForResponseComplete(120).then(
      () => 'resolved',
      (error: Error) => error
    );

    // Wait a long time while approval is pending — should NOT timeout
    await vi.advanceTimersByTimeAsync(300);
    expect(await Promise.race([waitPromise, Promise.resolve('still-waiting')])).toBe('still-waiting');

    // User approves — pendingApprovals becomes empty
    resolveApproval({ decision: 'approved' });
    await vi.advanceTimersByTimeAsync(1); // flush microtasks

    // Now idle timeout should resume — advance past timeout
    await vi.advanceTimersByTimeAsync(200);

    const result = await waitPromise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('idle timeout');
  });

  it('does not terminate turn on error event (waits for task_complete)', async () => {
    const backend = createBackend();
    const anyBackend = backend as any;

    anyBackend.resetTurnComplete();
    const waitPromise = backend.waitForResponseComplete(120).then(
      () => 'resolved',
      (error: Error) => error
    );

    // Error event should NOT resolve the turn
    anyBackend.handleCodexEvent({ type: 'error', message: 'Reconnecting... 1/5' });

    // Turn should still be pending — only task_complete resolves it
    anyBackend.handleCodexEvent({ type: 'task_complete' });
    const result = await waitPromise;

    expect(result).toBe('resolved');
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

  it('accepts snake_case call_id for patch approval requests', async () => {
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

    anyBackend.handlePatchApproval(
      {
        call_id: 'patch-call-1',
        file_changes: { 'a.txt': { type: 'update' } },
        reason: 'patch apply approval',
      },
      789
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
      'patch-call-1',
      'CodexPatch',
      {
        changes: { 'a.txt': { type: 'update' } },
        reason: 'patch apply approval',
      }
    );
    expect(respond).toHaveBeenCalledWith(789, { decision: 'approved' });
  });
});
