import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import {
    loadCompleteSessionMessages,
    loadSessionMessagesThroughSequence,
    publishPublicSessionSnapshot,
    type PublicSessionPublishDependencies,
} from '@/sync/publicSessionSharePublishing';

describe('public session share publishing', () => {
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
