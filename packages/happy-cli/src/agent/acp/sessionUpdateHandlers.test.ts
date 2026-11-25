import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@/agent/core';
import { DefaultTransport } from '@/agent/transport';
import { handleToolCall, handleToolCallUpdate, type HandlerContext } from './sessionUpdateHandlers';

afterEach(() => vi.useRealTimers());

function context() {
  vi.useFakeTimers();
  const messages: AgentMessage[] = [];
  const ctx: HandlerContext = {
    transport: new DefaultTransport('antigravity'), activeToolCalls: new Set(),
    toolCallStartTimes: new Map(), toolCallTimeouts: new Map(), toolCallIdToNameMap: new Map(),
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
