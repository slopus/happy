import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverCodexSkillCommands } from './codexSkills';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'happy-codex-skills-'));
    tempRoots.push(root);
    return root;
}

async function addSkill(root: string, pathParts: string[]): Promise<void> {
    const skillDir = join(root, ...pathParts);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: test\n---\n');
}

afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('discoverCodexSkillCommands', () => {
    it('discovers user, project, system, and plugin skills as slash commands', async () => {
        const root = await makeTempRoot();
        const cwd = join(root, 'project');
        const codexHome = join(root, 'codex-home');

        await addSkill(cwd, ['.agents', 'skills', 'agent-browser']);
        await addSkill(codexHome, ['skills', 'plan-to-beads']);
        await addSkill(codexHome, ['skills', '.system', 'imagegen']);
        await addSkill(codexHome, ['plugins', 'cache', 'openai-curated', 'superpowers', '43313cc9', 'skills', 'brainstorming']);
        await addSkill(codexHome, ['plugins', 'cache', 'openai-primary-runtime', 'documents', '26.614.11602', 'skills', 'documents']);

        const commands = await discoverCodexSkillCommands({ cwd, codexHome });

        expect(commands).toEqual([
            'agent-browser',
            'documents:documents',
            'imagegen',
            'plan-to-beads',
            'superpowers:brainstorming',
        ]);
    });

    it('deduplicates skills discovered from multiple locations', async () => {
        const root = await makeTempRoot();
        const cwd = join(root, 'project');
        const codexHome = join(root, 'codex-home');

        await addSkill(cwd, ['.agents', 'skills', 'plan-to-beads']);
        await addSkill(codexHome, ['skills', 'plan-to-beads']);

        const commands = await discoverCodexSkillCommands({ cwd, codexHome });

        expect(commands).toEqual(['plan-to-beads']);
    });
});
