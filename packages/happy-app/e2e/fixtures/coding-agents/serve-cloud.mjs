import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const output = path.join(root, 'packages/happy-app/test-results/coding-agent-cloud');
await fs.mkdir(output, { recursive: true });
const serverUrl = process.env.CODING_AGENT_CLOUD_URL ?? 'http://127.0.0.1:19465';
process.env.HAPPY_SERVER_URL = serverUrl;
process.env.HAPPY_HOME_DIR = path.join(output, 'worker-home');
const { ApiSessionClient } = await import('../../../../happy-cli/src/api/apiSession.ts');
const { RpcHandlerManager } = await import('../../../../happy-cli/src/api/rpc/RpcHandlerManager.ts');
const { encrypt, decrypt, encodeBase64, decodeBase64 } = await import('../../../../happy-cli/src/api/encryption.ts');
const { createProcessRunner } = await import('../../../../happy-cli/src/environment/processRunner.ts');
const { createCodingAgentService } = await import('../../../../happy-cli/src/environment/codingAgentService.ts');
const { io } = await import('socket.io-client');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const challenge = randomBytes(32);
const authResponse = await fetch(`${serverUrl}/v1/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'), challenge: challenge.toString('base64'), signature: sign(null, challenge, privateKey).toString('base64') }) });
assert(authResponse.ok, `Cloud auth status ${authResponse.status}`);
const { token } = await authResponse.json();
const key = randomBytes(32);
const secret = key.toString('base64');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const encode = object => encodeBase64(encrypt(key, 'legacy', object));
const settings = await (await fetch(`${serverUrl}/v1/account/settings`, { headers })).json();
assert((await fetch(`${serverUrl}/v1/account/settings`, { method: 'POST', headers, body: JSON.stringify({ expectedVersion: settings.settingsVersion, settings: encode({ preferredLanguage: 'zh-Hans' }) }) })).ok);
const metrics = { spawns: [], messages: [], inspections: [], updates: [] };
const sockets = [];
const sessions = [];
const machines = [];
const packages = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code', opencode: 'opencode-ai' };
const models = [{ code: 'gpt-6.1-sol', value: 'Cloud E2E Shared Model' }, { code: 'shared-model', value: 'Cloud E2E Alternate Model' }];
function once(emitter, event, predicate = () => true) { return new Promise((resolve, reject) => { const timer = setTimeout(() => { emitter.off(event, listener); reject(new Error(`Timeout ${event}`)); }, 30000); function listener(value) { if (!predicate(value)) return; clearTimeout(timer); emitter.off(event, listener); resolve(value); } emitter.on(event, listener); }); }
for (const label of ['A', 'B']) {
    const sandbox = path.join(output, `worker-${label}`);
    const bin = path.join(sandbox, 'bin');
    const npmRoot = path.join(sandbox, 'lib/node_modules');
    const versionsFile = path.join(sandbox, 'versions.json');
    const operationsFile = path.join(sandbox, 'operations.json');
    await fs.mkdir(bin, { recursive: true });
    await fs.rm(path.join(sandbox, 'fail-update'), { force: true });
    await fs.writeFile(versionsFile, JSON.stringify({ codex: '1.0.0', claude: '1.0.0', opencode: '1.0.0' }));
    await fs.writeFile(operationsFile, '[]');
    const scriptHead = `#!${process.execPath}\n`;
    for (const [id, name] of Object.entries(packages)) {
        const directory = path.join(npmRoot, name);
        await fs.mkdir(path.join(directory, 'bin'), { recursive: true });
        await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
        const executable = path.join(directory, 'bin', id);
        await fs.writeFile(executable, scriptHead + `const fs=require('node:fs');if(process.argv[2]!=='--version')process.exit(2);console.log(${JSON.stringify(id)}+' '+JSON.parse(fs.readFileSync(${JSON.stringify(versionsFile)},'utf8'))[${JSON.stringify(id)}]);`, { mode: 0o755 });
        await fs.symlink(executable, path.join(bin, id)).catch(error => { if (error.code !== 'EEXIST') throw error; });
    }
    const npmScript = `const fs=require('node:fs');const args=process.argv.slice(2);const packages=${JSON.stringify(packages)};if(args[0]==='root'){console.log(${JSON.stringify(npmRoot)});}else if(args[0]==='view'){if(!Object.values(packages).includes(args[1]))process.exit(2);console.log(JSON.stringify('1.1.0'));}else if(args[0]==='install'&&args[1]==='--global'){const p=args[2],n=p.lastIndexOf('@'),name=p.slice(0,n),version=p.slice(n+1);const id=Object.keys(packages).find(id=>packages[id]===name);if(!id||version!=='1.1.0')process.exit(2);if(fs.existsSync(${JSON.stringify(path.join(sandbox, 'fail-update'))}))process.exit(1);const state=JSON.parse(fs.readFileSync(${JSON.stringify(versionsFile)},'utf8'));state[id]=version;fs.writeFileSync(${JSON.stringify(versionsFile)},JSON.stringify(state));const ops=JSON.parse(fs.readFileSync(${JSON.stringify(operationsFile)},'utf8'));ops.push({id,version});fs.writeFileSync(${JSON.stringify(operationsFile)},JSON.stringify(ops));console.log('sandbox updated');}else process.exit(2);`;
    await fs.writeFile(path.join(bin, 'npm'), scriptHead + npmScript, { mode: 0o755 });
    const runner = createProcessRunner();
    const service = createCodingAgentService({ runner, home: sandbox, env: { ...process.env, PATH: bin }, resolve: async name => name === 'npm' || Object.hasOwn(packages, name) ? path.join(bin, name) : null });
    const machineId = randomUUID();
    const metadata = { host: `cloud-agent-e2e-${label}.test`, displayName: `Cloud E2E Worker ${label}`, platform: process.platform, happyCliVersion: 'cloud-e2e-branch', homeDir: sandbox, happyHomeDir: sandbox, cliAvailability: { ask: true, codex: true, claude: true, opencode: true, gemini: false, openclaw: false, detectedAt: Date.now() } };
    assert((await fetch(`${serverUrl}/v1/machines`, { method: 'POST', headers, body: JSON.stringify({ id: machineId, metadata: encode(metadata), dataEncryptionKey: null }) })).ok);
    machines.push({ id: machineId, label, sandbox, operationsFile });
    async function createSession(flavor, name) {
        const metadata = { path: sandbox, homeDir: sandbox, host: `cloud-agent-e2e-${label}.test`, name, machineId, flavor, lifecycleState: 'running', startedBy: 'terminal', models, currentModelCode: 'gpt-6.1-sol', thoughtLevels: ['low', 'medium', 'high'].map(code => ({ code, value: code })) };
        const response = await fetch(`${serverUrl}/v1/sessions`, { method: 'POST', headers, body: JSON.stringify({ tag: randomUUID(), metadata: encode(metadata), agentState: encode({ turnStatus: { status: 'completed', turnId: randomUUID(), updatedAt: Date.now() } }), dataEncryptionKey: null }) });
        assert(response.ok); const { session } = await response.json();
        const client = new ApiSessionClient(token, { id: session.id, seq: session.seq, encryptionKey: key, encryptionVariant: 'legacy', metadata, metadataVersion: session.metadataVersion, agentState: null, agentStateVersion: session.agentStateVersion });
        sessions.push(client);
        client.rpcHandlerManager.registerHandler('cloudE2EReady', async () => ({ ready: true }));
        await once(client.socket, 'rpc-registered', event => event.method === `${session.id}:cloudE2EReady`);
        client.keepAlive(false, 'remote');
        client.socket.io.engine.on('packet', packet => { if (packet.type === 'ping') client.keepAlive(false, 'remote'); });
        client.onUserMessage(message => {
            metrics.messages.push({ sessionId: session.id, agent: flavor, model: message.meta?.model, effort: message.meta?.effort });
            const id = randomUUID();
            client.sendAgentMessage('codex', { type: 'task_started', id });
            client.sendAgentMessage('codex', { type: 'message', message: 'CLOUD_AGENT_TRANSPORT_OK' });
            client.sendAgentMessage('codex', { type: 'task_complete', id });
            client.keepAlive(false, 'remote');
        });
        return session.id;
    }
    const manager = new RpcHandlerManager({ scopePrefix: machineId, encryptionKey: key, encryptionVariant: 'legacy' });
    manager.registerHandler('browseDirectory', async () => ({ success: true, path: sandbox, entries: [], parentPath: null }));
    manager.registerHandler('get-path-suggestions', async () => ({ suggestions: [sandbox] }));
    manager.registerHandler('goalProjects', async () => ({ success: true, projects: [] }));
    manager.registerHandler('coding-agents-inspect', async request => { metrics.inspections.push({ machine: label, checkUpdates: request.checkUpdates }); return service.inspect(request); });
    manager.registerHandler('coding-agent-update', async request => { const result = await service.update(request); metrics.updates.push({ machine: label, id: request.id, success: result.success, reason: result.reason }); return result; });
    manager.registerHandler('spawn-happy-session', async input => {
        assert(Object.hasOwn(packages, input.agent));
        const sessionId = await createSession(input.agent, `Cloud E2E · ${input.agent}`);
        metrics.spawns.push({ sessionId, agent: input.agent });
        return { type: 'success', sessionId };
    });
    const socket = io(serverUrl, { path: '/v1/updates', transports: ['websocket'], reconnection: false, auth: { token, clientType: 'machine-scoped', machineId } });
    socket.on('rpc-request', async (request, callback) => callback(await manager.handleRequest(request)));
    sockets.push(socket);
    await once(socket, 'connect'); manager.onSocketConnect(socket);
    await once(socket, 'rpc-registered', event => event.method === `${machineId}:spawn-happy-session`);
    socket.emit('machine-alive', { machineId, time: Date.now() });
    socket.io.engine.on('packet', packet => { if (packet.type === 'ping') socket.emit('machine-alive', { machineId, time: Date.now() }); });
    for (const flavor of ['codex', 'claude', 'opencode']) await createSession(flavor, `Catalog ${label} · ${flavor}`);
}
await fs.writeFile(path.join(output, 'credentials.json'), JSON.stringify({ token, secret }), { mode: 0o600 });
const controller = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname === '/metrics') return response.end(JSON.stringify({ ...metrics, processes: await Promise.all(machines.map(async machine => ({ machine: machine.label, operations: JSON.parse(await fs.readFile(machine.operationsFile, 'utf8')) }))) }));
        if (url.pathname === '/settings') {
            const result = await (await fetch(`${serverUrl}/v1/account/settings`, { headers })).json();
            const settings = result.settings ? decrypt(key, 'legacy', decodeBase64(result.settings)) : {};
            return response.end(JSON.stringify({ codingAgentMachines: settings.codingAgentMachines ?? {} }));
        }
        if (url.pathname === '/fail-update' && request.method === 'POST') { await fs.writeFile(path.join(machines[0].sandbox, 'fail-update'), '1'); return response.end('{}'); }
        if (url.pathname === '/shutdown' && request.method === 'POST') { response.end('{}'); setImmediate(() => void cleanup()); return; }
        response.writeHead(404); response.end('{}');
    } catch { response.writeHead(500); response.end('{"error":"controller failure"}'); }
});
await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve));
const runtime = { serverUrl, webUrl: serverUrl, controllerUrl: `http://127.0.0.1:${controller.address().port}`, machines: machines.map(({ id, label }) => ({ id, label })), credentialsFile: path.join(output, 'credentials.json'), boundaries: { app: 'full branch web export hosted on an isolated cloud instance', backend: 'independent cloud PGlite', rpc: 'real encrypted socket/RPC', updater: 'real product service and process runner; sandbox package manager only', inference: 'stub transport response, no external model', production: false, screenshots: false } };
await fs.writeFile(path.join(output, 'runtime.json'), JSON.stringify(runtime, null, 2));
console.log(JSON.stringify({ ready: true, ...runtime }));
async function cleanup() { for (const client of sessions) await client.close(); for (const socket of sockets) socket.disconnect(); controller.close(); process.exit(0); }
process.on('SIGINT', () => void cleanup()); process.on('SIGTERM', () => void cleanup());
