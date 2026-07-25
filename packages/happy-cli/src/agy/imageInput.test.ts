import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() },
}));

vi.mock('@/configuration', () => ({
    configuration: { happyHomeDir: '/home/test/.happy' },
}));

import { buildAgyImagePrompt, cleanupAgyImageCache, prepareAgyImageFiles } from './imageInput';

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'happy-agy-image-input-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop()!;
        await rm(dir, { recursive: true, force: true });
    }
});

describe('prepareAgyImageFiles', () => {
    it('returns empty result without touching disk when there are no attachments', async () => {
        const result = await prepareAgyImageFiles(undefined, { sessionId: 'session-1' });
        expect(result).toEqual({ paths: [], skipped: 0, cacheDir: null });
    });

    it('writes supported images into a session-scoped dir and skips unsupported bytes', async () => {
        const cacheRootDir = await makeTempDir();
        const result = await prepareAgyImageFiles(
            [
                { data: PNG_MAGIC, mimeType: 'image/png', name: 'shot.png' },
                { data: new TextEncoder().encode('not an image'), mimeType: 'image/png', name: 'fake.png' },
            ],
            { sessionId: 'session-1', cacheRootDir },
        );

        expect(result.skipped).toBe(1);
        expect(result.paths).toHaveLength(1);
        // The session segment is a hash of the raw id, so only assert structure:
        // a direct child of the cache root, stable across calls for the same id.
        expect(result.cacheDir!.startsWith(cacheRootDir + '/')).toBe(true);
        expect(join(result.cacheDir!, '..')).toBe(cacheRootDir);
        expect(result.paths[0].startsWith(result.cacheDir!)).toBe(true);
        expect(result.paths[0].endsWith('.png')).toBe(true);

        const written = await readFile(result.paths[0]);
        expect(new Uint8Array(written)).toEqual(PNG_MAGIC);
        const dirStat = await stat(result.cacheDir!);
        expect(dirStat.mode & 0o777).toBe(0o700);
    });

    it('maps sessions to distinct dirs even when ids collide under path sanitization', async () => {
        const cacheRootDir = await makeTempDir();
        const att = () => [{ data: PNG_MAGIC, mimeType: 'image/png', name: 'a.png' }];
        const a = await prepareAgyImageFiles(att(), { sessionId: 'abc/def', cacheRootDir });
        const b = await prepareAgyImageFiles(att(), { sessionId: 'abc_def', cacheRootDir });
        const c = await prepareAgyImageFiles(att(), { sessionId: '///', cacheRootDir });
        const d = await prepareAgyImageFiles(att(), { sessionId: '...', cacheRootDir });
        const dirs = [a.cacheDir, b.cacheDir, c.cacheDir, d.cacheDir];
        expect(new Set(dirs).size).toBe(4);
        // Same id stays deterministic.
        const a2 = await prepareAgyImageFiles(att(), { sessionId: 'abc/def', cacheRootDir });
        expect(a2.cacheDir).toBe(a.cacheDir);
    });

    it('reports no cacheDir when every attachment is skipped', async () => {
        const cacheRootDir = await makeTempDir();
        const result = await prepareAgyImageFiles(
            [{ data: new TextEncoder().encode('nope'), mimeType: 'image/png', name: 'fake.png' }],
            { sessionId: 'session-1', cacheRootDir },
        );
        expect(result).toEqual({ paths: [], skipped: 1, cacheDir: null });
    });
});

describe('cleanupAgyImageCache', () => {
    it('removes the session dir and leaves other sessions alone', async () => {
        const cacheRootDir = await makeTempDir();
        const mine = await prepareAgyImageFiles(
            [{ data: PNG_MAGIC, mimeType: 'image/png', name: 'a.png' }],
            { sessionId: 'session-1', cacheRootDir },
        );
        const other = await prepareAgyImageFiles(
            [{ data: PNG_MAGIC, mimeType: 'image/png', name: 'b.png' }],
            { sessionId: 'session-2', cacheRootDir },
        );

        await cleanupAgyImageCache({ sessionId: 'session-1', cacheRootDir });

        await expect(stat(mine.cacheDir!)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readdir(other.cacheDir!)).toHaveLength(1);
    });

    it('is a no-op for a session that never wrote images', async () => {
        const cacheRootDir = await makeTempDir();
        await expect(cleanupAgyImageCache({ sessionId: 'never-there', cacheRootDir })).resolves.toBeUndefined();
    });
});

describe('buildAgyImagePrompt', () => {
    it('passes text through untouched when there are no image paths', () => {
        expect(buildAgyImagePrompt('hello', [])).toBe('hello');
    });

    it('prefixes the path list and isolation instruction before the user text', () => {
        const prompt = buildAgyImagePrompt('what is this?', ['/cache/s1/a.png']);
        expect(prompt).toContain('an image file');
        expect(prompt).toContain('- /cache/s1/a.png');
        expect(prompt.endsWith('what is this?')).toBe(true);
        expect(prompt.indexOf('/cache/s1/a.png')).toBeLessThan(prompt.indexOf('what is this?'));
    });

    it('sends only the header for image-only messages and counts multiple files', () => {
        const prompt = buildAgyImagePrompt('   ', ['/cache/s1/a.png', '/cache/s1/b.jpg']);
        expect(prompt).toContain('2 image files');
        expect(prompt).toContain('- /cache/s1/a.png');
        expect(prompt).toContain('- /cache/s1/b.jpg');
        expect(prompt.trim().endsWith('b.jpg')).toBe(true);
    });
});
