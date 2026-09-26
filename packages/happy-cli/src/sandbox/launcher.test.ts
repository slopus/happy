import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filterClaudeProcessEnv } from './claudeProcessSandbox';
const dir = mkdtempSync(join(tmpdir(), 'launcher-unit-'));
copyFileSync('scripts/agent-browser/claude-sbx-launch', join(dir, 'launcher.cjs'));
const launcher = createRequire(import.meta.url)(join(dir, 'launcher.cjs')) as { filterEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv; validate: (meta: unknown, args: string[]) => void; normalizeRestrictions: (read: string[], write: string[]) => { read: string[]; write: string[] } };
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
});
