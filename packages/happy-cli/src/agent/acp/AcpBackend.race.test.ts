import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '@/agent/core';
import { DEFAULT_IDLE_TIMEOUT_MS } from './sessionUpdateHandlers';
import { AcpBackend } from './AcpBackend';

interface DeferredPromise<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function defer<T>(): DeferredPromise<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createBackend(): AcpBackend {
  return new AcpBackend({
    agentName: 'test',
    cwd: '/tmp',
    command: '/bin/true',
  });
}

function stubBackend(backend: AcpBackend, responseControl: DeferredPromise<unknown>) {
  const messages: AgentMessage[] = [];
  backend.onMessage((msg) => messages.push(msg));

  // Pretend a session is already open.
  (backend as unknown as { acpSessionId: string }).acpSessionId = 'test-session';
  (backend as unknown as { connection: { prompt: (...args: unknown[]) => Promise<unknown>; cancel: () => Promise<void> } }).connection = {
    prompt: vi.fn(() => responseControl.promise),
    cancel: vi.fn(async () => {}),
  };

  return {
    messages,
    idleCount: () => messages.filter((m) => m.type === 'status' && (m as { status: string }).status === 'idle').length,
  };
}

function dispatchUpdate(backend: AcpBackend, update: Record<string, unknown>): void {
  (backend as unknown as { handleSessionUpdate(params: unknown): void }).handleSessionUpdate({
    sessionId: 'test-session',
    update,
  });
}

describe('AcpBackend turn-completion race conditions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('normal order: updates first, response last — emits idle exactly once after the idle window', async () => {
    const backend = createBackend();
    const response = defer<unknown>();
    const { idleCount } = stubBackend(backend, response);

    const sendPromise = backend.sendPrompt('test-session', 'hello');
    // Let `sendPrompt` reach `await this.connection.prompt(...)`.
    await Promise.resolve();

    // Updates first.
    dispatchUpdate(backend, { sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } });
    dispatchUpdate(backend, { sessionUpdate: 'agent_message_chunk', content: { text: ' there' } });

    // Without the response, even a long silence must not produce `idle`.
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIMEOUT_MS * 2);
    expect(idleCount()).toBe(0);

    // Response arrives last (spec-typical ordering).
    response.resolve({ stopReason: 'end_turn' });
    await sendPromise;
    // The .then() callback runs as a microtask, then maybeCompleteTurn sees
    // updatesSettled=true (set by the chunk idle timer that already fired
    // during the silence advance above) and emits idle synchronously.
    expect(idleCount()).toBe(1);
  });

  it('race: response arrives BEFORE the final update — defers idle for the grace window, then emits once', async () => {
    const backend = createBackend();
    const response = defer<unknown>();
    const { idleCount } = stubBackend(backend, response);

    const sendPromise = backend.sendPrompt('test-session', 'hello');
    await Promise.resolve();

    // Agent flushes the response immediately, before any chunk.
    response.resolve({ stopReason: 'end_turn' });
    await sendPromise;

    // Response is in, updates haven't settled — grace timer should be armed.
    expect(idleCount()).toBe(0);

    // A late chunk arrives within the grace window.
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIMEOUT_MS / 2);
    dispatchUpdate(backend, { sessionUpdate: 'agent_message_chunk', content: { text: 'late chunk' } });

    // Chunk handler should have re-armed the chunk-idle timer; the grace
    // path's eventual fire must not double-emit.
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIMEOUT_MS * 3);
    expect(idleCount()).toBe(1);
  });

  it('late update after a settled window resets the update gate before response completes', async () => {
    const backend = createBackend();
    const response = defer<unknown>();
    const { idleCount } = stubBackend(backend, response);

    const sendPromise = backend.sendPrompt('test-session', 'hello');
    await Promise.resolve();

    dispatchUpdate(backend, { sessionUpdate: 'agent_message_chunk', content: { text: 'first' } });
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIMEOUT_MS);
    expect(idleCount()).toBe(0);

    dispatchUpdate(backend, { sessionUpdate: 'agent_message_chunk', content: { text: 'late' } });
    response.resolve({ stopReason: 'end_turn' });
    await sendPromise;

    expect(idleCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIMEOUT_MS);
    expect(idleCount()).toBe(1);
  });

  it('race: empty turn — response arrives, NO updates ever — grace timer still settles the turn', async () => {
    const backend = createBackend();
    const response = defer<unknown>();
    const { idleCount } = stubBackend(backend, response);

    const sendPromise = backend.sendPrompt('test-session', 'hello');
    await Promise.resolve();

    response.resolve({ stopReason: 'end_turn' });
    await sendPromise;

    // Right after response: idle must NOT fire (grace timer protects against
    // the chunk-first ordering above).
    expect(idleCount()).toBe(0);

    // After POST_RESPONSE_GRACE_MS the grace timer fires and we accept "no
    // updates ever arrived" as the update stream settling.
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIMEOUT_MS);
    expect(idleCount()).toBe(1);
  });

  it('race: tool_call_update completes BEFORE response — turn does not finish until response arrives', async () => {
    const backend = createBackend();
    const response = defer<unknown>();
    const { idleCount } = stubBackend(backend, response);

    const sendPromise = backend.sendPrompt('test-session', 'use a tool');
    await Promise.resolve();

    // Tool starts then immediately completes — all before the RPC response.
    dispatchUpdate(backend, {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      status: 'pending',
      kind: 'read_file',
    });
    dispatchUpdate(backend, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      kind: 'read_file',
      content: [],
    });

    // The deferred-idle timer (introduced by the spinner-stuck fix) fires
    // after 500 ms and marks updates settled. Without a response, no idle.
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIMEOUT_MS * 4);
    expect(idleCount()).toBe(0);

    // Response finally arrives.
    response.resolve({ stopReason: 'end_turn' });
    await sendPromise;
    expect(idleCount()).toBe(1);
  });

  it('error path: response Promise rejects — no idle emitted, sendPrompt throws', async () => {
    const backend = createBackend();
    const response = defer<unknown>();
    const { idleCount, messages } = stubBackend(backend, response);

    const sendPromise = backend.sendPrompt('test-session', 'hello');
    await Promise.resolve();

    response.reject(new Error('boom'));

    await expect(sendPromise).rejects.toThrow(/boom/);

    // Even if a stale update sneaks in afterwards, we should not emit idle
    // for a turn whose RPC errored out.
    dispatchUpdate(backend, { sessionUpdate: 'agent_message_chunk', content: { text: 'stale' } });
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIMEOUT_MS * 4);
    expect(idleCount()).toBe(0);

    // The error path emits an `error` status instead.
    expect(messages.some((m) => m.type === 'status' && (m as { status: string }).status === 'error')).toBe(true);
  });

  it('a fresh prompt while a previous one is still racing replaces the turnId — stale .then is ignored', async () => {
    const backend = createBackend();
    const response1 = defer<unknown>();
    const { idleCount } = stubBackend(backend, response1);

    // First prompt — won't be awaited from this test (kept "in flight").
    const send1 = backend.sendPrompt('test-session', 'first');
    await Promise.resolve();

    // Before the first response comes back, the caller bumps a new prompt.
    // Swap the deferred for the second response.
    const response2 = defer<unknown>();
    const conn = (backend as unknown as { connection: { prompt: ReturnType<typeof vi.fn> } }).connection;
    conn.prompt.mockImplementation(() => response2.promise);

    const send2 = backend.sendPrompt('test-session', 'second');
    await Promise.resolve();

    // Late resolution of the first response — must NOT mark the *current*
    // turn as response-received.
    response1.resolve({ stopReason: 'end_turn' });
    // Bring stray microtasks forward.
    await vi.advanceTimersByTimeAsync(0);

    // No idle yet — the current (second) turn still has no response.
    expect(idleCount()).toBe(0);

    // Now the second response actually arrives.
    response2.resolve({ stopReason: 'end_turn' });
    await send2;
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIMEOUT_MS);
    expect(idleCount()).toBe(1);

    await send1; // tidy up: the first promise resolved with response1 above.
  });
});
