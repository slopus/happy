/**
 * Cross-platform security and error-contract coverage for home directory
 * browsing, including canonical paths and symlink escape rejection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browseHomeDirectory, getMountedVolumePaths } from './browseHomeDirectory';

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

        expect(result).toMatchObject({
            success: false,
            error: 'Access denied: Path is outside the home directory and mounted volumes',
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

        expect(result).toMatchObject({
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
    it('browses an authorized volume with spaces and stops at its root', async () => {
        const volume = join(fixtureRoot, 'External SSD');
        const project = join(volume, 'Development', 'demo');
        await mkdir(project, { recursive: true });
        await writeFile(join(project, '.git'), 'gitdir: elsewhere');
        const canonicalVolume = await realpath(volume);
        const canonicalHome = await realpath(home);

        const root = await browseHomeDirectory(home, volume, [volume]);
        expect(root).toMatchObject({
            success: true, path: canonicalVolume, parent: null, root: canonicalVolume,
            roots: [
                { name: '~', path: canonicalHome, kind: 'home' },
                { name: 'External SSD', path: canonicalVolume, kind: 'volume' },
            ],
        });
        const result = await browseHomeDirectory(home, join(volume, 'Development'), [volume]);
        expect(result).toMatchObject({
            success: true, parent: canonicalVolume, root: canonicalVolume,
            directories: [{ name: 'demo', path: await realpath(project), isProjectRoot: true }],
        });
    });

    it('lists migrated project symlinks only when their targets are in an allowed root', async () => {
        const volume = join(fixtureRoot, 'External SSD');
        await mkdir(volume);
        await symlink(volume, join(home, 'migrated'), process.platform === 'win32' ? 'junction' : 'dir');
        await symlink(outside, join(home, 'private'), process.platform === 'win32' ? 'junction' : 'dir');
        const result = await browseHomeDirectory(home, home, [volume]);
        expect(result.directories).toEqual([
            { name: 'migrated', path: await realpath(volume), isProjectRoot: false },
        ]);
        expect(await browseHomeDirectory(home, join(home, 'migrated'), [volume])).toMatchObject({
            success: true, path: await realpath(volume), root: await realpath(volume),
        });
    });

    it('rejects volume escapes through parents, prefix siblings and symlinks', async () => {
        const volume = join(fixtureRoot, 'External SSD');
        const sibling = `${volume}-private`;
        await mkdir(volume);
        await mkdir(sibling);
        await symlink(outside, join(volume, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
        for (const target of [join(volume, '..'), sibling, join(volume, 'escape')]) {
            expect(await browseHomeDirectory(home, target, [volume])).toMatchObject({ success: false });
        }
    });

    it('returns available roots on failure so an unplugged drive can be left', async () => {
        const removedVolume = join(fixtureRoot, 'Disconnected SSD');
        const result = await browseHomeDirectory(home, removedVolume, [removedVolume]);
        expect(result).toMatchObject({
            success: false,
            roots: [{ name: '~', path: await realpath(home), kind: 'home' }],
        });
        expect(result.path).toBeUndefined();
    });

    it('does not discover ordinary directories or symlinks as mounted volumes', async () => {
        const volumes = join(fixtureRoot, 'Volumes');
        await mkdir(join(volumes, 'unmounted'), { recursive: true });
        await symlink(outside, join(volumes, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
        expect(await getMountedVolumePaths(volumes)).toEqual([]);
        expect(await getMountedVolumePaths(join(fixtureRoot, 'missing'))).toEqual([]);
    });

});
