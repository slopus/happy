import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filterClaudeProcessEnv } from './claudeProcessSandbox';
const dir = mkdtempSync(join(tmpdir(), 'launcher-unit-'));
copyFileSync('scripts/agent-browser/claude-sbx-launch', join(dir, 'launcher.cjs'));
const launcher = createRequire(import.meta.url)(join(dir, 'launcher.cjs')) as { filterEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv; validate: (meta: unknown, args: string[]) => void; normalizeRestrictions: (read: string[], write: string[]) => { read: string[]; write: string[] }; withStoredToken: (env: NodeJS.ProcessEnv, file: string, warn: (message: string) => void) => NodeJS.ProcessEnv };
afterAll(() => rmSync(dir, { recursive: true, force: true }));
describe('installed fixed launcher', () => {
    it('reapplies the env allowlist independently of the Happy caller', () => {
        const env = { HOME: '/secret', PATH: '/work', BASH_ENV: '/work/evil', NODE_OPTIONS: '--inspect', LD_PRELOAD: '/work/evil', HAPPY_TOKEN: 'synthetic', SAYCODE_MCP_TOKEN: 'synthetic', CLAUDE_CONFIG_DIR: '/secret', ANTHROPIC_API_KEY: 'synthetic', LANG: 'C' };
        expect(launcher.filterEnv(env)).toEqual(filterClaudeProcessEnv(env));
    });
    it('drops source binds covered by read masks before statting inaccessible descendants', () => {
        expect(launcher.normalizeRestrictions(['/home/agent', '/home/agent/.happy', '/work/secret'],
            ['/home/agent/.happy', '/home/agent/.happy-staging/key', '/work/secret', '/work/secret/child', '/work/secrets']))
            .toEqual({ read: ['/home/agent', '/work/secret'], write: ['/work/secrets'] });
    });
    it('normalizes path boundaries and keeps write ancestors before nested read masks', () => {
        expect(launcher.normalizeRestrictions(['/work/parent/child/', '/work/parent/child/deeper', '/work/./secret'],
            ['/work/parent', '/work/parent/child', '/work/secret/../secret/key']))
            .toEqual({ read: ['/work/parent/child', '/work/secret'], write: ['/work/parent'] });
    });
    it('rejects invalid argv metadata without executing text', () => {
        const meta = { version: 1, argc: 1, cwd: '/work', env: {}, denyRead: [], denyWrite: [] };
        launcher.validate(meta, ['/bin/true']);
        for (const altered of [{ ...meta, argc: 2 }, { ...meta, argc: -1 }, { ...meta, version: 0 }, { ...meta, cwd: 'relative' }, { ...meta, denyRead: ['relative'] }]) expect(() => launcher.validate(altered, ['/bin/true'])).toThrow();
        expect(() => launcher.validate(meta, ['$(touch /work/evil)'])).toThrow();
    });
    describe('stored long-lived Claude token (abp-install claude-login --token-file)', () => {
        const token = 'sk-ant-oat01-' + 'a'.repeat(40);
        const stored = (content: string, mode = 0o600) => { const file = join(dir, `token-${Math.random()}`); writeFileSync(file, content); chmodSync(file, mode); return file; };
        const run = (env: NodeJS.ProcessEnv, file: string) => { const warnings: string[] = []; return { env: launcher.withStoredToken(env, file, m => warnings.push(m)), warnings }; };
        it('supplies CLAUDE_CODE_OAUTH_TOKEN from the agent-sbx-only file when the session brings no credential', () => {
            const { env, warnings } = run({ LANG: 'C' }, stored(`${token}\n`));
            expect(env).toEqual({ LANG: 'C', CLAUDE_CODE_OAUTH_TOKEN: token });
            expect(warnings).toEqual([]);
        });
        it('keeps a credential the session brings', () => {
            for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
                expect(run({ [key]: 'session' }, stored(token)).env).toEqual({ [key]: 'session' });
            }
        });
        it('uses no file when there is none, silently', () => {
            expect(run({}, join(dir, 'absent'))).toEqual({ env: {}, warnings: [] });
        });
        it('refuses, and says so, a file others can read, a symlink or malformed content', () => {
            const link = join(dir, `link-${Math.random()}`); symlinkSync(stored(token), link);
            for (const file of [stored(token, 0o644), link, stored('two words'), stored(''), stored('x'.repeat(5000))]) {
                const { env, warnings } = run({}, file);
                expect(env).toEqual({});
                expect(warnings).toHaveLength(1);
                expect(warnings[0]).not.toContain(token);
            }
        });
    });
});
