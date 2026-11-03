import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() },
}));

vi.mock('@/configuration', () => ({
    configuration: { happyHomeDir: '/home/test/.happy' },
}));

import { logger } from '@/ui/logger';
import {
    detectSupportedImageType,
    formatAttachmentNote,
    parseAttachmentNotePaths,
    pruneAttachmentDirs,
    resolveAttachmentDir,
    saveAttachmentFiles,
} from './attachmentFiles';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 4, 5]);
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'happy-attachments-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await rm(tempDirs.pop()!, { recursive: true, force: true });
    }
    vi.mocked(logger.debug).mockClear();
});

describe('detectSupportedImageType', () => {
    it('detects the four formats models read by magic bytes', () => {
        expect(detectSupportedImageType(PNG)).toEqual({ mimeType: 'image/png', extension: 'png' });
        expect(detectSupportedImageType(JPEG)).toEqual({ mimeType: 'image/jpeg', extension: 'jpg' });
        expect(detectSupportedImageType(new TextEncoder().encode('GIF89a'))).toEqual({ mimeType: 'image/gif', extension: 'gif' });
        expect(detectSupportedImageType(new Uint8Array([
            0x52, 0x49, 0x46, 0x46,
            0x00, 0x00, 0x00, 0x00,
            0x57, 0x45, 0x42, 0x50,
        ]))).toEqual({ mimeType: 'image/webp', extension: 'webp' });
    });

    it('rejects unsupported bytes', () => {
        expect(detectSupportedImageType(new TextEncoder().encode('not an image'))).toBeNull();
    });
});

describe('resolveAttachmentDir', () => {
    it('defaults to Happy local state, one folder per session', () => {
        expect(resolveAttachmentDir({ sessionId: 'session-1' })).toBe('/home/test/.happy/attachments/session-1');
    });

    it('keeps malformed session ids inside the root', () => {
        const resolved = resolveAttachmentDir({ rootDir: '/tmp/happy-attachments', sessionId: '../outside/nested' });
        expect(resolved.startsWith(`/tmp/happy-attachments${sep}`)).toBe(true);
        expect(resolved).not.toContain('..');
    });
});

describe('saveAttachmentFiles', () => {
    it('writes each attachment under a fresh name, in order, with its detected type', async () => {
        const rootDir = await makeTempDir();

        const saved = await saveAttachmentFiles([
            { data: PNG, mimeType: 'image/heic', name: '../../original name.heic' },
            { data: JPEG, mimeType: 'image/jpeg', name: 'photo.jpg' },
        ], { sessionId: 'session-1', rootDir });

        expect(saved).toHaveLength(2);
        expect(saved.map((file) => file.mimeType)).toEqual(['image/png', 'image/jpeg']);
        expect(saved.every((file) => file.isImage)).toBe(true);
        expect(saved[0].path.startsWith(join(rootDir, 'session-1') + sep)).toBe(true);
        expect(saved[0].path).toMatch(/\.png$/);
        expect(saved[0].path).not.toContain('original');
        expect(saved[1].path).toMatch(/\.jpg$/);
        expect(new Uint8Array(await readFile(saved[0].path))).toEqual(PNG);
        expect(new Uint8Array(await readFile(saved[1].path))).toEqual(JPEG);
    });

    it('keeps a picture models cannot read, so the agent can still decide what to do with it', async () => {
        const rootDir = await makeTempDir();
        const sensitiveName = 'https://upload.example.test/presigned?token=secret';

        const saved = await saveAttachmentFiles([
            { data: new TextEncoder().encode('heic bytes'), mimeType: 'image/heic', name: sensitiveName },
        ], { sessionId: 'session-2', rootDir });

        expect(saved).toEqual([expect.objectContaining({ mimeType: 'image/heic', isImage: true, size: 10 })]);
        expect(saved[0].path).toMatch(/\.heic$/);
        expect(saved[0].path).not.toContain('presigned');
    });

    it('uses restrictive permissions on POSIX', async () => {
        if (process.platform === 'win32') return;
        const rootDir = await makeTempDir();

        const [file] = await saveAttachmentFiles([{ data: PNG, mimeType: 'image/png', name: 'a.png' }], {
            sessionId: 'session-permissions',
            rootDir,
        });

        expect((await stat(join(rootDir, 'session-permissions'))).mode & 0o777).toBe(0o700);
        expect((await stat(file.path)).mode & 0o777).toBe(0o600);
    });

    it('returns nothing when the folder cannot be made, without logging names or paths', async () => {
        const tempDir = await makeTempDir();
        const fileRoot = join(tempDir, 'not-a-directory');
        await writeFile(fileRoot, 'occupied');
        const sensitiveName = 'data:image/png;base64,secret';

        const saved = await saveAttachmentFiles([{ data: JPEG, mimeType: 'image/jpeg', name: sensitiveName }], {
            sessionId: 'session-3',
            rootDir: fileRoot,
        });

        expect(saved).toEqual([]);
        expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain(fileRoot);
        expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain(sensitiveName);
    });
});

describe('formatAttachmentNote', () => {
    it('names every path and says nothing was loaded', () => {
        const note = formatAttachmentNote([
            { path: '/h/.happy/attachments/s/a.png', mimeType: 'image/png', size: 1, isImage: true },
            { path: '/h/.happy/attachments/s/b.jpg', mimeType: 'image/jpeg', size: 1, isImage: true },
        ]);

        expect(note).toBe([
            'The user attached 2 images. They were saved on this machine and not loaded into your context; open them with your file-reading or image-viewing tool only if you need to see them:',
            '- /h/.happy/attachments/s/a.png',
            '- /h/.happy/attachments/s/b.jpg',
        ].join('\n'));
        expect(formatAttachmentNote([])).toBeNull();
    });

    it('reads back as the paths it names, even inside a larger prompt', () => {
        const files = [
            { path: '/h/a dir/x.png', mimeType: 'image/png', size: 1, isImage: true },
            { path: '/h/y.pdf', mimeType: 'application/pdf', size: 1, isImage: false },
        ];
        const note = formatAttachmentNote(files)!;
        expect(note.startsWith('The user attached 2 files.')).toBe(true);

        const prompt = `look\n\n<happy-system>\n${note}\n</happy-system>\n\n- /not/a/note/path`;
        expect(parseAttachmentNotePaths(prompt)).toEqual(['/h/a dir/x.png', '/h/y.pdf']);
        expect(parseAttachmentNotePaths('- /etc/passwd')).toEqual([]);
    });
});

describe('pruneAttachmentDirs', () => {
    it('removes session folders idle past the retention, keeping recent ones and the running session', async () => {
        const rootDir = await makeTempDir();
        const now = Date.now();
        const old = new Date(now - 40 * 24 * 60 * 60 * 1000);
        for (const name of ['old-session', 'running-session', 'recent-session']) {
            await mkdir(join(rootDir, name));
            await writeFile(join(rootDir, name, 'x.png'), PNG);
        }
        await utimes(join(rootDir, 'old-session'), old, old);
        await utimes(join(rootDir, 'running-session'), old, old);

        await pruneAttachmentDirs({ rootDirs: [rootDir, join(rootDir, 'missing-root')], keepSessionId: 'running-session', now });

        expect((await readdir(rootDir)).sort()).toEqual(['recent-session', 'running-session']);
    });
});
