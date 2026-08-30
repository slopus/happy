import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import {
    loadCompleteSessionMessages,
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
});
