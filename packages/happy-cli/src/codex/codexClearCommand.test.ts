import { describe, expect, it, vi } from 'vitest';

import { createSerializedTaskRunner, MessageQueue2, type PendingAttachment } from '@/utils/MessageQueue2';
import { enqueueCodexUserText } from './codexClearCommand';

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

describe('enqueueCodexUserText', () => {
    it('queues /clear in isolation instead of batching it into a model prompt', () => {
        const mode = { permissionMode: 'default' as const };
        const queue = {
            push: vi.fn(),
            pushIsolateAndClear: vi.fn(),
        };

        const result = enqueueCodexUserText({
            text: '  /clear  ',
            mode,
            queue,
        });

        expect(result).toEqual({ status: 'clear', displacedAttachments: [] });
        expect(queue.pushIsolateAndClear).toHaveBeenCalledWith('  /clear  ', mode, undefined);
        expect(queue.push).not.toHaveBeenCalled();
    });

    it('queues /skills in isolation instead of batching it into a model prompt', () => {
        const mode = { permissionMode: 'default' as const };
        const queue = {
            push: vi.fn(),
            pushIsolateAndClear: vi.fn(),
        };

        const result = enqueueCodexUserText({
            text: '/skills',
            mode,
            queue,
        });

        expect(result).toEqual({ status: 'skills', displacedAttachments: [] });
        expect(queue.pushIsolateAndClear).toHaveBeenCalledWith('/skills', mode, undefined);
        expect(queue.push).not.toHaveBeenCalled();
    });

    it('queues /goal in isolation instead of batching it into a model prompt', () => {
        const mode = { permissionMode: 'default' as const };
        const queue = {
            push: vi.fn(),
            pushIsolateAndClear: vi.fn(),
        };

        const result = enqueueCodexUserText({
            text: '/goal Reduce p95 latency',
            mode,
            queue,
        });

        expect(result).toEqual({ status: 'goal', displacedAttachments: [] });
        expect(queue.pushIsolateAndClear).toHaveBeenCalledWith('/goal Reduce p95 latency', mode, undefined);
        expect(queue.push).not.toHaveBeenCalled();
    });

    it.each([
        ['/compact', 'compact'],
        ['/mcp verbose', 'mcp'],
        ['/usage weekly', 'usage'],
        ['/status', 'status'],
        ['/diff', 'diff'],
        ['/new', 'new'],
        ['/fork', 'fork'],
        ['/review focus on regressions', 'review'],
        ['/plan propose a migration', 'plan'],
    ] as const)('queues %s in isolation', (text, expected) => {
        const mode = { permissionMode: 'default' as const };
        const queue = {
            push: vi.fn(),
            pushIsolateAndClear: vi.fn(),
        };

        const result = enqueueCodexUserText({
            text,
            mode,
            queue,
        });

        expect(result).toEqual({ status: expected, displacedAttachments: [] });
        expect(queue.pushIsolateAndClear).toHaveBeenCalledWith(text, mode, undefined);
        expect(queue.push).not.toHaveBeenCalled();
    });

    it('forwards image attachments alongside ordinary text', () => {
        const mode = { permissionMode: 'default' as const };
        const queue = {
            push: vi.fn(),
            pushIsolateAndClear: vi.fn(),
        };
        const attachments = [{ data: new Uint8Array([1, 2, 3]), mimeType: 'image/png', name: 'pic' }];

        const result = enqueueCodexUserText({
            text: 'look at this',
            mode,
            attachments,
            queue,
        });

        expect(result).toEqual({ status: 'queued', displacedAttachments: [] });
        expect(queue.push).toHaveBeenCalledWith('look at this', mode, attachments);
        expect(queue.pushIsolateAndClear).not.toHaveBeenCalled();
    });

    it('serializes an in-flight PDF prompt before /clear and reports the displaced file', async () => {
        const queue = new MessageQueue2<{ permissionMode: 'default' }>(() => 'default');
        const runSerially = createSerializedTaskRunner();
        const firstAttachments = createDeferred<PendingAttachment[]>();
        const pdf = {
            kind: 'file' as const,
            localPath: '/tmp/queued.pdf',
            size: 123,
            mimeType: 'application/pdf',
            name: 'queued.pdf',
        };
        const cleanup = vi.fn(async (_attachments: PendingAttachment[]) => {});

        const first = runSerially(async () => enqueueCodexUserText({
            text: 'read the PDF',
            mode: { permissionMode: 'default' },
            attachments: await firstAttachments.promise,
            queue,
        }));
        const clear = runSerially(async () => {
            const result = enqueueCodexUserText({
                text: '/clear',
                mode: { permissionMode: 'default' },
                queue,
            });
            await cleanup(result.displacedAttachments);
            return result;
        });

        firstAttachments.resolve([pdf]);
        const [, clearResult] = await Promise.all([first, clear]);

        expect(clearResult).toEqual({ status: 'clear', displacedAttachments: [pdf] });
        expect(queue.queue.map((item) => item.message)).toEqual(['/clear']);
        expect(cleanup).toHaveBeenCalledWith([pdf]);
    });
});
