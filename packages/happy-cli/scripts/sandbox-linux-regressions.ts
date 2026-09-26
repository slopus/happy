/** Real-UID launcher regressions; run only inside sandbox-linux-smoke's disposable container. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { buildSandboxRuntimeConfig } from '../src/sandbox/config';
import { encodeLauncherInput, prepareClaudeProcessSandbox } from '../src/sandbox/claudeProcessSandbox';

assert.equal(process.env.HAPPY_SANDBOX_LINUX_SMOKE, '1');
assert.equal(execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(), 'agent');
const config = { enabled: true, sessionIsolation: 'strict' as const, customWritePaths: [], extraWritePaths: [], denyReadPaths: [], denyWritePaths: [], networkMode: 'allowed' as const, allowedDomains: [], deniedDomains: [], allowLocalBinding: false };
const launcher = '/usr/local/libexec/abp/claude-sbx-launch';
const launch = (command: string, args: string[], read: string[] = [], write: string[] = [], blocked = false) => execFileSync('/usr/bin/sudo', ['-n', '-u', 'agent-sbx', launcher, '0'], {
    input: encodeLauncherInput({ command, args, cwd: '/work', env: {} }, read, write, blocked), encoding: 'utf8', timeout: 10000,
});
async function launchConfigured(args: string[], blocked: boolean): Promise<void> {
    const sandboxConfig = { ...config, networkMode: blocked ? 'blocked' as const : 'allowed' as const };
    const provider = buildSandboxRuntimeConfig(sandboxConfig, '/work', 'mandatory');
    const sandbox = await prepareClaudeProcessSandbox({ sandboxConfig, sessionPath: '/work',
        additionalDenyRead: provider.filesystem.denyRead, additionalDenyWrite: provider.filesystem.denyWrite });
    try {
        const child = sandbox.spawn({ command: '/usr/bin/python3', args, cwd: '/work', env: {}, signal: new AbortController().signal });
        child.stdout!.resume(); child.stdin!.end();
        const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
        assert.equal(code, 0);
    } finally { await sandbox.close(); }
}
const tests: [string, () => void | Promise<void>][] = [];
tests.push(['complete production deny lists pass /bin/true under private agent home', async () => {
    assert.equal(statSync('/home/agent').mode & 0o777, 0o700);
    for (const name of ['.happy', '.happy-synthetic', '.happy_remote', '.happy-staging']) {
        mkdirSync(`/home/agent/${name}`, { recursive: true, mode: 0o700 });
        writeFileSync(`/home/agent/${name}/access.key`, 'synthetic', { mode: 0o600 });
    }
    const provider = buildSandboxRuntimeConfig(config, '/work', 'mandatory');
    assert.ok(provider.filesystem.denyRead.includes('/home/agent/.happy'));
    assert.ok(provider.filesystem.denyWrite.includes('/home/agent/.happy'));
    const sandbox = await prepareClaudeProcessSandbox({ sandboxConfig: config, sessionPath: '/work',
        additionalDenyRead: provider.filesystem.denyRead, additionalDenyWrite: provider.filesystem.denyWrite });
    await sandbox.close(); // prepare executes the same /bin/true preflight as claudeRemote.
    launch('/usr/bin/python3', ['-c', `import os
assert os.getuid() == ${Number(execFileSync('id', ['-u', 'agent-sbx'], { encoding: 'utf8' }))}
for p in ${JSON.stringify(provider.filesystem.denyRead.map(p => p + '/access.key'))}:
 try: open(p).read()
 except OSError: pass
 else: raise AssertionError(p)`], provider.filesystem.denyRead, provider.filesystem.denyWrite);
}]);
for (const [name, read, write] of [
    ['identical', '/work/masks/identical', '/work/masks/identical'],
    ['read-parent', '/work/masks/read-parent', '/work/masks/read-parent/child'],
    ['write-parent', '/work/masks/write-parent/child', '/work/masks/write-parent'],
] as const) {
    tests.push([`read masks survive ${name} denyWrite overlap`, () => {
        const parent = name === 'read-parent' ? write : read;
        mkdirSync(parent, { recursive: true }); chmodSync(parent, 0o777);
        chmodSync(write, 0o777);
        writeFileSync(`${parent}/canary`, 'synthetic-canary');
        launch('/usr/bin/python3', ['-c', `assert open('${parent}/canary').read() == 'synthetic-canary'
open('${write}/control-write','w').write('synthetic')`]);
        launch('/usr/bin/python3', ['-c', `import os
try: open('${parent}/canary').read()
except OSError: pass
else: raise AssertionError('read mask undone')
try: open('${write}/forbidden-write','w').write('synthetic')
except OSError: pass
else: raise AssertionError('write denial undone')`], [read], [write]);
    }]);
}
tests.push(['explicit read denial still masks the MCP allowlist', () => {
    mkdirSync('/run/abp-mcp/denied', { recursive: true, mode: 0o755 });
    writeFileSync('/run/abp-mcp/denied/canary', 'synthetic');
    launch('/usr/bin/python3', ['-c', "assert open('/run/abp-mcp/denied/canary').read() == 'synthetic'"]);
    launch('/usr/bin/python3', ['-c', "try: open('/run/abp-mcp/denied/canary').read()\nexcept OSError: pass\nelse: raise AssertionError('MCP allowlist overrode read denial')"], ['/run/abp-mcp/denied']);
}]);
tests.push(['private run never permits denied writes', () => {
    launch('/usr/bin/python3', ['-c', "try: open('/run/forbidden-write','w').write('synthetic')\nexcept OSError: pass\nelse: raise AssertionError('write denial undone')"], [], ['/run']);
}]);
tests.push(['uncovered inaccessible restrictions still fail closed', () => {
    mkdirSync('/work/private/child', { recursive: true }); chmodSync('/work/private', 0o700);
    assert.throws(() => launch('/bin/true', [], [], ['/work/private/child']), { status: 125 });
}]);
const sockets = ['/run/systemd/resolve/io.systemd.Resolve', '/run/dbus/system_bus_socket', '/run/systemd/private', '/run/nscd/socket', '/var/run/nscd/socket'];
for (const blocked of [false, true]) {
    tests.push([`host resolver and bus requests denied (networkMode=${blocked ? 'blocked' : 'allowed'})`, async () => {
        // Positive controls: an unapproved name resolves through the real host resolver and D-Bus.
        execFileSync('/usr/bin/python3', ['-c', `import socket,json
assert socket.getaddrinfo('exfil.unapproved.test',443)
for p in ${JSON.stringify(sockets)}:
 s=socket.socket(socket.AF_UNIX); s.settimeout(2); s.connect(p)
 if 'io.systemd' in p:
  s.sendall((json.dumps({'method':'io.systemd.Resolve.ResolveHostname','parameters':{'name':'exfil.unapproved.test','family':0}})+'\\0').encode())
  assert 'parameters' in json.loads(s.recv(65536).rstrip(b'\\0'))
 s.close()`]);
        execFileSync('/usr/bin/busctl', ['--system', 'call', 'org.freedesktop.resolve1', '/org/freedesktop/resolve1', 'org.freedesktop.resolve1.Manager', 'ResolveHostname', 'isit', '0', 'exfil.unapproved.test', '0', '0']);
        await launchConfigured(['-c', `import socket, json, subprocess
paths=${JSON.stringify(sockets)}
for p in paths:
 s=socket.socket(socket.AF_UNIX); s.settimeout(1)
 try:
  s.connect(p)
  s.sendall((json.dumps({'method':'io.systemd.Resolve.ResolveHostname','parameters':{'name':'exfil.unapproved.test','family':0}})+'\\0').encode() if 'io.systemd' in p else b'\\0AUTH EXTERNAL\\r\\n')
 except OSError: pass
 else: raise AssertionError('host interface reachable: '+p)
 finally: s.close()
assert subprocess.run(['/usr/bin/busctl','--system','call','org.freedesktop.resolve1','/org/freedesktop/resolve1','org.freedesktop.resolve1.Manager','ResolveHostname','isit','0','exfil.unapproved.test','0','0'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode != 0
assert subprocess.run(['/usr/bin/resolvectl','query','exfil.unapproved.test'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode != 0
try: socket.getaddrinfo('exfil.unapproved.test',443)
except socket.gaierror: pass
else: raise AssertionError('unapproved hostname resolved')`], blocked);
    }]);
}
let failures = 0;
for (const [name, test] of tests) {
    try { await test(); console.log(`PASS: ${name}`); }
    catch (error) { failures++; console.error(`FAIL: ${name}`, error); }
}
assert.equal(failures, 0, 'launcher regressions');
