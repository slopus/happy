import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@/agent/core';
import { DefaultTransport } from '@/agent/transport';
import { handleToolCall, handleToolCallUpdate, type HandlerContext } from './sessionUpdateHandlers';
import { AcpSessionManager } from './AcpSessionManager';

afterEach(() => vi.useRealTimers());

function context() {
  vi.useFakeTimers();
  const messages: AgentMessage[] = [];
  const ctx: HandlerContext = {
    transport: new DefaultTransport('antigravity'), activeToolCalls: new Set(),
    toolCallStartTimes: new Map(), toolCallTimeouts: new Map(), toolCallIdToNameMap: new Map(),
    toolCallStates: new Map(),
    idleTimeout: null, toolCallCountSincePrompt: 0,
    emit: message => messages.push(message), emitIdleStatus: () => {},
    clearIdleTimeout: () => {}, setIdleTimeout: () => {},
  };
  return { ctx, messages };
}

describe('standard ACP tool input', () => {
  it.each(['agent_roles', 'delegate_task'])('preserves the native AGY title for %s while retaining its other kind', name => {
    const { ctx, messages } = context();
    handleToolCall({ sessionUpdate: 'tool_call', toolCallId: `native-${name}`, kind: 'other',
      title: `Run mcp_happy_${name}`, rawInput: { toolSummary: 'Synthetic human summary' },
    }, ctx);
    expect(messages.find(message => message.type === 'tool-call')).toEqual({ type: 'tool-call', toolName: 'other',
      title: `Run mcp_happy_${name}`, args: { toolSummary: 'Synthetic human summary' }, callId: `native-${name}` });
  });

  it('retains agy rawInput and locations needed to identify an actual Skill document read', () => {
    const { ctx, messages } = context();
    handleToolCall({ sessionUpdate: 'tool_call', toolCallId: 'read-1', kind: 'read', status: 'in_progress',
      title: 'File SKILL.md', rawInput: { Path: '/skills/ego-browser/SKILL.md' },
      locations: [{ path: '/skills/ego-browser/SKILL.md' }],
    }, ctx);
    expect(messages.find(message => message.type === 'tool-call')).toMatchObject({
      toolName: 'read', args: { Path: '/skills/ego-browser/SKILL.md', locations: [{ path: '/skills/ego-browser/SKILL.md' }] },
    });
  });

  it('uses rawInput instead of output content and accepts update-only tool starts', () => {
    const { ctx, messages } = context();
    handleToolCallUpdate({ toolCallId: 'exec-1', kind: 'execute', status: 'in_progress',
      rawInput: { CommandLine: "cat '/skills/ego-ops/SKILL.md'" }, content: [{ text: 'partial output' }],
    }, ctx);
    expect(messages.find(message => message.type === 'tool-call')).toMatchObject({
      toolName: 'execute', args: { CommandLine: "cat '/skills/ego-ops/SKILL.md'" },
    });
  });

  it('does not mutate provider inputs when attaching locations', () => {
    const { ctx, messages } = context();
    const rawInput = Object.freeze({ Path: '/repo/README.md' });
    handleToolCall({ toolCallId: 'read-2', kind: 'read', rawInput, locations: [{ path: '/repo/README.md' }] }, ctx);
    expect(rawInput).toEqual({ Path: '/repo/README.md' });
    expect(messages.find(message => message.type === 'tool-call')).toMatchObject({ args: { Path: '/repo/README.md' } });
  });
});


describe('ACP changed-field result retention', () => {
  const text = `${'original tool output '.repeat(6000)}LATE_RANDOM_EVIDENCE`;
  const content = [{ type: 'content', content: { type: 'text', text } },
    { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'AQID' } }];
  const start = (ctx: HandlerContext, id = 'first') => handleToolCall({ toolCallId: id, kind: 'other',
    title: 'Run mcp_happy_thread_read', rawInput: { itemId: 'source/1/0', textOffset: 52000, limit: 4000 } }, ctx);
  const ends = (messages: AgentMessage[]) => {
    const mapper = new AcpSessionManager(); mapper.startTurn();
    return messages.flatMap(message => mapper.mapMessage(message)).filter(envelope => envelope.ev.t === 'tool-call-end');
  };

  it.each([undefined, 'in_progress'] as const)('retains original content before status-only completion (intermediate %s)', status => {
    const { ctx, messages } = context(); start(ctx);
    handleToolCallUpdate({ toolCallId: 'first', ...(status ? { status } : {}), content }, ctx);
    handleToolCallUpdate({ toolCallId: 'first', status: 'completed' }, ctx);
    expect(ends(messages)[0].ev).toMatchObject({ t: 'tool-call-end', status: 'completed', output: content });
    expect(JSON.stringify(ends(messages)[0].ev)).toContain('LATE_RANDOM_EVIDENCE');
  });

  it.each([[], null] as const)('honors explicit content replacement %j', replacement => {
    const { ctx, messages } = context(); start(ctx);
    handleToolCallUpdate({ toolCallId: 'first', content }, ctx);
    handleToolCallUpdate({ toolCallId: 'first', content: replacement }, ctx);
    handleToolCallUpdate({ toolCallId: 'first', status: 'completed' }, ctx);
    expect(ends(messages)[0].ev).toMatchObject({ t: 'tool-call-end', status: 'completed', output: replacement });
  });

  it.each([null, '', []] as const)('preserves explicit rawOutput replacement %j', replacement => {
    const { ctx, messages } = context(); start(ctx);
    handleToolCallUpdate({ toolCallId: 'first', rawOutput: { original: text } }, ctx);
    handleToolCallUpdate({ toolCallId: 'first', rawOutput: replacement }, ctx);
    handleToolCallUpdate({ toolCallId: 'first', status: 'completed' }, ctx);
    expect(ends(messages)[0].ev).toMatchObject({ t: 'tool-call-end', status: 'completed', output: replacement });
  });

  it('preserves raw output and separate tool content without concatenating original bytes', () => {
    const { ctx, messages } = context(); start(ctx);
    handleToolCallUpdate({ toolCallId: 'first', content }, ctx);
    handleToolCallUpdate({ toolCallId: 'first', rawOutput: { original: text } }, ctx);
    handleToolCallUpdate({ toolCallId: 'first', status: 'completed' }, ctx);
    expect(ends(messages)[0].ev).toMatchObject({ t: 'tool-call-end', status: 'completed', output: { rawOutput: { original: text }, content } });
  });

  it.each(['completed', 'failed', 'cancelled'] as const)('preserves original body and explicit %s exactly once', status => {
    const { ctx, messages } = context(); start(ctx);
    handleToolCallUpdate({ toolCallId: 'first', content }, ctx);
    handleToolCallUpdate({ toolCallId: 'first', status }, ctx);
    handleToolCallUpdate({ toolCallId: 'first', status, content: [{ text: 'duplicate must not replace original' }] }, ctx);
    expect(ends(messages)).toHaveLength(1);
    expect(ends(messages)[0].ev).toMatchObject({ t: 'tool-call-end', status, output: content });
  });

  it('keeps each call body separate and does not invent an absent result', () => {
    const { ctx, messages } = context(); start(ctx); start(ctx, 'second');
    handleToolCallUpdate({ toolCallId: 'first', content }, ctx);
    handleToolCallUpdate({ toolCallId: 'second', status: 'completed' }, ctx);
    handleToolCallUpdate({ toolCallId: 'first', status: 'completed' }, ctx);
    const result = ends(messages);
    expect(result).toHaveLength(2);
    expect(Object.hasOwn(result[0].ev, 'output')).toBe(false);
    expect(result[1].ev).toMatchObject({ output: content });
    if (result[0].ev.t !== 'tool-call-end' || result[1].ev.t !== 'tool-call-end') throw new Error('Expected tool ends');
    expect(result[0].ev.call).not.toBe(result[1].ev.call);
    expect(result[0].turn).toBe(result[1].turn);
  });
});
