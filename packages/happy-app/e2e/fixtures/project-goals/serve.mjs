import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import environmentHelpers from '../../../../../environments/environments.ts';
const { createEnvironment, getEnvironmentConfig, setEnvironmentTemplate, startEnvironmentServices, seedEnvironment, startEnvironmentWeb, stopEnvironment, removeEnvironment } = environmentHelpers;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const canvasPerf = process.argv.includes('--canvas-perf');
const canvasMarks = process.argv.includes('--canvas-marks');
const rpcOnly = canvasPerf && process.argv.includes('--rpc-only');
const canvasSmoke = canvasPerf || canvasMarks || process.argv.includes('--canvas');
const canvasPerfRangeDelayMs = 700;
const liveCanvas = canvasSmoke && process.argv.includes('--canvas-live-codex');
assert(!(canvasPerf || canvasMarks) || !liveCanvas, 'Synthetic canvas fixtures cannot start a model worker');
assert(!canvasPerf || !canvasMarks, 'Choose one synthetic canvas scenario per fixture');
const canvasReply = canvasSmoke && !canvasPerf && !canvasMarks ? process.env.PAWS_CANVAS_TEST_REPLY : undefined;
const canvasRun = canvasSmoke ? process.env.PAWS_CANVAS_TEST_RUN : undefined;
if (canvasRun && !/^[a-z0-9-]{1,40}$/.test(canvasRun)) throw new Error('Invalid isolated canvas test run name');
const output = path.join(root, 'packages/happy-app/test-results', canvasSmoke ? ['project-canvas', canvasRun].filter(Boolean).join('-') : 'project-goals');
await fs.mkdir(output, { recursive: true });
delete process.env.TSX_TSCONFIG_PATH;
process.env.HAPPY_E2E_DISABLE_WATCHMAN = '1'; process.env.S3_HOST = '';
process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
const originalLog = console.log;
console.log = (...args) => originalLog(...args.map(value => typeof value === 'string' && value.includes('Auth URL:') ? 'Auth URL: saved privately' : value));
let environment, controller, accountSocket, machineSocket, service, runtime;
let canvasControl, canvasMcp, liveWorker;
const clients = new Map();
const liveSessions = new Map();
const metrics = { rpc: [], spawned: [], submitted: [], received: [], canvasTurns: [], ...(canvasPerf ? { canvasReads: [] } : {}) };
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
    await put(path.join(projectPath, 'index.md'), canvasSmoke ? '# Jackie 画布验收' : '# Paws 项目工作区');
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
    const materialize = canvasSmoke ? (await import('../../../../happy-cli/src/codex/codexImageInput.ts')).materializeCodexImageItems : undefined;
    const markReplyEnvelopes = canvasMarks ? (await import('../../../../happy-cli/src/codex/codexImmediateCommand.ts')).immediateCodexCommandEnvelopes : undefined;
    const { ApiSessionClient } = await import('../../../../happy-cli/src/api/apiSession.ts');
    const { RpcHandlerManager } = await import('../../../../happy-cli/src/api/rpc/RpcHandlerManager.ts');
    const { registerProjectGoalHandlers } = await import('../../../../happy-cli/src/modules/goalBoard/projectService.ts');
    const { createProjectGoalRuntime } = await import('../../../../happy-cli/src/daemon/projectGoalRuntime.ts');
    const { registerArtifactHandlers } = await import('../../../../happy-cli/src/modules/artifacts/rpc.ts');
    const { ArtifactStore } = await import('../../../../happy-cli/src/modules/artifacts/store.ts');
    const require = createRequire(path.join(root, 'packages/happy-cli/package.json')); const { io } = require('socket.io-client');
    const encode = value => encryption.encodeBase64(encryption.encryptLegacy(value, key));
    const machineId = randomUUID();
    const daemonStartedAt = Date.now();
    const daemonState = { status: 'running', startedAt: daemonStartedAt };
    const machineMetadata = {
        host: 'project-goals-fixture.local', platform: process.platform, displayName: '项目工作区 · 隔离验收',
        happyCliVersion: 'project-goals-branch', happyHomeDir: path.join(directory, 'cli/home'), homeDir: home,
        ...(canvasSmoke ? { projectCanvas: { version: 1, daemonStartedAt } } : {}),
    };
    const store = new ArtifactStore({ storage: path.join(directory, 'artifact-store'), accountScope: 'a'.repeat(64), inventory: async () => [] });
    accountSocket = io(serverUrl, { path: '/v1/updates', transports: ['websocket'], reconnection: false, auth: { token: auth.token, clientType: 'user-scoped' } }); await once(accountSocket, 'connect');
    const created = await fetch(serverUrl + '/v1/machines', { method: 'POST', headers, body: JSON.stringify({ id: machineId, metadata: encode(machineMetadata), daemonState: encode(daemonState), dataEncryptionKey: null }) }); assert(created.ok);
    let daemonVersion = (await created.json()).machine.daemonStateVersion;
    const manager = new RpcHandlerManager({ scopePrefix: machineId, encryptionKey: key, encryptionVariant: 'legacy' });
    const register = manager.registerHandler.bind(manager);
    manager.registerHandler = (method, handler) => register(method, async input => {
        metrics.rpc.push({ method, time: Date.now() });
        if (method === 'goalTaskListDirectory' && controls.failDirectory) {
            controls.failDirectory = false;
            throw new Error('Synthetic directory failure');
        }
        if (!canvasPerf || !['goalProjectCanvasAsset', 'goalProjectCanvasPreview'].includes(method)) return handler(input);
        const read = { method, assetId: input.assetId, offset: input.offset ?? 0, startedAt: Date.now() };
        metrics.canvasReads.push(read);
        if (method === 'goalProjectCanvasAsset') await delay(canvasPerfRangeDelayMs);
        try {
            const result = await handler(input);
            read.success = result.success;
            if (result.success) read.bytes = Buffer.byteLength(result.base64, 'base64');
            return result;
        } finally {
            read.finishedAt = Date.now();
        }
    });
    machineSocket = io(serverUrl, { path: '/v1/updates', transports: ['websocket'], reconnection: false, auth: { token: auth.token, clientType: 'machine-scoped', machineId } });
    machineSocket.on('rpc-request', async (data, cb) => cb(await manager.handleRequest(data))); await once(machineSocket, 'connect');
    let publish = Promise.resolve();
    const changed = () => { publish = publish.catch(() => {}).then(async () => { const result = await machineSocket.timeout(10000).emitWithAck('machine-update-state', { machineId, daemonState: encode({ ...daemonState, goalProjectRevision: randomUUID() }), expectedVersion: daemonVersion }); if (result.result === 'success') daemonVersion = result.version; }); return publish; };
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
        let attachments = [];
        client.onUserMessage(message => {
            metrics.received.push({ sessionId: session.id, localId: message.localId });
            const pending = attachments;
            attachments = [];
            void (async () => {
                const markTurn = markReplyEnvelopes && directory === projectPath;
                if (materialize && (pending.length || markTurn)) {
                    const received = await Promise.all(pending);
                    const localImages = materialize(received);
                    const hashes = await Promise.all(localImages.map(async item => createHash('sha256').update(await fs.readFile(item.path)).digest('hex')));
                    metrics.canvasTurns.push({
                        sessionId: session.id, names: received.map(item => item.name), hashes,
                        ...(markTurn ? { localId: message.localId, text: message.content.text, images: localImages.length } : {}),
                    });
                    if (canvasReply && hashes.length === received.length) {
                        const { ref, name, size, dims } = await client.uploadImageAttachment(canvasReply);
                        client.sendFileEvent(ref, name, size, dims, { source: 'generated', batchId: randomUUID() });
                    }
                }
                if (markReplyEnvelopes && markTurn) {
                    for (const envelope of markReplyEnvelopes('已收到画布标注验收消息（本地测试执行器）。', message.localId ? [message.localId] : undefined)) {
                        client.sendSessionProtocolMessage(envelope);
                    }
                } else {
                    await client.updateAgentState(state => ({ ...state, turnStatus: { status: 'completed', turnId: randomUUID(), updatedAt: Date.now() } }));
                }
            })().catch(error => { if (canvasSmoke) metrics.canvasTurns.push({ error: String(error) }); });
        }, materialize ? event => {
            const { ref, name, mimeType } = event.content.data.ev;
            attachments.push(client.downloadAndDecryptAttachment(ref).then(data => {
                assert(data, 'Could not decrypt fixture attachment');
                return { data, name, mimeType: mimeType ?? 'image/png' };
            }));
        } : undefined);
        return session.id;
    }
    const adapter = createProjectGoalRuntime({ serverUrl, token: auth.token, machineId, legacyKey: key, findSession: id => clients.get(id) ?? liveSessions.get(id) });
    service = registerProjectGoalHandlers(manager, { homeDirectory: home, workingDirectory: home, storageDirectory: path.join(directory, 'goal-state'), getArtifactStore: async () => store, changed,
        history: adapter.history,
        spawn: async options => { const sessionId = await createSession(options.directory, 'Task 对话 · STUB 执行器'); metrics.spawned.push({ sessionId, directory: options.directory }); return { type: 'success', sessionId }; },
        send: async (...args) => { await adapter.send(...args); metrics.submitted.push({ sessionId: args[0], localId: args[2] }); if (controls.loseSubmissionResponse) { controls.loseSubmissionResponse = false; throw new Error('Synthetic response loss after accepted submission'); } },
    });
    const perfAssets = canvasPerf ? await (await import('./canvasPerfAssets.mjs')).seedCanvasPerfAssets(service.canvas, projectPath) : undefined;
    const markAssets = canvasMarks ? await (await import('./canvasPerfAssets.mjs')).seedCanvasMarkAssets(service.canvas, projectPath) : undefined;
    registerArtifactHandlers(manager, async () => store, undefined, async chosen => { assert(chosen.startsWith(home + '/')); });
    manager.onSocketConnect(machineSocket); await once(machineSocket, 'rpc-registered', event => event.method === `${machineId}:goalProjects`);
    machineSocket.emit('machine-alive', { machineId, time: Date.now() }); machineSocket.io.engine.on('packet', packet => { if (packet.type === 'ping') machineSocket.emit('machine-alive', { machineId, time: Date.now() }); });
    const sessionA = await createSession(taskA, '工作区方案 · 第一段讨论', { turnStatus: { status: 'completed', turnId: 'historical-one', updatedAt: 1 } });
    const sessionB = await createSession(taskA, '工作区方案 · 第二段讨论', { turnStatus: { status: 'completed', turnId: 'historical-two', updatedAt: 2 } });
    const canvasSessions = canvasSmoke && !liveCanvas ? [await createSession(projectPath, 'Jackie · 画布对话'), await createSession(projectPath, 'Jackie · 第二会话')] : [];
    const rpc = async (method, input = {}) => { const response = await accountSocket.timeout(60000).emitWithAck('rpc-call', { method: `${machineId}:${method}`, params: encode(input) }); assert(response.ok, response.error); return encryption.decryptLegacy(new Uint8Array(Buffer.from(response.result, 'base64')), key); };
    const board = await rpc('goalProjectRead', { featurePath: feature }); assert(board.success);
    runtime = { environment, pid: process.pid, serverUrl, webUrl: `http://localhost:${config.expoPort}`, machineId, projectPath, featurePath: feature, taskA: board.snapshot.tasks.find(task => task.title === '工作区方案'), taskB: board.snapshot.tasks.find(task => task.title === '首次执行任务'), taskDirectory: taskA, sessionIds: [sessionA, sessionB], canvasSessions, authUrlFile: path.join(output, 'auth-url.txt'), boundaries: { app: 'real complete App', relay: 'real isolated server/account/encrypted RPC', archive: 'real synthetic Goal First files and durable state', launcher: 'STUB creates real relay sessions; does not spawn production daemon/model', submission: 'real production encrypted HTTP adapter and delivery receipt', businessPolling: false } };
    if (perfAssets) {
        runtime.canvasPerf = { assets: perfAssets, originalDelayMs: canvasPerfRangeDelayMs, rpcOnly };
        if (rpcOnly) runtime.boundaries.app = 'not started in RPC-only mode';
    }
    if (markAssets) runtime.canvasMarks = { assets: markAssets, worker: 'local-stub' };
    if (canvasSmoke && (liveCanvas || process.argv.includes('--canvas-tools'))) {
        const { startDaemonControlServer } = await import('../../../../happy-cli/src/daemon/controlServer.ts');
        const { createProjectCanvasControlHandler, invokeBoundProjectCanvas } = await import('../../../../happy-cli/src/daemon/projectCanvasLocal.ts');
        const liveEvents = new EventEmitter();
        canvasControl = await startDaemonControlServer({
            getChildren: () => [...liveSessions.values()], stopSession: () => false, requestShutdown: () => {},
            onHappySessionWebhook: (id, metadata, encryption) => {
                if (!liveCanvas || metadata.path !== projectPath || metadata.machineId !== machineId || metadata.flavor !== 'codex') return;
                liveSessions.set(id, { happySessionId: id, pid: liveWorker?.pid, startedBy: 'daemon', metadata, happySessionMetadataFromLocalWebhook: metadata, encryption });
                liveEvents.emit('started', id);
            },
            spawnSession: async () => ({ type: 'error', errorMessage: 'Not available in the canvas fixture' }),
            projectCanvas: createProjectCanvasControlHandler(auth.token, async request => {
                const bound = 'sessionId' in request;
                const metadata = bound ? (clients.get(request.sessionId) ?? liveSessions.get(request.sessionId))?.metadata : undefined;
                const result = await invokeBoundProjectCanvas(service, request, metadata);
                if (liveCanvas && bound) {
                    (metrics.liveCanvasTools ??= []).push({ action: request.command.action, success: !result.isError, time: Date.now() });
                }
                return result;
            }),
        });
        await fs.writeFile(path.join(directory, 'cli/home/daemon.state.json'),
            JSON.stringify({ pid: process.pid, httpPort: canvasControl.port }), { mode: 0o600 });
        if (liveCanvas) {
            const sourcePackage = process.env.PAWS_CANVAS_TEST_SEED_PACKAGE;
            assert(sourcePackage && path.isAbsolute(sourcePackage), 'A local seed asset package is required for live canvas testing');
            const seedFile = 'Jackie-基准素材.pawscanvas';
            await fs.copyFile(sourcePackage, path.join(projectPath, seedFile));
            const { operateProjectCanvas } = await import('../../../../happy-cli/src/modules/goalBoard/projectCanvasTools.ts');
            const loaded = await operateProjectCanvas(service.canvas, projectPath, { action: 'import-package', path: seedFile }, projectPath);
            assert(!loaded.isError, 'Could not load live canvas test assets');
            const settingsFile = path.join(directory, 'cli/home/settings.json');
            const settings = await fs.readFile(settingsFile, 'utf8').then(JSON.parse, error => {
                if (error.code !== 'ENOENT') throw error;
                return {};
            });
            await fs.writeFile(settingsFile, JSON.stringify({ ...settings, machineId }), { mode: 0o600 });
            const workerEnv = { ...process.env, HAPPY_CODEX_APP_SERVER_MODE: 'spawn' };
            for (const field of ['HAPPY_FORKED_FROM_SESSION_ID', 'HAPPY_FORKED_FROM_MESSAGE_ID', 'HAPPY_CROSS_AGENT_REQUEST_ID',
                'HAPPY_CROSS_AGENT_SOURCE_AGENT', 'HAPPY_CODEX_ACCOUNT_PROFILE_ID', 'HAPPY_CODEX_ACCOUNT_CREDENTIAL_VERSION']) delete workerEnv[field];
            if (process.env.PAWS_CANVAS_USE_DEFAULT_CODEX_LOGIN === '1') delete workerEnv.CODEX_HOME;
            const log = await fs.open(path.join(output, 'codex-worker.log'), 'w', 0o600);
            const started = once(liveEvents, 'started');
            const model = process.env.PAWS_CANVAS_TEST_CODEX_MODEL;
            try {
                liveWorker = spawn(process.execPath, [path.join(root, 'packages/happy-cli/dist/codexWorkerEntry.mjs'), '--started-by', 'daemon',
                    '--permission-mode', 'acceptEdits', ...(model ? ['--model', model] : []), '--effort', 'low'],
                    { cwd: projectPath, env: workerEnv, stdio: ['ignore', log.fd, log.fd] });
            } finally {
                await log.close();
            }
            liveWorker.on('error', error => console.error('Native Codex test worker could not start', error.code));
            canvasSessions.push(await started);
            runtime.boundaries.launcher = 'Native Paws Codex worker; Paws account, relay and project storage are isolated';
        } else {
            const { startHappyServer } = await import('../../../../happy-cli/src/claude/utils/startHappyServer.ts');
            canvasMcp = await startHappyServer(clients.get(canvasSessions[0]).client);
            runtime.canvasMcpUrl = canvasMcp.url;
        }
        const roundTripProjectPath = path.join(projects, 'canvas-roundtrip');
        await put(path.join(roundTripProjectPath, 'index.md'), '# 资产包恢复验收');
        Object.assign(runtime, { roundTripProjectPath, cliHome: path.join(directory, 'cli/home') });
    }
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
    if (!rpcOnly) {
        await startEnvironmentWeb(environment, { warmBundle: true, localhost: canvasSmoke });
        await import('../goal-board/repair-router-types.mjs');
    }
    originalLog(JSON.stringify({ ready: true, ...(rpcOnly ? {} : { webUrl: runtime.webUrl, authUrlFile: runtime.authUrlFile }), controllerUrl: runtime.controllerUrl }));
}
async function cleanup(code = 0) { if (closing) return; closing = true; liveWorker?.kill(); await canvasMcp?.stop(); await canvasControl?.stop(); service?.dispose(); for (const { client } of clients.values()) { client.sendSessionDeath(); await client.close(); } machineSocket?.disconnect(); accountSocket?.disconnect(); controller?.close(); if (environment) { stopEnvironment(environment); removeEnvironment(environment); } process.exit(code); }
process.on('SIGINT', () => { void cleanup(); }); process.on('SIGTERM', () => { void cleanup(); });
main().catch(error => { console.error(error); void cleanup(1); });
