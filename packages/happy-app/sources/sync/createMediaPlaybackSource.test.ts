import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadMediaPlaybackSource } from './createMediaPlaybackSource';

const mocks = vi.hoisted(() => ({
    deleteAsync: vi.fn(),
    downloadAsync: vi.fn(),
    writeAsStringAsync: vi.fn(),
}));

vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: 'file:///cache/',
    deleteAsync: mocks.deleteAsync,
    downloadAsync: mocks.downloadAsync,
    EncodingType: { Base64: 'base64' },
    writeAsStringAsync: mocks.writeAsStringAsync,
}));
vi.mock('@/encryption/base64', () => ({ encodeBase64: vi.fn() }));

describe('downloadMediaPlaybackSource', () => {
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
});
