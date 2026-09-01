import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { publicSessionSnapshotSchema } from '@slopus/happy-wire';
import { codexAdapter } from './codex';
import { readResolvedAttachmentBytes } from './shared';
import { createTemporaryDirectory, removeTemporaryDirectory } from '../testSupport/temporaryDirectory';

const fixture = resolve('test/fixtures/codex-session.jsonl');
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory));
});

describe('codexAdapter', () => {
    it('converts messages, reasoning, tools, and a structured attachment without private metadata', async () => {
        const converted = await codexAdapter.convert({ provider: 'codex', path: fixture });

        expect(publicSessionSnapshotSchema.parse(converted.snapshot)).toEqual(converted.snapshot);
        expect(converted.snapshot.source).toEqual({ provider: 'codex' });
        expect(converted.snapshot.title).toBe('Create a purple Paws sharing illustration.');
        expect(converted.snapshot.messages[0]).toMatchObject({
            role: 'assistant',
            blocks: [expect.objectContaining({ type: 'text', markdown: 'The illustration is ready and keeps the same aspect ratio.' })],
        });
        expect(converted.snapshot.messages.at(-1)).toMatchObject({ role: 'user' });
        expect(converted.snapshot.messages.flatMap((message) => message.blocks)).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'thinking', markdown: expect.stringContaining('preserve its proportions') }),
            expect.objectContaining({ type: 'tool', name: 'view_image', status: 'completed', body: 'Image is 320 by 180 pixels.' }),
            expect.objectContaining({ type: 'attachment', name: 'attachment.svg', kind: 'image', mimeType: 'image/svg+xml' }),
        ]));
        expect(converted.attachments).toHaveLength(1);
        expect(converted.attachments[0].sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(converted.unresolvedAttachments).toEqual([]);
        expect((await readResolvedAttachmentBytes(converted.attachments[0])).toString('utf8')).toContain('Paws Share');
        expect(JSON.stringify(converted.snapshot)).not.toContain('codex-private-session');
        expect(JSON.stringify(converted.snapshot)).not.toContain(fixture);
    });

    it('exports a structured base64 data URL image', async () => {
        const directory = await createTemporaryDirectory('paws-share-codex-data-image-');
        temporaryDirectories.push(directory);
        const transcript = join(directory, 'session.jsonl');
        const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
        const lines = [{
            type: 'response_item',
            timestamp: '2026-09-01T00:00:00.000Z',
            payload: {
                id: 'message-1',
                type: 'message',
                role: 'user',
                content: [
                    { type: 'input_text', text: 'Share this embedded drawing.' },
                    { type: 'input_image', image_url: `data:image/png;base64,${png.toString('base64')}` },
                ],
            },
        }];
        await writeFile(transcript, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);

        const converted = await codexAdapter.convert({ provider: 'codex', path: transcript });

        expect(converted.attachments).toHaveLength(1);
        expect(await readResolvedAttachmentBytes(converted.attachments[0])).toEqual(png);
        expect(converted.unresolvedAttachments).toEqual([]);
    });
});
