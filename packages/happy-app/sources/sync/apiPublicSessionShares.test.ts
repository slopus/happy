import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/tokenStorage';
import {
    createPublicSessionShareDraft,
    clonePublicSessionCover,
    getRandomPublicSessionCover,
    getPublicSessionAttachmentUrl,
    getPublicSessionShare,
    getPublicSessionShareSnapshot,
    getPublicSessionShareUrl,
    importPublicSessionPexelsCover,
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

    it('loads a display-safe random candidate and imports only its photo id into a draft', async () => {
        const candidate = {
            provider: 'pexels' as const,
            photoId: 123,
            previewUrl: 'https://images.pexels.com/photos/123/preview.jpeg',
            width: 2400,
            height: 900,
            averageColor: '#123456',
            attribution: {
                photographer: 'Ada Lovelace',
                photographerUrl: 'https://www.pexels.com/@ada',
                photoUrl: 'https://www.pexels.com/photo/123',
            },
        };
        const canonicalCover = {
            assetId: '22222222-2222-4222-8222-222222222222',
            mimeType: 'image/webp',
            size: 4321,
            width: 2400,
            height: 900,
            attribution: {
                photoId: 123,
                photographer: 'Canonical Ada',
                photographerUrl: 'https://www.pexels.com/@canonical-ada',
                photoUrl: 'https://www.pexels.com/photo/123-canonical',
            },
        };
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify(candidate), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify(canonicalCover), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        expect(await getRandomPublicSessionCover(credentials, 'session / 1')).toEqual(candidate);
        expect(await importPublicSessionPexelsCover(
            credentials,
            'session / 1',
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
            candidate.photoId,
        )).toEqual(canonicalCover);

        expect(fetchMock.mock.calls[0]).toEqual([
            'https://api.paws.test/v1/sessions/session%20%2F%201/share/covers/random',
            { headers: { Authorization: 'Bearer owner-token' } },
        ]);
        expect(fetchMock.mock.calls[1][0]).toBe(
            'https://api.paws.test/v1/sessions/session%20%2F%201/share/drafts/11111111-1111-4111-8111-111111111111/covers/import',
        );
        expect(fetchMock.mock.calls[1][1].headers).toEqual({
            Authorization: 'Bearer owner-token',
            'Content-Type': 'application/json',
        });
        expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
            assetId: '22222222-2222-4222-8222-222222222222',
            photoId: 123,
        });
    });

    it('rejects malformed, extra, or non-allowlisted random candidate data before render', async () => {
        const valid = {
            provider: 'pexels',
            photoId: 123,
            previewUrl: 'https://images.pexels.com/photos/123/preview.jpeg',
            width: 2400,
            height: 900,
            averageColor: '#123456',
            attribution: {
                photographer: 'Ada Lovelace',
                photographerUrl: 'https://www.pexels.com/@ada',
                photoUrl: 'https://pexels.com/photo/123',
            },
        };
        const invalidCandidates = [
            { ...valid, previewUrl: 'http://images.pexels.com/photos/123/preview.jpeg' },
            { ...valid, previewUrl: 'https://images.pexels.com.attacker.invalid/preview.jpeg' },
            { ...valid, attribution: { ...valid.attribution, photographerUrl: 'http://www.pexels.com/@ada' } },
            { ...valid, attribution: { ...valid.attribution, photoUrl: 'https://attacker.invalid/photo/123' } },
            { ...valid, extra: 'untrusted' },
            { ...valid, attribution: { ...valid.attribution, extra: 'untrusted' } },
        ];

        for (const candidate of invalidCandidates) {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(candidate), { status: 200 })));
            await expect(getRandomPublicSessionCover(credentials, 'session-1')).rejects.toThrow();
        }
    });

    it('asks the authenticated server to clone only an existing active asset id', async () => {
        const canonicalCover = {
            assetId: '51515151-5151-4515-8515-515151515151',
            mimeType: 'image/jpeg',
            size: 5,
            width: 1200,
            height: 600,
        };
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(canonicalCover), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        expect(await clonePublicSessionCover(
            credentials,
            'session / 1',
            '11111111-1111-4111-8111-111111111111',
            canonicalCover.assetId,
        )).toEqual(canonicalCover);
        expect(fetchMock.mock.calls[0][0]).toBe(
            'https://api.paws.test/v1/sessions/session%20%2F%201/share/drafts/11111111-1111-4111-8111-111111111111/covers/clone',
        );
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ assetId: canonicalCover.assetId });
        expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer owner-token');
    });

    it('builds the browser-facing share URL from the Web origin', () => {
        expect(getPublicSessionShareUrl('public-id')).toBe('https://paws.test/share/public-id');

        vi.stubGlobal('location', { origin: 'tauri://localhost' });
        expect(getPublicSessionShareUrl('public-id')).toBe('https://api.paws.test/share/public-id');

        vi.stubGlobal('location', undefined);
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
