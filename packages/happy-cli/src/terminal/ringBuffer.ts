/**
 * Bounded output ring buffer for a remote terminal.
 *
 * Every chunk written by the shell gets a monotonically increasing sequence
 * number. The buffer keeps only the most recent `maxBytes` worth of output so
 * a disconnected client can replay what it missed without unbounded memory
 * growth. When chunks are evicted the `truncated` flag latches, letting the
 * UI show an honest "output was truncated while you were away" marker.
 */

export interface RingBufferFrame {
    seq: number;
    data: string;
}

export interface RingBufferReplay {
    frames: RingBufferFrame[];
    nextSeq: number;
    truncated: boolean;
}

export class OutputRingBuffer {
    private frames: RingBufferFrame[] = [];
    private bytes = 0;
    private nextSeqValue = 1;
    private truncatedValue = false;

    constructor(private readonly maxBytes: number) {
        if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
            throw new Error('OutputRingBuffer maxBytes must be a positive number');
        }
    }

    get nextSeq(): number {
        return this.nextSeqValue;
    }

    get truncated(): boolean {
        return this.truncatedValue;
    }

    get byteLength(): number {
        return this.bytes;
    }

    /** Append a chunk and return its sequence number. */
    push(data: string): number {
        const seq = this.nextSeqValue++;
        const size = Buffer.byteLength(data, 'utf8');
        this.frames.push({ seq, data });
        this.bytes += size;

        while (this.bytes > this.maxBytes && this.frames.length > 1) {
            const dropped = this.frames.shift()!;
            this.bytes -= Buffer.byteLength(dropped.data, 'utf8');
            this.truncatedValue = true;
        }
        if (this.bytes > this.maxBytes) {
            // A single chunk can exceed the cap (e.g. a huge paste); keep it
            // for replay but still mark the stream as truncated.
            this.truncatedValue = true;
        }

        return seq;
    }

    /** Return every retained frame with `seq > afterSeq`. */
    replay(afterSeq: number): RingBufferReplay {
        const frames = this.frames.filter((frame) => frame.seq > afterSeq);
        return {
            frames,
            nextSeq: this.nextSeqValue,
            truncated: this.truncatedValue,
        };
    }
}
