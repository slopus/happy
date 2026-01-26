import { describe, expect, it } from 'vitest';

import { claimMessageQueueV1Next, clearMessageQueueV1InFlight, parseMessageQueueV1 } from './messageQueueV1';

describe('messageQueueV1', () => {
    it('parses v1 queue with optional inFlight', () => {
        const parsed = parseMessageQueueV1({
            v: 1,
            queue: [{ localId: 'a', message: 'm', createdAt: 1, updatedAt: 1 }],
            inFlight: null,
        });
        expect(parsed?.v).toBe(1);
        expect(parsed?.queue[0]?.localId).toBe('a');
        expect(parsed?.inFlight).toBe(null);
    });

    it('rejects invalid inFlight objects', () => {
        const parsed = parseMessageQueueV1({
            v: 1,
            queue: [],
            inFlight: { localId: 'x', message: 'mx', createdAt: 0, updatedAt: 0 },
        });
        expect(parsed).toBe(null);
    });

    it('claims the first queue item into inFlight', () => {
        const result = claimMessageQueueV1Next({
            messageQueueV1: {
                v: 1,
                queue: [
                    { localId: 'a', message: 'm1', createdAt: 1, updatedAt: 1 },
                    { localId: 'b', message: 'm2', createdAt: 2, updatedAt: 2 },
                ],
            },
        }, 10);

        expect(result?.inFlight.localId).toBe('a');
        expect((result?.metadata as any).messageQueueV1.inFlight.claimedAt).toBe(10);
        expect((result?.metadata as any).messageQueueV1.queue.map((q: any) => q.localId)).toEqual(['b']);
    });

    it('returns existing inFlight without mutating metadata', () => {
        const input = {
            messageQueueV1: {
                v: 1,
                queue: [{ localId: 'a', message: 'm1', createdAt: 1, updatedAt: 1 }],
                inFlight: { localId: 'x', message: 'mx', createdAt: 0, updatedAt: 0, claimedAt: 9 },
            },
        };
        const result = claimMessageQueueV1Next(input, 10);
        expect(result?.inFlight.localId).toBe('x');
        expect(result?.metadata).toBe(input);
    });

    it('reclaims stale inFlight by re-claiming it with a fresh claimedAt', () => {
        const input = {
            messageQueueV1: {
                v: 1,
                queue: [],
                inFlight: { localId: 'x', message: 'mx', createdAt: 0, updatedAt: 0, claimedAt: 0 },
            },
        };
        const result = claimMessageQueueV1Next(input, 61_000);
        expect(result?.inFlight.localId).toBe('x');
        expect(result?.inFlight.claimedAt).toBe(61_000);
        expect(result?.metadata).not.toBe(input);
    });

    it('clears inFlight only when localId matches', () => {
        const input = {
            messageQueueV1: {
                v: 1,
                queue: [],
                inFlight: { localId: 'x', message: 'mx', createdAt: 0, updatedAt: 0, claimedAt: 9 },
            },
        };
        expect(clearMessageQueueV1InFlight(input, 'nope')).toBe(input);
        const cleared = clearMessageQueueV1InFlight(input, 'x');
        expect((cleared as any).messageQueueV1.inFlight).toBe(null);
    });
});
