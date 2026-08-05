/**
 * Cross-platform security and error-contract coverage for home directory
 * browsing, including canonical paths and symlink escape rejection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browseHomeDirectory } from './browseHomeDirectory';

describe('browseHomeDirectory', () => {
    let fixtureRoot: string;
    let home: string;
    let outside: string;

    beforeEach(async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), 'paws-browse-home-'));
        home = join(fixtureRoot, 'home');
        outside = join(fixtureRoot, 'outside');
        await mkdir(home);
        await mkdir(outside);
    });

    afterEach(async () => {
        await rm(fixtureRoot, { recursive: true, force: true });
    });

    it('rejects an in-home symlink whose canonical target escapes home', async () => {
        const link = join(home, 'outside-link');
        await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

        const result = await browseHomeDirectory(home, link);

        expect(result).toEqual({
            success: false,
            error: 'Access denied: Path is outside the home directory',
        });
    });

    it('returns canonical home, target, parent, and child paths', async () => {
        const projects = join(home, 'projects');
        const demo = join(projects, 'demo');
        const child = join(demo, 'child');
        await mkdir(child, { recursive: true });
        await writeFile(join(demo, '.git'), 'gitdir: elsewhere');
        const homeAlias = join(fixtureRoot, 'home-alias');
        await symlink(home, homeAlias, process.platform === 'win32' ? 'junction' : 'dir');

        const canonicalHome = await realpath(home);
        const canonicalDemo = await realpath(demo);
        const result = await browseHomeDirectory(homeAlias, join(homeAlias, 'projects', 'demo'));

        expect(result).toEqual({
            success: true,
            home: canonicalHome,
            path: canonicalDemo,
            parent: join(canonicalHome, 'projects'),
            directories: [{
                name: 'child',
                path: join(canonicalDemo, 'child'),
                isProjectRoot: false,
            }],
        });
    });

    it('returns the filesystem error for a missing or non-directory target', async () => {
        const missing = await browseHomeDirectory(home, join(home, 'missing'));
        expect(missing.success).toBe(false);
        expect(missing.error).toMatch(/ENOENT|not found|cannot find/i);

        const file = join(home, 'file.txt');
        await writeFile(file, 'not a directory');
        const notDirectory = await browseHomeDirectory(home, file);
        expect(notDirectory.success).toBe(false);
        expect(notDirectory.error).toMatch(/ENOTDIR|not a directory|directory name is invalid/i);
    });
});
