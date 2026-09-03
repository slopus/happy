import { describe, expect, it, vi } from 'vitest';
import {
    createPublicSessionShareQueue,
    type PublicSessionShareJob,
    type PublicSessionShareQueueStorage,
} from './publicSessionShareQueue';

function createStorage(initial: PublicSessionShareJob[] = []) {
    let jobs = initial;
    const storage: PublicSessionShareQueueStorage = {
        load: () => jobs,
        save: (next) => { jobs = next; },
    };
    return { storage, read: () => jobs };
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

const input = {
    sessionId: 'session-1',
    title: 'Release notes',
    requestedAt: 1_788_000_000_000,
    cutoffSeq: 42,
    ownerId: 'owner-1',
    serverUrl: 'https://paws.test',
    groupToolCalls: true,
    themePack: 'caramel' as const,
};

describe('public session share queue', () => {
    it('persists a queued job before the asynchronous publish completes', () => {
        const pending = createDeferred<{ publicId: string; publishedAt: number }>();
        const { storage, read } = createStorage();
        const queue = createPublicSessionShareQueue({
            storage,
            createId: () => 'job-1',
            execute: () => pending.promise,
            notify: vi.fn(async () => undefined),
        });

        const job = queue.enqueue(input);

        expect(job).toMatchObject({ id: 'job-1', sessionId: 'session-1', status: 'queued' });
        expect(read()).toEqual([expect.objectContaining({ id: 'job-1', status: 'queued' })]);
    });

    it('drops unsafe fresh cover fields before persistence and execution', async () => {
        const unsafeSelections: unknown[] = [
            {
                kind: 'existing',
                assetId: '51515151-5151-4515-8515-515151515151',
                uri: 'https://attacker.invalid/cover.webp',
            },
            {
                kind: 'pexels',
                photoId: 123,
                previewUrl: 'https://images.pexels.com/private-candidate.jpg',
                attribution: { photographer: 'Untrusted candidate' },
            },
            {
                kind: 'upload',
                attachmentId: '11111111-1111-4111-8111-111111111111',
                uri: 'https://attacker.invalid/cover.webp',
                name: 'cover.webp', mimeType: 'image/webp', size: 3, width: 1600, height: 600,
            },
            {
                kind: 'upload',
                attachmentId: '22222222-2222-4222-8222-222222222222',
                uri: 'data:image/webp;base64,UklGRg==',
                name: 'embedded.webp', mimeType: 'image/webp', size: 4, width: 1600, height: 600,
            },
            {
                kind: 'upload',
                attachmentId: '33333333-3333-4333-8333-333333333333',
                uri: 'ftp://attacker.invalid/cover.webp',
                name: 'network.webp', mimeType: 'image/webp', size: 4, width: 1600, height: 600,
            },
        ];

        for (const [index, coverSelection] of unsafeSelections.entries()) {
            const { storage, read } = createStorage();
            const execute = vi.fn(async () => ({ publicId: `public-${index}`, publishedAt: 300 }));
            const queue = createPublicSessionShareQueue({
                storage,
                createId: () => `job-${index}`,
                execute,
                notify: vi.fn(async () => undefined),
            });
            const unsafeInput = { ...input, sessionId: `session-${index}`, coverSelection };

            const job = queue.enqueue(unsafeInput as unknown as Parameters<typeof queue.enqueue>[0]);

            expect(job.coverSelection).toBeUndefined();
            expect(JSON.stringify(read())).not.toContain('attacker.invalid');
            expect(JSON.stringify(read())).not.toContain('base64');
            expect(JSON.stringify(read())).not.toContain('previewUrl');
            await queue.resume();
            expect(execute).toHaveBeenCalledWith(
                expect.objectContaining({ coverSelection: undefined }),
                expect.any(Object),
            );
        }
    });

    it('persists an existing active-cover reference with no client metadata', () => {
        const { storage, read } = createStorage();
        const queue = createPublicSessionShareQueue({
            storage,
            createId: () => 'job-existing',
            execute: vi.fn(async () => ({ publicId: 'public-id', publishedAt: 300 })),
            notify: vi.fn(async () => undefined),
        });

        const job = queue.enqueue({
            ...input,
            coverSelection: { kind: 'existing', assetId: '51515151-5151-4515-8515-515151515151' },
        });

        expect(job.coverSelection).toEqual({
            kind: 'existing',
            assetId: '51515151-5151-4515-8515-515151515151',
        });
        expect(read()[0].coverSelection).toEqual(job.coverSelection);
    });

    it('resumes an interrupted running job and records the ready link', async () => {
        const interrupted: PublicSessionShareJob = {
            id: 'job-1',
            ...input,
            status: 'running',
            progress: { completed: 1, total: 3 },
            notificationPending: false,
            updatedAt: input.requestedAt,
        };
        const { storage, read } = createStorage([interrupted]);
        const notify = vi.fn(async () => undefined);
        const queue = createPublicSessionShareQueue({
            storage,
            createId: () => 'unused',
            execute: async (_job, context) => {
                context.onProgress(3, 3);
                return { publicId: 'public-id', publishedAt: 1_788_000_001_000 };
            },
            notify,
        });

        expect(queue.getJob('session-1')?.status).toBe('queued');
        await queue.resume();

        expect(read()).toEqual([expect.objectContaining({
            id: 'job-1',
            status: 'ready',
            publicId: 'public-id',
            publishedAt: 1_788_000_001_000,
            progress: { completed: 3, total: 3 },
            notificationPending: false,
        })]);
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready', publicId: 'public-id' }));
    });

    it('does not restore a cancelled share when an older publish finishes later', async () => {
        const pending = createDeferred<{ publicId: string; publishedAt: number }>();
        const { storage, read } = createStorage();
        const notify = vi.fn(async () => undefined);
        const queue = createPublicSessionShareQueue({
            storage,
            createId: () => 'job-1',
            execute: () => pending.promise,
            notify,
        });

        queue.enqueue(input);
        await vi.waitFor(() => expect(queue.getJob('session-1')?.status).toBe('running'));
        queue.cancel('session-1');
        pending.resolve({ publicId: 'stale-public-id', publishedAt: 1_788_000_001_000 });
        await queue.resume();

        expect(read()).toEqual([]);
        expect(notify).not.toHaveBeenCalled();
    });

    it('persists a failed job and sends a failure notification', async () => {
        const { storage, read } = createStorage();
        const notify = vi.fn(async () => undefined);
        const queue = createPublicSessionShareQueue({
            storage,
            createId: () => 'job-1',
            execute: async () => { throw new Error('network unavailable'); },
            notify,
        });

        queue.enqueue(input);
        await queue.resume();

        expect(read()).toEqual([expect.objectContaining({
            id: 'job-1',
            status: 'failed',
            error: 'network unavailable',
            notificationPending: false,
        })]);
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', error: 'network unavailable' }));
    });

    it('requeues a failed job when the user taps retry', async () => {
        const { storage } = createStorage();
        let attempts = 0;
        const queue = createPublicSessionShareQueue({
            storage,
            createId: () => 'job-1',
            execute: async () => {
                attempts += 1;
                if (attempts === 1) throw new Error('offline');
                return { publicId: 'public-id', publishedAt: 300 };
            },
            notify: vi.fn(async () => undefined),
        });

        queue.enqueue(input);
        await queue.resume();
        expect(queue.getJob('session-1')?.status).toBe('failed');

        expect(queue.retry('session-1')).toBe(true);
        await queue.resume();

        expect(attempts).toBe(2);
        expect(queue.getJob('session-1')).toMatchObject({ status: 'ready', publicId: 'public-id' });
    });

    it('leaves another account\'s queued job untouched', async () => {
        const foreign: PublicSessionShareJob = {
            id: 'job-foreign',
            ...input,
            ownerId: 'owner-a',
            status: 'queued',
            progress: { completed: 0, total: 0 },
            notificationPending: false,
            updatedAt: input.requestedAt,
        };
        const { storage } = createStorage([foreign]);
        const execute = vi.fn(async () => ({ publicId: 'public-id', publishedAt: 300 }));
        const queue = createPublicSessionShareQueue({
            storage,
            createId: () => 'unused',
            execute,
            notify: vi.fn(async () => undefined),
            canExecute: (job) => job.ownerId === 'owner-b',
        });

        await queue.resume();

        expect(execute).not.toHaveBeenCalled();
        expect(queue.getJob('session-1')).toMatchObject({ status: 'queued', ownerId: 'owner-a' });
    });

    it('retries a persisted terminal notification until scheduling succeeds', async () => {
        const { storage } = createStorage();
        const notify = vi.fn()
            .mockRejectedValueOnce(new Error('notification service unavailable'))
            .mockResolvedValueOnce(undefined);
        const queue = createPublicSessionShareQueue({
            storage,
            createId: () => 'job-1',
            execute: async () => ({ publicId: 'public-id', publishedAt: 300 }),
            notify,
        });

        queue.enqueue(input);
        await queue.resume();
        expect(queue.getJob('session-1')).toMatchObject({ status: 'ready', notificationPending: true });

        await queue.resume();
        expect(queue.getJob('session-1')).toMatchObject({ status: 'ready', notificationPending: false });
        expect(notify).toHaveBeenCalledTimes(2);
    });

    it('continues publishing other jobs when a notification cannot be scheduled', async () => {
        const { storage } = createStorage();
        const execute = vi.fn(async (job: PublicSessionShareJob) => ({
            publicId: `public-${job.sessionId}`,
            publishedAt: 300,
        }));
        const queue = createPublicSessionShareQueue({
            storage,
            createId: () => `job-${Math.random()}`,
            execute,
            notify: vi.fn(async () => { throw new Error('notifications denied'); }),
        });

        queue.enqueue(input);
        queue.enqueue({ ...input, sessionId: 'session-2' });
        await queue.resume();

        expect(execute).toHaveBeenCalledTimes(2);
        expect(queue.getJob('session-1')).toMatchObject({ status: 'ready', notificationPending: true });
        expect(queue.getJob('session-2')).toMatchObject({ status: 'ready', notificationPending: true });
    });
});
