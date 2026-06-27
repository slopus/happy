import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@slopus/happy-wire';

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() },
}));

vi.mock('@/configuration', () => ({
    configuration: { happyHomeDir: '/home/test/.happy' },
}));

import { buildCodexThreadBackfillEnvelopes } from './threadImageBackfill';

const tempDirs: string[] = [];

async function makePngFile(name: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'happy-codex-backfill-'));
    tempDirs.push(dir);
    const filePath = join(dir, name);
    await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    return filePath;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await rm(tempDirs.pop()!, { recursive: true, force: true });
    }
});

describe('buildCodexThreadBackfillEnvelopes', () => {
    it('inserts uploaded local image file envelopes before the matching user text', async () => {
        const imagePath = await makePngFile('input.png');
        const uploadLocalImage = vi.fn(async (_attachment, opts) => createEnvelope('user', {
            t: 'file',
            ref: 'uploaded-ref',
            name: 'codex-image-1.png',
            size: 9,
            mimeType: 'image/png',
        }, opts));

        const envelopes = await buildCodexThreadBackfillEnvelopes({
            thread: {
                turns: [{
                    id: 'turn-1',
                    startedAt: 100,
                    completedAt: 101,
                    status: 'completed',
                    items: [
                        {
                            id: 'user-1',
                            type: 'userMessage',
                            content: [
                                { type: 'text', text: 'inspect this' },
                                { type: 'localImage', path: imagePath },
                            ],
                        },
                        { id: 'agent-1', type: 'agentMessage', text: 'ok' },
                    ],
                }],
            },
            uploadLocalImage,
        });

        expect(envelopes.map((envelope) => envelope.ev.t)).toEqual([
            'turn-start',
            'file',
            'text',
            'text',
            'turn-end',
        ]);
        expect(envelopes[1]).toMatchObject({
            role: 'user',
            id: 'user-1:image:1',
            time: 100_000,
            codexItemId: 'user-1',
            ev: { t: 'file', ref: 'uploaded-ref' },
        });
        expect(envelopes[2]).toMatchObject({
            role: 'user',
            codexItemId: 'user-1',
            ev: { t: 'text', text: 'inspect this' },
        });
        expect(uploadLocalImage).toHaveBeenCalledWith(expect.objectContaining({
            mimeType: 'image/png',
            name: 'codex-image-1.png',
        }), {
            id: 'user-1:image:1',
            time: 100_000,
            codexItemId: 'user-1',
        });

        const userMessagesInCreatedAtOrder = envelopes
            .filter((envelope) => envelope.role === 'user')
            .sort((a, b) => a.time - b.time);
        expect(userMessagesInCreatedAtOrder.map((envelope) => envelope.ev.t)).toEqual([
            'file',
            'text',
        ]);
    });

    it('backfills image-only user messages without inventing empty text', async () => {
        const imagePath = await makePngFile('only-image.png');
        const uploadLocalImage = vi.fn(async (_attachment, opts) => createEnvelope('user', {
            t: 'file',
            ref: 'uploaded-ref',
            name: 'codex-image-1.png',
            size: 9,
            mimeType: 'image/png',
        }, opts));

        const envelopes = await buildCodexThreadBackfillEnvelopes({
            thread: {
                turns: [{
                    id: 'turn-1',
                    startedAt: 100,
                    items: [{
                        id: 'user-image-only',
                        type: 'userMessage',
                        content: [{ type: 'localImage', path: imagePath }],
                    }],
                }],
            },
            uploadLocalImage,
        });

        expect(envelopes.map((envelope) => envelope.ev.t)).toEqual([
            'turn-start',
            'file',
            'turn-end',
        ]);
    });

    it('skips missing local paths and URL images while preserving text', async () => {
        const uploadLocalImage = vi.fn();

        const envelopes = await buildCodexThreadBackfillEnvelopes({
            thread: {
                turns: [{
                    id: 'turn-1',
                    startedAt: 100,
                    items: [{
                        id: 'user-1',
                        type: 'userMessage',
                        content: [
                            { type: 'text', text: 'text survives' },
                            { type: 'localImage', path: '/path/that/does/not/exist.png' },
                            { type: 'image', url: 'https://example.test/image.png' },
                        ],
                    }],
                }],
            },
            uploadLocalImage,
        });

        expect(envelopes.map((envelope) => envelope.ev.t)).toEqual([
            'turn-start',
            'text',
            'turn-end',
        ]);
        expect(uploadLocalImage).not.toHaveBeenCalled();
    });
});
