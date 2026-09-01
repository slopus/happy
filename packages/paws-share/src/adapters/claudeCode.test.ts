import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { publicSessionSnapshotSchema } from '@slopus/happy-wire';
import { claudeCodeAdapter } from './claudeCode';
import { createTemporaryDirectory, removeTemporaryDirectory } from '../testSupport/temporaryDirectory';

const fixture = resolve('test/fixtures/claude-code-session.jsonl');
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory));
});

describe('claudeCodeAdapter', () => {
    it('converts Claude content blocks, pairs tool results, and removes repeated resumed events', async () => {
        const converted = await claudeCodeAdapter.convert({ provider: 'claude-code', path: fixture });

        expect(publicSessionSnapshotSchema.parse(converted.snapshot)).toEqual(converted.snapshot);
        expect(converted.snapshot.source).toEqual({ provider: 'claude-code' });
        expect(converted.snapshot.title).toBe('Review this Paws sharing illustration.');
        expect(converted.snapshot.messages[0]).toMatchObject({
            role: 'assistant',
            blocks: [expect.objectContaining({ type: 'text', markdown: 'The illustration is ready to share.' })],
        });
        expect(converted.snapshot.messages.at(-1)).toMatchObject({ role: 'user' });
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

    it('exports base64 images from top-level and nested tool-result content', async () => {
        const directory = await createTemporaryDirectory('paws-share-claude-images-');
        temporaryDirectories.push(directory);
        const transcript = join(directory, 'session.jsonl');
        const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
        const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } };
        const lines = [
            { type: 'user', uuid: 'user-1', parentUuid: null, timestamp: '2026-09-01T00:00:00.000Z', message: { content: [{ type: 'text', text: 'Share both images.' }, image] } },
            { type: 'assistant', uuid: 'assistant-1', parentUuid: 'user-1', timestamp: '2026-09-01T00:00:01.000Z', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] } },
            { type: 'user', uuid: 'result-1', parentUuid: 'assistant-1', timestamp: '2026-09-01T00:00:02.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: 'Rendered image' }, image] }] } },
        ];
        await writeFile(transcript, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);

        const converted = await claudeCodeAdapter.convert({ provider: 'claude-code', path: transcript });
        const attachmentBlocks = converted.snapshot.messages.flatMap((message) => message.blocks)
            .filter((block) => block.type === 'attachment');

        expect(attachmentBlocks).toHaveLength(2);
        expect(converted.attachments).toHaveLength(2);
        expect(converted.attachments.every((attachment) => attachment.bytes?.equals(png))).toBe(true);
        expect(converted.unresolvedAttachments).toEqual([]);
        expect(JSON.stringify(converted.snapshot)).not.toContain(png.toString('base64'));
    });

    it('fails closed when a structured image source cannot be exported', async () => {
        const directory = await createTemporaryDirectory('paws-share-claude-unresolved-');
        temporaryDirectories.push(directory);
        const transcript = join(directory, 'session.jsonl');
        await writeFile(transcript, `${JSON.stringify({
            type: 'user',
            uuid: 'user-1',
            message: { content: [{ type: 'image', source: { type: 'url', url: 'https://private.test/image.png' } }] },
        })}\n`);

        const converted = await claudeCodeAdapter.convert({ provider: 'claude-code', path: transcript });

        expect(converted.attachments).toEqual([]);
        expect(converted.unresolvedAttachments).toHaveLength(1);
    });

    it('exports only the latest non-sidechain UUID ancestry', async () => {
        const directory = await createTemporaryDirectory('paws-share-claude-ancestry-');
        temporaryDirectories.push(directory);
        const transcript = join(directory, 'session.jsonl');
        const lines = [
            { type: 'user', uuid: 'root', parentUuid: null, isSidechain: false, message: { content: 'Root request' } },
            { type: 'assistant', uuid: 'ancestor', parentUuid: 'root', isSidechain: false, message: { content: [{ type: 'text', text: 'Kept ancestor' }] } },
            { type: 'user', uuid: 'abandoned', parentUuid: 'ancestor', isSidechain: false, message: { content: 'SECRET ABANDONED BRANCH' } },
            { type: 'user', uuid: 'current', parentUuid: 'ancestor', isSidechain: false, message: { content: 'Current branch' } },
            { type: 'assistant', uuid: 'final', parentUuid: 'current', isSidechain: false, message: { content: [{ type: 'text', text: 'Final answer' }] } },
            { type: 'assistant', uuid: 'sidechain', parentUuid: null, isSidechain: true, message: { content: [{ type: 'text', text: 'SECRET SIDECHAIN' }] } },
        ];
        await writeFile(transcript, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);

        const converted = await claudeCodeAdapter.convert({ provider: 'claude-code', path: transcript });
        const serialized = JSON.stringify(converted.snapshot);

        expect(serialized).toContain('Root request');
        expect(serialized).toContain('Kept ancestor');
        expect(serialized).toContain('Current branch');
        expect(serialized).toContain('Final answer');
        expect(serialized).not.toContain('SECRET ABANDONED BRANCH');
        expect(serialized).not.toContain('SECRET SIDECHAIN');
    });

    it('fails closed when the latest ancestry points to a missing parent', async () => {
        const directory = await createTemporaryDirectory('paws-share-claude-incomplete-');
        temporaryDirectories.push(directory);
        const transcript = join(directory, 'session.jsonl');
        await writeFile(transcript, `${JSON.stringify({
            type: 'assistant',
            uuid: 'latest',
            parentUuid: 'missing-parent',
            message: { content: [{ type: 'text', text: 'Only the tail is present' }] },
        })}\n`);

        await expect(claudeCodeAdapter.convert({ provider: 'claude-code', path: transcript }))
            .rejects.toThrow('ancestry is incomplete');
    });

    it('exports an image nested in an orphan tool result instead of silently dropping it', async () => {
        const directory = await createTemporaryDirectory('paws-share-claude-orphan-result-');
        temporaryDirectories.push(directory);
        const transcript = join(directory, 'session.jsonl');
        const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
        await writeFile(transcript, `${JSON.stringify({
            type: 'user',
            uuid: 'result-1',
            parentUuid: null,
            message: { content: [{
                type: 'tool_result',
                tool_use_id: 'missing-tool',
                content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }],
            }] },
        })}\n`);

        const converted = await claudeCodeAdapter.convert({ provider: 'claude-code', path: transcript });

        expect(converted.attachments).toHaveLength(1);
        expect(converted.snapshot.messages.flatMap((message) => message.blocks)
            .filter((block) => block.type === 'attachment')).toHaveLength(1);
        expect(converted.unresolvedAttachments).toEqual([]);
    });
});
