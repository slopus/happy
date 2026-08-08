import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveMediaAttachmentSource } from './resolveMediaAttachmentSource';

const mocks = vi.hoisted(() => ({
    requestDownloadSource: vi.fn(),
    downloadEncryptedAttachment: vi.fn(),
    createMediaPlaybackSource: vi.fn(),
    downloadMediaPlaybackSource: vi.fn(),
}));

vi.mock('./sync', () => ({
    sync: {
        getCredentials: () => ({ token: 'test-token' }),
        encryption: { getSessionBlobKey: () => new Uint8Array(32) },
    },
}));
vi.mock('./apiAttachments', () => ({
    requestAttachmentDownloadSource: mocks.requestDownloadSource,
    downloadEncryptedAttachment: mocks.downloadEncryptedAttachment,
}));
vi.mock('./createMediaPlaybackSource', () => ({
    createMediaPlaybackSource: mocks.createMediaPlaybackSource,
    downloadMediaPlaybackSource: mocks.downloadMediaPlaybackSource,
}));
vi.mock('@/encryption/blob', () => ({ decryptBlob: vi.fn(() => new Uint8Array([4, 5, 6])) }));

describe('resolveMediaAttachmentSource native media staging', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('downloads generated MP4s into a typed local cache file before native playback', async () => {
        const remote = {
            uri: 'https://files.test/object-without-video-extension.enc',
            headers: { Authorization: 'Bearer local-storage-token' },
        };
        const local = {
            uri: 'file:///cache/paws-media-acceptance.mp4',
            headers: {},
            release: vi.fn(),
        };
        mocks.requestDownloadSource.mockResolvedValue(remote);
        mocks.downloadMediaPlaybackSource.mockResolvedValue(local);

        const result = await resolveMediaAttachmentSource({
            sessionId: 'session-1',
            ref: 'sessions/session-1/attachments/object.enc',
            mimeType: 'video/mp4',
            encrypted: false,
        });

        expect(mocks.requestDownloadSource).toHaveBeenCalledWith(
            { token: 'test-token' },
            'session-1',
            'sessions/session-1/attachments/object.enc',
        );
        expect(mocks.downloadMediaPlaybackSource).toHaveBeenCalledWith(remote, 'video/mp4');
        expect(result).toBe(local);
    });

    it('forwards a PDF filename to encrypted cache staging', async () => {
        const local = {
            uri: 'file:///cache/unique/floor-plan.pdf',
            headers: {},
            release: vi.fn(),
        };
        mocks.downloadEncryptedAttachment.mockResolvedValue(new Uint8Array([1, 2, 3]));
        mocks.createMediaPlaybackSource.mockResolvedValue(local);

        const result = await resolveMediaAttachmentSource({
            sessionId: 'session-1',
            ref: 'sessions/session-1/attachments/floor-plan.enc',
            mimeType: 'application/pdf',
            fileName: 'floor-plan.pdf',
        });

        expect(mocks.createMediaPlaybackSource).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            'application/pdf',
            'floor-plan.pdf',
        );
        expect(result).toBe(local);
    });
});
