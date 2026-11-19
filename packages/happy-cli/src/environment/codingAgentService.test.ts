import { describe, it, expect, vi } from 'vitest';
import { createCodingAgentService } from './codingAgentService';
function fixture() {
  let version = '1.0.0';
  let time = 1000;
  const run = vi.fn(async (exe: string, args: readonly string[]) => {
    const stdout = args[0] === '--version' ? `codex ${version}` : args[0] === 'root' ? '/npm/lib/node_modules' : args[0] === 'view' ? '"1.1.0"' : '';
    if (args[0] === 'install') version = '1.1.0';
    return { stdout, stderr: '', exitCode: 0, timedOut: false };
  });
  const realpath = vi.fn(async (p: string) => p === '/bin/codex' ? '/npm/lib/node_modules/@openai/codex/bin/codex.js' : p);
  const service = createCodingAgentService({ runner: { run }, resolve: async name => name === 'npm' ? '/bin/npm' : name === 'codex' ? '/bin/codex' : null,
    realpath, readPackage: async () => ({ name: '@openai/codex' }), env: {}, home: '/home/test', now: () => time });
  return { service, run, realpath, advance: () => { time += 600_001; } };
}
describe('coding agent management', () => {
  it('checks only the requested agent and preserves other rows update tickets', async () => {
    const { service, run } = fixture();
    const first = await service.inspect({ checkUpdates: true, id: 'codex' });
    expect(first.agents.map(agent => agent.id)).toEqual(['codex']);
    const token = first.agents[0]!.updateToken;
    run.mockClear();
    const other = await service.inspect({ checkUpdates: true, id: 'claude' });
    expect(other.agents.map(agent => agent.id)).toEqual(['claude']);
    expect(run).not.toHaveBeenCalled();
    expect(await service.update({ id: 'codex', updateToken: token })).toMatchObject({ success: true });
  });

  it('preserves Windows installation detection without executing npm shims or offering unsafe updates', async () => {
    const run = vi.fn();
    const service = createCodingAgentService({ runner: { run }, platform: 'win32', availability: () => ({ codex: true, claude: true, opencode: false }) });
    const result = await service.inspect({ checkUpdates: true });
    expect(result.agents.find(agent => agent.id === 'claude')).toMatchObject({ installed: true, source: 'manual', reason: 'manual-update' });
    expect(result.agents.find(agent => agent.id === 'opencode')).toMatchObject({ installed: false, reason: 'not-installed' });
    expect(result.agents.every(agent => !agent.updateToken)).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
  it('checks only on request, updates an owned npm installation and verifies the version', async () => {
    const { service, run } = fixture();
    await service.inspect({ checkUpdates: false });
    expect(run.mock.calls.some(([, args]) => args[0] === 'view')).toBe(false);
    const observed = await service.inspect({ checkUpdates: true });
    const agent = observed.agents.find(a => a.id === 'codex')!;
    expect(agent.updateToken).toBeDefined();
    const request = { id: 'codex', updateToken: agent.updateToken };
    expect(await service.update(request)).toMatchObject({ success: true, reason: 'updated', agent: { version: '1.1.0' } });
    expect(run).toHaveBeenCalledWith('/bin/npm', ['install', '--global', '@openai/codex@1.1.0'], expect.anything());
    expect(await service.update(request)).toMatchObject({ success: false, reason: 'stale' });
  });
  it('rejects shell injection and changed installations before mutation', async () => {
    const { service, run, realpath } = fixture();
    await expect(service.update({ id: 'codex;touch /tmp/x', updateToken: 'bad' })).rejects.toThrow();
    const observed = await service.inspect({ checkUpdates: true });
    realpath.mockImplementation(async p => p === '/bin/codex' ? '/custom/codex' : p);
    expect(await service.update({ id: 'codex', updateToken: observed.agents[0]!.updateToken })).toMatchObject({ success: false, reason: 'stale' });
    expect(run.mock.calls.some(([, args]) => args[0] === 'install')).toBe(false);
  });
  it('expires previews and never offers an update for an unknown installation', async () => {
    const { service, run, realpath, advance } = fixture();
    const first = await service.inspect({ checkUpdates: true });
    advance();
    expect(await service.update({ id: 'codex', updateToken: first.agents[0]!.updateToken })).toMatchObject({ success: false, reason: 'stale' });
    realpath.mockImplementation(async p => p === '/bin/codex' ? '/custom/codex' : p);
    const next = await service.inspect({ checkUpdates: true });
    expect(next.agents[0]).toMatchObject({ installed: true, source: 'manual', reason: 'manual-update' });
    expect(next.agents[0]!.updateToken).toBeUndefined();
    expect(run.mock.calls.some(([, args]) => args[0] === 'install')).toBe(false);
  });
  it('serializes updates and reports a failing update without replaying it', async () => {
    const { service, run } = fixture();
    const inspected = await service.inspect({ checkUpdates: true });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const original = run.getMockImplementation()!;
    run.mockImplementation(async (exe, args) => {
      if (args[0] === 'install') { await blocked; return { stdout: '', stderr: 'private installer output', exitCode: 1, timedOut: false }; }
      return original(exe, args);
    });
    const request = { id: 'codex', updateToken: inspected.agents[0]!.updateToken };
    const pending = service.update(request);
    expect(await service.update(request)).toMatchObject({ success: false, reason: 'busy' });
    release();
    expect(await pending).toEqual({ success: false, reason: 'update-failed' });
    expect(await service.update(request)).toMatchObject({ success: false, reason: 'stale' });
  });
  it('keeps a detected CLI installed when its version process cannot launch', async () => {
    const { service, run } = fixture();
    run.mockImplementation(async () => { throw new Error('spawn ENOEXEC'); });
    expect((await service.inspect({ checkUpdates: true })).agents[0]).toMatchObject({ installed: true, version: null, reason: 'check-failed' });
  });

  it('uses Homebrew only when the binary belongs to the matching prefix and formula', async () => {
    let version = '1.0.0';
    const run = vi.fn(async (_exe: string, args: readonly string[]) => {
      if (args[0] === 'upgrade') version = '1.1.0';
      const stdout = args[0] === '--version' ? version : args[0] === '--prefix' ? '/brew' : args[0] === 'info' ? JSON.stringify({ formulae: [{ name: 'opencode', versions: { stable: '1.1.0' } }] }) : '';
      return { stdout, stderr: '', exitCode: 0, timedOut: false };
    });
    const service = createCodingAgentService({ runner: { run }, env: {}, home: '/home',
      resolve: async name => name === 'opencode' ? '/brew/bin/opencode' : name === 'brew' ? '/brew/bin/brew' : null,
      realpath: async p => p === '/brew/bin/opencode' ? '/brew/Cellar/opencode/1.0.0/bin/opencode' : p,
    });
    const observed = (await service.inspect({ checkUpdates: true })).agents.find(a => a.id === 'opencode')!;
    expect(observed).toMatchObject({ source: 'homebrew', reason: 'update-available' });
    expect(await service.update({ id: 'opencode', updateToken: observed.updateToken })).toMatchObject({ success: true });
    expect(run).toHaveBeenCalledWith('/brew/bin/brew', ['upgrade', '--formula', 'opencode'], expect.anything());
  });

});
