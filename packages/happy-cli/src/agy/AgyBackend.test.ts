import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { AgyBackend, isRetryableAgyError, type SpawnFn } from './AgyBackend';
import type { AgentMessage } from '@/agent/core/AgentBackend';

function makeFakeChild() {
  const stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stdout.setEncoding = () => {};
  stderr.setEncoding = () => {};
  const child = new EventEmitter() as EventEmitter & {
    stdin: typeof stdin;
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: (signal?: string) => boolean;
    killed: boolean;
  };
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return { child, stdin, stdout, stderr };
}

describe('isRetryableAgyError', () => {
  it('identifies eligibility check and EOF errors as retryable', () => {
    expect(
      isRetryableAgyError('Error: Eligibility check failed: failed to get profile picture: Get "...": EOF')
    ).toBe(true);
    expect(
      isRetryableAgyError('agy exited with code 1', 'failed to get profile picture: Get "...": EOF')
    ).toBe(true);
    expect(isRetryableAgyError('The model API is currently overloaded')).toBe(true);
  });

  it('identifies permanent errors as non-retryable', () => {
    expect(isRetryableAgyError('invalid model selection (--model "unknown")')).toBe(false);
    expect(isRetryableAgyError('Syntax error in prompt')).toBe(false);
  });
});

describe('AgyBackend persistent single-process', () => {
  it('initializes persistent child and executes multiple turns in single process', async () => {
    const { child, stdin, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
    });

    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    // 1. startSession spawns agy with stream-json
    const startPromise = backend.startSession();
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // Initial init payload received
    stdout.emit(
      'data',
      '{"event":"init","conversation_id":"c-persistent-123","init":{"cwd":"/work"}}\n'
    );
    await expect(startPromise).resolves.toEqual({ sessionId: '/work' });
    expect(backend.getConversationId()).toBe('c-persistent-123');

    // 2. Turn 1: dispatches prompt via stdin
    const turn1 = backend.sendPrompt('/work', 'first question');
    await new Promise((r) => setTimeout(r, 10));

    expect(stdin.write).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'user',
        message: { content: 'first question' },
      }) + '\n'
    );

    stdout.emit(
      'data',
      '{"event":"step_update","step_update":{"conversation_id":"c-persistent-123","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"Hello "}}\n'
    );
    stdout.emit(
      'data',
      '{"event":"step_update","step_update":{"conversation_id":"c-persistent-123","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"world!"}}\n'
    );
    stdout.emit(
      'data',
      '{"event":"result","result":{"conversation_id":"c-persistent-123","status":"SUCCESS"}}\n'
    );

    await expect(turn1).resolves.toBeUndefined();
    expect(messages.filter((m) => m.type === 'model-output')).toEqual([
      { type: 'model-output', textDelta: 'Hello ' },
      { type: 'model-output', textDelta: 'world!' },
    ]);
    expect(messages.at(-1)).toMatchObject({ type: 'status', status: 'idle' });

    // 3. Turn 2: dispatches prompt in SAME PROCESS (no new spawn!)
    const turn2 = backend.sendPrompt('/work', 'second question');
    await new Promise((r) => setTimeout(r, 10));

    expect(spawnFn).toHaveBeenCalledTimes(1); // STILL 1!

    expect(stdin.write).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'user',
        message: { content: 'second question' },
      }) + '\n'
    );

    stdout.emit(
      'data',
      '{"event":"step_update","step_update":{"conversation_id":"c-persistent-123","step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"Turn 2 answer"}}\n'
    );
    stdout.emit(
      'data',
      '{"event":"result","result":{"conversation_id":"c-persistent-123","status":"SUCCESS"}}\n'
    );

    await expect(turn2).resolves.toBeUndefined();

    // 4. Dispose kills the persistent process
    await backend.dispose();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('automatically retries on transient startup EOF errors', async () => {
    const child1 = makeFakeChild();
    const child2 = makeFakeChild();

    let attempts = 0;
    const spawnFn = vi.fn(() => {
      attempts++;
      return attempts === 1 ? child1.child : child2.child;
    }) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
    });

    const startPromise = backend.startSession();

    // Attempt 1 fails with EOF error
    child1.stdout.emit(
      'data',
      '{"event":"result","result":{"status":"ERROR","error":"Eligibility check failed: failed to get profile picture: EOF"}}\n'
    );

    // Wait for auto-retry
    await new Promise((r) => setTimeout(r, 850));

    expect(spawnFn).toHaveBeenCalledTimes(2);

    // Attempt 2 succeeds
    child2.stdout.emit(
      'data',
      '{"event":"init","conversation_id":"c-retry-success","init":{"cwd":"/work"}}\n'
    );

    await expect(startPromise).resolves.toEqual({ sessionId: '/work' });
    expect(backend.getConversationId()).toBe('c-retry-success');
  });

  it('emits exactly one error status when a turn fails with an ERROR result', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
    });

    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    const startPromise = backend.startSession();
    stdout.emit(
      'data',
      '{"event":"init","conversation_id":"c-fail","init":{"cwd":"/work"}}\n'
    );
    await startPromise;

    const turn = backend.sendPrompt('/work', 'boom');
    await new Promise((r) => setTimeout(r, 10));

    stdout.emit(
      'data',
      '{"event":"result","result":{"conversation_id":"c-fail","status":"ERROR","error":"Model rate limit reached"}}\n'
    );

    await expect(turn).rejects.toThrow('Model rate limit reached');

    // The parser must not emit its own error status on top of the one from
    // the sendPrompt catch — the chat would show the same error twice.
    const errorStatuses = messages.filter((m) => m.type === 'status' && m.status === 'error');
    expect(errorStatuses).toEqual([
      { type: 'status', status: 'error', detail: 'Model rate limit reached' },
    ]);
  });

  it('recycles child process after an error turn so subsequent turns spawn cleanly without repeating old errors', async () => {
    const { child: child1, stdout: stdout1 } = makeFakeChild();
    const { child: child2, stdin: stdin2, stdout: stdout2 } = makeFakeChild();
    let spawnCount = 0;
    const spawnFn = vi.fn(() => {
      spawnCount++;
      return spawnCount === 1 ? child1 : child2;
    }) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
    });

    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    const startPromise = backend.startSession();
    stdout1.emit(
      'data',
      '{"event":"init","conversation_id":"c-recover-123","init":{"cwd":"/work"}}\n'
    );
    await startPromise;

    // Turn 1: Fails with a tool execution error
    const turn1 = backend.sendPrompt('/work', 'run bad tool');
    await new Promise((r) => setTimeout(r, 10));

    stdout1.emit(
      'data',
      '{"event":"result","result":{"conversation_id":"c-recover-123","status":"ERROR","error":"Error executing tool quant_get_factor_research: Either batch_id or experiment_ids must be provided."}}\n'
    );

    await expect(turn1).rejects.toThrow('quant_get_factor_research');
    expect(child1.kill).toHaveBeenCalled();

    // Turn 2: Starts with clean respawned child process preserving conversation ID
    messages.length = 0;
    const turn2 = backend.sendPrompt('/work', 'next prompt');
    await new Promise((r) => setTimeout(r, 10));

    expect(spawnFn).toHaveBeenCalledTimes(2);

    // Initial handshake for child2
    stdout2.emit(
      'data',
      '{"event":"init","conversation_id":"c-recover-123","init":{"cwd":"/work"}}\n'
    );
    await new Promise((r) => setTimeout(r, 10));

    // child2 outputs success for turn 2
    stdout2.emit(
      'data',
      '{"event":"step_update","step_update":{"conversation_id":"c-recover-123","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"all good"}}\n'
    );
    stdout2.emit(
      'data',
      '{"event":"result","result":{"conversation_id":"c-recover-123","status":"SUCCESS"}}\n'
    );

    await expect(turn2).resolves.toBeUndefined();

    // Turn 2 only has text and idle status, no old error messages repeated
    const turn2ErrorStatuses = messages.filter((m) => m.type === 'status' && m.status === 'error');
    expect(turn2ErrorStatuses).toHaveLength(0);
    expect(messages.some((m) => m.type === 'model-output' && m.textDelta === 'all good')).toBe(true);
  });

  it('emits an error status when the process exits mid-turn', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
    });

    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    const startPromise = backend.startSession();
    stdout.emit(
      'data',
      '{"event":"init","conversation_id":"c-crash","init":{"cwd":"/work"}}\n'
    );
    await startPromise;

    const turn = backend.sendPrompt('/work', 'crash please');
    await new Promise((r) => setTimeout(r, 10));

    child.emit('close', 1);

    await expect(turn).rejects.toThrow('agy process exited unexpectedly during turn');

    const errorStatuses = messages.filter((m) => m.type === 'status' && m.status === 'error');
    expect(errorStatuses).toHaveLength(1);
    expect(errorStatuses[0]).toMatchObject({ status: 'error' });
  });
});

describe('AgyBackend model switching', () => {
  it('does not restart the child when the model is unchanged', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      model: 'Gemini 3.5 Flash (Low)',
      spawnFn,
    });

    const startPromise = backend.startSession();
    stdout.emit(
      'data',
      '{"event":"init","conversation_id":"c-same-model","init":{"cwd":"/work"}}\n'
    );
    await startPromise;

    backend.setModel('Gemini 3.5 Flash (Low)');
    // Also a no-op when the slug resolves to the same display name.
    backend.setModel('gemini-3.5-flash-low');

    expect(child.kill).not.toHaveBeenCalled();
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('restarts the idle child immediately and respawns with the new model and same conversation', async () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    const spawnFn = vi
      .fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      model: 'Gemini 3.5 Flash (Low)',
      spawnFn,
    });

    const startPromise = backend.startSession();
    first.stdout.emit(
      'data',
      '{"event":"init","conversation_id":"c-switch","init":{"cwd":"/work"}}\n'
    );
    await startPromise;

    backend.setModel('Gemini 3.7 Flash (High)');

    expect(first.child.kill).toHaveBeenCalledWith('SIGTERM');

    const turn = backend.sendPrompt('/work', 'hello on the new model');
    await new Promise((r) => setTimeout(r, 10));

    expect(spawnFn).toHaveBeenCalledTimes(2);
    const respawnArgs = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1] as string[];
    expect(respawnArgs).toContain('Gemini 3.7 Flash (High)');
    expect(respawnArgs).toEqual(
      expect.arrayContaining(['--conversation', 'c-switch'])
    );

    second.stdout.emit(
      'data',
      '{"event":"init","conversation_id":"c-switch","init":{"cwd":"/work"}}\n'
    );
    await new Promise((r) => setTimeout(r, 10));
    second.stdout.emit(
      'data',
      '{"event":"result","result":{"conversation_id":"c-switch","status":"SUCCESS"}}\n'
    );
    await expect(turn).resolves.toBeUndefined();
    expect(backend.getModel()).toBe('Gemini 3.7 Flash (High)');
    expect(backend.getConversationId()).toBe('c-switch');
  });

  it('defers the restart until the in-flight turn finishes', async () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    const spawnFn = vi
      .fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      model: 'Gemini 3.5 Flash (Low)',
      spawnFn,
    });

    const startPromise = backend.startSession();
    first.stdout.emit(
      'data',
      '{"event":"init","conversation_id":"c-defer","init":{"cwd":"/work"}}\n'
    );
    await startPromise;

    const turn = backend.sendPrompt('/work', 'still running');
    await new Promise((r) => setTimeout(r, 10));

    // Model change arrives mid-turn: the running prompt must not be killed.
    backend.setModel('Gemini 3.7 Flash (High)');
    expect(first.child.kill).not.toHaveBeenCalled();

    first.stdout.emit(
      'data',
      '{"event":"result","result":{"conversation_id":"c-defer","status":"SUCCESS"}}\n'
    );
    await expect(turn).resolves.toBeUndefined();

    // Turn finished — the pending restart kicks in now.
    expect(first.child.kill).toHaveBeenCalledWith('SIGTERM');

    const turn2 = backend.sendPrompt('/work', 'next turn uses new model');
    await new Promise((r) => setTimeout(r, 10));

    expect(spawnFn).toHaveBeenCalledTimes(2);
    const respawnArgs = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1] as string[];
    expect(respawnArgs).toContain('Gemini 3.7 Flash (High)');
    expect(respawnArgs).toEqual(
      expect.arrayContaining(['--conversation', 'c-defer'])
    );

    second.stdout.emit(
      'data',
      '{"event":"init","conversation_id":"c-defer","init":{"cwd":"/work"}}\n'
    );
    await new Promise((r) => setTimeout(r, 10));
    second.stdout.emit(
      'data',
      '{"event":"result","result":{"conversation_id":"c-defer","status":"SUCCESS"}}\n'
    );
    await expect(turn2).resolves.toBeUndefined();
  });

  it('survives a late close event from the killed child arriving after the replacement spawned', async () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    const spawnFn = vi
      .fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      model: 'Gemini 3.5 Flash (Low)',
      spawnFn,
    });

    const startPromise = backend.startSession();
    first.stdout.emit(
      'data',
      '{"event":"init","conversation_id":"c-race","init":{"cwd":"/work"}}\n'
    );
    await startPromise;

    // Model change kills the old child — its close event has NOT fired yet.
    backend.setModel('Gemini 3.7 Flash (High)');
    expect(first.child.kill).toHaveBeenCalledWith('SIGTERM');

    // The next prompt spawns the replacement...
    const turn = backend.sendPrompt('/work', 'hello on the new model');
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnFn).toHaveBeenCalledTimes(2);

    // ...and only NOW does the old child's close event arrive. It must not
    // clear `this.child` (which points at the replacement) or fail the turn.
    first.child.emit('close', 1);

    second.stdout.emit(
      'data',
      '{"event":"init","conversation_id":"c-race","init":{"cwd":"/work"}}\n'
    );
    await new Promise((r) => setTimeout(r, 10));

    // The prompt must have been written to the REPLACEMENT's stdin — before the
    // fix, the late close nulled `this.child` and the write was silently dropped,
    // leaving the turn pending forever ("处理中").
    expect(second.stdin.write).toHaveBeenCalledWith(
      JSON.stringify({ event: 'user', message: { content: 'hello on the new model' } }) + '\n'
    );

    second.stdout.emit(
      'data',
      '{"event":"result","result":{"conversation_id":"c-race","status":"SUCCESS"}}\n'
    );
    await expect(turn).resolves.toBeUndefined();
  });

  it('cancel still rejects the in-flight turn when the killed process closes', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
    });

    const startPromise = backend.startSession();
    stdout.emit(
      'data',
      '{"event":"init","conversation_id":"c-cancel","init":{"cwd":"/work"}}\n'
    );
    await startPromise;

    const turn = backend.sendPrompt('/work', 'abort me');
    await new Promise((r) => setTimeout(r, 10));

    // cancel() kills and nulls the reference BEFORE the close event arrives.
    await backend.cancel();
    child.emit('close', null);

    await expect(turn).rejects.toThrow('agy process exited unexpectedly during turn');
  });

  it('reset clears conversation ID, terminates child, and respawns without --conversation on next turn', async () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    const spawnFn = vi
      .fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
    });

    const startPromise = backend.startSession();
    first.stdout.emit(
      'data',
      '{"event":"init","conversation_id":"c-old-session","init":{"cwd":"/work"}}\n'
    );
    await startPromise;
    expect(backend.getConversationId()).toBe('c-old-session');

    // Call reset
    backend.reset();
    expect(backend.getConversationId()).toBeNull();
    expect(first.child.kill).toHaveBeenCalledWith('SIGTERM');

    // Next turn spawns a new process without --conversation
    const turn = backend.sendPrompt('/work', 'brand new prompt');
    await new Promise((r) => setTimeout(r, 10));

    expect(spawnFn).toHaveBeenCalledTimes(2);
    const spawnArgs = vi.mocked(spawnFn).mock.calls[1][1] as string[];
    expect(spawnArgs).not.toContain('--conversation');

    second.stdout.emit(
      'data',
      '{"event":"init","conversation_id":"c-fresh-session","init":{"cwd":"/work"}}\n'
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(backend.getConversationId()).toBe('c-fresh-session');

    second.stdout.emit(
      'data',
      '{"event":"result","result":{"conversation_id":"c-fresh-session","status":"SUCCESS"}}\n'
    );
    await expect(turn).resolves.toBeUndefined();
  });
});
