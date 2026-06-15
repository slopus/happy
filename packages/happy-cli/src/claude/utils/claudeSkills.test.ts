import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverClaudeSkills } from './claudeSkills';

describe('discoverClaudeSkills', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
        tempDirs.length = 0;
    });

    it('reads project Claude skills from SKILL.md frontmatter', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-claude-skills-'));
        tempDirs.push(root);
        await mkdir(join(root, '.claude', 'skills', 'zeta'), { recursive: true });
        await mkdir(join(root, '.claude', 'skills', 'alpha'), { recursive: true });
        await mkdir(join(root, '.claude', 'skills', 'broken'), { recursive: true });
        await writeFile(join(root, '.claude', 'skills', 'zeta', 'SKILL.md'), [
            '---',
            'name: release',
            'description: Release flow',
            '---',
            '# Release',
        ].join('\n'));
        await writeFile(join(root, '.claude', 'skills', 'alpha', 'SKILL.md'), [
            '---',
            'name: sessions',
            '---',
            '# Sessions',
        ].join('\n'));

        await expect(discoverClaudeSkills(root)).resolves.toEqual(['release', 'sessions']);
    });
});
