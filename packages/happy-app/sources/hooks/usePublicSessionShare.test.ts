import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import {
    loadCompleteSessionMessages,
    loadSessionMessagesThroughSequence,
    publishPublicSessionSnapshot,
    type PublicSessionPublishDependencies,
} from '@/sync/publicSessionSharePublishing';

describe('public session share publishing', () => {
    const pexelsCover = {
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
    } as const;

    it('loads older pages until the complete history is present', async () => {
        const first: Message = { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, text: 'first' };
        const second: Message = { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, text: 'second' };
        let state: { messages: Message[]; hasMoreOlder: boolean } = { messages: [second], hasMoreOlder: true };
        const loadOlder = vi.fn(async () => {
            state = { messages: [first, second], hasMoreOlder: false };
        });

        const messages = await loadCompleteSessionMessages('session-1', {
            ensureMessagesLoaded: vi.fn(async () => undefined),
            loadOlderMessages: loadOlder,
            getMessageState: () => state,
        });

        expect(messages).toEqual([first, second]);
        expect(loadOlder).toHaveBeenCalledOnce();
    });

    it('waits when background prefetch temporarily owns the older-page load', async () => {
        const first: Message = { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, text: 'first' };
        const second: Message = { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, text: 'second' };
        let state: { messages: Message[]; hasMoreOlder: boolean } = { messages: [second], hasMoreOlder: true };
        let attempts = 0;
        const loadOlder = vi.fn(async () => {
            attempts += 1;
            if (attempts === 3) {
                state = { messages: [first, second], hasMoreOlder: false };
            }
        });

        const messages = await loadCompleteSessionMessages('session-1', {
            ensureMessagesLoaded: vi.fn(async () => undefined),
            loadOlderMessages: loadOlder,
            getMessageState: () => state,
        });

        expect(messages).toEqual([first, second]);
        expect(loadOlder).toHaveBeenCalledTimes(3);
    });

    it('uploads every decrypted attachment before atomically publishing', async () => {
        const events: string[] = [];
        const message: Message = {
            kind: 'tool-call', id: 'file-1', localId: null, createdAt: 1,
            tool: {
                name: 'file', state: 'completed', input: {
                    ref: 'sessions/s1/attachments/photo.enc', name: 'photo.jpg', size: 3,
                    kind: 'image', mimeType: 'image/jpeg', encrypted: true,
                },
                description: null, createdAt: 1, startedAt: 1, completedAt: 1,
            }, children: [],
        };
        const deps: PublicSessionPublishDependencies = {
            loadMessages: vi.fn(async () => [message]),
            createDraft: vi.fn(async () => ({ generation: 'generation-1', publicId: 'public-id' })),
            loadAttachmentBytes: vi.fn(async () => { events.push('decrypt'); return new Uint8Array([1, 2, 3]); }),
            prepareAsset: vi.fn(async (_generation, asset, sha256) => {
                events.push('prepare');
                expect(sha256).toBe('a'.repeat(64));
                return { assetId: asset.attachmentId, method: 'PUT' as const, uploadUrl: 'https://upload.test' };
            }),
            uploadAsset: vi.fn(async () => { events.push('upload'); }),
            publishDraft: vi.fn(async () => { events.push('publish'); return { publicId: 'public-id', publishedAt: 123 }; }),
            createAttachmentId: () => '11111111-1111-4111-8111-111111111111',
            hashAttachmentBytes: vi.fn(async () => 'a'.repeat(64)),
        };

        const result = await publishPublicSessionSnapshot({ sessionId: 'session-1', title: 'Title', sharedAt: 123 }, deps);

        expect(result).toEqual({ publicId: 'public-id', publishedAt: 123 });
        expect(events).toEqual(['decrypt', 'prepare', 'upload', 'publish']);
    });

    it('never publishes a partial snapshot after one attachment upload fails', async () => {
        const message: Message = {
            kind: 'tool-call', id: 'file-1', localId: null, createdAt: 1,
            tool: {
                name: 'file', state: 'completed', input: {
                    ref: 'sessions/s1/attachments/photo.enc', name: 'photo.jpg', size: 3,
                    kind: 'image', mimeType: 'image/jpeg', encrypted: true,
                },
                description: null, createdAt: 1, startedAt: 1, completedAt: 1,
            }, children: [],
        };
        const publishDraft = vi.fn(async () => ({ publicId: 'public-id', publishedAt: 123 }));
        const deps: PublicSessionPublishDependencies = {
            loadMessages: vi.fn(async () => [message]),
            createDraft: vi.fn(async () => ({ generation: 'generation-1', publicId: 'public-id' })),
            loadAttachmentBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
            prepareAsset: vi.fn(async (_generation, asset) => ({ assetId: asset.attachmentId, method: 'PUT' as const, uploadUrl: 'https://upload.test' })),
            uploadAsset: vi.fn(async () => { throw new Error('upload failed'); }),
            publishDraft,
            createAttachmentId: () => '11111111-1111-4111-8111-111111111111',
            hashAttachmentBytes: vi.fn(async () => 'a'.repeat(64)),
        };

        await expect(publishPublicSessionSnapshot({ sessionId: 'session-1', title: 'Title', sharedAt: 123 }, deps)).rejects.toThrow('upload failed');
        expect(publishDraft).not.toHaveBeenCalled();
    });

    it('imports a Pexels cover after draft creation and publishes only canonical server metadata', async () => {
        const events: string[] = [];
        let publishedSnapshot: unknown;
        const deps: PublicSessionPublishDependencies = {
            loadMessages: vi.fn(async () => []),
            createDraft: vi.fn(async () => {
                events.push('draft');
                return { generation: 'generation-1', publicId: 'public-id' };
            }),
            loadAttachmentBytes: vi.fn(),
            prepareAsset: vi.fn(),
            uploadAsset: vi.fn(),
            importPexelsCover: vi.fn(async (generation, assetId, photoId) => {
                events.push('import');
                expect({ generation, assetId, photoId }).toEqual({
                    generation: 'generation-1',
                    assetId: '11111111-1111-4111-8111-111111111111',
                    photoId: 123,
                });
                return pexelsCover;
            }),
            publishDraft: vi.fn(async (_generation, snapshot) => {
                events.push('publish');
                publishedSnapshot = snapshot;
                return { publicId: 'public-id', publishedAt: 123 };
            }),
        };

        await publishPublicSessionSnapshot({
            sessionId: 'session-1',
            jobId: '11111111-1111-4111-8111-111111111111',
            title: 'Title',
            sharedAt: 123,
            themePack: 'sakura',
            coverSelection: { kind: 'pexels', photoId: 123 },
        }, deps);

        expect(events).toEqual(['draft', 'import', 'publish']);
        expect(publishedSnapshot).toEqual({
            version: 2,
            title: 'Title',
            sharedAt: 123,
            presentation: { groupToolCalls: true },
            appearance: { themePack: 'sakura', cover: pexelsCover },
            messages: [],
        });
        expect(JSON.stringify(publishedSnapshot)).not.toContain('images.pexels.com');
    });

    it('clones a cross-device active cover after draft creation and publishes only the canonical response', async () => {
        const events: string[] = [];
        const existingCover = {
            assetId: '51515151-5151-4515-8515-515151515151',
            mimeType: 'image/jpeg',
            size: 5,
            width: 1200,
            height: 600,
        } as const;
        let publishedSnapshot: unknown;
        const deps: PublicSessionPublishDependencies = {
            loadMessages: vi.fn(async () => []),
            createDraft: vi.fn(async () => {
                events.push('draft');
                return { generation: 'generation-1', publicId: 'public-id' };
            }),
            loadAttachmentBytes: vi.fn(),
            prepareAsset: vi.fn(),
            uploadAsset: vi.fn(),
            cloneExistingCover: vi.fn(async (generation, assetId) => {
                events.push('clone');
                expect({ generation, assetId }).toEqual({
                    generation: 'generation-1',
                    assetId: existingCover.assetId,
                });
                return existingCover;
            }),
            publishDraft: vi.fn(async (_generation, snapshot) => {
                events.push('publish');
                publishedSnapshot = snapshot;
                return { publicId: 'public-id', publishedAt: 123 };
            }),
        };

        await publishPublicSessionSnapshot({
            sessionId: 'session-1',
            title: 'Title',
            sharedAt: 123,
            themePack: 'gingham',
            coverSelection: { kind: 'existing', assetId: existingCover.assetId },
        }, deps);

        expect(events).toEqual(['draft', 'clone', 'publish']);
        expect(publishedSnapshot).toMatchObject({
            appearance: { themePack: 'gingham', cover: existingCover },
        });
    });

    it('stops before publish when preserving an existing cover fails', async () => {
        const publishDraft = vi.fn();
        const deps: PublicSessionPublishDependencies = {
            loadMessages: vi.fn(async () => []),
            createDraft: vi.fn(async () => ({ generation: 'generation-1', publicId: 'public-id' })),
            loadAttachmentBytes: vi.fn(),
            prepareAsset: vi.fn(),
            uploadAsset: vi.fn(),
            cloneExistingCover: vi.fn(async () => { throw new Error('clone failed'); }),
            publishDraft,
        };

        await expect(publishPublicSessionSnapshot({
            sessionId: 'session-1',
            title: 'Title',
            sharedAt: 123,
            coverSelection: { kind: 'existing', assetId: '51515151-5151-4515-8515-515151515151' },
        }, deps)).rejects.toThrow('clone failed');
        expect(publishDraft).not.toHaveBeenCalled();
    });

    it('reads and uploads a local cover through the asset path and counts it in progress', async () => {
        const events: string[] = [];
        const progress: Array<[number, number]> = [];
        let publishedSnapshot: unknown;
        const coverSelection = {
            kind: 'upload' as const,
            attachmentId: '22222222-2222-4222-8222-222222222222',
            uri: 'file:///tmp/cover.webp',
            name: 'cover.webp',
            mimeType: 'image/webp' as const,
            size: 3,
            width: 1600,
            height: 600,
            thumbhash: 'safe-thumbhash',
        };
        const deps: PublicSessionPublishDependencies = {
            loadMessages: vi.fn(async () => []),
            createDraft: vi.fn(async () => ({ generation: 'generation-1', publicId: 'public-id' })),
            loadAttachmentBytes: vi.fn(),
            loadCoverBytes: vi.fn(async (selection) => {
                events.push('read-cover');
                expect(selection).toEqual(coverSelection);
                return new Uint8Array([1, 2, 3, 4]);
            }),
            prepareAsset: vi.fn(async (generation, asset, sha256) => {
                events.push('prepare-cover');
                expect(generation).toBe('generation-1');
                expect(asset).toMatchObject({
                    attachmentId: coverSelection.attachmentId,
                    name: 'cover.webp',
                    mimeType: 'image/webp',
                    kind: 'image',
                    size: 4,
                });
                expect(sha256).toBe('b'.repeat(64));
                return { assetId: asset.attachmentId, method: 'PUT' as const, uploadUrl: 'https://upload.test' };
            }),
            uploadAsset: vi.fn(async (_upload, bytes) => {
                events.push('upload-cover');
                expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
            }),
            publishDraft: vi.fn(async (_generation, snapshot) => {
                events.push('publish');
                publishedSnapshot = snapshot;
                return { publicId: 'public-id', publishedAt: 123 };
            }),
            hashAttachmentBytes: vi.fn(async () => 'b'.repeat(64)),
            onProgress: (completed, total) => progress.push([completed, total]),
        };

        await publishPublicSessionSnapshot({
            sessionId: 'session-1',
            jobId: '11111111-1111-4111-8111-111111111111',
            title: 'Title',
            sharedAt: 123,
            themePack: 'terminal',
            coverSelection,
        }, deps);

        expect(events).toEqual(['read-cover', 'prepare-cover', 'upload-cover', 'publish']);
        expect(progress).toEqual([[0, 1], [1, 1]]);
        expect(publishedSnapshot).toMatchObject({
            version: 2,
            appearance: {
                themePack: 'terminal',
                cover: {
                    assetId: coverSelection.attachmentId,
                    mimeType: 'image/webp',
                    size: 4,
                    width: 1600,
                    height: 600,
                    thumbhash: 'safe-thumbhash',
                },
            },
        });
    });

    it('stops before publish when Pexels cover preparation fails', async () => {
        const publishDraft = vi.fn();
        const deps: PublicSessionPublishDependencies = {
            loadMessages: vi.fn(async () => []),
            createDraft: vi.fn(async () => ({ generation: 'generation-1', publicId: 'public-id' })),
            loadAttachmentBytes: vi.fn(),
            prepareAsset: vi.fn(),
            uploadAsset: vi.fn(),
            importPexelsCover: vi.fn(async () => { throw new Error('Pexels import failed'); }),
            publishDraft,
        };

        await expect(publishPublicSessionSnapshot({
            sessionId: 'session-1',
            jobId: '11111111-1111-4111-8111-111111111111',
            title: 'Title',
            sharedAt: 123,
            themePack: 'caramel',
            coverSelection: { kind: 'pexels', photoId: 123 },
        }, deps)).rejects.toThrow('Pexels import failed');
        expect(publishDraft).not.toHaveBeenCalled();
    });

    it('stops before asset preparation and publish when local cover bytes are unavailable', async () => {
        const prepareAsset = vi.fn();
        const publishDraft = vi.fn();
        const deps: PublicSessionPublishDependencies = {
            loadMessages: vi.fn(async () => []),
            createDraft: vi.fn(async () => ({ generation: 'generation-1', publicId: 'public-id' })),
            loadAttachmentBytes: vi.fn(),
            loadCoverBytes: vi.fn(async () => { throw new Error('Local cover unavailable'); }),
            prepareAsset,
            uploadAsset: vi.fn(),
            publishDraft,
        };

        await expect(publishPublicSessionSnapshot({
            sessionId: 'session-1',
            jobId: '11111111-1111-4111-8111-111111111111',
            title: 'Title',
            sharedAt: 123,
            themePack: 'caramel',
            coverSelection: {
                kind: 'upload',
                attachmentId: '22222222-2222-4222-8222-222222222222',
                uri: 'file:///missing.webp',
                name: 'missing.webp',
                mimeType: 'image/webp',
                size: 123,
                width: 1600,
                height: 600,
            },
        }, deps)).rejects.toThrow('Local cover unavailable');
        expect(prepareAsset).not.toHaveBeenCalled();
        expect(publishDraft).not.toHaveBeenCalled();
    });

    it('rejects an empty local cover before asset preparation or publish', async () => {
        const prepareAsset = vi.fn();
        const uploadAsset = vi.fn();
        const publishDraft = vi.fn();
        const deps: PublicSessionPublishDependencies = {
            loadMessages: vi.fn(async () => []),
            createDraft: vi.fn(async () => ({ generation: 'generation-1', publicId: 'public-id' })),
            loadAttachmentBytes: vi.fn(),
            loadCoverBytes: vi.fn(async () => new Uint8Array()),
            prepareAsset,
            uploadAsset,
            publishDraft,
        };

        await expect(publishPublicSessionSnapshot({
            sessionId: 'session-1',
            jobId: '11111111-1111-4111-8111-111111111111',
            title: 'Title',
            sharedAt: 123,
            themePack: 'caramel',
            coverSelection: {
                kind: 'upload',
                attachmentId: '22222222-2222-4222-8222-222222222222',
                uri: 'file:///empty.webp',
                name: 'empty.webp',
                mimeType: 'image/webp',
                size: 123,
                width: 1600,
                height: 600,
            },
        }, deps)).rejects.toThrow('Public session cover is empty');
        expect(prepareAsset).not.toHaveBeenCalled();
        expect(uploadAsset).not.toHaveBeenCalled();
        expect(publishDraft).not.toHaveBeenCalled();
    });

    it('keeps the resumed publication pinned to messages that existed when sharing was requested', async () => {
        const loadPage = vi.fn(async () => ({
            hasMore: false,
            messages: [
                {
                    seq: 43,
                    normalized: {
                        id: 'after', localId: null, createdAt: 50, isSidechain: false,
                        role: 'agent' as const,
                        content: [{ type: 'text' as const, text: 'after tap despite an older desktop clock', uuid: 'after', parentUUID: null }],
                    },
                },
                {
                    seq: 42,
                    normalized: {
                        id: 'before', localId: null, createdAt: 100, isSidechain: false,
                        role: 'user' as const,
                        content: { type: 'text' as const, text: 'before tap' },
                    },
                },
            ],
        }));

        const messages = await loadSessionMessagesThroughSequence(42, { loadPage });

        expect(loadPage).toHaveBeenCalledWith(43);
        expect(messages).toEqual([
            expect.objectContaining({ kind: 'user-text', text: 'before tap' }),
        ]);
    });

    it('does not apply a later tool result to a tool captured by the sequence cursor', async () => {
        const messages = await loadSessionMessagesThroughSequence(1, {
            loadPage: async () => ({
                hasMore: false,
                messages: [
                    {
                        seq: 2,
                        normalized: {
                            id: 'tool-result', localId: null, createdAt: 50, isSidechain: false,
                            role: 'agent',
                            content: [{
                                type: 'tool-result', tool_use_id: 'tool-1', content: 'later output', is_error: false,
                                uuid: 'tool-result', parentUUID: null,
                            }],
                        },
                    },
                    {
                        seq: 1,
                        normalized: {
                            id: 'tool-call', localId: null, createdAt: 100, isSidechain: false,
                            role: 'agent',
                            content: [{
                                type: 'tool-call', id: 'tool-1', name: 'Bash', input: { command: 'test' },
                                description: null, uuid: 'tool-call', parentUUID: null,
                            }],
                        },
                    },
                ],
            }),
        });

        expect(messages).toEqual([
            expect.objectContaining({ kind: 'tool-call', tool: expect.objectContaining({ state: 'running' }) }),
        ]);
    });

    it('stops before publishing when the queued job was cancelled during attachment upload', async () => {
        const message: Message = {
            kind: 'tool-call', id: 'file-1', localId: null, createdAt: 100,
            tool: {
                name: 'file', state: 'completed', input: {
                    ref: 'sessions/s1/attachments/photo.enc', name: 'photo.jpg', size: 3,
                    kind: 'image', mimeType: 'image/jpeg', encrypted: true,
                },
                description: null, createdAt: 100, startedAt: 100, completedAt: 100,
            }, children: [],
        };
        let cancelled = false;
        const publishDraft = vi.fn(async () => ({ publicId: 'public-id', publishedAt: 300 }));
        const deps: PublicSessionPublishDependencies = {
            loadMessages: vi.fn(async () => [message]),
            createDraft: vi.fn(async () => ({ generation: 'generation-1', publicId: 'public-id' })),
            loadAttachmentBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
            prepareAsset: vi.fn(async (_generation, asset) => ({
                assetId: asset.attachmentId, method: 'PUT' as const, uploadUrl: 'https://upload.test',
            })),
            uploadAsset: vi.fn(async () => { cancelled = true; }),
            publishDraft,
            createAttachmentId: () => '11111111-1111-4111-8111-111111111111',
            hashAttachmentBytes: vi.fn(async () => 'a'.repeat(64)),
            isCancelled: () => cancelled,
        };

        await expect(publishPublicSessionSnapshot({ sessionId: 'session-1', title: 'Title', sharedAt: 200 }, deps))
            .rejects.toThrow('Public session share cancelled');
        expect(publishDraft).not.toHaveBeenCalled();
    });

    it('removes a snapshot that finishes publishing after the queued job was cancelled', async () => {
        let cancelled = false;
        const cleanupPublishedShare = vi.fn(async () => undefined);
        const deps: PublicSessionPublishDependencies = {
            loadMessages: vi.fn(async () => []),
            createDraft: vi.fn(async () => ({ generation: 'generation-1', publicId: 'public-id' })),
            loadAttachmentBytes: vi.fn(async () => new Uint8Array()),
            prepareAsset: vi.fn(),
            uploadAsset: vi.fn(),
            publishDraft: vi.fn(async () => {
                cancelled = true;
                return { publicId: 'public-id', publishedAt: 300 };
            }),
            cleanupPublishedShare,
            isCancelled: () => cancelled,
        };

        await expect(publishPublicSessionSnapshot({ sessionId: 'session-1', title: 'Title', sharedAt: 200 }, deps))
            .rejects.toThrow('Public session share cancelled');
        expect(cleanupPublishedShare).toHaveBeenCalledOnce();
    });
});
