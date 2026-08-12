import { describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/tokenStorage';
import type { AttachmentPreview } from './attachmentTypes';
import { uploadAttachmentForSession } from './uploadAttachmentForSession';

const credentials = {} as AuthCredentials;
const blobKey = new Uint8Array(32);

function attachment(overrides: Partial<AttachmentPreview> = {}): AttachmentPreview {
    return {
        id: 'attachment-1',
        uri: 'file:///tmp/clip.mp4',
        width: 0,
        height: 0,
        mimeType: 'video/mp4',
        size: 1_522_082,
        name: 'clip.mp4',
        kind: 'video',
        ...overrides,
    };
}

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
        box('ftyp', [1]),
        box('mdat', [2]),
        box('moov', [3]),
    ];
    const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) { output.set(part, offset); offset += part.length; }
    return output;
}

describe('uploadAttachmentForSession', () => {
    it('streams video through the media lane and marks the event as plaintext', async () => {
        const requestUpload = vi.fn(async () => ({
            ref: 'sessions/s1/attachments/video-id.mp4',
            uploadUrl: 'https://bucket.example/video-id.mp4',
            method: 'PUT' as const,
        }));
        const uploadMediaFile = vi.fn(async () => undefined);
        const readFileBytes = vi.fn(async () => new Uint8Array([1, 2, 3]));
        const encryptBlob = vi.fn(() => new Uint8Array([4, 5, 6]));
        const uploadEncryptedBlob = vi.fn(async () => undefined);

        const result = await uploadAttachmentForSession({
            credentials,
            sessionId: 's1',
            attachment: attachment(),
        }, {
            requestUpload,
            uploadMediaFile,
            readFileBytes,
            encryptBlob,
            uploadEncryptedBlob,
        });

        expect(requestUpload).toHaveBeenCalledWith(credentials, 's1', 'clip.mp4', 1_522_082, 'video');
        expect(uploadMediaFile).toHaveBeenCalledWith(
            expect.objectContaining({ ref: 'sessions/s1/attachments/video-id.mp4' }),
            'file:///tmp/clip.mp4',
            'video/mp4',
            credentials,
        );
        expect(readFileBytes).not.toHaveBeenCalled();
        expect(encryptBlob).not.toHaveBeenCalled();
        expect(uploadEncryptedBlob).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            ref: 'sessions/s1/attachments/video-id.mp4',
            kind: 'video',
            mimeType: 'video/mp4',
            encrypted: false,
        });
    });

    it('keeps images on the encrypted attachment lane', async () => {
        const requestUpload = vi.fn(async () => ({
            ref: 'sessions/s1/attachments/image-id.enc',
            uploadUrl: 'https://bucket.example',
            method: 'POST' as const,
        }));
        const uploadMediaFile = vi.fn(async () => undefined);
        const readFileBytes = vi.fn(async () => new Uint8Array([1, 2, 3]));
        const encryptBlob = vi.fn(() => new Uint8Array([4, 5, 6, 7]));
        const uploadEncryptedBlob = vi.fn(async () => undefined);

        const result = await uploadAttachmentForSession({
            credentials,
            sessionId: 's1',
            attachment: attachment({
                uri: 'file:///tmp/photo.png',
                width: 640,
                height: 480,
                mimeType: 'image/png',
                size: 3,
                name: 'photo.png',
                kind: 'image',
                thumbhash: 'hash',
            }),
            blobKey,
        }, {
            requestUpload,
            uploadMediaFile,
            readFileBytes,
            encryptBlob,
            uploadEncryptedBlob,
        });

        expect(requestUpload).toHaveBeenCalledWith(credentials, 's1', 'photo.png', 4);
        expect(uploadEncryptedBlob).toHaveBeenCalledWith(
            expect.objectContaining({ ref: 'sessions/s1/attachments/image-id.enc' }),
            new Uint8Array([4, 5, 6, 7]),
            credentials,
        );
        expect(uploadMediaFile).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            ref: 'sessions/s1/attachments/image-id.enc',
            width: 640,
            height: 480,
            thumbhash: 'hash',
        });
        expect(result.encrypted).toBeUndefined();
    });

    it('adds embedded MP4 metadata when uploading an Honor motion photo', async () => {
        const bytes = motionJpeg();
        const result = await uploadAttachmentForSession({
            credentials,
            sessionId: 's1',
            attachment: attachment({
                uri: 'file:///tmp/photo.jpg', width: 1080, height: 1920,
                mimeType: 'image/jpeg', size: bytes.length, name: 'photo.jpg', kind: 'image',
            }),
            blobKey,
        }, {
            requestUpload: vi.fn(async () => ({
                ref: 'sessions/s1/attachments/photo.enc', uploadUrl: 'https://bucket.example', method: 'POST' as const,
            })),
            uploadMediaFile: vi.fn(),
            readFileBytes: vi.fn(async () => bytes),
            encryptBlob: vi.fn(() => new Uint8Array([1, 2, 3])),
            uploadEncryptedBlob: vi.fn(async () => undefined),
        });

        expect(result.motionPhoto).toMatchObject({ mimeType: 'video/mp4', videoLength: 27 });
    });

    it('keeps PDF documents encrypted and preserves their file metadata', async () => {
        const requestUpload = vi.fn(async () => ({
            ref: 'sessions/s1/attachments/pdf-id.enc',
            uploadUrl: 'https://bucket.example',
            method: 'POST' as const,
        }));
        const uploadMediaFile = vi.fn(async () => undefined);
        const readFileBytes = vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]));
        const encryptBlob = vi.fn(() => new Uint8Array([4, 5, 6, 7, 8]));
        const uploadEncryptedBlob = vi.fn(async () => undefined);

        const result = await uploadAttachmentForSession({
            credentials,
            sessionId: 's1',
            attachment: attachment({
                uri: 'file:///tmp/floor-plan.pdf',
                mimeType: 'application/pdf',
                size: 4,
                name: 'floor-plan.pdf',
                kind: 'file' as any,
            }),
            blobKey,
        }, {
            requestUpload,
            uploadMediaFile,
            readFileBytes,
            encryptBlob,
            uploadEncryptedBlob,
        });

        expect(requestUpload).toHaveBeenCalledWith(credentials, 's1', 'floor-plan.pdf', 5);
        expect(uploadEncryptedBlob).toHaveBeenCalledWith(
            expect.objectContaining({ ref: 'sessions/s1/attachments/pdf-id.enc' }),
            new Uint8Array([4, 5, 6, 7, 8]),
            credentials,
        );
        expect(uploadMediaFile).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            ref: 'sessions/s1/attachments/pdf-id.enc',
            kind: 'file',
            mimeType: 'application/pdf',
        });
        expect(result.encrypted).toBeUndefined();
    });

    it('rejects a PDF whose actual bytes exceed the encrypted file limit', async () => {
        const readFileBytes = vi.fn(async () => new Uint8Array(10 * 1024 * 1024 + 1));
        const encryptBlob = vi.fn(() => new Uint8Array([1]));
        const requestUpload = vi.fn(async () => ({
            ref: 'sessions/s1/attachments/oversized.enc',
            uploadUrl: 'https://bucket.example',
            method: 'POST' as const,
        }));

        await expect(uploadAttachmentForSession({
            credentials,
            sessionId: 's1',
            attachment: attachment({
                uri: 'file:///tmp/oversized.pdf',
                mimeType: 'application/pdf',
                size: 0,
                name: 'oversized.pdf',
                kind: 'file' as any,
            }),
            blobKey,
        }, {
            requestUpload,
            uploadMediaFile: vi.fn(),
            readFileBytes,
            encryptBlob,
            uploadEncryptedBlob: vi.fn(),
        })).rejects.toThrow('PDF attachment is too large');

        expect(encryptBlob).not.toHaveBeenCalled();
        expect(requestUpload).not.toHaveBeenCalled();
        expect(readFileBytes).toHaveBeenCalledWith('file:///tmp/oversized.pdf', 10 * 1024 * 1024);
    });

    it('requires a blob key only for encrypted images', async () => {
        await expect(uploadAttachmentForSession({
            credentials,
            sessionId: 's1',
            attachment: attachment({
                uri: 'file:///tmp/photo.png',
                mimeType: 'image/png',
                name: 'photo.png',
                kind: 'image',
            }),
        }, {
            requestUpload: vi.fn(),
            uploadMediaFile: vi.fn(),
            readFileBytes: vi.fn(),
            encryptBlob: vi.fn(),
            uploadEncryptedBlob: vi.fn(),
        })).rejects.toThrow('Attachment encryption key is unavailable for photo.png');
    });
});
