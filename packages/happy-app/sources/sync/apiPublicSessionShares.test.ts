import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/tokenStorage';
import {
    createPublicSessionShareDraft,
    getPublicSessionAttachmentUrl,
    getPublicSessionShare,
    getPublicSessionShareSnapshot,
    getPublicSessionShareUrl,
    preparePublicSessionShareAsset,
    publishPublicSessionShareDraft,
    revokePublicSessionShare,
    uploadPublicSessionShareAsset,
} from './apiPublicSessionShares';

vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://api.paws.test' }));

const credentials: AuthCredentials = { token: 'owner-token', secret: 'owner-secret' };

describe('apiPublicSessionShares', () => {
    beforeEach(() => {
        vi.stubGlobal('location', { origin: 'https://paws.test' });
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('uses authenticated owner endpoints for state, draft, publish, and revoke', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ active: false, publicId: null, publishedAt: null }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ generation: '11111111-1111-4111-8111-111111111111', publicId: 'public-id' }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ publicId: 'public-id', publishedAt: 123 }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        expect(await getPublicSessionShare(credentials, 'session-1')).toEqual({ active: false, publicId: null, publishedAt: null });
        expect(await createPublicSessionShareDraft(credentials, 'session-1')).toEqual({
            generation: '11111111-1111-4111-8111-111111111111', publicId: 'public-id',
        });
        const snapshot = { version: 1 as const, title: 'Shared', sharedAt: 123, messages: [] };
        expect(await publishPublicSessionShareDraft(credentials, 'session-1', '11111111-1111-4111-8111-111111111111', snapshot)).toEqual({
            publicId: 'public-id', publishedAt: 123,
        });
        await revokePublicSessionShare(credentials, 'session-1');

        for (const call of fetchMock.mock.calls) {
            expect(call[1].headers.Authorization).toBe('Bearer owner-token');
        }
        expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ snapshot });
        expect(fetchMock.mock.calls[3][1].method).toBe('DELETE');
    });

    it('prepares and uploads a plaintext asset through the authenticated Paws server', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                assetId: '22222222-2222-4222-8222-222222222222',
                method: 'PUT',
                uploadUrl: 'http://localhost:3005/local-upload',
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
            .mockResolvedValueOnce(new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const upload = await preparePublicSessionShareAsset(
            credentials,
            'session-1',
            '11111111-1111-4111-8111-111111111111',
            {
                attachmentId: '22222222-2222-4222-8222-222222222222',
                name: 'photo.jpg', mimeType: 'image/jpeg', kind: 'image', size: 5,
            },
            'a'.repeat(64),
        );
        expect(upload.uploadUrl).toBe('https://api.paws.test/local-upload');
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
            attachmentId: '22222222-2222-4222-8222-222222222222',
            name: 'photo.jpg', mimeType: 'image/jpeg', kind: 'image', size: 5,
            sha256: 'a'.repeat(64),
        });
        await uploadPublicSessionShareAsset(upload, new Uint8Array([1, 2, 3, 4, 5]), credentials);
        await expect(uploadPublicSessionShareAsset(
            { ...upload, uploadUrl: 'https://s3.test/signed' },
            new Uint8Array([1]),
            credentials,
        )).rejects.toThrow('untrusted upload origin');

        expect(fetchMock.mock.calls[1][1].headers).toEqual({
            Authorization: 'Bearer owner-token',
            'Content-Type': 'application/octet-stream',
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('builds the browser-facing share URL from the Web origin', () => {
        expect(getPublicSessionShareUrl('public-id')).toBe('https://paws.test/share/public-id');

        vi.stubGlobal('location', { origin: 'tauri://localhost' });
        expect(getPublicSessionShareUrl('public-id')).toBe('https://api.paws.test/share/public-id');
    });

    it('loads a public snapshot and builds public attachment URLs without credentials', async () => {
        const snapshot = { version: 1 as const, title: 'Shared', sharedAt: 123, messages: [] };
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ snapshot, publishedAt: 123 }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        expect(await getPublicSessionShareSnapshot('public-id')).toEqual({ snapshot, publishedAt: 123 });
        expect(fetchMock).toHaveBeenCalledWith('https://paws.test/v1/public/session-shares/public-id', {
            headers: { Accept: 'application/json' },
        });
        expect(getPublicSessionAttachmentUrl('public-id', 'asset-id')).toBe(
            'https://paws.test/v1/public/session-shares/public-id/attachments/asset-id',
        );
    });
});
