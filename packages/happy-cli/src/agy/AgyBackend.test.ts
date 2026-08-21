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
});
