import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publicSessionSnapshotSchema } from '@slopus/happy-wire';
import { codexAdapter } from './codex';

const fixture = resolve('test/fixtures/codex-session.jsonl');

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
        expect(await readFile(converted.attachments[0].path, 'utf8')).toContain('Paws Share');
        expect(JSON.stringify(converted.snapshot)).not.toContain('codex-private-session');
        expect(JSON.stringify(converted.snapshot)).not.toContain(fixture);
    });
});
