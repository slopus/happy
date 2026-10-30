import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '../core';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  completeToolCall,
  failToolCall,
  handleAgentMessageChunk,
  scheduleDeferredIdle,
  startToolCall,
  type HandlerContext,
  type SessionUpdate,
} from './sessionUpdateHandlers';

function makeCtx() {
  const messages: AgentMessage[] = [];
  let idleTimeoutHandle: NodeJS.Timeout | null = null;

  const ctx: HandlerContext = {
    transport: {
      getIdleTimeout: () => DEFAULT_IDLE_TIMEOUT_MS,
    } as HandlerContext['transport'],
    activeToolCalls: new Set<string>(),
    toolCallStartTimes: new Map<string, number>(),
    toolCallTimeouts: new Map<string, NodeJS.Timeout>(),
    toolCallIdToNameMap: new Map<string, string>(),
    idleTimeout: null,
    toolCallCountSincePrompt: 0,
    emit: (msg) => {
      messages.push(msg);
    },
    // In production this signals the backend that the update stream has
    // settled; the backend then waits for the RPC response before actually
    // emitting `idle`. For these handler-level tests we model that as a
    // direct `idle` push so the assertions in this file continue to verify
    // the 500ms deferral timing exposed by sessionUpdateHandlers itself.
    markUpdatesSettled: () => {
      messages.push({ type: 'status', status: 'idle' });
    },
    clearIdleTimeout: () => {
      if (idleTimeoutHandle) {
        clearTimeout(idleTimeoutHandle);
        idleTimeoutHandle = null;
      }
    },
    setIdleTimeout: (callback, ms) => {
      idleTimeoutHandle = setTimeout(() => {
        callback();
        idleTimeoutHandle = null;
      }, ms);
    },
  };

  return {
    ctx,
    messages,
    idleStatusCount: () => messages.filter((m) => m.type === 'status' && (m as { status: string }).status === 'idle').length,
  };
}

describe('Spinner-stuck fix: deferred idle after tool completion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT emit idle synchronously when the last tool completes', () => {
    const { ctx, idleStatusCount } = makeCtx();
    ctx.activeToolCalls.add('t1');
    ctx.toolCallStartTimes.set('t1', Date.now());

    completeToolCall('t1', 'read_file', [], ctx);

    // Tool was the only active one, but idle must wait for the deferral window.
    expect(idleStatusCount()).toBe(0);
  });

  it('emits idle after the standard idle window elapses', () => {
    const { ctx, idleStatusCount } = makeCtx();
    ctx.activeToolCalls.add('t1');
    ctx.toolCallStartTimes.set('t1', Date.now());

    completeToolCall('t1', 'read_file', [], ctx);
    expect(idleStatusCount()).toBe(0);

    vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS);

    expect(idleStatusCount()).toBe(1);
  });

  it('regression: a follow-up text chunk arriving before the window expires re-arms the timer (no flicker)', () => {
    const { ctx, idleStatusCount } = makeCtx();
    ctx.activeToolCalls.add('t1');
    ctx.toolCallStartTimes.set('t1', Date.now());

    // Tool completes — schedules deferred idle.
    completeToolCall('t1', 'read_file', [], ctx);

    // Halfway through the window the agent streams a follow-up text chunk.
    vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS / 2);
    const chunk: SessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: { text: 'tool used: result is 42' },
    };
    handleAgentMessageChunk(chunk, ctx);

    // The chunk handler should have re-armed the idle timer; idle must NOT
    // have fired at the old tool-complete deadline.
    vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS / 2);
    expect(idleStatusCount()).toBe(0);

    // After the new full window elapses, idle finally fires — exactly once.
    vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS);
    expect(idleStatusCount()).toBe(1);
  });

  it('a new tool starting before the window expires cancels the deferred idle', () => {
    const { ctx, idleStatusCount } = makeCtx();
    ctx.activeToolCalls.add('t1');
    ctx.toolCallStartTimes.set('t1', Date.now());

    completeToolCall('t1', 'read_file', [], ctx);

    // Before the window elapses, a second tool kicks off.
    vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS / 2);
    startToolCall(
      't2',
      'write_file',
      { sessionUpdate: 'tool_call', toolCallId: 't2' } as SessionUpdate,
      ctx,
      'tool_call',
    );

    // Even if we ride through the originally-scheduled idle moment, no idle
    // should be emitted while a tool is active.
    vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS);
    expect(idleStatusCount()).toBe(0);
  });

  it('failToolCall also defers idle (mirrors completeToolCall)', () => {
    const { ctx, idleStatusCount } = makeCtx();
    ctx.activeToolCalls.add('t1');
    ctx.toolCallStartTimes.set('t1', Date.now());

    failToolCall('t1', 'failed', 'read_file', { error: 'nope' }, ctx);

    expect(idleStatusCount()).toBe(0);

    vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS);
    expect(idleStatusCount()).toBe(1);
  });

  it('scheduleDeferredIdle skips the emit if a tool became active during the wait', () => {
    const { ctx, idleStatusCount } = makeCtx();

    scheduleDeferredIdle(ctx, 'unit test idle');

    // Simulate a tool starting in-between.
    ctx.activeToolCalls.add('t-late');

    vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS);

    // Active tool count > 0 at fire time → no idle should be emitted.
    expect(idleStatusCount()).toBe(0);
  });

  it('multiple tool completions inside the deferral window collapse into a single idle emission', () => {
    const { ctx, idleStatusCount } = makeCtx();
    ctx.activeToolCalls.add('t1');
    ctx.activeToolCalls.add('t2');
    ctx.toolCallStartTimes.set('t1', Date.now());
    ctx.toolCallStartTimes.set('t2', Date.now());

    completeToolCall('t1', 'read_file', [], ctx);
    // First completion still has an active tool — must NOT schedule anything
    // visible by waiting through the window:
    vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS);
    expect(idleStatusCount()).toBe(0);

    completeToolCall('t2', 'read_file', [], ctx);
    vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS);
    expect(idleStatusCount()).toBe(1);
  });
});
