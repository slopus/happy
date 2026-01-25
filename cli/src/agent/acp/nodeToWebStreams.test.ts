import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { nodeToWebStreams } from './AcpBackend';

class FakeStdin extends EventEmitter {
    writeImpl: (chunk: Uint8Array, cb: (err?: Error | null) => void) => boolean;

    constructor(writeImpl: (chunk: Uint8Array, cb: (err?: Error | null) => void) => boolean) {
        super();
        this.writeImpl = writeImpl;
    }

    write(chunk: Uint8Array, cb: (err?: Error | null) => void): boolean {
        return this.writeImpl(chunk, cb);
    }

    end(cb?: () => void) {
        cb?.();
    }

    destroy(_reason?: unknown) { }
}

describe('nodeToWebStreams', () => {
    it('rejects when stdin write callback reports an error even if write() returned true', async () => {
        const stdin = new FakeStdin((_chunk, cb) => {
            queueMicrotask(() => cb(new Error('boom')));
            return true;
        });
        const stdout = new Readable({ read() { } });

        const { writable } = nodeToWebStreams(stdin as any, stdout);
        const writer = writable.getWriter();
        await expect(writer.write(new Uint8Array([1, 2, 3]))).rejects.toThrow('boom');
        writer.releaseLock();
    });

    it('waits for drain when stdin backpressures', async () => {
        let capturedCb: ((err?: Error | null) => void) | null = null;
        const stdin = new FakeStdin((_chunk, cb) => {
            capturedCb = cb;
            return false;
        });
        const stdout = new Readable({ read() { } });

        const { writable } = nodeToWebStreams(stdin as any, stdout);
        const writer = writable.getWriter();
        const promise = writer.write(new Uint8Array([1]));

        // Simulate successful write completion, but keep backpressure until drain fires.
        queueMicrotask(() => capturedCb?.(null));
        queueMicrotask(() => stdin.emit('drain'));

        await expect(promise).resolves.toBeUndefined();
        writer.releaseLock();
    });
});
