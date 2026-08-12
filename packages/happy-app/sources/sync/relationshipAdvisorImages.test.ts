import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn(),
    readFileBytes: vi.fn(),
    uploadEncryptedBlob: vi.fn(),
    getCredentials: vi.fn(),
}));

vi.mock('./apiSocket', () => ({ apiSocket: { request: mocks.request } }));
vi.mock('@/utils/readFileBytes', () => ({ readFileBytes: mocks.readFileBytes }));
vi.mock('./apiAttachments', () => ({ uploadEncryptedBlob: mocks.uploadEncryptedBlob }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: mocks.getCredentials } }));

import {
    discardRelationshipAdvisorImages,
    uploadRelationshipAdvisorImage,
    uploadRelationshipAdvisorImages,
} from './relationshipAdvisorImages';

const image = (id: string) => ({
    id,
    uri: `file:///${id}.jpg`,
    width: 100,
    height: 100,
    mimeType: 'image/jpeg',
    size: 3,
    name: `${id}.jpg`,
});

describe('uploadRelationshipAdvisorImage', () => {
    beforeEach(() => vi.clearAllMocks());
    it('uploads normalized image bytes without applying session encryption', async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const upload = {
            ref: 'advisor/user-1/12345678-1234-1234-1234-123456789abc.jpg',
            uploadUrl: 'https://oss.test/upload',
            method: 'POST' as const,
            formFields: { policy: 'signed' },
        };
        mocks.readFileBytes.mockResolvedValue(bytes);
        mocks.getCredentials.mockResolvedValue({ token: 'token', secret: 'secret' });
        mocks.request.mockResolvedValue(new Response(JSON.stringify(upload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));

        const ref = await uploadRelationshipAdvisorImage({
            id: 'image-1',
            uri: 'file:///normalized.jpg',
            width: 1200,
            height: 800,
            mimeType: 'image/jpeg',
            size: 3,
            name: 'chat.jpg',
        });

        expect(ref).toBe(upload.ref);
        expect(mocks.request).toHaveBeenCalledWith('/v1/relationship-advisor/images/request-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mimeType: 'image/jpeg', size: 3 }),
        });
        expect(mocks.uploadEncryptedBlob).toHaveBeenCalledWith(upload, bytes, { token: 'token', secret: 'secret' });
    });

    it('discards temporary refs after a cancelled or failed start', async () => {
        mocks.request.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));
        const refs = ['advisor/user-1/12345678-1234-1234-1234-123456789abc.jpg'];

        await discardRelationshipAdvisorImages(refs);

        expect(mocks.request).toHaveBeenCalledWith('/v1/relationship-advisor/images', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refs }),
        });
    });

    it('cleans already-uploaded refs when a later image upload fails', async () => {
        const upload = vi.fn()
            .mockResolvedValueOnce('advisor/user-1/first.jpg')
            .mockRejectedValueOnce(new Error('upload failed'));
        const discard = vi.fn(async () => undefined);

        await expect(uploadRelationshipAdvisorImages(
            [image('first'), image('second')],
            { isCancelled: () => false },
            { upload, discard },
        )).rejects.toThrow('upload failed');

        expect(discard).toHaveBeenCalledWith(['advisor/user-1/first.jpg']);
    });

    it('stops the batch and cleans refs when cancellation arrives during upload', async () => {
        let cancelled = false;
        const upload = vi.fn(async () => {
            cancelled = true;
            return 'advisor/user-1/first.jpg';
        });
        const discard = vi.fn(async () => undefined);

        const result = await uploadRelationshipAdvisorImages(
            [image('first'), image('second')],
            { isCancelled: () => cancelled },
            { upload, discard },
        );

        expect(result).toBeNull();
        expect(upload).toHaveBeenCalledTimes(1);
        expect(discard).toHaveBeenCalledWith(['advisor/user-1/first.jpg']);
    });
});
