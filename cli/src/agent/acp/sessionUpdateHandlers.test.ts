import { describe, expect, it, vi } from 'vitest';

import type { HandlerContext, SessionUpdate } from './sessionUpdateHandlers';
import { handleToolCall, handleToolCallUpdate } from './sessionUpdateHandlers';
import { defaultTransport } from '../transport/DefaultTransport';
import { GeminiTransport } from '@/backends/gemini/acp/transport';

function createCtx(opts?: { transport?: HandlerContext['transport'] }): HandlerContext & { emitted: any[] } {
  const emitted: any[] = [];
  return {
    transport: opts?.transport ?? defaultTransport,
    activeToolCalls: new Set(),
    toolCallStartTimes: new Map(),
    toolCallTimeouts: new Map(),
    toolCallIdToNameMap: new Map(),
    toolCallIdToInputMap: new Map(),
    idleTimeout: null,
    toolCallCountSincePrompt: 0,
    emit: (msg) => emitted.push(msg),
    emitIdleStatus: () => emitted.push({ type: 'status', status: 'idle' }),
    clearIdleTimeout: () => {},
    setIdleTimeout: () => {},
    emitted,
  };
}

describe('sessionUpdateHandlers tool call tracking', () => {
  it('does not treat update.title as the tool name', () => {
    const ctx = createCtx();

    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_test_1',
      status: 'in_progress',
      kind: 'execute',
      title: 'Run echo hello',
      content: { command: ['/bin/zsh', '-lc', 'echo hello'] },
    };

    handleToolCall(update, ctx);

    const toolCall = ctx.emitted.find((m) => m.type === 'tool-call');
    expect(toolCall).toBeTruthy();
    expect(toolCall.toolName).toBe('execute');
    expect(toolCall.args?._acp?.title).toBe('Run echo hello');
  });

  it('does not start an execution timeout while status is pending, but arms timeout when in_progress arrives', () => {
    vi.useFakeTimers();
    const ctx = createCtx();

    const pendingUpdate: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_test_pending',
      status: 'pending',
      kind: 'read',
      title: 'Read /etc/hosts',
      content: { filePath: '/etc/hosts' },
    };

    handleToolCall(pendingUpdate, ctx);
    expect(ctx.activeToolCalls.has('call_test_pending')).toBe(true);
    expect(ctx.toolCallTimeouts.has('call_test_pending')).toBe(false);

    const inProgressUpdate: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_test_pending',
      status: 'in_progress',
      kind: 'read',
      title: 'Read /etc/hosts',
      content: { filePath: '/etc/hosts' },
      meta: {},
    };

    handleToolCallUpdate(inProgressUpdate, ctx);
    expect(ctx.toolCallTimeouts.has('call_test_pending')).toBe(true);

    vi.useRealTimers();
  });

  it('infers tool kind/name for terminal tool_call_update events when kind/start are missing (Gemini)', () => {
    vi.useFakeTimers();
    const ctx = createCtx({ transport: new GeminiTransport() });

    const failedUpdate: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'read_file-1',
      status: 'failed',
      title: 'Read /etc/hosts',
      locations: [{ path: '/etc/hosts' }],
      content: { filePath: '/etc/hosts' },
      meta: {},
    };

    handleToolCallUpdate(failedUpdate, ctx);

    const toolCall = ctx.emitted.find((m) => m.type === 'tool-call' && m.callId === 'read_file-1');
    expect(toolCall).toBeTruthy();
    expect(toolCall.toolName).toBe('read');

    const toolResult = ctx.emitted.find((m) => m.type === 'tool-result' && m.callId === 'read_file-1');
    expect(toolResult).toBeTruthy();
    expect(toolResult.toolName).toBe('read');
    expect(toolResult.result?._acp?.kind).toBe('read');

    expect(ctx.toolCallTimeouts.size).toBe(0);
    vi.useRealTimers();
  });

  it('extracts tool output from update.result when output/rawOutput/content are absent', () => {
    const ctx = createCtx();

    const completedUpdate: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'read_file-1',
      status: 'completed',
      kind: 'read',
      title: 'Read /tmp/a.txt',
      // Gemini-style: result may be carried in a non-standard field.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...( { result: { content: 'hello' } } as any ),
    };

    handleToolCallUpdate(completedUpdate, ctx);

    const toolResult = ctx.emitted.find((m) => m.type === 'tool-result' && m.callId === 'read_file-1');
    expect(toolResult).toBeTruthy();
    expect(toolResult.result).toMatchObject({ content: 'hello' });
  });
});
