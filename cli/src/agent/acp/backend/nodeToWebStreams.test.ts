import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { nodeToWebStreams } from './nodeToWebStreams';

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

    it('does not hang if drain fires synchronously during write', async () => {
        let stdin: FakeStdin | null = null;
        stdin = new FakeStdin((_chunk, cb) => {
            stdin?.emit('drain');
            queueMicrotask(() => cb(null));
            return false;
        });

        const stdout = new Readable({ read() { } });

        const { writable } = nodeToWebStreams(stdin as any, stdout);
        const writer = writable.getWriter();
        const promise = writer.write(new Uint8Array([1]));

        await expect(
            Promise.race([
                promise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('write() hung waiting for drain')), 50)),
            ]),
        ).resolves.toBeUndefined();

        writer.releaseLock();
    });
});
