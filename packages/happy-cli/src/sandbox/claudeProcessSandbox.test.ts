import { describe, expect, it } from 'vitest';
import { filterClaudeProcessEnv, encodeLauncherInput, prepareClaudeProcessSandbox } from './claudeProcessSandbox';
import { assertFirewallRules, firewallRules } from './sandboxPreflight';
const config = { enabled: true, sessionIsolation: 'strict' as const, customWritePaths: [], extraWritePaths: [], denyReadPaths: [], denyWritePaths: [], networkMode: 'allowed' as const, allowedDomains: [], deniedDomains: [], allowLocalBinding: false };
describe('separate UID sandbox', () => {
    it('strips caller homes, injection variables and Happy secrets', () => {
        const env = filterClaudeProcessEnv({ HOME: '/home/agent', PATH: '/evil', NODE_OPTIONS: '--require /evil', BASH_ENV: '/evil', HAPPY_BROWSER_TASK_SESSION_SECRET: 'synthetic', ANTHROPIC_API_KEY: 'synthetic' });
        expect(env.HOME).toBe('/home/agent-sbx');
        expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
        expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:3128');
        for (const name of ['NODE_OPTIONS', 'BASH_ENV', 'HAPPY_BROWSER_TASK_SESSION_SECRET']) expect(env[name]).toBeUndefined();
        expect(env.ANTHROPIC_API_KEY).toBe('synthetic');
    });
    it('frames arbitrary argv as data in a single bounded descriptor', () => {
        const args = ['', 'a\nb', '$(touch /work/evil)', '*'];
        expect(encodeLauncherInput({ command: '/usr/bin/node', args, cwd: '/work', env: {} }).toString()).toContain(args.join('\0'));
        expect(() => encodeLauncherInput({ command: '/bin/true', args: ['a\0b'], cwd: '/work', env: {} })).toThrow();
    });
    it('fails closed before launching on disabled config or unsupported OS', async () => {
        await expect(prepareClaudeProcessSandbox({ sandboxConfig: { ...config, enabled: false }, sessionPath: '/work' })).rejects.toThrow();
        if (process.platform !== 'linux') await expect(prepareClaudeProcessSandbox({ sandboxConfig: config, sessionPath: '/work' })).rejects.toThrow();
    });
    it.each([4, 6] as const)('requires ordered IPv%s firewall rules and rejects every missing rule or earlier bypass', family => {
        const rules = firewallRules(family, 1001, 1002);
        assertFirewallRules(rules.join('\n'), family, 1001, 1002);
        for (let i = 0; i < rules.length; i++) expect(() => assertFirewallRules(rules.filter((_, n) => n !== i).join('\n'), family, 1001, 1002)).toThrow();
        expect(() => assertFirewallRules('-A OUTPUT -j ACCEPT\n' + rules.join('\n'), family, 1001, 1002)).toThrow();
    });
});
