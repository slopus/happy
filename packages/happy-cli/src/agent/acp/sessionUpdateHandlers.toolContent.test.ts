import { describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '../core';
import {
  emitToolContentItems,
  formatToolCallDiff,
  parseToolArgs,
  type HandlerContext,
  type SessionUpdate,
} from './sessionUpdateHandlers';

function makeCtx(): { ctx: HandlerContext; messages: AgentMessage[] } {
  const messages: AgentMessage[] = [];
  const ctx: HandlerContext = {
    transport: {} as HandlerContext['transport'],
    activeToolCalls: new Set<string>(),
    toolCallStartTimes: new Map<string, number>(),
    toolCallTimeouts: new Map<string, NodeJS.Timeout>(),
    toolCallIdToNameMap: new Map<string, string>(),
    idleTimeout: null,
    toolCallCountSincePrompt: 0,
    emit: (msg) => {
      messages.push(msg);
    },
    emitIdleStatus: vi.fn(),
    clearIdleTimeout: vi.fn(),
    setIdleTimeout: vi.fn(),
  };
  return { ctx, messages };
}

describe('parseToolArgs', () => {
  it('uses rawInput when present (object form)', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      rawInput: { path: '/tmp/foo', limit: 5 },
    } as SessionUpdate;

    expect(parseToolArgs(update)).toEqual({ path: '/tmp/foo', limit: 5 });
  });

  it('wraps a non-object rawInput in { value }', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      rawInput: 'just a string',
    } as SessionUpdate;

    expect(parseToolArgs(update)).toEqual({ value: 'just a string' });
  });

  it('falls back to content when rawInput is absent (legacy agents)', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      content: { path: '/legacy', mode: 'read' },
    };

    expect(parseToolArgs(update)).toEqual({ path: '/legacy', mode: 'read' });
  });

  it('wraps a content array into { items } via the legacy fallback', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      content: [{ type: 'content', content: { type: 'text', text: 'hi' } }],
    };

    const args = parseToolArgs(update);
    expect(Array.isArray((args as { items?: unknown }).items)).toBe(true);
  });

  it('returns empty object when neither rawInput nor content is usable', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
    };

    expect(parseToolArgs(update)).toEqual({});
  });

  it('prefers rawInput even when content is also present', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      rawInput: { from: 'rawInput' },
      content: { from: 'content' },
    } as SessionUpdate;

    expect(parseToolArgs(update)).toEqual({ from: 'rawInput' });
  });
});

describe('formatToolCallDiff', () => {
  it('renders an empty header when both texts are empty', () => {
    expect(formatToolCallDiff('/a/b.txt', '', '')).toBe('--- /a/b.txt\n+++ /a/b.txt\n');
  });

  it('prefixes old and new lines with - / + and includes the file header', () => {
    const out = formatToolCallDiff('/x.txt', 'foo\nbar', 'foo\nBAZ');
    expect(out).toContain('--- /x.txt');
    expect(out).toContain('+++ /x.txt');
    expect(out).toContain('-foo');
    expect(out).toContain('-bar');
    expect(out).toContain('+foo');
    expect(out).toContain('+BAZ');
  });

  it('omits the header when path is empty', () => {
    const out = formatToolCallDiff('', 'old', 'new');
    expect(out.startsWith('---')).toBe(false);
    expect(out).toContain('-old');
    expect(out).toContain('+new');
  });
});

describe('emitToolContentItems', () => {
  it('emits an fs-edit for each diff entry', () => {
    const { ctx, messages } = makeCtx();

    emitToolContentItems(
      'call-1',
      'edit_file',
      [
        { type: 'diff', path: '/src/a.ts', oldText: 'old', newText: 'new' },
        { type: 'diff', path: '/src/b.ts', oldText: '', newText: 'created' },
      ],
      ctx,
    );

    const edits = messages.filter((m) => m.type === 'fs-edit');
    expect(edits).toHaveLength(2);
    expect(edits[0]).toMatchObject({
      type: 'fs-edit',
      description: 'Edit /src/a.ts',
      path: '/src/a.ts',
    });
    expect(typeof (edits[0] as { diff?: string }).diff).toBe('string');
    expect(edits[1]).toMatchObject({
      type: 'fs-edit',
      description: 'Edit /src/b.ts',
      path: '/src/b.ts',
    });
  });

  it('emits a tool_terminal_ref event for each terminal entry', () => {
    const { ctx, messages } = makeCtx();

    emitToolContentItems(
      'call-2',
      'run_command',
      [{ type: 'terminal', terminalId: 'term-42' }],
      ctx,
    );

    expect(messages).toEqual([
      {
        type: 'event',
        name: 'tool_terminal_ref',
        payload: { toolCallId: 'call-2', toolName: 'run_command', terminalId: 'term-42' },
      },
    ]);
  });

  it('does not emit anything extra for plain content blocks', () => {
    const { ctx, messages } = makeCtx();

    emitToolContentItems(
      'call-3',
      'read_file',
      [
        { type: 'content', content: { type: 'text', text: 'hello' } },
        { type: 'content', content: { type: 'image', data: '...' } },
      ],
      ctx,
    );

    expect(messages).toEqual([]);
  });

  it('mixes diff / terminal / content correctly within one tool result', () => {
    const { ctx, messages } = makeCtx();

    emitToolContentItems(
      'call-4',
      'multi_tool',
      [
        { type: 'content', content: { type: 'text', text: 'log line' } },
        { type: 'diff', path: '/x.ts', oldText: 'a', newText: 'b' },
        { type: 'terminal', terminalId: 'term-1' },
      ],
      ctx,
    );

    const types = messages.map((m) => m.type);
    expect(types).toEqual(['fs-edit', 'event']);
  });

  it('is a no-op when content is not an array (no throw)', () => {
    const { ctx, messages } = makeCtx();

    emitToolContentItems('call-5', 'tool', undefined, ctx);
    emitToolContentItems('call-5', 'tool', 'string instead of array', ctx);
    emitToolContentItems('call-5', 'tool', { type: 'diff' }, ctx);

    expect(messages).toEqual([]);
  });

  it('skips diff entries with no string path/newText/oldText gracefully', () => {
    const { ctx, messages } = makeCtx();

    emitToolContentItems(
      'call-6',
      'edit_file',
      [{ type: 'diff', path: 42, oldText: null, newText: undefined }],
      ctx,
    );

    expect(messages).toHaveLength(1);
    const edit = messages[0] as { type: 'fs-edit'; description: string; diff?: string; path?: string };
    expect(edit.type).toBe('fs-edit');
    expect(edit.path).toBeUndefined();
    expect(edit.description).toBe('File edit');
  });
});
