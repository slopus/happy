import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import environmentHelpers from '../../../../../environments/environments.ts';
const { createEnvironment, getEnvironmentConfig, setEnvironmentTemplate, startEnvironmentServices, seedEnvironment, startEnvironmentWeb, stopEnvironment, removeEnvironment } = environmentHelpers;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const output = path.join(root, 'packages/happy-app/test-results/indexeddb-migration');
await fs.mkdir(output, { recursive: true });
delete process.env.TSX_TSCONFIG_PATH;
process.env.HAPPY_E2E_DISABLE_WATCHMAN = '1';
process.env.EXPO_NO_METRO_LAZY = '1';
process.env.S3_HOST = '';
process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
const log = console.log;
console.log = (...args) => log(...args.map(value => typeof value === 'string' && value.includes('Auth URL:') ? 'Auth URL: saved privately' : value));
let environment, machineSocket, controller, runtime;
const clients = new Map();
const metrics = { spawns: [], messages: [], aborts: 0 };
let held = false;
const accounts = [];
const models = [
    { code: 'gpt-6.1-sol', value: 'GPT-6.1 Sol', description: '能力与速度兼顾', serviceTiers: [{ id: 'priority', name: 'Fast' }] },
    { code: 'gpt-6.1-terra', value: 'GPT-6.1 Terra', description: '编码与工程任务', serviceTiers: [{ id: 'priority', name: 'Fast' }] },
    { code: 'gpt-6-astra', value: 'GPT-6 Astra', description: '复杂推理任务', serviceTiers: [] },
    ...Array.from({ length: 18 }, (_, index) => ({ code: `fixture-model-${index + 1}`, value: `能力边界样本 ${index + 1}`, description: '用于验证长列表，不表示可调用的真实模型', serviceTiers: [] })),
];
const levels = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((code, i) => ({ code, value: ['轻度', '中', '高', '极高', 'Max', 'Ultra'][i], description: ['适合简单、快速的问题', '日常任务的轻量推理', '平衡速度与复杂任务', '为复杂任务投入更多推理', '适合最有挑战的任务', '最高强度'][i] }));
async function main() {
    environment = await createEnvironment({ noSwitch: true });
    setEnvironmentTemplate(environment, 'authenticated-empty');
    await startEnvironmentServices(environment, { startWeb: false });
    await seedEnvironment(environment, { startDaemon: false });
    const config = getEnvironmentConfig(environment);
    await fs.writeFile(path.join(output, 'auth-a.txt'), config.authenticatedWebUrl, { mode: 0o600 });
    const directory = path.join(root, 'environments/data/envs', environment);
    const auth = JSON.parse(await fs.readFile(path.join(directory, 'cli/home/access.key'), 'utf8'));
    const key = new Uint8Array(Buffer.from(auth.secret, 'base64'));
    const serverUrl = `http://localhost:${config.serverPort}`;
    const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
    process.env.HAPPY_SERVER_URL = serverUrl;
    process.env.HAPPY_HOME_DIR = path.join(directory, 'cli/home');
    const encryption = await import('../../../../happy-cli/src/api/encryption.ts');
    const { ApiSessionClient } = await import('../../../../happy-cli/src/api/apiSession.ts');
    const { RpcHandlerManager } = await import('../../../../happy-cli/src/api/rpc/RpcHandlerManager.ts');
    const require = createRequire(path.join(root, 'packages/happy-cli/package.json'));
    const { io } = require('socket.io-client');
    const encode = value => encryption.encodeBase64(encryption.encryptLegacy(value, key));
    const settings = await (await fetch(`${serverUrl}/v1/account/settings`, { headers })).json();
    assert((await fetch(`${serverUrl}/v1/account/settings`, { method: 'POST', headers, body: JSON.stringify({ expectedVersion: settings.settingsVersion, settings: encode({ preferredLanguage: 'zh-Hans' }) }) })).ok);
    const machineId = randomUUID();
    const project = path.join(directory, 'project');
    const machineMetadata = { host: 'codex-settings-fixture.local', displayName: 'IndexedDB 合成验收设备', platform: 'darwin', happyCliVersion: 'fixture', homeDir: directory, happyHomeDir: path.join(directory, 'cli/home'), cliAvailability: { codex: true, claude: true, gemini: false, openclaw: false, detectedAt: Date.now() } };
    assert((await fetch(`${serverUrl}/v1/machines`, { method: 'POST', headers, body: JSON.stringify({ id: machineId, metadata: encode(machineMetadata), dataEncryptionKey: null }) })).ok);
    async function createSession(name = '统一设置验收', flavor = 'codex') {
        const metadata = { path: project, homeDir: directory, host: machineMetadata.host, name, machineId, flavor, lifecycleState: 'running', startedBy: 'terminal', models, currentModelCode: 'gpt-6.1-terra', thoughtLevels: levels, currentThoughtLevelCode: 'high' };
        const agentState = { turnStatus: { status: 'completed', turnId: randomUUID(), updatedAt: Date.now() } };
        const response = await fetch(`${serverUrl}/v1/sessions`, { method: 'POST', headers, body: JSON.stringify({ tag: randomUUID(), metadata: encode(metadata), agentState: encode(agentState), dataEncryptionKey: null }) });
        assert(response.ok); const session = (await response.json()).session;
        const client = new ApiSessionClient(auth.token, { id: session.id, seq: session.seq, encryptionKey: key, encryptionVariant: 'legacy', metadata, metadataVersion: session.metadataVersion, agentState, agentStateVersion: session.agentStateVersion });
        clients.set(session.id, client);
        client.rpcHandlerManager.registerHandler('fixtureReady', async () => ({ ready: true }));
        await once(client.socket, 'rpc-registered', e => e.method === `${session.id}:fixtureReady`);
        client.rpcHandlerManager.registerHandler('abort', async () => {
            metrics.aborts++;
            client.sendAgentMessage('codex', { type: 'turn_aborted', id: randomUUID(), status: 'cancelled' });
            client.keepAlive(false, 'remote');
            return { success: true };
        });
        client.keepAlive(false, 'remote');
        client.socket.io.engine.on('packet', p => { if (p.type === 'ping') client.keepAlive(false, 'remote'); });
        client.onUserMessage(message => {
            metrics.messages.push({ account: 'A', text: message.content?.text ?? message.text ?? '', sessionId: session.id, model: message.meta?.model, effort: message.meta?.effort, fast: message.meta?.fast });
            const turn = randomUUID();
            client.sendAgentMessage('codex', { type: 'task_started', id: turn });
            client.sendAgentMessage('codex', { type: 'message', message: '已收到本条消息的模型、推理强度和 Fast 设置。此为隔离传输验收，不执行模型。' });
            if (!held) client.sendAgentMessage('codex', { type: 'task_complete', id: turn });
            client.keepAlive(false, 'remote');
        });
        return session.id;
    }
    const manager = new RpcHandlerManager({ scopePrefix: machineId, encryptionKey: key, encryptionVariant: 'legacy' });
    manager.registerHandler('browseDirectory', async () => ({ success: true, path: project, entries: [], parentPath: directory }));
    manager.registerHandler('get-path-suggestions', async () => ({ suggestions: [project] }));
    // Navigation checks use an empty synthetic project catalog; no real files are read.
    manager.registerHandler('goalProjects', async () => ({ success: true, projects: [] }));
    manager.registerHandler('spawn-happy-session', async input => {
        assert.equal(input.agent, 'codex');
        const sessionId = await createSession('新建会话 · 设置传输验收');
        metrics.spawns.push({ sessionId, agent: input.agent });
        return { type: 'success', sessionId };
    });
    machineSocket = io(serverUrl, { path: '/v1/updates', transports: ['websocket'], reconnection: false, auth: { token: auth.token, clientType: 'machine-scoped', machineId } });
    machineSocket.on('rpc-request', async (data, callback) => callback(await manager.handleRequest(data)));
    await once(machineSocket, 'connect');
    manager.onSocketConnect(machineSocket);
    await once(machineSocket, 'rpc-registered', e => e.method === `${machineId}:spawn-happy-session`);
    machineSocket.emit('machine-alive', { machineId, time: Date.now() });
    machineSocket.io.engine.on('packet', p => { if (p.type === 'ping') machineSocket.emit('machine-alive', { machineId, time: Date.now() }); });
    const sessionId = await createSession();
    accounts.push({ label: 'A', sessionId, authUrlFile: path.join(output, 'auth-a.txt') });
    await seedEnvironment(environment, { startDaemon: false });
    const configB = getEnvironmentConfig(environment);
    await fs.writeFile(path.join(output, 'auth-b.txt'), configB.authenticatedWebUrl, { mode: 0o600 });
    const authB = JSON.parse(await fs.readFile(path.join(directory, 'cli/home/access.key'), 'utf8'));
    const keyB = new Uint8Array(Buffer.from(authB.secret, 'base64'));
    const encodeB = value => encryption.encodeBase64(encryption.encryptLegacy(value, keyB));
    const bCreated = await fetch(serverUrl + '/v1/sessions', { method: 'POST', headers: { Authorization: `Bearer ${authB.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tag: randomUUID(), metadata: encodeB({ path: '/fixture/account-b', host: 'indexeddb-fixture.local', name: '账号 B · 持久化验收', flavor: 'codex', lifecycleState: 'running', startedBy: 'terminal' }), agentState: encodeB({ turnStatus: { status: 'completed', turnId: randomUUID(), updatedAt: Date.now() } }), dataEncryptionKey: null }) });
    assert(bCreated.ok); const bSession = (await bCreated.json()).session;
    const clientB = new ApiSessionClient(authB.token, { id: bSession.id, seq: bSession.seq, encryptionKey: keyB, encryptionVariant: 'legacy', metadata: { path: '/fixture/account-b', host: 'indexeddb-fixture.local', name: '账号 B · 持久化验收', flavor: 'codex' }, metadataVersion: bSession.metadataVersion, agentState: { turnStatus: { status: 'completed' } }, agentStateVersion: bSession.agentStateVersion });
    clients.set(bSession.id, clientB);
    clientB.rpcHandlerManager.registerHandler('fixtureReady', async () => ({ready:true}));
    await once(clientB.socket, 'rpc-registered', e => e.method === `${bSession.id}:fixtureReady`);
    clientB.keepAlive(false, 'remote');
    clientB.socket.io.engine.on('packet', p => { if (p.type === 'ping') clientB.keepAlive(false, 'remote'); });
    clientB.onUserMessage(message => {
        metrics.messages.push({ account: 'B', sessionId: bSession.id, text: message.content?.text ?? message.text ?? '' });
        const turn = randomUUID(); clientB.sendAgentMessage('codex', { type:'task_started',id:turn });
        clientB.sendAgentMessage('codex',{type:'message',message:'账号 B 的加密消息已由隔离执行端收到。'});
        if (!held) clientB.sendAgentMessage('codex',{type:'task_complete',id:turn});
        clientB.keepAlive(false,'remote');
    });
    accounts.push({ label: 'B', sessionId: bSession.id, authUrlFile: path.join(output, 'auth-b.txt') });
    runtime = { accounts, environment, pid: process.pid, serverUrl, webUrl: `http://localhost:${config.expoPort}`, sessionId, machineId, authUrlFile: path.join(output, 'auth-url.txt'), boundaries: { app: 'full App', server: 'isolated PGlite', transport: 'real encrypted sockets/RPC/messages', models: 'synthetic catalog with explicit capability boundaries', executor: 'stub only; no daemon or external model', production: false } };
    await fs.writeFile(runtime.authUrlFile, config.authenticatedWebUrl, { mode: 0o600 });
    controller = createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        try {
            const url = new URL(request.url, 'http://127.0.0.1');
            if (url.pathname === '/runtime') return response.end(JSON.stringify(runtime));
            if (url.pathname === '/metrics') return response.end(JSON.stringify(metrics));
            if (url.pathname === '/persisted') {
                const owner = url.searchParams.get('account') === 'B' ? { auth: authB, key: keyB, id: bSession.id } : { auth, key, id: sessionId };
                const source=await fetch(`${serverUrl}/v3/sessions/${owner.id}/messages?limit=100`,{headers:{Authorization:`Bearer ${owner.auth.token}`}});
                assert(source.ok); const data=await source.json();
                return response.end(JSON.stringify(data.messages.map(m=>encryption.decryptLegacy(new Uint8Array(Buffer.from(m.content.c,'base64')),owner.key))));
            }
            if (request.method === 'POST' && url.pathname === '/shutdown') { response.end('{"stopping":true}'); setImmediate(() => { void cleanup(); }); return; }
            if (request.method === 'POST' && url.pathname === '/complete') { held=false; for(const client of clients.values()){client.sendAgentMessage('codex',{type:'task_complete',id:randomUUID()});client.keepAlive(false,'remote');} return response.end('{"completed":true}'); }
            if (request.method === 'POST' && url.pathname === '/running') {
                held = true;
                for (const client of clients.values()) {
                    client.sendAgentMessage('codex', { type: 'task_started', id: randomUUID() });
                    client.keepAlive(true, 'remote');
                }
                return response.end('{"running":true}');
            }
            if (request.method === 'POST' && url.pathname === '/offline') { for (const client of clients.values()) client.sendSessionDeath(); return response.end('{"offline":true}'); }
            if (request.method === 'POST' && url.pathname === '/online') { for (const client of clients.values()) client.keepAlive(false, 'remote'); return response.end('{"online":true}'); }
            response.writeHead(404); response.end('{}');
        } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); }
    });
    await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve));
    runtime.controllerUrl = `http://127.0.0.1:${controller.address().port}`;
    await fs.writeFile(path.join(output, 'runtime.json'), JSON.stringify(runtime, null, 2));
    await startEnvironmentWeb(environment, { warmBundle: true, queryAuthOnly: true });
    await import('../goal-board/repair-router-types.mjs');
    log(JSON.stringify({ ready: true, ...runtime }));
}
function once(emitter, event, predicate = () => true) { return new Promise((resolve, reject) => { const timer = setTimeout(() => { emitter.off(event, listener); reject(new Error(`Timeout ${event}`)); }, 30000); const listener = value => { if (!predicate(value)) return; clearTimeout(timer); emitter.off(event, listener); resolve(value); }; emitter.on(event, listener); }); }
let closing = false;
async function cleanup(code = 0) { if (closing) return; closing = true; for (const client of clients.values()) { client.sendSessionDeath(); await client.close(); } machineSocket?.disconnect(); controller?.close(); if (environment) { stopEnvironment(environment); removeEnvironment(environment); } process.exit(code); }
process.on('SIGINT', () => { void cleanup(); }); process.on('SIGTERM', () => { void cleanup(); });
main().catch(error => { console.error(error); void cleanup(1); });
