import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() },
}));

vi.mock('@/configuration', () => ({
    configuration: { happyHomeDir: '/home/test/.happy' },
}));

import { buildClaudeAttachmentContent, claudeCanReadFiles } from './attachmentContent';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'happy-claude-attachments-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await rm(tempDirs.pop()!, { recursive: true, force: true });
    }
});

describe('buildClaudeAttachmentContent', () => {
    it('sends the picture as a path Claude can Read, not as an image block', async () => {
        const rootDir = await makeTempDir();

        const content = await buildClaudeAttachmentContent({
            text: 'what is on this screen?',
            attachments: [{ data: PNG, mimeType: 'image/png', name: 'screen.png' }],
            sessionId: 'session-1',
            canReadFiles: true,
            rootDir,
        });

        expect(Array.isArray(content)).toBe(true);
        const blocks = content as Array<{ type: string; text?: string }>;
        expect(blocks.map((block) => block.type)).toEqual(['text', 'text']);
        expect(blocks[0].text).toBe('what is on this screen?');
        const path = blocks[1].text!.split('\n')[1].slice(2);
        expect(path.startsWith(join(rootDir, 'session-1'))).toBe(true);
        expect(new Uint8Array(await readFile(path))).toEqual(PNG);
    });

    it('sends an image-only message as just the note, never an empty text block', async () => {
        const content = await buildClaudeAttachmentContent({
            text: '',
            attachments: [{ data: PNG, mimeType: 'image/png', name: 'screen.png' }],
            sessionId: 'session-2',
            canReadFiles: true,
            rootDir: await makeTempDir(),
        });

        const blocks = content as Array<{ type: string; text?: string }>;
        expect(blocks).toHaveLength(1);
        expect(blocks[0].text).toMatch(/^The user attached 1 image\./);
    });

    it('falls back to inline image blocks when Claude cannot read files', async () => {
        const content = await buildClaudeAttachmentContent({
            text: 'look',
            attachments: [
                { data: PNG, mimeType: 'image/heic', name: 'a.heic' },
                { data: new TextEncoder().encode('not an image'), mimeType: 'image/png', name: 'b.png' },
            ],
            sessionId: 'session-3',
            canReadFiles: false,
            rootDir: await makeTempDir(),
        });

        expect(content).toEqual([
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(PNG).toString('base64') } },
            { type: 'text', text: 'look' },
        ]);
    });
});

describe('claudeCanReadFiles', () => {
    it('is false only when Read itself is disallowed', () => {
        expect(claudeCanReadFiles(undefined)).toBe(true);
        expect(claudeCanReadFiles(['Bash', 'Read(./secrets/**)'])).toBe(true);
        expect(claudeCanReadFiles(['Read'])).toBe(false);
    });
});
