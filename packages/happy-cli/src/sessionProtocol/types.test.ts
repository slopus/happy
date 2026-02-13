import { describe, expect, it } from 'vitest';
import {
    createEnvelope,
    sessionEnvelopeSchema,
    sessionEventSchema,
    type SessionEvent,
} from './types';

describe('session protocol schemas', () => {
    it('accepts all supported event types', () => {
        const events: SessionEvent[] = [
            { t: 'text', text: 'hello' },
            { t: 'text', text: 'thinking', thinking: true },
            {
                t: 'tool-call-start',
                call: 'call-1',
                name: 'CodexBash',
                title: 'Run `ls`',
                description: 'Run `ls -la` in the repo root',
                args: { command: 'ls -la' },
            },
            { t: 'tool-call-end', call: 'call-1' },
            { t: 'file', ref: 'upload-1', name: 'report.txt' },
            { t: 'photo', ref: 'upload-2', thumbhash: 'abc', width: 100, height: 80 },
            { t: 'turn-start' },
            { t: 'turn-end' },
        ];

        for (const event of events) {
            expect(sessionEventSchema.safeParse(event).success).toBe(true);
        }
    });

    it('rejects malformed events', () => {
        expect(sessionEventSchema.safeParse({ t: 'tool-call-start', call: '1' }).success).toBe(false);
        expect(sessionEventSchema.safeParse({ t: 'photo', ref: 'x', width: 10, height: 10 }).success).toBe(false);
        expect(sessionEventSchema.safeParse({ t: 'not-real' }).success).toBe(false);
    });

    it('validates envelopes that include turn/invoke', () => {
        const envelope = {
            id: 'msg-1',
            time: 123,
            role: 'agent' as const,
            turn: 'turn-1',
            invoke: 'tool-1',
            ev: { t: 'text', text: 'hello' } as const,
        };

        const parsed = sessionEnvelopeSchema.safeParse(envelope);
        expect(parsed.success).toBe(true);
    });
});

describe('createEnvelope', () => {
    it('creates id/time by default', () => {
        const envelope = createEnvelope('agent', { t: 'turn-start' });
        expect(typeof envelope.id).toBe('string');
        expect(envelope.id.length).toBeGreaterThan(0);
        expect(typeof envelope.time).toBe('number');
        expect(envelope.role).toBe('agent');
        expect(envelope.ev.t).toBe('turn-start');
    });

    it('respects explicit options', () => {
        const envelope = createEnvelope(
            'agent',
            { t: 'tool-call-end', call: 'call-1' },
            {
                id: 'fixed-id',
                time: 999,
                turn: 'turn-1',
                invoke: 'parent-call',
            }
        );

        expect(envelope).toEqual({
            id: 'fixed-id',
            time: 999,
            role: 'agent',
            turn: 'turn-1',
            invoke: 'parent-call',
            ev: { t: 'tool-call-end', call: 'call-1' },
        });
    });
});
