import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installSkill } from './installSkill';
import { createTemporaryDirectory, removeTemporaryDirectory } from './testSupport/temporaryDirectory';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory));
});

describe('installSkill', () => {
    it('installs the same provider-neutral skill for Codex and Claude Code without touching unrelated skills', async () => {
        const home = await createTemporaryDirectory('paws-share-skill-');
        temporaryDirectories.push(home);
        const codexHome = join(home, 'codex');
        const claudeHome = join(home, 'claude');
        await mkdir(join(codexHome, 'skills', 'unrelated'), { recursive: true });
        await writeFile(join(codexHome, 'skills', 'unrelated', 'SKILL.md'), 'keep me');

        const result = await installSkill({
            target: 'all',
            codexHome,
            claudeHome,
            sourceSkillDirectory: resolve('skills/share-session'),
        });

        expect(result.installed).toEqual([
            join(codexHome, 'skills', 'share-session'),
            join(claudeHome, 'skills', 'share-session'),
        ]);
        const codexSkill = await readFile(join(codexHome, 'skills', 'share-session', 'SKILL.md'), 'utf8');
        const claudeSkill = await readFile(join(claudeHome, 'skills', 'share-session', 'SKILL.md'), 'utf8');
        expect(codexSkill).toBe(claudeSkill);
        expect(codexSkill).toContain('paws-share inspect --current --json');
        expect(codexSkill).toContain('paws-share share --current --yes --json');
        expect(await readFile(join(codexHome, 'skills', 'unrelated', 'SKILL.md'), 'utf8')).toBe('keep me');
    });

    it('replaces only its own previously installed folder on update', async () => {
        const home = await createTemporaryDirectory('paws-share-skill-');
        temporaryDirectories.push(home);
        const codexHome = join(home, 'codex');
        const target = join(codexHome, 'skills', 'share-session');
        await mkdir(target, { recursive: true });
        await writeFile(join(target, 'stale.txt'), 'stale');

        await installSkill({ target: 'codex', codexHome, sourceSkillDirectory: resolve('skills/share-session') });

        await expect(readFile(join(target, 'stale.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toContain('name: share-session');
    });
});
