/** Disposable privileged-container regression; only synthetic credentials, no daemon. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildSandboxRuntimeConfig } from '../src/sandbox/config';
import { checkProxyReachable, firewallRules } from '../src/sandbox/sandboxPreflight';
import { prepareClaudeProcessSandbox } from '../src/sandbox/claudeProcessSandbox';
import { startHappyServer } from '../src/claude/utils/startHappyServer';
import type { ApiSessionClient } from '../src/api/apiSession';
import { BROWSER_TASK_TOOL_NAMES } from '../src/browserRuntime/agentTools';
import { stageUserCredentials, unstageUserCredentials } from '../src/daemon/stageUserCredentials';

assert.equal(process.platform, 'linux');
assert.equal(process.env.HAPPY_SANDBOX_LINUX_SMOKE, '1');
const uid = (name: string) => Number(execFileSync('/usr/bin/id', ['-u', name], { encoding: 'utf8' }).trim());
const gid = (name: string) => Number(execFileSync('/usr/bin/id', ['-g', name], { encoding: 'utf8' }).trim());
const config = { enabled: true, sessionIsolation: 'strict' as const, customWritePaths: [], extraWritePaths: [], denyReadPaths: [], denyWritePaths: [], networkMode: 'allowed' as const, allowedDomains: [], deniedDomains: [], allowLocalBinding: false };
if (process.getuid!() === 0) {
    for (const family of [4, 6] as const) {
        for (const rule of firewallRules(family, uid('agent-sbx'), uid('abp-proxy'))) execFileSync(family === 4 ? '/usr/sbin/iptables' : '/usr/sbin/ip6tables', rule.split(' '));
    }
    writeFileSync('/etc/aplus/sandbox-policy.json', '{"mode":"mandatory"}');
    writeFileSync('/etc/aplus/claude-sandbox.json', JSON.stringify({ allowedDomains: ['api.anthropic.com', 'platform.claude.com', 'private.allowed.test'] }));
    writeFileSync('/etc/hosts', '\n127.0.0.1 private.allowed.test\n8.8.8.8 platform.claude.com\n', { flag: 'a' });
    writeFileSync('/etc/abp/key', 'synthetic-stack-key', { mode: 0o600 });
    writeFileSync('/var/lib/abp/key', 'synthetic-stack-key', { mode: 0o600 });
    const broker = createServer((_req, res) => res.end('must-not-read'));
    await new Promise<void>(resolve => broker.listen('/run/abp/broker.sock', resolve));
    chmodSync('/run/abp/broker.sock', 0o660); chownSync('/run/abp/broker.sock', 0, Number(execFileSync('getent', ['group', 'abp-session'], { encoding: 'utf8' }).split(':')[2]));
    const protectedPaths = ['/run/abp/admin.sock', '/run/docker.sock', '/run/systemd/private'];
    const protectedSockets = protectedPaths.map(() => createServer((_req, res) => res.end('must-not-read')));
    await Promise.all(protectedSockets.map((server, index) => new Promise<void>(resolve => { const path = protectedPaths[index]; server.listen(path, () => { chmodSync(path, path === '/run/systemd/private' ? 0o666 : 0o600); resolve(); }); })));
    // A synthetic public-address TLS endpoint exercises CONNECT + the refresh URL without internet credentials.
    execFileSync('/usr/sbin/ip', ['addr', 'add', '8.8.8.8/32', 'dev', 'lo']);
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '/tmp/refresh.key', '-out', '/tmp/refresh.crt', '-subj', '/CN=platform.claude.com', '-days', '1'], { stdio: 'ignore' });
    writeFileSync('/tmp/refresh-server.py', `import http.server, ssl, json\nclass H(http.server.BaseHTTPRequestHandler):\n def do_POST(self):\n  assert self.path == '/v1/oauth/token'\n  assert b'synthetic-refresh-old' in self.rfile.read(int(self.headers['Content-Length']))\n  self.send_response(200); self.end_headers(); self.wfile.write(json.dumps({'access_token':'synthetic-access-new','refresh_token':'synthetic-refresh-new'}).encode())\n def log_message(self,*args): pass\ns=http.server.HTTPServer(('8.8.8.8',443),H); c=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain('/tmp/refresh.crt','/tmp/refresh.key'); s.socket=c.wrap_socket(s.socket,server_side=True); s.serve_forever()\n`);
    const refresh = spawn('/usr/bin/python3', ['/tmp/refresh-server.py'], { stdio: 'inherit' });
    const proxy = spawn('/usr/sbin/runuser', ['-u', 'abp-proxy', '--', '/usr/local/bin/node', '--import', '/test/node_modules/tsx/dist/loader.mjs', 'src/sandbox/egressProxyMain.ts'], { stdio: 'inherit' });
    for (let i = 0; ; i++) {
        try { await checkProxyReachable(); break; }
        catch (error) { if (i === 99) throw error; await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    const regressions = spawn('/usr/sbin/runuser', ['-u', 'agent', '--', '/usr/local/bin/node', '--import', '/test/node_modules/tsx/dist/loader.mjs', 'scripts/sandbox-linux-regressions.ts'], { env: { ...process.env, HOME: '/home/agent', HAPPY_HOME_DIR: '/home/agent/.happy-synthetic' }, stdio: 'inherit' });
    const regressionCode = await new Promise<number | null>(resolve => regressions.on('exit', resolve));
    if (regressionCode !== 0) process.exit(1);
    const child = spawn('/usr/sbin/runuser', ['-u', 'agent', '--', '/usr/local/bin/node', '--import', '/test/node_modules/tsx/dist/loader.mjs', 'scripts/sandbox-linux-smoke.ts'], { env: { ...process.env, HOME: '/home/agent', HAPPY_HOME_DIR: '/home/agent/.happy-synthetic' }, stdio: 'inherit' });
    const code = await new Promise<number | null>(resolve => child.on('exit', resolve));
    proxy.kill('SIGTERM'); refresh.kill('SIGTERM'); broker.close(); protectedSockets.forEach(server => server.close());
    assert.equal(code, 0);
    const agentProcess = spawn('/bin/sleep', ['30'], { uid: uid('agent'), gid: gid('agent'), stdio: 'ignore' });
    try {
        execFileSync('/usr/sbin/runuser', ['-u', 'agent-sbx', '--', '/usr/bin/python3', '-c', `import ctypes,socket,platform,errno
c=ctypes.CDLL(None,use_errno=True)
n=198 if platform.machine()=='aarch64' else 41
fd=c.syscall(n,ctypes.c_ulonglong(0x100000001),1,0)
assert fd>=0
s=socket.socket(fileno=fd)
try: s.connect('/run/abp/broker.sock')
except OSError as e: assert e.errno==errno.EACCES
else: raise AssertionError('broker reached')
try: open('/home/agent/.happy-synthetic/access.key').read()
except PermissionError: pass
else: raise AssertionError('credentials readable')
assert c.ptrace(16,${agentProcess.pid},0,0)==-1 and ctypes.get_errno()==errno.EPERM
print('PASS: WITHOUT bwrap or seccomp, UID permissions deny raw AF_UNIX broker, credentials and ptrace')`], { stdio: 'inherit' });
    } finally { agentProcess.kill('SIGTERM'); }
    // The same application preflight must refuse a deleted live rule, not a stale installation marker.
    execFileSync('/usr/sbin/ip6tables', ['-D', 'OUTPUT', '1']);
    const missing = spawn('/usr/sbin/runuser', ['-u', 'agent', '--', '/usr/local/bin/node', '--import', '/test/node_modules/tsx/dist/loader.mjs', 'scripts/sandbox-linux-smoke.ts', '--missing-firewall'], { env: { ...process.env, HOME: '/home/agent', HAPPY_HOME_DIR: '/home/agent/.happy-synthetic' }, stdio: 'inherit' });
    assert.equal(await new Promise(resolve => missing.on('exit', resolve)), 0);
} else if (process.argv.includes('--missing-firewall')) {
    await assert.rejects(prepareClaudeProcessSandbox({ sandboxConfig: config, sessionPath: '/work' }), /firewall/);
    console.log('PASS: missing live firewall rule refuses session');
} else {
    assert.equal(process.getuid!(), uid('agent'));
    mkdirSync('/home/agent/.happy-synthetic', { mode: 0o700, recursive: true });
    chmodSync('/home/agent/.happy-synthetic', 0o700);
    writeFileSync('/home/agent/.happy-synthetic/access.key', 'synthetic-happy', { mode: 0o600 });
    const host = createServer((_req, res) => res.end('must-not-read'));
    await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve));
    const hostPort = (host.address() as { port: number }).port;
    process.env.HAPPY_BROWSER_TASK_RUNTIME_URL = `http://127.0.0.1:${hostPort}`;
    const happy = await startHappyServer({ sessionId: 'synthetic-session', hasTitle: () => true } as ApiSessionClient, { mandatorySandbox: true });
    // Proxy startup is asynchronous; bounded readiness before asserting production preflight.
    for (let i = 0; i < 100; i++) { try { execFileSync('curl', ['-s', '--max-time', '1', 'http://127.0.0.1:3128'], { stdio: 'ignore' }); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); } }
    const providerSandbox = buildSandboxRuntimeConfig(config, '/work', 'mandatory');
    const sandbox = await prepareClaudeProcessSandbox({ sandboxConfig: config, sessionPath: '/work', mcpSocketPath: happy.socketPath,
        additionalDenyRead: providerSandbox.filesystem.denyRead, additionalDenyWrite: providerSandbox.filesystem.denyWrite });
    async function run(command: string, args: string[], signal = new AbortController().signal, endInput = true): Promise<{ code: number | null; output: string }> {
        const child = sandbox.spawn({ command, args, cwd: '/work', signal, env: { ...process.env, ...happy.mcpConfig.env, HAPPY_MASTER_SECRET: 'synthetic-secret' } });
        let output = ''; child.stdout!.on('data', data => { output += data; });
        if (endInput) child.stdin!.end();
        return new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve({ code, output })); });
    }
    let staged: string | undefined;
    try {
        process.env.TMPDIR = '/work';
        const lateReader = run('/usr/local/bin/node', ['-e', `const fs=require('fs'),assert=require('assert/strict');fs.writeFileSync('/work/late-reader-ready','ready');const timer=setInterval(()=>{if(!fs.existsSync('/work/late-staging-path'))return;clearInterval(timer);assert.throws(()=>fs.readFileSync(fs.readFileSync('/work/late-staging-path','utf8')+'/access.key'));},20);`]);
        while (!existsSync('/work/late-reader-ready')) await new Promise(resolve => setTimeout(resolve, 20));
        staged = (await stageUserCredentials('synthetic-late', 'synthetic-secret')).homeDir;
        assert.ok(staged.startsWith('/home/agent/.happy-staging/'));
        writeFileSync('/work/late-staging-path', staged);
        assert.equal((await lateReader).code, 0);
        console.log('PASS: credentials staged after sandbox startup remain unreadable despite TMPDIR=/work');
        const args = ['', 'space and\nnewline', '$(touch /work/evil)', '*'];
        const concurrent = await Promise.all(Array.from({ length: 8 }, () => run('/usr/local/bin/node', ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args])));
        for (const result of concurrent) { assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.output), args); }
        assert.equal(existsSync('/work/evil'), false);
        console.log('PASS: 8 simultaneous single-fd argv launches; no shell evaluation');
        const checks = `
const fs=require('node:fs'),assert=require('node:assert/strict'),http=require('node:http'),net=require('node:net');
for(const p of ['/home/agent/.happy-synthetic/access.key',${JSON.stringify(staged + '/access.key')},'/etc/abp/key','/var/lib/abp/key']) assert.throws(()=>fs.readFileSync(p));
assert.equal(process.env.HAPPY_MASTER_SECRET,undefined); assert.equal(process.env.HOME,'/home/agent-sbx');
function connect(o) { return new Promise(resolve=>{const s=net.connect(o);s.setTimeout(1000);s.on('connect',()=>{s.destroy();resolve(true)});s.on('error',()=>resolve(false));s.on('timeout',()=>{s.destroy();resolve(false)});}); }
(async()=>{for(const o of [{path:'/run/abp/broker.sock'},{path:'/run/abp/admin.sock'},{path:'/run/docker.sock'},{host:'127.0.0.1',port:${hostPort}},{host:'10.0.0.1',port:443},{host:'::1',port:${hostPort}},{host:'8.8.8.8',port:443}])assert.equal(await connect(o),false);
const req=(token)=>new Promise((resolve,reject)=>{let body='';const r=http.request({socketPath:process.env.SAYCODE_MCP_SOCKET,path:'/',method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'}},res=>{res.on('data',d=>body+=d);res.on('end',()=>resolve({status:res.statusCode,body}));});r.on('error',reject);r.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}));});
assert.equal((await req('wrong-synthetic')).status,401);const r=await req(process.env.SAYCODE_MCP_TOKEN);assert.equal(r.status,200);assert.deepEqual(JSON.parse(r.body.slice(r.body.indexOf('data: ')+6)).result.tools.map(t=>t.name).sort(),${JSON.stringify(['change_title', ...BROWSER_TASK_TOOL_NAMES].sort())});
console.log('PASS: filesystem, loopback/private/public TCP denial, authenticated 13-tool Unix MCP');})().catch(e=>{console.error(e);process.exit(1)});
`;
        const result = await run('/usr/local/bin/node', ['-e', checks]); assert.equal(result.code, 0); process.stdout.write(result.output);
        const bridge = await run('/usr/local/bin/node', ['--input-type=module', '-e', `
import {Client} from '/w/packages/happy-cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StdioClientTransport} from '/w/packages/happy-cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
const client=new Client({name:'synthetic',version:'1'},{capabilities:{}});
await client.connect(new StdioClientTransport({command:'/usr/local/bin/node',args:['/w/packages/happy-cli/bin/happy-mcp.mjs'],env:process.env}));
console.log(JSON.stringify((await client.listTools()).tools.map(t=>t.name).sort()));await client.close();`]);
        assert.equal(bridge.code, 0); assert.deepEqual(JSON.parse(bridge.output), ['change_title', ...BROWSER_TASK_TOOL_NAMES].sort());
        console.log('PASS: packaged happy-mcp stdio bridge reaches Unix MCP with session token');
        for (const input of [Buffer.from('malformed\0'), Buffer.from(JSON.stringify({ version: 1, argc: 2 }) + '\0/bin/true\0')]) {
            assert.throws(() => execFileSync('/usr/bin/sudo', ['-n', '-u', 'agent-sbx', '/usr/local/libexec/abp/claude-sbx-launch', '0'], { input, timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] }));
        }
        console.log('PASS: truncated and malformed argv frames refuse launch');
        const privateDns = await run('/usr/bin/curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '3', '-x', 'http://127.0.0.1:3128', 'https://private.allowed.test']);
        assert.equal(privateDns.code, 56); // CONNECT 403 produces CURLE_RECV_ERROR.
        console.log('PASS: allowlisted hostname resolving to loopback rejected by proxy');
        // Linux truncates the domain to int. Socket creation succeeds, but filesystem permissions still deny the target.
        const raw = await run('/usr/bin/python3', ['-c', `import ctypes, socket, platform, os\nc=ctypes.CDLL(None,use_errno=True)\nn=198 if platform.machine()=='aarch64' else 41\nfd=c.syscall(n,ctypes.c_ulonglong(0x100000001),1,0)\nassert fd>=0\ns=socket.socket(fileno=fd)\ntry: s.connect('/run/abp/broker.sock')\nexcept OSError: pass\nelse: raise AssertionError('broker reached')\nassert c.ptrace(16,${process.pid},0,0)==-1\nprint('PASS: high-bit AF_UNIX syscall cannot reach broker; ptrace agent denied')`]);
        assert.equal(raw.code, 0); process.stdout.write(raw.output);
        const refresh = await run('/bin/bash', ['-c', `mkdir -p "$CLAUDE_CONFIG_DIR"; curl -ksS --fail --max-time 5 -X POST -d 'refresh_token=synthetic-refresh-old' https://platform.claude.com/v1/oauth/token > "$CLAUDE_CONFIG_DIR/.credentials.next" && mv "$CLAUDE_CONFIG_DIR/.credentials.next" "$CLAUDE_CONFIG_DIR/.credentials.json"`]);
        assert.equal(refresh.code, 0);
        const rotated = await run('/usr/local/bin/node', ['-e', `const assert=require('assert/strict'),fs=require('fs');assert.equal(JSON.parse(fs.readFileSync(process.env.CLAUDE_CONFIG_DIR+'/.credentials.json')).refresh_token,'synthetic-refresh-new')`]); assert.equal(rotated.code, 0);
        console.log('PASS: synthetic OAuth refresh POST traverses CONNECT; atomic rotation persists next spawn');
        const controller = new AbortController();
        const pending = run('/bin/bash', ['-c', 'setsid /bin/bash -c "while true; do date +%s%N > /work/descendant-heartbeat; sleep .05; done" & wait'], controller.signal, false);
        while (!existsSync('/work/descendant-heartbeat')) await new Promise(resolve => setTimeout(resolve, 20));
        const descendants = execFileSync('/bin/ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).split('\n').filter(line => line.includes('/work/descendant-heartbeat')).map(line => Number(line.trim().split(/\s+/)[0]));
        assert.ok(descendants.length >= 2);
        controller.abort(); await pending;
        await new Promise(resolve => setTimeout(resolve, 200));
        const heartbeat = readFileSync('/work/descendant-heartbeat', 'utf8');
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(readFileSync('/work/descendant-heartbeat', 'utf8'), heartbeat);
        for (const pid of descendants) {
            try { assert.match(readFileSync(`/proc/${pid}/status`, 'utf8'), /State:\s+Z/); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        console.log('PASS: cancellation kills setsid descendants (host PIDs dead and heartbeat stopped)');
    } finally { if (staged) await unstageUserCredentials(staged); await sandbox.close(); happy.stop(); host.close(); }
}
