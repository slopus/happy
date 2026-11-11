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
const output = path.join(root, 'packages/happy-app/test-results/project-goals');
await fs.mkdir(output, { recursive: true });
delete process.env.TSX_TSCONFIG_PATH;
process.env.HAPPY_E2E_DISABLE_WATCHMAN = '1'; process.env.S3_HOST = '';
process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
const originalLog = console.log;
console.log = (...args) => originalLog(...args.map(value => typeof value === 'string' && value.includes('Auth URL:') ? 'Auth URL: saved privately' : value));
let environment, controller, accountSocket, machineSocket, service, runtime;
const clients = new Map();
const metrics = { rpc: [], spawned: [], submitted: [], received: [] };
const controls = { failDirectory: false, loseSubmissionResponse: false };
let closing = false;
const put = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
function once(emitter, event, predicate = () => true) { return new Promise((resolve, reject) => { const listener = value => { if (!predicate(value)) return; clearTimeout(timer); emitter.off(event, listener); resolve(value); }; const timer = setTimeout(() => { emitter.off(event, listener); reject(new Error(`Timeout ${event}`)); }, 30000); emitter.on(event, listener); }); }
async function main() {
    environment = await createEnvironment({ noSwitch: true }); setEnvironmentTemplate(environment, 'authenticated-empty');
    await startEnvironmentServices(environment, { startWeb: false }); await seedEnvironment(environment, { startDaemon: false });
    const config = getEnvironmentConfig(environment);
    const directory = path.join(root, 'environments/data/envs', environment);
    const auth = JSON.parse(await fs.readFile(path.join(directory, 'cli/home/access.key'), 'utf8'));
    const key = new Uint8Array(Buffer.from(auth.secret, 'base64'));
    const serverUrl = `http://localhost:${config.serverPort}`;
    const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
    process.env.HAPPY_SERVER_URL = serverUrl; process.env.HAPPY_HOME_DIR = path.join(directory, 'cli/home');
    process.env.HAPPY_WEBAPP_URL = `http://localhost:${config.expoPort}`;
    const home = path.join(directory, 'goal-home');
    const projects = path.join(home, '.codex/skills/goal-first-ops/projects');
    const projectPath = path.join(projects, 'paws');
    const feature = path.join(projectPath, 'features/workspace');
    const taskA = path.join(feature, 'tasks/01-delivery');
    const taskB = path.join(feature, 'tasks/02-first-run');
    await put(path.join(projectPath, 'index.md'), '# Paws 项目工作区');
    await put(path.join(feature, 'index.md'), '# 桌面工作区\n[相关子项目](../separate/index.md)');
    await put(path.join(projectPath, 'features/separate/index.md'), '# 独立子项目');
    await put(path.join(projectPath, 'features/separate/tasks/only/index.md'), '---\nstatus: pending\n---\n# 其他子项目的独立任务');
    await put(path.join(projects, 'direct/index.md'), '# 直接管理任务的项目');
    await put(path.join(projects, 'direct/tasks/task/index.md'), '---\nstatus: pending\n---\n# 直接归属项目的 Task');
    await put(path.join(taskA, 'index.md'), '---\nstatus: review\n---\n# 工作区方案\n目标：让用户在同一个 Task 中连续对话、阅读与认可交付。\n## 预期交付物\n- 一份产品方案\n- 一份可交互页面\n## 验收标准\n- 切换对话仍保留正在阅读的文件\n- 文件变更后重新认可\n## 阶段产物\n[过程笔记](过程.txt)\n## 最终交付\n[产品方案](产品方案.md)\n[可交互页面](demo/index.html)');
    await put(path.join(taskA, 'PROMPT.md'), '# 任务指令\n仅操作当前隔离验收目录。');
    await put(path.join(taskA, '产品方案.md'), '# 工作区方案\n\n这是实际归档的最终交付文件。\n\n## 验收\n切换对话、确认交付与文件更新均围绕当前 Task。\n\nEND-PROJECT-DELIVERY-V1');
    await put(path.join(taskA, '过程.txt'), '过程内容只在文件目录出现，不进入最终交付。');
    await put(path.join(taskA, 'demo/index.html'), '<!doctype html><html lang="zh"><meta charset="utf-8"><title>Task 交付</title><style>body{font-family:system-ui;padding:32px}button{padding:12px}</style><h1>同一份任务交付</h1><button onclick="this.textContent=Number(this.textContent)+1">0</button><p>切换对话后，按钮计数应保留。</p></html>');
    await put(path.join(taskB, 'index.md'), '---\nstatus: pending\n---\n# 首次执行任务\n目标：在隔离账号中验证一次性提交和新建空白对话。\n## 预期交付物\n- 一份任务执行记录\n## 验收标准\n- Prompt 只提交一次');
    await put(path.join(taskB, 'PROMPT.md'), '# 首次执行\n这是合成的验收任务；只验证提交，不调用外部模型。');
    const encryption = await import('../../../../happy-cli/src/api/encryption.ts');
    const { ApiSessionClient } = await import('../../../../happy-cli/src/api/apiSession.ts');
    const { RpcHandlerManager } = await import('../../../../happy-cli/src/api/rpc/RpcHandlerManager.ts');
    const { registerProjectGoalHandlers } = await import('../../../../happy-cli/src/modules/goalBoard/projectService.ts');
    const { createProjectGoalRuntime } = await import('../../../../happy-cli/src/daemon/projectGoalRuntime.ts');
    const { registerArtifactHandlers } = await import('../../../../happy-cli/src/modules/artifacts/rpc.ts');
    const { ArtifactStore } = await import('../../../../happy-cli/src/modules/artifacts/store.ts');
    const require = createRequire(path.join(root, 'packages/happy-cli/package.json')); const { io } = require('socket.io-client');
    const encode = value => encryption.encodeBase64(encryption.encryptLegacy(value, key));
    const machineId = randomUUID();
    const store = new ArtifactStore({ storage: path.join(directory, 'artifact-store'), accountScope: 'a'.repeat(64), inventory: async () => [] });
    accountSocket = io(serverUrl, { path: '/v1/updates', transports: ['websocket'], reconnection: false, auth: { token: auth.token, clientType: 'user-scoped' } }); await once(accountSocket, 'connect');
    const created = await fetch(serverUrl + '/v1/machines', { method: 'POST', headers, body: JSON.stringify({ id: machineId, metadata: encode({ host: 'project-goals-fixture.local', platform: process.platform, displayName: '项目工作区 · 隔离验收', happyCliVersion: 'project-goals-branch', happyHomeDir: path.join(directory, 'cli/home'), homeDir: home }), daemonState: encode({ status: 'running' }), dataEncryptionKey: null }) }); assert(created.ok);
    let daemonVersion = (await created.json()).machine.daemonStateVersion;
    const manager = new RpcHandlerManager({ scopePrefix: machineId, encryptionKey: key, encryptionVariant: 'legacy' });
    const register = manager.registerHandler.bind(manager);
    manager.registerHandler = (method, handler) => register(method, async input => { metrics.rpc.push({ method, time: Date.now() }); if (method === 'goalTaskListDirectory' && controls.failDirectory) { controls.failDirectory = false; throw new Error('Synthetic directory failure'); } return handler(input); });
    machineSocket = io(serverUrl, { path: '/v1/updates', transports: ['websocket'], reconnection: false, auth: { token: auth.token, clientType: 'machine-scoped', machineId } });
    machineSocket.on('rpc-request', async (data, cb) => cb(await manager.handleRequest(data))); await once(machineSocket, 'connect');
    let publish = Promise.resolve();
    const changed = () => { publish = publish.catch(() => {}).then(async () => { const result = await machineSocket.timeout(10000).emitWithAck('machine-update-state', { machineId, daemonState: encode({ status: 'running', goalProjectRevision: randomUUID() }), expectedVersion: daemonVersion }); if (result.result === 'success') daemonVersion = result.version; }); return publish; };
    async function createSession(directory, name, initialState = {}) {
        const metadata = { path: directory, host: 'project-goals-fixture.local', homeDir: home, name, machineId, flavor: 'codex', lifecycleState: 'running', startedBy: 'terminal' };
        const response = await fetch(serverUrl + '/v1/sessions', { method: 'POST', headers, body: JSON.stringify({ tag: randomUUID(), metadata: encode(metadata), agentState: encode(initialState), dataEncryptionKey: null }) }); assert(response.ok);
        const session = (await response.json()).session;
        const encryptionData = { encryptionKey: key, encryptionVariant: 'legacy', seq: session.seq, metadataVersion: session.metadataVersion, agentStateVersion: session.agentStateVersion };
        const client = new ApiSessionClient(auth.token, { ...encryptionData, id: session.id, metadata, agentState: initialState });
        registerArtifactHandlers(client.rpcHandlerManager, async () => store, directory);
        clients.set(session.id, { client, encryption: encryptionData, metadata, pid: process.pid, startedBy: 'fixture', happySessionId: session.id });
        await once(client.socket, 'rpc-registered', event => event.method === `${session.id}:workspaceReadFile`);
        client.keepAlive(false, 'remote'); client.socket.io.engine.on('packet', packet => { if (packet.type === 'ping') client.keepAlive(false, 'remote'); });
        client.onUserMessage(message => { metrics.received.push({ sessionId: session.id, localId: message.localId }); void client.updateAgentState(state => ({ ...state, turnStatus: { status: 'completed', turnId: randomUUID(), updatedAt: Date.now() } })); });
        return session.id;
    }
    const adapter = createProjectGoalRuntime({ serverUrl, token: auth.token, machineId, legacyKey: key, findSession: id => clients.get(id) });
    service = registerProjectGoalHandlers(manager, { homeDirectory: home, workingDirectory: home, storageDirectory: path.join(directory, 'goal-state'), getArtifactStore: async () => store, changed,
        history: adapter.history,
        spawn: async options => { const sessionId = await createSession(options.directory, 'Task 对话 · STUB 执行器'); metrics.spawned.push({ sessionId, directory: options.directory }); return { type: 'success', sessionId }; },
        send: async (...args) => { await adapter.send(...args); metrics.submitted.push({ sessionId: args[0], localId: args[2] }); if (controls.loseSubmissionResponse) { controls.loseSubmissionResponse = false; throw new Error('Synthetic response loss after accepted submission'); } },
    });
    registerArtifactHandlers(manager, async () => store, undefined, async chosen => { assert(chosen.startsWith(home + '/')); });
    manager.onSocketConnect(machineSocket); await once(machineSocket, 'rpc-registered', event => event.method === `${machineId}:goalProjects`);
    machineSocket.emit('machine-alive', { machineId, time: Date.now() }); machineSocket.io.engine.on('packet', packet => { if (packet.type === 'ping') machineSocket.emit('machine-alive', { machineId, time: Date.now() }); });
    const sessionA = await createSession(taskA, '工作区方案 · 第一段讨论', { turnStatus: { status: 'completed', turnId: 'historical-one', updatedAt: 1 } });
    const sessionB = await createSession(taskA, '工作区方案 · 第二段讨论', { turnStatus: { status: 'completed', turnId: 'historical-two', updatedAt: 2 } });
    const rpc = async (method, input = {}) => { const response = await accountSocket.timeout(60000).emitWithAck('rpc-call', { method: `${machineId}:${method}`, params: encode(input) }); assert(response.ok, response.error); return encryption.decryptLegacy(new Uint8Array(Buffer.from(response.result, 'base64')), key); };
    const board = await rpc('goalProjectRead', { featurePath: feature }); assert(board.success);
    runtime = { environment, pid: process.pid, serverUrl, webUrl: `http://localhost:${config.expoPort}`, machineId, projectPath, featurePath: feature, taskA: board.snapshot.tasks.find(task => task.title === '工作区方案'), taskB: board.snapshot.tasks.find(task => task.title === '首次执行任务'), taskDirectory: taskA, sessionIds: [sessionA, sessionB], authUrlFile: path.join(output, 'auth-url.txt'), boundaries: { app: 'real complete App', relay: 'real isolated server/account/encrypted RPC', archive: 'real synthetic Goal First files and durable state', launcher: 'STUB creates real relay sessions; does not spawn production daemon/model', submission: 'real production encrypted HTTP adapter and delivery receipt', businessPolling: false } };
    await fs.writeFile(runtime.authUrlFile, config.authenticatedWebUrl, { mode: 0o600 });
    controller = createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        try {
            const url = new URL(request.url, 'http://fixture'); const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
            if (url.pathname === '/runtime') return response.end(JSON.stringify(runtime));
            if (url.pathname === '/metrics') return response.end(JSON.stringify(metrics));
            if (url.pathname === '/rpc' && request.method === 'POST') return response.end(JSON.stringify(await rpc(body.method, body.input)));
            if (url.pathname === '/mutate-final' && request.method === 'POST') { await put(path.join(taskA, '产品方案.md'), '# 工作区方案\n\nEND-PROJECT-DELIVERY-V2'); return response.end('{"changed":true}'); }
            if (url.pathname === '/directory-error' && request.method === 'POST') { controls.failDirectory = true; return response.end('{}'); }
            if (url.pathname === '/lose-submission-response' && request.method === 'POST') { controls.loseSubmissionResponse = true; return response.end('{}'); }
            if (url.pathname === '/add-project' && request.method === 'POST') { await put(path.join(projects, 'new-project/index.md'), '# AI 整理的新项目'); return response.end('{}'); }
            if (url.pathname === '/shutdown' && request.method === 'POST') { response.end('{}'); queueMicrotask(() => cleanup()); return; }
            response.writeHead(404); response.end('{}');
        } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); }
    });
    await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve)); runtime.controllerUrl = `http://127.0.0.1:${controller.address().port}`;
    await fs.writeFile(path.join(output, 'runtime.json'), JSON.stringify(runtime, null, 2));
    await startEnvironmentWeb(environment, { warmBundle: true }); await import('../goal-board/repair-router-types.mjs');
    originalLog(JSON.stringify({ ready: true, webUrl: runtime.webUrl, controllerUrl: runtime.controllerUrl, authUrlFile: runtime.authUrlFile }));
}
async function cleanup(code = 0) { if (closing) return; closing = true; service?.dispose(); for (const { client } of clients.values()) { client.sendSessionDeath(); await client.close(); } machineSocket?.disconnect(); accountSocket?.disconnect(); controller?.close(); if (environment) { stopEnvironment(environment); removeEnvironment(environment); } process.exit(code); }
process.on('SIGINT', () => { void cleanup(); }); process.on('SIGTERM', () => { void cleanup(); });
main().catch(error => { console.error(error); void cleanup(1); });
