import { describe, expect, it } from 'vitest';
import { isCuid } from '@paralleldrive/cuid2';
import type { AgentMessage } from '@/agent/core';
import { AcpSessionManager } from './AcpSessionManager';

function mapMany(mapper: AcpSessionManager, messages: AgentMessage[]) {
  return messages.flatMap((message) => mapper.mapMessage(message));
}

describe('AcpSessionManager turn lifecycle', () => {
  it('emits turn-start from startTurn()', () => {
    const mapper = new AcpSessionManager();
    const envelopes = mapper.startTurn();

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].ev.t).toBe('turn-start');
    expect(typeof envelopes[0].turn).toBe('string');
    expect(isCuid(envelopes[0].turn!)).toBe(true);
  });

  it('emits completed turn-end from endTurn()', () => {
    const mapper = new AcpSessionManager();
    const started = mapper.startTurn();
    const ended = mapper.endTurn('completed');

    expect(started).toHaveLength(1);
    expect(ended).toHaveLength(1);
    expect(ended[0].ev).toEqual({ t: 'turn-end', status: 'completed' });
    expect(ended[0].turn).toBe(started[0].turn);
  });

  it('emits failed turn-end from endTurn()', () => {
    const mapper = new AcpSessionManager();
    const started = mapper.startTurn();
    const ended = mapper.endTurn('failed');

    expect(ended).toHaveLength(1);
    expect(ended[0].ev).toEqual({ t: 'turn-end', status: 'failed' });
    expect(ended[0].turn).toBe(started[0].turn);
  });

  it('emits cancelled turn-end from endTurn()', () => {
    const mapper = new AcpSessionManager();
    const started = mapper.startTurn();
    const ended = mapper.endTurn('cancelled');

    expect(ended).toHaveLength(1);
    expect(ended[0].ev).toEqual({ t: 'turn-end', status: 'cancelled' });
    expect(ended[0].turn).toBe(started[0].turn);
  });

  it('is idempotent for repeated startTurn()', () => {
    const mapper = new AcpSessionManager();
    const first = mapper.startTurn();
    const second = mapper.startTurn();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('does not emit turn-end without active turn', () => {
    const mapper = new AcpSessionManager();
    const envelopes = mapper.endTurn('completed');
    expect(envelopes).toHaveLength(0);
  });

  it('is idempotent for repeated endTurn()', () => {
    const mapper = new AcpSessionManager();
    mapper.startTurn();
    const first = mapper.endTurn('completed');
    const second = mapper.endTurn('completed');

    expect(first).toHaveLength(1);
    expect(first[0].ev.t).toBe('turn-end');
    expect(second).toHaveLength(0);
  });

  it('supports multiple complete turn cycles with distinct turn ids', () => {
    const mapper = new AcpSessionManager();
    const start1 = mapper.startTurn();
    mapper.endTurn('completed');
    const start2 = mapper.startTurn();
    mapper.endTurn('completed');

    expect(start1[0].turn).not.toBe(start2[0].turn);
    expect(isCuid(start1[0].turn!)).toBe(true);
    expect(isCuid(start2[0].turn!)).toBe(true);
  });

  it('ignores status messages in mapMessage', () => {
    const mapper = new AcpSessionManager();
    expect(mapper.mapMessage({ type: 'status', status: 'running' })).toHaveLength(0);
    expect(mapper.mapMessage({ type: 'status', status: 'idle' })).toHaveLength(0);
    expect(mapper.mapMessage({ type: 'status', status: 'error' })).toHaveLength(0);
    expect(mapper.mapMessage({ type: 'status', status: 'stopped' })).toHaveLength(0);
    expect(mapper.mapMessage({ type: 'status', status: 'starting' })).toHaveLength(0);
  });

  it('flushes pending text on endTurn()', () => {
    const mapper = new AcpSessionManager();
    mapper.startTurn();
    mapper.mapMessage({ type: 'model-output', textDelta: 'What command would you like me' });

    const ended = mapper.endTurn('completed');
    expect(ended).toHaveLength(2);
    expect(ended[0].ev).toEqual({ t: 'text', text: 'What command would you like me' });
    expect(ended[1].ev.t).toBe('turn-end');
  });

  it('flushes pending text on endTurn() even without active turn', () => {
    const mapper = new AcpSessionManager();
    mapper.startTurn();
    mapper.endTurn('completed');

    // Late output arrives after turn ended
    mapper.mapMessage({ type: 'model-output', textDelta: 'late text' });

    // endTurn flushes it even though no active turn
    const ended = mapper.endTurn('completed');
    expect(ended).toHaveLength(1);
    expect(ended[0].ev).toEqual({ t: 'text', text: 'late text' });
  });
});

describe('AcpSessionManager text mapping', () => {
  it('accumulates model-output and flushes on endTurn()', () => {
    const mapper = new AcpSessionManager();
    const start = mapper.startTurn()[0];

    // Accumulates - not flushed yet
    expect(mapper.mapMessage({ type: 'model-output', textDelta: 'hel' })).toHaveLength(0);
    expect(mapper.mapMessage({ type: 'model-output', textDelta: 'lo' })).toHaveLength(0);

    // Flushed combined output on turn-end
    const envelopes = mapper.endTurn('completed');
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0].ev).toEqual({ t: 'text', text: 'hello' });
    expect(envelopes[0].turn).toBe(start.turn);
    expect(envelopes[1].ev).toEqual({ t: 'turn-end', status: 'completed' });
  });

  it('flushes accumulated output when thinking starts', () => {
    const mapper = new AcpSessionManager();
    mapper.startTurn();

    mapper.mapMessage({ type: 'model-output', textDelta: 'hello' });
    // Thinking flushes the pending output
    const envelopes = mapper.mapMessage({ type: 'event', name: 'thinking', payload: { text: 'hmm', streaming: true } });
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].ev).toEqual({ t: 'text', text: 'hello' });
  });

  it('skips empty model-output text', () => {
    const mapper = new AcpSessionManager();
    expect(mapper.mapMessage({ type: 'model-output', textDelta: '' })).toHaveLength(0);
    expect(mapper.mapMessage({ type: 'model-output' })).toHaveLength(0);
  });
});

describe('AcpSessionManager tool mapping', () => {
  it('maps tool-call to tool-call-start with generated call id', () => {
    const mapper = new AcpSessionManager();
    const start = mapper.startTurn()[0];

    const envelopes = mapper.mapMessage({
      type: 'tool-call',
      callId: 'acp-call-1',
      toolName: 'ReadFile',
      args: { path: 'README.md' },
    });

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].ev.t).toBe('tool-call-start');
    if (envelopes[0].ev.t === 'tool-call-start') {
      expect(isCuid(envelopes[0].ev.call)).toBe(true);
      expect(envelopes[0].ev.name).toBe('ReadFile');
      expect(envelopes[0].ev.title).toBe('ReadFile');
      expect(envelopes[0].ev.description).toContain('ReadFile');
      expect(envelopes[0].ev.args).toEqual({ path: 'README.md' });
    }
    expect(envelopes[0].turn).toBe(start.turn);
  });

  it('maps tool-result to paired tool-call-end', () => {
    const mapper = new AcpSessionManager();
    mapper.startTurn();
    const start = mapper.mapMessage({
      type: 'tool-call',
      callId: 'acp-call-1',
      toolName: 'ReadFile',
      args: { path: 'README.md' },
    })[0];
    const end = mapper.mapMessage({
      type: 'tool-result',
      callId: 'acp-call-1',
      toolName: 'ReadFile',
      result: { ok: true },
    })[0];

    expect(start.ev.t).toBe('tool-call-start');
    expect(end.ev.t).toBe('tool-call-end');
    if (start.ev.t === 'tool-call-start' && end.ev.t === 'tool-call-end') {
      expect(end.ev.call).toBe(start.ev.call);
    }
  });

  it('creates distinct call ids for multiple tool calls', () => {
    const mapper = new AcpSessionManager();
    mapper.startTurn();

    const first = mapper.mapMessage({
      type: 'tool-call',
      callId: 'acp-call-1',
      toolName: 'ReadFile',
      args: {},
    })[0];
    const second = mapper.mapMessage({
      type: 'tool-call',
      callId: 'acp-call-2',
      toolName: 'WriteFile',
      args: {},
    })[0];

    expect(first.ev.t).toBe('tool-call-start');
    expect(second.ev.t).toBe('tool-call-start');
    if (first.ev.t === 'tool-call-start' && second.ev.t === 'tool-call-start') {
      expect(first.ev.call).not.toBe(second.ev.call);
    }
  });

  it('emits tool-call-end with generated call id for unknown tool result', () => {
    const mapper = new AcpSessionManager();
    mapper.startTurn();
    const envelope = mapper.mapMessage({
      type: 'tool-result',
      callId: 'missing-call',
      toolName: 'ReadFile',
      result: { ok: true },
    })[0];

    expect(envelope.ev.t).toBe('tool-call-end');
    if (envelope.ev.t === 'tool-call-end') {
      expect(isCuid(envelope.ev.call)).toBe(true);
    }
  });
});

describe('AcpSessionManager thinking mapping', () => {
  it('accumulates streaming thinking and flushes on type change', () => {
    const mapper = new AcpSessionManager();
    mapper.startTurn();

    // Streaming thinking accumulates
    expect(mapper.mapMessage({ type: 'event', name: 'thinking', payload: { text: 'The user', streaming: true } })).toHaveLength(0);
    expect(mapper.mapMessage({ type: 'event', name: 'thinking', payload: { text: ' wants X', streaming: true } })).toHaveLength(0);

    // Model output flushes accumulated thinking, then accumulates output
    const envelopes = mapper.mapMessage({ type: 'model-output', textDelta: 'answer' });
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].ev).toEqual({ t: 'text', text: 'The user wants X', thinking: true });
  });

  it('emits non-streaming thinking immediately', () => {
    const mapper = new AcpSessionManager();
    mapper.startTurn();

    const envelopes = mapper.mapMessage({ type: 'event', name: 'thinking', payload: { text: 'full thought' } });
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].ev).toEqual({ t: 'text', text: 'full thought', thinking: true });
  });

  it('flushes streaming thinking on endTurn()', () => {
    const mapper = new AcpSessionManager();
    const start = mapper.startTurn()[0];

    mapper.mapMessage({ type: 'event', name: 'thinking', payload: { text: 'A', streaming: true } });
    mapper.mapMessage({ type: 'event', name: 'thinking', payload: { text: 'B', streaming: true } });

    const envelopes = mapper.endTurn('completed');
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0].ev).toEqual({ t: 'text', text: 'AB', thinking: true });
    expect(envelopes[1].ev).toEqual({ t: 'turn-end', status: 'completed' });
    expect(envelopes[0].turn).toBe(start.turn);
  });

  it('alternates between thinking and output correctly', () => {
    const mapper = new AcpSessionManager();
    mapper.startTurn();

    // Streaming thinking
    mapper.mapMessage({ type: 'event', name: 'thinking', payload: { text: 'think1', streaming: true } });
    mapper.mapMessage({ type: 'event', name: 'thinking', payload: { text: 'think2', streaming: true } });
    // Output flushes thinking, then accumulates
    const e1 = mapper.mapMessage({ type: 'model-output', textDelta: 'out1' });
    expect(e1).toHaveLength(1);
    expect(e1[0].ev).toEqual({ t: 'text', text: 'think1think2', thinking: true });

    mapper.mapMessage({ type: 'model-output', textDelta: 'out2' });
    // More thinking flushes accumulated output
    const e2 = mapper.mapMessage({ type: 'event', name: 'thinking', payload: { text: 'think3', streaming: true } });
    expect(e2).toHaveLength(1);
    expect(e2[0].ev).toEqual({ t: 'text', text: 'out1out2' });

    // Turn end flushes remaining thinking
    const end = mapper.endTurn('completed');
    expect(end).toHaveLength(2);
    expect(end[0].ev).toEqual({ t: 'text', text: 'think3', thinking: true });
    expect(end[1].ev.t).toBe('turn-end');
  });

  it('skips thinking messages with empty text', () => {
    const mapper = new AcpSessionManager();
    expect(mapper.mapMessage({ type: 'event', name: 'thinking', payload: { text: '' } })).toHaveLength(0);
    expect(mapper.mapMessage({ type: 'event', name: 'thinking', payload: {} })).toHaveLength(0);
  });
});

describe('AcpSessionManager ignored messages', () => {
  it('ignores non-session-protocol ACP messages', () => {
    const mapper = new AcpSessionManager();
    const messages: AgentMessage[] = [
      { type: 'permission-request', id: 'p1', reason: 'ReadFile', payload: {} },
      { type: 'permission-response', id: 'p1', approved: true },
      { type: 'token-count', total: 1 },
      { type: 'fs-edit', description: 'edit' },
      { type: 'terminal-output', data: 'stdout' },
    ];

    const envelopes = mapMany(mapper, messages);
    expect(envelopes).toHaveLength(0);
  });
});

describe('AcpSessionManager id consistency', () => {
  it('keeps ids consistent across a full turn sequence', () => {
    const mapper = new AcpSessionManager();
    // startTurn, then output "hello" accumulates, tool-call flushes it,
    // tool-result, then output "done" accumulates, endTurn flushes it + turn-end
    const envelopes = [
      ...mapper.startTurn(),
      ...mapper.mapMessage({ type: 'model-output', textDelta: 'hello' }),
      ...mapper.mapMessage({ type: 'tool-call', callId: 'tool-1', toolName: 'ReadFile', args: { path: 'a.txt' } }),
      ...mapper.mapMessage({ type: 'tool-result', callId: 'tool-1', toolName: 'ReadFile', result: { ok: true } }),
      ...mapper.mapMessage({ type: 'model-output', textDelta: 'done' }),
      ...mapper.endTurn('completed'),
    ];

    expect(envelopes).toHaveLength(6);
    const turnId = envelopes[0].turn!;
    for (const envelope of envelopes) {
      expect(envelope.turn).toBe(turnId);
      expect(isCuid(envelope.id)).toBe(true);
    }

    const toolStart = envelopes.find((envelope) => envelope.ev.t === 'tool-call-start');
    const toolEnd = envelopes.find((envelope) => envelope.ev.t === 'tool-call-end');
    expect(toolStart).toBeDefined();
    expect(toolEnd).toBeDefined();
    if (toolStart?.ev.t === 'tool-call-start' && toolEnd?.ev.t === 'tool-call-end') {
      expect(toolStart.ev.call).toBe(toolEnd.ev.call);
      expect(isCuid(toolStart.ev.call)).toBe(true);
    }

    const allIds = envelopes.map((envelope) => envelope.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('assigns strictly increasing timestamps to all envelopes', () => {
    const mapper = new AcpSessionManager();
    const envelopes = [
      ...mapper.startTurn(),
      ...mapper.mapMessage({ type: 'event', name: 'thinking', payload: { text: 'hmm', streaming: true } }),
      ...mapper.mapMessage({ type: 'model-output', textDelta: 'hello' }),
      ...mapper.mapMessage({ type: 'tool-call', callId: 'c1', toolName: 'Bash', args: {} }),
      ...mapper.mapMessage({ type: 'tool-result', callId: 'c1', toolName: 'Bash', result: {} }),
      ...mapper.endTurn('completed'),
    ];

    // Every envelope should have a unique, strictly increasing time
    for (let i = 1; i < envelopes.length; i++) {
      expect(envelopes[i].time).toBeGreaterThan(envelopes[i - 1].time);
    }
  });

  it('uses different turn ids between separate turns', () => {
    const mapper = new AcpSessionManager();
    const firstStart = mapper.startTurn()[0];
    mapper.endTurn('completed');
    const secondStart = mapper.startTurn()[0];

    expect(firstStart.turn).not.toBe(secondStart.turn);
    expect(isCuid(firstStart.turn!)).toBe(true);
    expect(isCuid(secondStart.turn!)).toBe(true);
  });
});
