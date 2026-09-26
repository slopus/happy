import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ exec: vi.fn(), stat: vi.fn(), realpath: vi.fn((p: string) => p) }));
vi.mock('node:child_process', () => ({ execFileSync: mocks.exec }));
vi.mock('node:fs', () => ({ lstatSync: mocks.stat, realpathSync: mocks.realpath }));
vi.mock('node:os', () => ({ userInfo: () => ({ uid: 1000, username: 'agent', homedir: '/home/agent' }) }));
import { checkSandboxPrerequisites, firewallRules, FIREWALL_READER, SANDBOX_LAUNCHER } from './sandboxPreflight';
beforeEach(() => {
    mocks.stat.mockImplementation((path: string) => ({ uid: path === '/home/agent' ? 1000 : 0, mode: path === '/home/agent' ? 0o700 : 0o755, isDirectory: () => true, isSymbolicLink: () => false }));
    mocks.exec.mockImplementation((path: string, args: string[]) => {
        if (path === '/usr/bin/id') return args[0] === '-Gn' ? 'agent-sbx abp-work' : args[1] === 'agent-sbx' ? '1001' : '1002';
        if (path === FIREWALL_READER) return [4, 6].map(family => '*filter\n' + firewallRules(family as 4 | 6, 1001, 1002).join('\n') + '\nCOMMIT\n').join('');
        return '';
    });
});
it('checks current rules and the exact sudo command', () => {
    checkSandboxPrerequisites();
    expect(mocks.exec).toHaveBeenCalledWith('/usr/bin/sudo', ['-n', '-l', '-u', 'agent-sbx', SANDBOX_LAUNCHER, '0'], expect.anything());
});
it.each(['/usr/bin/bwrap', SANDBOX_LAUNCHER, FIREWALL_READER])('refuses missing or mutable prerequisite %s', path => {
    const original = mocks.stat.getMockImplementation()!;
    mocks.stat.mockImplementation(p => { if (p === path) throw new Error('missing'); return original(p); });
    expect(() => checkSandboxPrerequisites()).toThrow();
});
it.each(['/usr/bin/sudo', FIREWALL_READER])('refuses failed live check %s', path => {
    const original = mocks.exec.getMockImplementation()!;
    mocks.exec.mockImplementation((p, args) => { if (p === path) throw new Error('denied'); return original(p, args); });
    expect(() => checkSandboxPrerequisites()).toThrow();
});
it('refuses broker group membership', () => {
    const original = mocks.exec.getMockImplementation()!;
    mocks.exec.mockImplementation((p, args) => args[0] === '-Gn' ? 'agent-sbx abp-session' : original(p, args));
    expect(() => checkSandboxPrerequisites()).toThrow(/sandbox identity, permissions/);
});
it('refuses a world-readable agent home while every installation path is trusted', () => {
    // Only the home changes (0755): the installation paths stay root-owned 0755, so a failure here can only
    // come from the home check, never from the earlier installation check.
    const original = mocks.stat.getMockImplementation()!;
    mocks.stat.mockImplementation((p: string) => p === '/home/agent' ? { ...original(p), mode: 0o755 } : original(p));
    expect(() => checkSandboxPrerequisites()).toThrow(/sandbox identity, permissions/);
    expect(() => checkSandboxPrerequisites()).not.toThrow(/untrusted sandbox installation/);
});
