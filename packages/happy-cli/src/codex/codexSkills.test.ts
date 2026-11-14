import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { listCodexSkillNames } from './codexSkills';

vi.mock('node:fs', async (importOriginal) => {
    const fs = await importOriginal<typeof import('node:fs')>();
    return { ...fs, readdirSync: vi.fn(fs.readdirSync) };
});

function writeSkill(root: string, relativePath: string, frontmatterName?: string): void {
    const filePath = join(root, relativePath);
    mkdirSync(filePath.replace(/\/SKILL\.md$/, ''), { recursive: true });
    const body = frontmatterName
        ? `---\nname: "${frontmatterName}"\ndescription: "desc"\n---\n`
        : `---\ndescription: "desc"\n---\n`;
    writeFileSync(filePath, body, 'utf8');
}

describe('listCodexSkillNames', () => {
    const created: string[] = [];

    afterEach(() => {
        vi.mocked(readdirSync).mockClear();
        for (const dir of created.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('collects global, local, nested system, and plugin skill names', () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'codex-skills-home-'));
        const repoRoot = mkdtempSync(join(tmpdir(), 'codex-skills-repo-'));
        created.push(homeDir, repoRoot);

        const cwd = join(repoRoot, 'packages', 'happy-cli');
        mkdirSync(cwd, { recursive: true });

        writeSkill(homeDir, '.codex/skills/brainstorming/SKILL.md', 'brainstorming');
        writeSkill(homeDir, '.codex/skills/.system/openai-docs/SKILL.md', 'openai-docs');
        writeSkill(homeDir, '.agents/skills/agent-browser/SKILL.md', 'agent-browser');
        writeSkill(repoRoot, '.agents/skills/dev/SKILL.md', 'dev');
        writeSkill(
            homeDir,
            '.codex/plugins/cache/openai-curated-remote/supabase/1.0.0/skills/supabase/SKILL.md',
            'supabase',
        );

        expect(listCodexSkillNames({ cwd, homeDir })).toEqual([
            'agent-browser',
            'brainstorming',
            'dev',
            'openai-docs',
            'supabase:supabase',
        ]);
    });

    it('treats a Skill as a leaf without scanning its state, dependencies or linked volume', () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'codex-skills-leaf-'));
        const linkedVolume = mkdtempSync(join(tmpdir(), 'codex-skills-volume-'));
        created.push(homeDir, linkedVolume);
        writeSkill(homeDir, '.codex/skills/workflow/SKILL.md', 'workflow');
        writeSkill(homeDir, '.codex/skills/workflow/state/nested/SKILL.md', 'private-state');
        writeSkill(homeDir, '.codex/skills/workflow/node_modules/package/SKILL.md', 'dependency');
        writeSkill(linkedVolume, 'outside/SKILL.md', 'linked-volume');
        const leaf = join(homeDir, '.codex/skills/workflow');
        symlinkSync(linkedVolume, join(leaf, 'external-volume'), process.platform === 'win32' ? 'junction' : 'dir');
        vi.mocked(readdirSync).mockClear();

        expect(listCodexSkillNames({ cwd: homeDir, homeDir })).toEqual(['workflow']);
        const scanned = vi.mocked(readdirSync).mock.calls.map(([path]) => String(path));
        expect(scanned.some(path => path === leaf || path.startsWith(leaf + '/'))).toBe(false);
        expect(scanned.some(path => path.startsWith(linkedVolume))).toBe(false);
    });

    it('keeps traversing aggregate containers to find sibling plugin Skills', () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'codex-skills-container-'));
        created.push(homeDir);
        writeSkill(homeDir, '.codex/plugins/cache/vendor/plugin/1.0.0/skills/one/SKILL.md', 'one');
        writeSkill(homeDir, '.codex/plugins/cache/vendor/plugin/1.0.0/skills/two/SKILL.md', 'two');
        expect(listCodexSkillNames({ cwd: homeDir, homeDir })).toEqual(['plugin:one', 'plugin:two']);
    });

    it('dedupes repeated names across roots', () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'codex-skills-home-'));
        const repoRoot = mkdtempSync(join(tmpdir(), 'codex-skills-repo-'));
        created.push(homeDir, repoRoot);

        const cwd = join(repoRoot, 'apps', 'mobile');
        mkdirSync(cwd, { recursive: true });

        writeSkill(homeDir, '.codex/skills/find-skills/SKILL.md', 'find-skills');
        writeSkill(repoRoot, '.agents/skills/find-skills/SKILL.md', 'find-skills');

        expect(listCodexSkillNames({ cwd, homeDir })).toEqual(['find-skills']);
    });

    it('falls back to the directory name when frontmatter name is missing', () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'codex-skills-home-'));
        created.push(homeDir);

        writeSkill(homeDir, '.codex/skills/no-frontmatter-name/SKILL.md');

        expect(listCodexSkillNames({ cwd: homeDir, homeDir })).toEqual(['no-frontmatter-name']);
    });
});
