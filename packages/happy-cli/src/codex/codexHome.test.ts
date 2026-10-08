import { mkdir, mkdtemp, readFile, writeFile, stat, symlink, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareCodexHomeWithAuth, resolveCodexHome } from './codexHome';

async function makeTempDir(prefix: string): Promise<string> {
    return mkdtemp(join(tmpdir(), prefix));
}

describe('resolveCodexHome', () => {
    it('defaults to ~/.codex', () => {
        expect(resolveCodexHome({
            env: {},
            homeDir: '/Users/tester',
        })).toBe('/Users/tester/.codex');
    });

    it('respects CODEX_HOME', () => {
        expect(resolveCodexHome({
            env: { CODEX_HOME: '~/custom-codex' },
            homeDir: '/Users/tester',
        })).toBe('/Users/tester/custom-codex');
    });
});

describe('prepareCodexHomeWithAuth', () => {
    it('isolates application launches from host MCP, skills and instructions while retaining the selected login', async () => {
        const sourceHome = await makeTempDir('codex-app-source-');
        let home: string | undefined;
        try {
            await writeFile(join(sourceHome, 'config.toml'), '[mcp_servers.host]\ncommand="host-only"');
            await writeFile(join(sourceHome, 'AGENTS.md'), 'host instructions');
            await mkdir(join(sourceHome, 'skills'));
            await writeFile(join(sourceHome, 'auth.json'), 'host-login');
            home = await prepareCodexHomeWithAuth('selected-login', { sourceHome, inheritConfiguration: false });
            expect(await readdir(home)).toEqual(['auth.json']);
            expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('selected-login');
            expect(await readFile(join(sourceHome, 'auth.json'), 'utf8')).toBe('host-login');
        } finally {
            await rm(sourceHome, { recursive: true, force: true });
            if (home) await rm(home, { recursive: true, force: true });
        }
    });
    it('writes private auth without overwriting a pre-existing auth symlink', async () => {
        const sourceHome = await makeTempDir('codex-source-');
        await writeFile(join(sourceHome, 'auth.json'), 'global-original');
        const tempHome = await makeTempDir('codex-private-');
        await symlink(join(sourceHome, 'auth.json'), join(tempHome, 'auth.json'));
        await expect(prepareCodexHomeWithAuth('secret', { sourceHome, createTempDir: () => tempHome })).rejects.toThrow();
        expect(await readFile(join(sourceHome, 'auth.json'), 'utf8')).toBe('global-original');
        const safe = await prepareCodexHomeWithAuth('secret', { sourceHome });
        expect((await stat(join(safe, 'auth.json'))).mode & 0o777).toBe(0o600);
        expect((await stat(safe)).mode & 0o777).toBe(0o700);
    });
    it('inherits Codex configuration entries while isolating auth.json', async () => {
        const sourceHome = await makeTempDir('codex-source-');
        const tempHome = await makeTempDir('codex-temp-');

        await writeFile(join(sourceHome, 'auth.json'), 'local-auth');
        await writeFile(join(sourceHome, 'config.toml'), 'model = "gpt-5.5"');
        await writeFile(join(sourceHome, 'work.config.toml'), 'model = "gpt-5.5-mini"');
        await writeFile(join(sourceHome, 'AGENTS.md'), 'global instructions');
        await writeFile(join(sourceHome, 'hooks.json'), '{"hooks":[]}');
        await writeFile(join(sourceHome, 'history.jsonl'), 'do not inherit');
        await mkdir(join(sourceHome, 'skills', 'codex-harness'), { recursive: true });
        await writeFile(join(sourceHome, 'skills', 'codex-harness', 'SKILL.md'), 'harness skill');
        await mkdir(join(sourceHome, 'plugins', 'cache', 'plugin', '1.0.0'), { recursive: true });
        await writeFile(join(sourceHome, 'plugins', 'cache', 'plugin', '1.0.0', 'plugin.json'), '{}');

        const result = await prepareCodexHomeWithAuth('cloud-auth', {
            sourceHome,
            createTempDir: () => tempHome,
        });

        expect(result).toBe(tempHome);
        await expect(readFile(join(tempHome, 'auth.json'), 'utf8')).resolves.toBe('cloud-auth');
        await expect(readFile(join(tempHome, 'config.toml'), 'utf8')).resolves.toBe('model = "gpt-5.5"');
        await expect(readFile(join(tempHome, 'work.config.toml'), 'utf8')).resolves.toBe('model = "gpt-5.5-mini"');
        await expect(readFile(join(tempHome, 'AGENTS.md'), 'utf8')).resolves.toBe('global instructions');
        await expect(readFile(join(tempHome, 'hooks.json'), 'utf8')).resolves.toBe('{"hooks":[]}');
        await expect(readFile(join(tempHome, 'skills', 'codex-harness', 'SKILL.md'), 'utf8')).resolves.toBe('harness skill');
        await expect(readFile(join(tempHome, 'plugins', 'cache', 'plugin', '1.0.0', 'plugin.json'), 'utf8')).resolves.toBe('{}');
        await expect(readFile(join(tempHome, 'history.jsonl'), 'utf8')).rejects.toThrow();
    });

    it('still creates an auth-only Codex home when the source home does not exist', async () => {
        const tempHome = await makeTempDir('codex-auth-only-');
        const result = await prepareCodexHomeWithAuth('cloud-auth', {
            sourceHome: join(tempHome, 'missing-source'),
            createTempDir: () => tempHome,
        });

        expect(result).toBe(tempHome);
        await expect(readFile(join(tempHome, 'auth.json'), 'utf8')).resolves.toBe('cloud-auth');
    });
});
