import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveMotionPhotoAttachmentSource } from './resolveMotionPhotoAttachmentSource';

const mocks = vi.hoisted(() => ({
    download: vi.fn(),
    decrypt: vi.fn(),
    createSource: vi.fn(),
}));

vi.mock('./sync', () => ({
    sync: {
        getCredentials: () => ({ token: 'test-token' }),
        encryption: { getSessionBlobKey: () => new Uint8Array(32) },
    },
}));
vi.mock('./apiAttachments', () => ({ downloadEncryptedAttachment: mocks.download }));
vi.mock('@/encryption/blob', () => ({ decryptBlob: mocks.decrypt }));
vi.mock('./createMediaPlaybackSource', () => ({ createMediaPlaybackSource: mocks.createSource }));

function box(type: string, payload: number[]): Uint8Array {
    const output = new Uint8Array(8 + payload.length);
    new DataView(output.buffer).setUint32(0, output.length, false);
    for (let index = 0; index < 4; index += 1) output[4 + index] = type.charCodeAt(index);
    output.set(payload, 8);
    return output;
}

function motionJpeg(): Uint8Array {
    const parts = [
        new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        new TextEncoder().encode('HiHonor_OfflineData\0'),
        box('ftyp', [1, 2, 3, 4]),
        box('mdat', [5, 6, 7]),
        box('moov', [8]),
        box('uuid', [9]),
    ];
    const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) { output.set(part, offset); offset += part.length; }
    return output;
}

describe('resolveMotionPhotoAttachmentSource', () => {
    beforeEach(() => vi.clearAllMocks());

    it('decrypts the JPEG and stages only its playable MP4 boxes', async () => {
        const source = { uri: 'file:///cache/photo.jpg.mp4', headers: {}, release: vi.fn() };
        mocks.download.mockResolvedValue(new Uint8Array([1, 2, 3]));
        mocks.decrypt.mockReturnValue(motionJpeg());
        mocks.createSource.mockResolvedValue(source);

        await expect(resolveMotionPhotoAttachmentSource({
            sessionId: 's1', ref: 'attachment.enc', fileName: 'photo.jpg',
        })).resolves.toBe(source);

        expect(mocks.createSource).toHaveBeenCalledWith(
            expect.objectContaining({ length: 32 }),
            'video/mp4',
            'photo.jpg.mp4',
        );
    });

    it('rejects a message flag when the downloaded JPEG has no motion payload', async () => {
        mocks.download.mockResolvedValue(new Uint8Array([1]));
        mocks.decrypt.mockReturnValue(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
        await expect(resolveMotionPhotoAttachmentSource({
            sessionId: 's1', ref: 'attachment.enc', fileName: 'photo.jpg',
        })).rejects.toThrow('Motion photo data is unavailable');
        expect(mocks.createSource).not.toHaveBeenCalled();
    });
});
