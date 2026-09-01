import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ShareRecordStore } from './records';
import { inspectSession, shareSession, type ShareApi } from './share';
import { createTemporaryDirectory, removeTemporaryDirectory } from './testSupport/temporaryDirectory';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory));
});

describe('session sharing orchestration', () => {
    it('inspects a Codex fixture and reports the complete disclosure without private content', async () => {
        const inspection = await inspectSession({
            candidate: { provider: 'codex', path: resolve('test/fixtures/codex-session.jsonl') },
        });

        expect(inspection).toMatchObject({
            source: 'codex',
            title: 'Create a purple Paws sharing illustration.',
            messageCount: 4,
            attachmentCount: 1,
            unresolvedAttachmentCount: 0,
            blockingFindingCount: 0,
        });
        expect(inspection.attachmentBytes).toBeGreaterThan(100);
        expect(JSON.stringify(inspection)).not.toContain('codex-private-session');
        expect(JSON.stringify(inspection)).not.toContain(resolve('test/fixtures/codex-session.jsonl'));
    });

    it('publishes converted bytes, stores the private capability locally, and returns only public data', async () => {
        const home = await createTemporaryDirectory('paws-share-flow-');
        temporaryDirectories.push(home);
        const store = new ShareRecordStore(home);
        const managementToken = Buffer.alloc(32, 9).toString('base64url');
        const uploaded: Array<{ name: string; bytes: Buffer }> = [];
        let publishedTitle = '';
        const api: ShareApi = {
            createDraft: async () => ({
                shareId: 'share-1',
                generation: 'generation-1',
                publicId: 'public-1',
                publicUrl: 'https://paws.test/share/public-1',
                expiresAt: '2026-11-30T00:00:00.000Z',
            }),
            prepareAndUploadAsset: async (_shareId, _generation, asset) => {
                uploaded.push({ name: asset.name, bytes: Buffer.from(asset.bytes) });
            },
            publish: async (_shareId, _generation, snapshot) => {
                publishedTitle = snapshot.title;
                return { publicId: 'public-1', publishedAt: 1_788_192_000_000 };
            },
            renew: async () => ({ expiresAt: '2026-11-30T00:00:00.000Z' }),
            revoke: async () => ({ ok: true as const }),
        };

        const result = await shareSession({
            candidate: { provider: 'codex', path: resolve('test/fixtures/codex-session.jsonl') },
            serverUrl: 'https://paws.test',
            store,
        }, {
            createApi: (token) => {
                expect(token).toBe(managementToken);
                return api;
            },
            createManagementToken: () => managementToken,
            createRequestId: () => '11111111-1111-4111-8111-111111111111',
            now: () => new Date('2026-09-01T00:00:00.000Z'),
        });

        expect(result).toEqual({
            publicUrl: 'https://paws.test/share/public-1',
            publicId: 'public-1',
            expiresAt: '2026-11-30T00:00:00.000Z',
            source: 'codex',
            messageCount: 4,
            attachmentCount: 1,
            attachmentBytes: expect.any(Number),
            recordId: 'public-1',
        });
        expect(JSON.stringify(result)).not.toContain(managementToken);
        expect(publishedTitle).toBe('Create a purple Paws sharing illustration.');
        expect(uploaded).toHaveLength(1);
        expect(uploaded[0].name).toBe('attachment.svg');
        expect(uploaded[0].bytes).toEqual(await readFile(resolve('test/fixtures/attachment.svg')));
        expect((await store.get('public-1'))?.managementToken).toBe(managementToken);
        expect(JSON.stringify(await store.list())).not.toContain(managementToken);
    });
});
