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
const output = path.join(root, 'packages/happy-app/test-results/codex-settings');
await fs.mkdir(output, { recursive: true });
delete process.env.TSX_TSCONFIG_PATH;
process.env.HAPPY_E2E_DISABLE_WATCHMAN = '1';
process.env.S3_HOST = '';
process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
const log = console.log;
console.log = (...args) => log(...args.map(value => typeof value === 'string' && value.includes('Auth URL:') ? 'Auth URL: saved privately' : value));
let environment, machineSocket, controller, runtime;
const clients = new Map();
const metrics = { spawns: [], messages: [], aborts: 0 };
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
    const machineMetadata = { host: 'codex-settings-fixture.local', displayName: 'long-device-name-example.local', platform: 'darwin', happyCliVersion: 'fixture', homeDir: directory, happyHomeDir: path.join(directory, 'cli/home'), cliAvailability: { codex: true, claude: true, gemini: false, openclaw: false, detectedAt: Date.now() } };
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
            metrics.messages.push({ sessionId: session.id, model: message.meta?.model, effort: message.meta?.effort, fast: message.meta?.fast });
            const turn = randomUUID();
            client.sendAgentMessage('codex', { type: 'task_started', id: turn });
            client.sendAgentMessage('codex', { type: 'message', message: '已收到本条消息的模型、推理强度和 Fast 设置。此为隔离传输验收，不执行模型。' });
            client.sendAgentMessage('codex', { type: 'task_complete', id: turn });
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
    runtime = { environment, pid: process.pid, serverUrl, webUrl: `http://localhost:${config.expoPort}`, sessionId, machineId, authUrlFile: path.join(output, 'auth-url.txt'), boundaries: { app: 'full App', server: 'isolated PGlite', transport: 'real encrypted sockets/RPC/messages', models: 'synthetic catalog with explicit capability boundaries', executor: 'stub only; no daemon or external model', production: false } };
    await fs.writeFile(runtime.authUrlFile, config.authenticatedWebUrl, { mode: 0o600 });
    controller = createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        try {
            const url = new URL(request.url, 'http://127.0.0.1');
            if (url.pathname === '/runtime') return response.end(JSON.stringify(runtime));
            if (url.pathname === '/metrics') return response.end(JSON.stringify(metrics));
            if (request.method === 'POST' && url.pathname === '/shutdown') { response.end('{"stopping":true}'); setImmediate(() => { void cleanup(); }); return; }
            if (request.method === 'POST' && url.pathname === '/running') {
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
    await startEnvironmentWeb(environment, { warmBundle: true });
    await import('../goal-board/repair-router-types.mjs');
    log(JSON.stringify({ ready: true, ...runtime }));
}
function once(emitter, event, predicate = () => true) { return new Promise((resolve, reject) => { const timer = setTimeout(() => { emitter.off(event, listener); reject(new Error(`Timeout ${event}`)); }, 30000); const listener = value => { if (!predicate(value)) return; clearTimeout(timer); emitter.off(event, listener); resolve(value); }; emitter.on(event, listener); }); }
let closing = false;
async function cleanup(code = 0) { if (closing) return; closing = true; for (const client of clients.values()) { client.sendSessionDeath(); await client.close(); } machineSocket?.disconnect(); controller?.close(); if (environment) { stopEnvironment(environment); removeEnvironment(environment); } process.exit(code); }
process.on('SIGINT', () => { void cleanup(); }); process.on('SIGTERM', () => { void cleanup(); });
main().catch(error => { console.error(error); void cleanup(1); });
