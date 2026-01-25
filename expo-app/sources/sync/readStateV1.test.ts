import { describe, expect, it } from 'vitest';

import { computeNextReadStateV1 } from './readStateV1';

describe('computeNextReadStateV1', () => {
    it('does not change state when existing marker already covers current activity', () => {
        expect(computeNextReadStateV1({
            prev: { v: 1, sessionSeq: 10, pendingActivityAt: 20, updatedAt: 100 },
            sessionSeq: 10,
            pendingActivityAt: 20,
            now: 200,
        })).toEqual({
            didChange: false,
            next: { v: 1, sessionSeq: 10, pendingActivityAt: 20, updatedAt: 100 },
        });
    });

    it('advances markers when activity increases', () => {
        expect(computeNextReadStateV1({
            prev: { v: 1, sessionSeq: 10, pendingActivityAt: 20, updatedAt: 100 },
            sessionSeq: 11,
            pendingActivityAt: 25,
            now: 200,
        })).toEqual({
            didChange: true,
            next: { v: 1, sessionSeq: 11, pendingActivityAt: 25, updatedAt: 200 },
        });
    });

    it('repairs invalid markers when previous sessionSeq exceeds current sessionSeq', () => {
        expect(computeNextReadStateV1({
            prev: { v: 1, sessionSeq: 50_000, pendingActivityAt: 20, updatedAt: 100 },
            sessionSeq: 11,
            pendingActivityAt: 20,
            now: 200,
        })).toEqual({
            didChange: true,
            next: { v: 1, sessionSeq: 11, pendingActivityAt: 20, updatedAt: 200 },
        });
    });
});

