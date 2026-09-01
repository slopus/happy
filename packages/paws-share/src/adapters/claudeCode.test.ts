import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publicSessionSnapshotSchema } from '@slopus/happy-wire';
import { claudeCodeAdapter } from './claudeCode';

const fixture = resolve('test/fixtures/claude-code-session.jsonl');

describe('claudeCodeAdapter', () => {
    it('converts Claude content blocks, pairs tool results, and removes repeated resumed events', async () => {
        const converted = await claudeCodeAdapter.convert({ provider: 'claude-code', path: fixture });

        expect(publicSessionSnapshotSchema.parse(converted.snapshot)).toEqual(converted.snapshot);
        expect(converted.snapshot.source).toEqual({ provider: 'claude-code' });
        expect(converted.snapshot.title).toBe('Review this Paws sharing illustration.');
        expect(converted.snapshot.messages.flatMap((message) => message.blocks)).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'thinking', markdown: 'I should inspect the image dimensions first.' }),
            expect.objectContaining({ type: 'tool', name: 'Read', status: 'completed', body: 'SVG is 320 by 180 pixels.' }),
            expect.objectContaining({ type: 'attachment', name: 'attachment.svg', kind: 'image' }),
        ]));
        expect(converted.snapshot.messages.flatMap((message) => message.blocks)
            .filter((block) => block.type === 'text' && block.markdown === 'The illustration is ready to share.')).toHaveLength(1);
        expect(converted.attachments).toHaveLength(1);
        expect(converted.unresolvedAttachments).toEqual([]);
        expect(JSON.stringify(converted.snapshot)).not.toContain('claude-private-session');
        expect(JSON.stringify(converted.snapshot)).not.toContain(fixture);
    });
});
