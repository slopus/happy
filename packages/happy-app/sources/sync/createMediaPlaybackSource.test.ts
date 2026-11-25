import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMediaPlaybackSource, downloadMediaPlaybackSource } from './createMediaPlaybackSource';

const mocks = vi.hoisted(() => ({
    deleteAsync: vi.fn(async () => undefined),
    downloadAsync: vi.fn(),
    createTask: vi.fn(),
    cancelAsync: vi.fn(async () => undefined),
    makeDirectoryAsync: vi.fn(),
    writeAsStringAsync: vi.fn(),
    writeBytes: vi.fn(),
}));

vi.mock('expo-file-system', () => ({
    File: class MockFile {
        constructor(readonly uri: string) {}
        write(bytes: Uint8Array) { mocks.writeBytes(this.uri, bytes); }
    },
}));

vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: 'file:///cache/',
    deleteAsync: mocks.deleteAsync,
    createDownloadResumable: (source: string, target: string, options: unknown, progress: unknown) => {
        mocks.createTask(source, target, options, progress);
        return { downloadAsync: () => mocks.downloadAsync(source, target, options), cancelAsync: mocks.cancelAsync };
    },
    EncodingType: { Base64: 'base64' },
    makeDirectoryAsync: mocks.makeDirectoryAsync,
    writeAsStringAsync: mocks.writeAsStringAsync,
}));
vi.mock('@/encryption/base64', () => ({ encodeBase64: vi.fn() }));

describe('downloadMediaPlaybackSource', () => {
    afterEach(() => vi.useRealTimers());
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('streams a remote object into a cache file carrying the MIME extension', async () => {
        mocks.downloadAsync.mockImplementation(async (_source: string, target: string) => ({
            uri: target,
            status: 206,
            headers: {},
            mimeType: 'application/octet-stream',
        }));

        const result = await downloadMediaPlaybackSource({
            uri: 'https://files.test/object.enc',
            headers: { Authorization: 'Bearer local-storage-token' },
        }, 'video/mp4');

        const [source, target, options] = mocks.downloadAsync.mock.calls[0];
        expect(source).toBe('https://files.test/object.enc');
        expect(target).toMatch(/^file:\/\/\/cache\/paws-media-.+\.mp4$/);
        expect(options).toEqual({ headers: { Authorization: 'Bearer local-storage-token' } });
        expect(result).toEqual({
            uri: target,
            headers: {},
            release: expect.any(Function),
            retain: expect.any(Function),
        });

        await result.release?.();
        expect(mocks.deleteAsync).toHaveBeenCalledWith(target, { idempotent: true });
    });

    it('deletes a failed download instead of exposing an error response as video', async () => {
        mocks.downloadAsync.mockImplementation(async (_source: string, target: string) => ({
            uri: target,
            status: 403,
            headers: {},
            mimeType: 'text/html',
        }));

        await expect(downloadMediaPlaybackSource({
            uri: 'https://files.test/expired.enc',
            headers: {},
        }, 'video/mp4')).rejects.toThrow('Media download failed: 403');

        const target = mocks.downloadAsync.mock.calls[0][1];
        expect(mocks.deleteAsync).toHaveBeenCalledWith(target, { idempotent: true });
    });

    it('preserves the original PDF filename in a collision-safe cache directory', async () => {
        mocks.downloadAsync.mockImplementation(async (_source: string, target: string) => ({
            uri: target,
            status: 200,
            headers: {},
            mimeType: 'application/pdf',
        }));

        const result = await downloadMediaPlaybackSource({
            uri: 'https://files.test/object.enc',
            headers: {},
        }, 'application/pdf', 'floor-plan.pdf');

        const target = mocks.downloadAsync.mock.calls[0][1];
        expect(target).toMatch(/^file:\/\/\/cache\/paws-media-.+\/floor-plan\.pdf$/);
        const directory = target.slice(0, -'floor-plan.pdf'.length);
        expect(mocks.makeDirectoryAsync).toHaveBeenCalledWith(directory, { intermediates: true });

        await result.release?.();
        expect(mocks.deleteAsync).toHaveBeenCalledWith(directory, { idempotent: true });
    });

    it('reports received bytes and cancels a download that stops making progress', async () => {
        vi.useFakeTimers();
        let rejectDownload!: (reason: unknown) => void;
        mocks.downloadAsync.mockImplementation(() => new Promise((_, reject) => { rejectDownload = reject; }));
        mocks.cancelAsync.mockImplementationOnce(async () => { rejectDownload(new Error('Native download cancelled')); });
        const onProgress = vi.fn();
        const pending = downloadMediaPlaybackSource({ uri: 'https://media.test/slow', headers: {} }, 'video/mp4', 'clip.mp4', { onProgress, stallTimeoutMs: 1000 });
        const failure = pending.catch(error => error);
        await vi.advanceTimersByTimeAsync(900);
        const progress = mocks.createTask.mock.calls[0][3] as (value: any) => void;
        progress({ totalBytesWritten: 512, totalBytesExpectedToWrite: 1024 });
        expect(onProgress).toHaveBeenCalledWith({ bytesWritten: 512, totalBytes: 1024 });
        await vi.advanceTimersByTimeAsync(900);
        expect(mocks.cancelAsync).not.toHaveBeenCalled();
        progress({ totalBytesWritten: 512, totalBytesExpectedToWrite: 1024 });
        await vi.advanceTimersByTimeAsync(100);
        expect(await failure).toMatchObject({ name: 'AttachmentTransferTimeoutError' });
        expect(mocks.cancelAsync).toHaveBeenCalledOnce();
        expect(mocks.downloadAsync).toHaveBeenCalledOnce();
        expect(mocks.deleteAsync).toHaveBeenCalledOnce();
    });

    it('keeps a borrowed playback file alive through saving and releases it exactly once', async () => {
        mocks.downloadAsync.mockImplementation(async (_source, target) => ({ uri: target, status: 200 }));
        const playing = await downloadMediaPlaybackSource({ uri: 'https://media.test/clip', headers: {} }, 'video/mp4');
        const saving = playing.retain!();
        await playing.release!();
        expect(mocks.deleteAsync).not.toHaveBeenCalled();
        await saving.release!();
        await saving.release!();
        expect(mocks.deleteAsync).toHaveBeenCalledOnce();
    });

    it('cancels waiting promptly but deletes the partial file only after native IO settles', async () => {
        let finishNative!: (result: { uri: string; status: number }) => void;
        mocks.downloadAsync.mockImplementationOnce(() => new Promise(resolve => { finishNative = resolve; }));
        const controller = new AbortController();
        const pending = downloadMediaPlaybackSource({ uri: 'https://media.test/clip', headers: {} }, 'video/mp4', undefined, { signal: controller.signal });
        const failure = pending.catch(error => error);
        controller.abort();
        expect(await failure).toMatchObject({ name: 'AbortError' });
        expect(mocks.cancelAsync).toHaveBeenCalledOnce();
        expect(mocks.deleteAsync).not.toHaveBeenCalled();
        const target = mocks.downloadAsync.mock.calls[0][1];
        finishNative({ uri: target, status: 200 });
        await Promise.resolve();
        expect(mocks.deleteAsync).toHaveBeenCalledWith(target, { idempotent: true });
    });
});

describe('createMediaPlaybackSource', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('writes decrypted PDF bytes directly without creating a base64 copy', async () => {
        const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

        const result = await createMediaPlaybackSource(bytes, 'application/pdf', 'floor-plan.pdf');

        expect(mocks.writeBytes).toHaveBeenCalledWith(result.uri, bytes);
        expect(mocks.writeAsStringAsync).not.toHaveBeenCalled();
    });
});
