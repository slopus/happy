import { describe, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import {
  createEnvelope,
  sessionEnvelopeSchema,
  sessionEventSchema,
  type SessionEvent,
} from './sessionProtocol';

describe('session protocol schemas', () => {
  it('accepts all supported event types', () => {
    const events: SessionEvent[] = [
      { t: 'text', text: 'hello' },
      { t: 'text', text: 'thinking', thinking: true },
      { t: 'service', text: '**Service:** restarting MCP bridge' },
      {
        t: 'tool-call-start',
        call: 'call-1',
        name: 'CodexBash',
        title: 'Run `ls`',
        description: 'Run `ls -la` in the repo root',
        args: { command: 'ls -la' },
      },
      { t: 'tool-call-end', call: 'call-1' },
      { t: 'file', ref: 'upload-1', name: 'report.txt', size: 1024 },
      {
        t: 'file',
        ref: 'upload-2',
        name: 'image.png',
        size: 2048,
        image: { thumbhash: 'abc', width: 100, height: 80 },
      },
      { t: 'turn-start' },
      { t: 'start', title: 'Research agent' },
      { t: 'turn-end', status: 'completed' },
      { t: 'stop' },
    ];

    for (const event of events) {
      expect(sessionEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it('rejects malformed events', () => {
    expect(sessionEventSchema.safeParse({ t: 'tool-call-start', call: '1' }).success).toBe(false);
    expect(sessionEventSchema.safeParse({ t: 'file', ref: 'x', name: 'x' }).success).toBe(false);
    expect(sessionEventSchema.safeParse({ t: 'file', ref: 'x', name: 'x', size: 1, image: { width: 10, height: 10 } }).success).toBe(false);
    expect(sessionEventSchema.safeParse({ t: 'turn-end' }).success).toBe(false);
    expect(sessionEventSchema.safeParse({ t: 'turn-end', status: 'canceled' }).success).toBe(false);
    expect(sessionEventSchema.safeParse({ t: 'start', title: 1 }).success).toBe(false);
    expect(sessionEventSchema.safeParse({ t: 'service' }).success).toBe(false);
    expect(sessionEventSchema.safeParse({ t: 'not-real' }).success).toBe(false);
  });

  it('validates envelopes that include turn/subagent', () => {
    const subagent = createId();
    const envelope = {
      id: 'msg-1',
      time: 1234,
      role: 'agent' as const,
      turn: 'turn-1',
      subagent,
      ev: { t: 'text', text: 'hello' } as const,
    };

    const parsed = sessionEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
  });

  it('rejects session role envelopes for text events', () => {
    const parsed = sessionEnvelopeSchema.safeParse({
      id: 'msg-session-1',
      role: 'session',
      ev: { t: 'text', text: 'shadow copy of user message' },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects service from non-agent role', () => {
    const parsed = sessionEnvelopeSchema.safeParse({
      id: 'msg-2',
      role: 'user',
      ev: { t: 'service', text: 'internal event' },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects start from non-agent role', () => {
    const subagent = createId();
    const parsed = sessionEnvelopeSchema.safeParse({
      id: 'msg-3',
      role: 'user',
      subagent,
      ev: { t: 'start', title: 'Research agent' },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects non-cuid subagent values', () => {
    const parsed = sessionEnvelopeSchema.safeParse({
      id: 'msg-4',
      role: 'agent',
      turn: 'turn-1',
      subagent: 'provider-tool-id',
      ev: { t: 'text', text: 'hello' },
    });

    expect(parsed.success).toBe(false);
  });
});

describe('createEnvelope', () => {
  it('creates id by default', () => {
    const envelope = createEnvelope('agent', { t: 'turn-start' });
    expect(typeof envelope.id).toBe('string');
    expect(typeof envelope.time).toBe('number');
    expect(envelope.id.length).toBeGreaterThan(0);
    expect(envelope.role).toBe('agent');
    expect(envelope.ev.t).toBe('turn-start');
  });

  it('respects explicit options', () => {
    const subagent = createId();
    const envelope = createEnvelope(
      'agent',
      { t: 'tool-call-end', call: 'call-1' },
      {
        id: 'fixed-id',
        time: 12345,
        turn: 'turn-1',
        subagent,
      }
    );

    expect(envelope).toEqual({
      id: 'fixed-id',
      time: 12345,
      role: 'agent',
      turn: 'turn-1',
      subagent,
      ev: { t: 'tool-call-end', call: 'call-1' },
    });
  });

  it('validates role/event compatibility', () => {
    expect(() => createEnvelope('user', { t: 'service', text: 'internal event' })).toThrow();
  });
});
