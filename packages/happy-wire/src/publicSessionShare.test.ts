import { describe, expect, it } from 'vitest';
import { publicSessionSnapshotSchema } from './publicSessionShare';

const legacySnapshot = {
    version: 1 as const,
    title: 'Release review',
    sharedAt: 1_788_192_000_000,
    presentation: { groupToolCalls: true },
    messages: [{
        id: 'message-1',
        role: 'assistant' as const,
        createdAt: 1_788_192_000_000,
        blocks: [{ type: 'text' as const, markdown: 'Ready.' }],
    }],
};

describe('publicSessionSnapshotSchema', () => {
    it('keeps existing version-one snapshots valid without source metadata', () => {
        expect(publicSessionSnapshotSchema.parse(legacySnapshot).version).toBe(1);
    });

    it('accepts version-two appearance metadata with a registered theme pack', () => {
        const parsed = publicSessionSnapshotSchema.parse({
            ...legacySnapshot,
            version: 2,
            appearance: { themePack: 'sage' },
        });
        expect(parsed).toMatchObject({ appearance: { themePack: 'sage' } });
    });

    it('rejects an unregistered version-two appearance theme pack', () => {
        expect(() => publicSessionSnapshotSchema.parse({
            ...legacySnapshot,
            version: 2,
            appearance: { themePack: 'invented' },
        })).toThrow();
    });

    it('accepts canonical HTTPS Pexels cover attribution', () => {
        const parsed = publicSessionSnapshotSchema.parse({
            ...legacySnapshot,
            version: 2,
            appearance: {
                themePack: 'sage',
                cover: {
                    assetId: '51515151-5151-4515-8515-515151515151',
                    mimeType: 'image/webp',
                    size: 4,
                    width: 2400,
                    height: 900,
                    attribution: {
                        photoId: 2014422,
                        photographer: 'Eberhard Grossgasteiger',
                        photographerUrl: 'https://www.pexels.com/@eberhardgross',
                        photoUrl: 'https://pexels.com/photo/brown-rocks-during-golden-hour-2014422/',
                    },
                },
            },
        });

        expect(parsed).toMatchObject({
            appearance: { cover: { attribution: { photoId: 2014422 } } },
        });
    });

    it.each([
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/avif',
    ])('accepts the safe uploaded-cover MIME type %s', (mimeType) => {
        expect(publicSessionSnapshotSchema.parse({
            ...legacySnapshot,
            version: 2,
            appearance: {
                themePack: 'sage',
                cover: {
                    assetId: '51515151-5151-4515-8515-515151515151',
                    mimeType,
                    size: 4,
                    width: 1,
                    height: 1,
                },
            },
        })).toMatchObject({ appearance: { cover: { mimeType } } });
    });

    it.each([
        'image/svg+xml',
        'image/gif',
        'application/octet-stream',
        'image/unknown',
    ])('rejects the unsafe uploaded-cover MIME type %s', (mimeType) => {
        expect(() => publicSessionSnapshotSchema.parse({
            ...legacySnapshot,
            version: 2,
            appearance: {
                themePack: 'sage',
                cover: {
                    assetId: '51515151-5151-4515-8515-515151515151',
                    mimeType,
                    size: 4,
                    width: 1,
                    height: 1,
                },
            },
        })).toThrow();
    });

    it.each([
        ['arbitrary host', 'https://attacker.example/@photographer'],
        ['plaintext Pexels', 'http://www.pexels.com/@photographer'],
        ['credentialed Pexels', 'https://user:password@www.pexels.com/@photographer'],
        ['non-default Pexels port', 'https://www.pexels.com:8443/@photographer'],
        ['Pexels lookalike', 'https://www.pexels.com.attacker.example/@photographer'],
    ])('rejects %s attribution URLs', (_case, photographerUrl) => {
        expect(() => publicSessionSnapshotSchema.parse({
            ...legacySnapshot,
            version: 2,
            appearance: {
                themePack: 'sage',
                cover: {
                    assetId: '51515151-5151-4515-8515-515151515151',
                    mimeType: 'image/webp',
                    size: 4,
                    width: 2400,
                    height: 900,
                    attribution: {
                        photoId: 2014422,
                        photographer: 'Eberhard Grossgasteiger',
                        photographerUrl,
                        photoUrl: 'https://www.pexels.com/photo/brown-rocks-during-golden-hour-2014422/',
                    },
                },
            },
        })).toThrow();
    });

    it.each(['paws', 'codex', 'claude-code'] as const)('accepts the display-safe %s provider label', (provider) => {
        expect(publicSessionSnapshotSchema.parse({
            ...legacySnapshot,
            source: { provider },
        }).source).toEqual({ provider });
    });

    it('rejects private provider identifiers in source metadata', () => {
        expect(() => publicSessionSnapshotSchema.parse({
            ...legacySnapshot,
            source: { provider: 'codex', sessionId: 'private-session-id' },
        })).toThrow();
    });

    it('preserves the explicit cancelled terminal tool status', () => {
        const snapshot = {
            ...legacySnapshot,
            messages: [{
                id: 'message-cancelled', role: 'assistant' as const, createdAt: 1,
                blocks: [{ type: 'tool' as const, name: 'ShowDemo', status: 'cancelled' as const }],
            }],
        };
        expect(publicSessionSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    });
});
