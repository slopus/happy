import * as crypto from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { PublicSessionCover } from './publicSessionShareSchemas';
import {
    assertSafeDecodedCoverMetadata,
    validateUploadedPublicSessionCover,
} from './publicSessionShareAssetValidation';

async function imageFixture(format: 'jpeg' | 'png' | 'webp' | 'avif', width = 3, height = 2): Promise<Buffer> {
    return sharp({
        create: { width, height, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
    }).toFormat(format).toBuffer();
}

function fixtureCover(bytes: Buffer, overrides: Partial<PublicSessionCover> = {}): PublicSessionCover {
    return {
        assetId: '51515151-5151-4515-8515-515151515151',
        mimeType: 'image/png',
        size: bytes.length,
        width: 3,
        height: 2,
        ...overrides,
    };
}

function fixtureAsset(bytes: Buffer, overrides: Record<string, unknown> = {}) {
    return {
        id: '51515151-5151-4515-8515-515151515151',
        kind: 'image',
        mimeType: 'image/png',
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        storagePath: 'private/session-shares/share/generation/cover',
        ...overrides,
    };
}

describe('uploaded public-session cover validation', () => {
    it.each([
        ['jpeg', 'image/jpeg'],
        ['png', 'image/png'],
        ['webp', 'image/webp'],
        ['avif', 'image/avif'],
    ] as const)('decodes a bounded single-page %s whose bytes match its snapshot', async (format, mimeType) => {
        const bytes = await imageFixture(format);
        await expect(validateUploadedPublicSessionCover({
            cover: fixtureCover(bytes, { mimeType }),
            asset: fixtureAsset(bytes, { mimeType }),
            readBytes: async () => bytes,
        })).resolves.toBeUndefined();
    });

    it.each([
        ['byte count', (bytes: Buffer) => ({ cover: fixtureCover(bytes), asset: fixtureAsset(bytes), read: bytes.subarray(0, -1) })],
        ['hash', (bytes: Buffer) => ({ cover: fixtureCover(bytes), asset: fixtureAsset(bytes, { sha256: '0'.repeat(64) }), read: bytes })],
        ['declared MIME', (bytes: Buffer) => ({ cover: fixtureCover(bytes, { mimeType: 'image/jpeg' }), asset: fixtureAsset(bytes, { mimeType: 'image/jpeg' }), read: bytes })],
        ['dimensions', (bytes: Buffer) => ({ cover: fixtureCover(bytes, { width: 4 }), asset: fixtureAsset(bytes), read: bytes })],
        ['decode', (bytes: Buffer) => ({ cover: fixtureCover(bytes), asset: fixtureAsset(bytes), read: Buffer.alloc(bytes.length, 1) })],
    ])('rejects a cover with invalid %s', async (_case, build) => {
        const bytes = await imageFixture('png');
        const fixture = build(bytes);
        await expect(validateUploadedPublicSessionCover({
            cover: fixture.cover,
            asset: fixture.asset,
            readBytes: async () => fixture.read,
        })).rejects.toThrow('Shared cover validation failed');
    });

    it('rejects animation and decompression-bomb metadata before pixel decode', () => {
        expect(() => assertSafeDecodedCoverMetadata({
            format: 'webp', width: 3, height: 4, pages: 2, autoOrient: { width: 3, height: 2 },
        }, fixtureCover(Buffer.alloc(1), { mimeType: 'image/webp', size: 1 }))).toThrow('Shared cover validation failed');
        expect(() => assertSafeDecodedCoverMetadata({
            format: 'png', width: 10_000, height: 10_000, pages: 1, autoOrient: { width: 10_000, height: 10_000 },
        }, fixtureCover(Buffer.alloc(1), { size: 1, width: 10_000, height: 10_000 }))).toThrow('Shared cover validation failed');
    });
});
