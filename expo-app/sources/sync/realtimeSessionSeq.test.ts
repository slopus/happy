import { describe, expect, it } from 'vitest';

import { computeNextSessionSeqFromUpdate } from './realtimeSessionSeq';

describe('computeNextSessionSeqFromUpdate', () => {
    it('keeps the session seq unchanged for update-session updates', () => {
        expect(computeNextSessionSeqFromUpdate({
            currentSessionSeq: 10,
            updateType: 'update-session',
            containerSeq: 9_999,
            messageSeq: 123,
        })).toBe(10);
    });

    it('uses the message seq (not the container seq) for new-message updates', () => {
        expect(computeNextSessionSeqFromUpdate({
            currentSessionSeq: 10,
            updateType: 'new-message',
            containerSeq: 9_999,
            messageSeq: 11,
        })).toBe(11);
    });

    it('never decreases the session seq', () => {
        expect(computeNextSessionSeqFromUpdate({
            currentSessionSeq: 10,
            updateType: 'new-message',
            containerSeq: 9_999,
            messageSeq: 9,
        })).toBe(10);
    });
});

