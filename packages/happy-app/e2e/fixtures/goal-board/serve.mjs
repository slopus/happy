import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import environmentHelpers from '../../../../../environments/environments.ts';
import { createGoalDataset } from './dataset.mjs';

const { createEnvironment, getEnvironmentConfig, setEnvironmentTemplate, startEnvironmentServices, seedEnvironment, startEnvironmentWeb, stopEnvironment, removeEnvironment } = environmentHelpers;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const output = path.join(root, 'packages/happy-app/test-results/goal-board');
await fs.mkdir(output, { recursive: true });
// tsx has already registered this process's CLI aliases. Child server/Metro processes use their own tsconfig.
delete process.env.TSX_TSCONFIG_PATH;
process.env.HAPPY_E2E_DISABLE_WATCHMAN = '1';
process.env.S3_HOST = ''; // Private local attachments only, never a configured external bucket.
process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
const originalLog = console.log;
console.log = (...args) => originalLog(...args.map(value => typeof value === 'string' && value.includes('Auth URL:') ? 'Auth URL: saved privately; credentials omitted' : value));
let environment, controller, accountSocket;
const clients = new Map(), taskLaunches = new Map();
const metrics = { rpc: [], uploads: [], stubLaunches: [] };
let runtime, dataset, serverUrl, headers, auth, key, ApiSessionClient, encryption;

async function main() {
    environment = await createEnvironment({ noSwitch: true });
    setEnvironmentTemplate(environment, 'authenticated-empty');
    await fs.writeFile(path.join(output, 'environment-name.txt'), environment);
    await startEnvironmentServices(environment, { startWeb: false, waitForWebBundle: true });
    await seedEnvironment(environment, { startDaemon: false });
    const config = getEnvironmentConfig(environment);
    const envDirectory = path.join(root, 'environments/data/envs', environment);
    auth = JSON.parse(await fs.readFile(path.join(envDirectory, 'cli/home/access.key'), 'utf8'));
    key = new Uint8Array(Buffer.from(auth.secret, 'base64'));
    serverUrl = `http://localhost:${config.serverPort}`;
    headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
    process.env.HAPPY_SERVER_URL = serverUrl;
    process.env.HAPPY_WEBAPP_URL = `http://localhost:${config.expoPort}`;
    process.env.HAPPY_HOME_DIR = path.join(envDirectory, 'cli/home');
    dataset = await createGoalDataset(path.join(envDirectory, 'goal-home'));
    encryption = await import('../../../../happy-cli/src/api/encryption.ts');
    ({ ApiSessionClient } = await import('../../../../happy-cli/src/api/apiSession.ts'));
    const require = createRequire(path.join(root, 'packages/happy-cli/package.json'));
    const { io } = require('socket.io-client');
    accountSocket = io(serverUrl, { path: '/v1/updates', transports: ['websocket'], reconnection: false, auth: { token: auth.token, clientType: 'user-scoped' } });
    await once(accountSocket, 'connect');
    const bound = await createSession('Goal Board 真实集成验收（任务启动为 stub）', { featurePath: dataset.featurePath });
    const unbound = await createSession('Goal Board 首次关联验收（未绑定）');
    runtime = {
        environment, pid: process.pid, serverUrl, webUrl: `http://localhost:${config.expoPort}`,
        sessionIds: [bound, unbound], featurePath: dataset.featurePath, otherFeaturePath: dataset.otherFeaturePath,
        authUrlFile: path.join(output, 'auth-url.txt'),
        boundaries: { app: 'full real App', server: 'isolated PGlite and account', cli: 'real ApiSessionClient, parser, watcher, encrypted RPC and attachment uploads', taskLauncher: 'STUB: creates an isolated child session only; never starts daemon or model', media: 'deterministically generated fixture files', businessPolling: false },
    };
    await fs.writeFile(runtime.authUrlFile, getEnvironmentConfig(environment).authenticatedWebUrl, { mode: 0o600 });
    controller = createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        try {
            const url = new URL(request.url, 'http://127.0.0.1');
            const body = request.method === 'POST' ? await jsonBody(request) : {};
            if (request.method === 'GET' && url.pathname === '/runtime') return response.end(JSON.stringify(runtime));
            if (request.method === 'GET' && url.pathname === '/metrics') return response.end(JSON.stringify(metrics));
            if (request.method === 'GET' && url.pathname === '/snapshot') return response.end(JSON.stringify(await sessionSnapshot(url.searchParams.get('session') || bound)));
            if (request.method === 'POST' && url.pathname === '/rpc') return response.end(JSON.stringify(await rpc(body.sessionId || bound, body.method, body.input || {})));
            if (request.method === 'POST' && url.pathname === '/mutate') {
                assert(['pending', 'running', 'review', 'done', 'blocked', 'unknown'].includes(body.status));
                const directory = dataset.taskDirectories.get(body.taskCode || 'G20'); assert(directory);
                const file = path.join(directory, 'index.md');
                await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace(/^status: .*$/m, `status: ${body.status}`));
                return response.end(JSON.stringify({ changed: body.taskCode || 'G20', status: body.status, trigger: 'real fs.watch' }));
            }
            if (request.method === 'POST' && url.pathname === '/activate') { for (const client of clients.values()) client.keepAlive(false, 'remote'); return response.end('{"active":true}'); }
            if (request.method === 'POST' && url.pathname === '/offline') { const client = clients.get(bound); client?.sendSessionDeath(); await client?.close(); clients.delete(bound); return response.end('{"offline":true}'); }
            if (request.method === 'POST' && url.pathname === '/smoke') return response.end(JSON.stringify(await smoke(bound)));
            response.writeHead(404); response.end('{"error":"Unknown fixture action"}');
        } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
    });
    await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve));
    runtime.controllerUrl = `http://127.0.0.1:${controller.address().port}`;
    await fs.writeFile(path.join(output, 'runtime.json'), JSON.stringify(runtime, null, 2));
    // Keep browser acceptance's bound session cold: smoke uploads belong to a separate archived session.
    const smokeSession = await createSession('Fixture smoke only（归档）', { featurePath: dataset.featurePath });
    runtime.smokeSessionId = smokeSession;
    const result = await smoke(smokeSession);
    await clients.get(smokeSession).updateMetadataAndAwait(metadata => ({ ...metadata, lifecycleState: 'archived' }));
    clients.get(smokeSession).sendSessionDeath();
    await clients.get(smokeSession).close();
    clients.delete(smokeSession);
    metrics.rpc.length = 0; metrics.uploads.length = 0; metrics.stubLaunches.length = 0;
    await fs.writeFile(path.join(output, 'runtime.json'), JSON.stringify(runtime, null, 2));
    await fs.writeFile(path.join(output, 'smoke.json'), JSON.stringify(result, null, 2));
    originalLog(JSON.stringify({ smoke: result, environment, controllerUrl: runtime.controllerUrl }));
    await startEnvironmentWeb(environment, { warmBundle: true });
    await import('./repair-router-types.mjs');
    originalLog(JSON.stringify({ ready: true, environment, webUrl: runtime.webUrl, sessionIds: runtime.sessionIds, controllerUrl: runtime.controllerUrl, authUrlFile: runtime.authUrlFile }));
}

async function createSession(name, binding, lineage) {
    const metadata = { path: dataset.featurePath, host: 'goal-board-fixture.local', homeDir: dataset.home, name, flavor: 'codex', lifecycleState: 'running', startedBy: 'terminal', ...(binding ? { goalBoard: binding } : {}), ...(lineage ? { independentSession: lineage } : {}) };
    const agentState = { turnStatus: { status: 'completed', turnId: 'fixture-turn', updatedAt: Date.now() } };
    const encode = value => encryption.encodeBase64(encryption.encryptLegacy(value, key));
    const response = await fetch(serverUrl + '/v1/sessions', { method: 'POST', headers, body: JSON.stringify({ tag: 'goal-board-fixture-' + randomUUID(), metadata: encode(metadata), agentState: encode(agentState), dataEncryptionKey: null }) });
    if (!response.ok) throw new Error(`Fixture session creation failed: ${response.status}`);
    const session = (await response.json()).session;
    const client = new ApiSessionClient(auth.token, { id: session.id, seq: session.seq, encryptionKey: key, encryptionVariant: 'legacy', metadata, metadataVersion: session.metadataVersion, agentState, agentStateVersion: session.agentStateVersion });
    // Instrument real handlers without replacing catalog/read/artifact behavior.
    const handle = client.rpcHandlerManager.handleRequest.bind(client.rpcHandlerManager);
    client.rpcHandlerManager.handleRequest = async request => { const started = performance.now(); try { return await handle(request); } finally { metrics.rpc.push({ sessionId: session.id, method: request.method.split(':').at(-1), durationMs: performance.now() - started }); } };
    for (const method of ['uploadImageAttachment', 'uploadMediaAttachment']) {
        const upload = client[method].bind(client);
        client[method] = async (...args) => { const value = await upload(...args); metrics.uploads.push({ sessionId: session.id, name: path.basename(args[0]), method, size: value.size }); return value; };
    }
    client.rpcHandlerManager.registerHandler('goalBoardStartTask', async input => {
        const launchKey = `${session.id}:${input.requestId}`;
        if (taskLaunches.has(launchKey)) return taskLaunches.get(launchKey);
        const operation = (async () => {
            const child = await createSession('STUB 任务会话：不会执行真实任务', { featurePath: input.featurePath, taskId: input.taskId, parentSessionId: session.id }, { parentSessionId: session.id, title: 'Fixture launcher stub' });
            metrics.stubLaunches.push({ parent: session.id, child, taskId: input.taskId, requestId: input.requestId });
            return { success: true, sessionId: child, title: 'Fixture launcher stub' };
        })();
        taskLaunches.set(launchKey, operation); return operation;
    });
    clients.set(session.id, client);
    await once(client.socket, 'rpc-registered', value => value.method === `${session.id}:goalBoardArtifact`);
    client.keepAlive(false, 'remote');
    // Transport ping events provide liveness; no task/file/status query timer is installed.
    client.socket.io.engine.on('packet', packet => { if (packet.type === 'ping') client.keepAlive(false, 'remote'); });
    const message = { id: randomUUID(), time: Date.now(), role: 'agent', turn: 'fixture-turn', ev: { t: 'text', text: '这是隔离的完整 App 验收会话。Goal Board 使用真实文件、加密 RPC 和附件通道。任务会话启动明确使用 fixture stub，不运行真实 RSI 任务。' } };
    const append = await fetch(`${serverUrl}/v3/sessions/${session.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ messages: [{ localId: 'fixture-' + session.id, content: encode({ role: 'session', content: message }) }] }) });
    if (!append.ok) throw new Error(`Fixture message seed failed: ${append.status}`);
    return session.id;
}
function once(emitter, event, predicate = () => true, timeout = 30000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { emitter.off(event, listener); reject(new Error(`Timed out waiting for ${event}`)); }, timeout);
        const listener = value => { if (!predicate(value)) return; clearTimeout(timer); emitter.off(event, listener); resolve(value); };
        emitter.on(event, listener);
    });
}
async function rpc(sessionId, method, input) {
    if (!['goalBoardCatalog', 'goalBoardRead', 'goalBoardArtifact', 'goalBoardStartTask'].includes(method)) throw new Error('Only Goal Board fixture RPC methods are allowed');
    const params = encryption.encodeBase64(encryption.encryptLegacy(input, key));
    const response = await accountSocket.timeout(30000).emitWithAck('rpc-call', { method: `${sessionId}:${method}`, params });
    if (!response.ok) throw new Error(response.error || 'Encrypted RPC failed');
    return encryption.decryptLegacy(new Uint8Array(Buffer.from(response.result, 'base64')), key);
}
async function sessionSnapshot(sessionId) {
    const response = await fetch(`${serverUrl}/v2/sessions/${sessionId}`, { headers });
    if (!response.ok) throw new Error(`Session read failed: ${response.status}`);
    const { session } = await response.json();
    return { ...session, metadata: encryption.decryptLegacy(new Uint8Array(Buffer.from(session.metadata, 'base64')), key), agentState: undefined, dataEncryptionKey: undefined };
}
async function smoke(sessionId) {
    const began = performance.now();
    const catalog = await rpc(sessionId, 'goalBoardCatalog', {}); assert(catalog.success);
    assert.equal(catalog.goals.length, 2, 'Fixture catalog must not discover real user projects');
    const read = await rpc(sessionId, 'goalBoardRead', { featurePath: dataset.featurePath }); assert(read.success); assert.equal(read.snapshot.tasks.length, 20);
    const task = read.snapshot.tasks.find(task => task.code === 'G01'); assert(task);
    const result = { passed: [], artifactMs: {}, taskCount: read.snapshot.tasks.length, catalogCount: catalog.goals.length, boundaries: runtime.boundaries };
    for (const kind of ['text', 'image', 'audio', 'video', 'pdf']) {
        const candidates = task.artifacts.filter(artifact => artifact.kind === kind && artifact.available && artifact.relation === 'output' && !artifact.name.includes('超限'));
        for (const artifact of kind === 'text' ? candidates : candidates.slice(0, 1)) {
            const start = performance.now();
            const opened = await rpc(sessionId, 'goalBoardArtifact', { featurePath: dataset.featurePath, taskId: task.id, artifactId: artifact.id }); assert(opened.success, opened.error);
            const original = await fs.readFile(artifact.path);
            if (kind === 'text') { assert.equal(opened.content, original.toString('utf8')); }
            else {
                assert.equal(opened.kind, 'attachment');
                const client = clients.get(sessionId);
                const bytes = opened.attachment.encrypted ? await client.downloadAndDecryptAttachment(opened.attachment.ref) : await client.downloadAttachment(opened.attachment.ref);
                assert.deepEqual(Buffer.from(bytes), original, 'Uploaded original must round-trip through the private attachment channel');
            }
            result.passed.push(`${kind}:${artifact.name}`); result.artifactMs[artifact.name] = performance.now() - start;
        }
    }
    for (const name of ['文件缺失', '超限文本', '越界链接']) {
        const artifact = task.artifacts.find(artifact => artifact.name === name); assert(artifact, `Missing fixture error artifact ${name}`);
        const opened = await rpc(sessionId, 'goalBoardArtifact', { featurePath: dataset.featurePath, taskId: task.id, artifactId: artifact.id }); assert.equal(opened.success, false); result.passed.push(`error:${name}`);
    }
    const changedStatus = read.snapshot.tasks.find(task => task.code === 'G20').status === 'done' ? 'pending' : 'done';
    const event = once(accountSocket, 'update', update => {
        if (update.body?.t !== 'update-session' || update.body.id !== sessionId || !update.body.metadata?.value) return false;
        const metadata = encryption.decryptLegacy(new Uint8Array(Buffer.from(update.body.metadata.value, 'base64')), key);
        return metadata?.goalBoardSnapshot?.tasks.some(task => task.code === 'G20' && task.status === changedStatus);
    });
    const taskFile = path.join(dataset.taskDirectories.get('G20'), 'index.md');
    await fs.writeFile(taskFile, (await fs.readFile(taskFile, 'utf8')).replace(/^status: .*$/m, `status: ${changedStatus}`));
    await event; result.passed.push('real fs.watch encrypted metadata event');
    const startInput = { featurePath: dataset.featurePath, taskId: task.id, requestId: 'smoke-stub-idempotence' };
    const [child1, child2] = await Promise.all([rpc(sessionId, 'goalBoardStartTask', startInput), rpc(sessionId, 'goalBoardStartTask', startInput)]);
    assert.equal(child1.sessionId, child2.sessionId); result.passed.push('STUB launch idempotence');
    result.durationMs = performance.now() - began;
    return result;
}
async function jsonBody(request) { let value = ''; for await (const chunk of request) { value += chunk; if (value.length > 16384) throw new Error('Fixture body too large'); } return value ? JSON.parse(value) : {}; }
let closing = false;
async function cleanup(code = 0) {
    if (closing) return; closing = true;
    for (const client of clients.values()) { client.sendSessionDeath(); await client.close(); }
    accountSocket?.disconnect(); controller?.close();
    if (environment) { stopEnvironment(environment); removeEnvironment(environment); }
    process.exit(code);
}
process.on('SIGINT', () => { void cleanup(); }); process.on('SIGTERM', () => { void cleanup(); });
main().catch(error => { console.error(error); void cleanup(1); });
