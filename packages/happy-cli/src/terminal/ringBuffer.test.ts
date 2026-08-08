import { describe, expect, it } from 'vitest';
import { OutputRingBuffer } from './ringBuffer';

describe('OutputRingBuffer', () => {
    it('assigns monotonically increasing sequence numbers', () => {
        const buffer = new OutputRingBuffer(1024);
        expect(buffer.push('a')).toBe(1);
        expect(buffer.push('b')).toBe(2);
        expect(buffer.nextSeq).toBe(3);
    });

    it('replays only frames after the given sequence', () => {
        const buffer = new OutputRingBuffer(1024);
        buffer.push('one');
        buffer.push('two');
        buffer.push('three');

        const replay = buffer.replay(1);
        expect(replay.frames.map((frame) => frame.data)).toEqual(['two', 'three']);
        expect(replay.nextSeq).toBe(4);
        expect(replay.truncated).toBe(false);
    });

    it('evicts oldest frames and latches truncated once the limit is exceeded', () => {
        const buffer = new OutputRingBuffer(10);
        buffer.push('1234567890'); // exactly at the limit
        expect(buffer.truncated).toBe(false);
        buffer.push('x'); // exceeds the limit

        expect(buffer.truncated).toBe(true);
        const replay = buffer.replay(0);
        expect(replay.frames.length).toBe(1);
        expect(replay.frames[0].data).toBe('x');
    });

    it('always keeps the most recent frame even when it exceeds the limit', () => {
        const buffer = new OutputRingBuffer(4);
        const seq = buffer.push('a-big-chunk');
        const replay = buffer.replay(0);
        expect(replay.frames).toEqual([{ seq, data: 'a-big-chunk' }]);
        expect(replay.truncated).toBe(true);
    });

    it('rejects invalid capacities', () => {
        expect(() => new OutputRingBuffer(0)).toThrow();
        expect(() => new OutputRingBuffer(Number.NaN)).toThrow();
    });
});
