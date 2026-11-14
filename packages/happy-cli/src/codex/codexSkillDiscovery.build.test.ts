import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverCodexSkillNames } from './codexSkillDiscovery';
import { resolveHappyCLIEntrypoint } from '../utils/spawnHappyCLI';

const execute = promisify(execFile);
const directories: string[] = [];
const packageDir = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);

afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
    const homeDir = mkdtempSync(join(tmpdir(), 'paws-skill-entry-'));
    directories.push(homeDir);
    const skillDir = join(homeDir, '.codex', 'skills', 'fixture');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: fixture\n---\nSynthetic fixture');
    return homeDir;
}

describe('packaged Skill discovery entry', () => {
    it('requires both scanner formats and their types before the atomic build can promote', () => {
        const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
        const { collectDistOutputs } = require(join(packageDir, 'scripts/build-atomic.cjs'));
        const required = collectDistOutputs(manifest);
        expect(required).toEqual(expect.arrayContaining([
            'codexSkillDiscoveryEntry.mjs', 'codexSkillDiscoveryEntry.cjs',
            'codexSkillDiscoveryEntry.d.mts', 'codexSkillDiscoveryEntry.d.cts',
        ]));
        for (const file of required.filter((file: string) => file.startsWith('codexSkillDiscoveryEntry.'))) {
            expect(existsSync(join(packageDir, 'dist', file))).toBe(true);
        }
        expect(manifest.files).toContain('dist');
        expect(resolveHappyCLIEntrypoint('codex-skill-discovery')).toBe(join(packageDir, 'dist/codexSkillDiscoveryEntry.mjs'));
    });

    it.each(['mjs', 'cjs'])('executes the actual %s scanner without CLI authentication or a session', async extension => {
        const homeDir = fixture();
        const { stdout, stderr } = await execute(process.execPath, [
            join(packageDir, `dist/codexSkillDiscoveryEntry.${extension}`), JSON.stringify({ cwd: homeDir, homeDir }),
        ], { encoding: 'utf8', timeout: 5_000, env: { PATH: process.env.PATH, HOME: homeDir } });
        expect(JSON.parse(stdout)).toEqual(['fixture']);
        expect(stderr).toBe('');
        expect(existsSync(join(homeDir, '.happy'))).toBe(false);
    });

    it('uses the real packaged scanner through the startup helper', async () => {
        const homeDir = fixture();
        await expect(discoverCodexSkillNames({ cwd: homeDir, homeDir })).resolves.toEqual(['fixture']);
    });
});
