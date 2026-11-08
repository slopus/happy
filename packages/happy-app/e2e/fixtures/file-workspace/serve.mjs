import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import environmentHelpers from '../../../../../environments/environments.ts';
const { createEnvironment, getEnvironmentConfig, setEnvironmentTemplate, startEnvironmentServices, seedEnvironment, startEnvironmentWeb, stopEnvironment, removeEnvironment } = environmentHelpers;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const output = path.join(root, 'packages/happy-app/test-results/file-workspace');
await fs.mkdir(output, { recursive: true });
delete process.env.TSX_TSCONFIG_PATH;
process.env.HAPPY_E2E_DISABLE_WATCHMAN = '1'; process.env.S3_HOST = '';
process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
const originalLog = console.log;
console.log = (...args) => originalLog(...args.map(value => typeof value === 'string' && value.includes('Auth URL:') ? 'Auth URL: saved privately' : value));
let environment, controller, accountSocket, serverUrl, headers, encryption, key, runtime, machineSocket, artifactStore, runArtifactTurn, machineId;
const clients = new Map(); const metrics = { rpc: [], model: [] }; const jobs = new Set();
async function main() {
    environment = await createEnvironment({ noSwitch: true }); setEnvironmentTemplate(environment, 'authenticated-empty');
    await fs.writeFile(path.join(output, 'environment-name.txt'), environment);
    await startEnvironmentServices(environment, { startWeb: false }); await seedEnvironment(environment, { startDaemon: false });
    const config = getEnvironmentConfig(environment);
    const directory = path.join(root, 'environments/data/envs', environment);
    const auth = JSON.parse(await fs.readFile(path.join(directory, 'cli/home/access.key'), 'utf8'));
    key = new Uint8Array(Buffer.from(auth.secret, 'base64')); serverUrl = `http://localhost:${config.serverPort}`;
    headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
    process.env.HAPPY_SERVER_URL = serverUrl; process.env.HAPPY_WEBAPP_URL = `http://localhost:${config.expoPort}`; process.env.HAPPY_HOME_DIR = path.join(directory, 'cli/home');
    const project = path.join(directory, 'file-project');
    await fs.mkdir(path.join(project, 'docs'), { recursive: true }); await fs.mkdir(path.join(project, 'demo/css'), { recursive: true });
    await fs.writeFile(path.join(project, 'docs/产品方案.md'), '# 作品协作方案\n\n这是从执行机器读取的真实 Markdown。\n\n## 当前目标\n边聊、边看、边改。\n\nFILE_WORKSPACE_END\n');
    await fs.writeFile(path.join(project, 'docs/实施计划.md'), '# 实施计划\n\n1. 接真实文件\n2. 接历史版本\n');
    await fs.writeFile(path.join(project, 'demo/index.html'), '<!doctype html><html lang="zh"><meta charset="utf-8"><title>真实文件预览</title><link rel="stylesheet" href="css/style.css"><body><h1>作品空间</h1><p id="status">运行中</p><p id="dependency-version">Script v1</p><script src="app.js"></script><button onclick="this.textContent=this.textContent===\'暂停\'?\'继续\':\'暂停\';document.getElementById(\'status\').textContent=this.textContent===\'继续\'?\'已暂停\':\'运行中\'">暂停</button></body></html>');
    await fs.writeFile(path.join(project, 'demo/app.js'), "document.getElementById('dependency-version').textContent='Script v1';");
    await fs.writeFile(path.join(project, 'demo/css/style.css'), 'body {font: 18px system-ui; padding:48px; color:#234; background:#f5f5f0;} button {padding:12px 28px; border-radius:10px;}');
    await fs.writeFile(path.join(project, '.hidden.md'), '# Hidden'); await fs.writeFile(path.join(directory, 'private.txt'), 'PRIVATE_FIXTURE');
    await fs.symlink(path.join(directory, 'private.txt'), path.join(project, 'escape.txt'));
    await fs.writeFile(path.join(project, 'too-large.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
    encryption = await import('../../../../happy-cli/src/api/encryption.ts');
    const { ApiSessionClient } = await import('../../../../happy-cli/src/api/apiSession.ts');
    const require = createRequire(path.join(root, 'packages/happy-cli/package.json')); const { io } = require('socket.io-client');
    accountSocket = io(serverUrl, { path: '/v1/updates', transports: ['websocket'], reconnection: false, auth: { token: auth.token, clientType: 'user-scoped' } }); await once(accountSocket, 'connect');
    const encode = value => encryption.encodeBase64(encryption.encryptLegacy(value, key));
    machineId = randomUUID();
    const created = await fetch(serverUrl+'/v1/machines',{method:'POST',headers,body:JSON.stringify({id:machineId,metadata:encode({host:'file-workspace-fixture.local',platform:process.platform,displayName:'History fixture',happyCliVersion:'task4-branch',happyHomeDir:path.join(directory,'cli/home'),homeDir:directory}),daemonState:encode({artifactChanges:[]}),dataEncryptionKey:null})});
    assert(created.ok); const machine=(await created.json()).machine; let daemonVersion=machine.daemonStateVersion;
    const {RpcHandlerManager}=await import('../../../../happy-cli/src/api/rpc/RpcHandlerManager.ts');
    const {registerArtifactHandlers}=await import('../../../../happy-cli/src/modules/artifacts/rpc.ts');
    const {registerWorkspaceFileHandlers}=await import('../../../../happy-cli/src/modules/common/workspaceFiles.ts');
    const {ArtifactStore}=await import('../../../../happy-cli/src/modules/artifacts/store.ts');
    ({runArtifactTurn}=await import('../../../../happy-cli/src/modules/artifacts/turn.ts'));
    const manager=new RpcHandlerManager({scopePrefix:machineId,encryptionKey:key,encryptionVariant:'legacy'});
    machineSocket=io(serverUrl,{path:'/v1/updates',transports:['websocket'],reconnection:false,auth:{token:auth.token,clientType:'machine-scoped',machineId}});
    machineSocket.on('rpc-request',async(data,cb)=>cb(await manager.handleRequest(data)));
    await once(machineSocket,'connect');
    const changed=new Map(); const publish=async event=>{changed.set(event.workspaceId+':'+event.artifactId,event);const events=Array.from(changed.values());const answer=await machineSocket.timeout(10000).emitWithAck('machine-update-state',{machineId,daemonState:encode({artifactChanges:events.slice(-64)}),expectedVersion:daemonVersion});if(answer.result==='success')daemonVersion=answer.version;};
    artifactStore=new ArtifactStore({storage:path.join(directory,'history-store'),accountScope:createHash('sha256').update(key).digest('hex'),inventory:async()=>[],onChanged:publish});
    registerArtifactHandlers(manager,async()=>artifactStore,project);
    manager.onSocketConnect(machineSocket); await once(machineSocket,'rpc-registered',e=>e.method===machineId+':artifactRestore');
    machineSocket.emit('machine-alive',{machineId,time:Date.now()});machineSocket.io.engine.on('packet',p=>{if(p.type==='ping')machineSocket.emit('machine-alive',{machineId,time:Date.now()});});
    async function createSession(name) {
        const metadata = { path: project, host: 'file-workspace-fixture.local', homeDir: directory, name, machineId, flavor: 'codex', lifecycleState: 'running', startedBy: 'terminal' };
        const agentState = { turnStatus: { status: 'completed', turnId: 'initial', updatedAt: Date.now() } };
        const response = await fetch(serverUrl + '/v1/sessions', { method: 'POST', headers, body: JSON.stringify({ tag: randomUUID(), metadata: encode(metadata), agentState: encode(agentState), dataEncryptionKey: null }) });
        assert(response.ok); const session = (await response.json()).session;
        const client = new ApiSessionClient(auth.token, { id: session.id, seq: session.seq, encryptionKey: key, encryptionVariant: 'legacy', metadata, metadataVersion: session.metadataVersion, agentState, agentStateVersion: session.agentStateVersion });
        registerArtifactHandlers(client.rpcHandlerManager,async()=>artifactStore,project);
        registerWorkspaceFileHandlers(client.rpcHandlerManager,project,async()=>artifactStore);
        const handle = client.rpcHandlerManager.handleRequest.bind(client.rpcHandlerManager);
        client.rpcHandlerManager.handleRequest = async request => { const begin = performance.now(); try { return await handle(request); } finally { metrics.rpc.push({ sessionId: session.id, method: request.method.split(':').at(-1), ms: performance.now() - begin }); } };
        clients.set(session.id, client); await once(client.socket, 'rpc-registered', event => event.method === `${session.id}:workspaceReadFile`);
        client.keepAlive(false, 'remote'); client.socket.io.engine.on('packet', packet => { if (packet.type === 'ping') client.keepAlive(false, 'remote'); });
        client.onUserMessage(message => { void runModel(client, message, project).catch(error => { console.error('Model fixture failure:', String(error)); }); });
        const envelope = { id: randomUUID(), time: Date.now(), role: 'agent', turn: 'fixture', ev: { t: 'text', text: '真实文件验收：打开 [产品方案](docs/产品方案.md) 和 `docs/实施计划.md`。\n\n```text\ndocs/产品方案.md\ndemo/index.html\n```\n\n此会话使用隔离账号与真实文件 RPC。发送引用修改时会运行真实 Codex；夹具只负责测试接线，不替换生产 daemon。' } };
        const append = await fetch(`${serverUrl}/v3/sessions/${session.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ messages: [{ localId: randomUUID(), content: encode({ role: 'session', content: envelope }) }] }) }); assert(append.ok);
        return session.id;
    }
    const sessionIds = [await createSession('作品空间 · 真实文件验收'), await createSession('作品空间 · 会话隔离')];
    runtime = { environment, pid: process.pid, serverUrl, webUrl: `http://localhost:${config.expoPort}`, sessionIds, machineId, project, authUrlFile: path.join(output, 'auth-url.txt'), boundaries: { app: 'real full App', fileRPC: 'real encrypted ApiSessionClient workspace handlers', files: 'synthetic on disk', model: 'real codex exec via test adapter when a user message is submitted; no daemon replacement', production: false } };
    await fs.writeFile(runtime.authUrlFile, config.authenticatedWebUrl, { mode: 0o600 });
    controller = createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        try {
            const url = new URL(request.url, 'http://127.0.0.1'); let body = {}; if (request.method === 'POST') { let raw = ''; for await (const chunk of request) raw += chunk; assert(raw.length < 4 * 1024 * 1024); body = raw ? JSON.parse(raw) : {}; }
            if (url.pathname === '/runtime') return response.end(JSON.stringify(runtime));
            if(request.method==='POST' && url.pathname==='/artifact-rpc') return response.end(JSON.stringify(await rpc(machineId,body.method,body.input)));
            if (url.pathname === '/metrics') return response.end(JSON.stringify(metrics));
            if (request.method === 'POST' && url.pathname === '/rpc') return response.end(JSON.stringify(await rpc(body.sessionId ?? sessionIds[0], body.method, body.input)));
            if (request.method === 'POST' && url.pathname === '/mutate') { const file = path.join(project, 'docs/产品方案.md'); await fs.writeFile(file, body.content); if (body.complete) await clients.get(sessionIds[0]).updateAgentState(state => ({ ...state, turnStatus: { status: 'completed', turnId: randomUUID(), updatedAt: Date.now() } })); return response.end('{"changed":true}'); }
            if (request.method === 'POST' && url.pathname === '/mutate-dependency') {
                assert(['css', 'js'].includes(body.kind) && typeof body.content === 'string' && body.content.length < 100000);
                await fs.writeFile(path.join(project, body.kind === 'css' ? 'demo/css/style.css' : 'demo/app.js'), body.content);
                if (body.complete) await clients.get(sessionIds[0]).updateAgentState(state => ({ ...state, turnStatus: { status: 'completed', turnId: randomUUID(), updatedAt: Date.now() } }));
                return response.end(JSON.stringify({ changed: body.kind, terminalEvent: !!body.complete }));
            }
            if (request.method === 'POST' && url.pathname === '/offline') { machineSocket?.disconnect(); const client = clients.get(sessionIds[0]); client.sendSessionDeath(); await client.close(); clients.delete(sessionIds[0]); return response.end('{"offline":true}'); }
            response.writeHead(404); response.end('{}');
        } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); }
    });
    await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve)); runtime.controllerUrl = `http://127.0.0.1:${controller.address().port}`;
    await fs.writeFile(path.join(output, 'runtime.json'), JSON.stringify(runtime, null, 2));
    const listed = await rpc(sessionIds[0], 'workspaceListDirectory', { path: project }); assert(listed.success);
    const read = await rpc(sessionIds[0], 'workspaceReadFile', { path: 'docs/产品方案.md' }); assert(read.success);
    assert.equal(read.hash, createHash('sha256').update(await fs.readFile(path.join(project, 'docs/产品方案.md'))).digest('hex'));
    assert.equal((await rpc(sessionIds[0], 'workspaceReadFile', { path: 'escape.txt' })).success, false);
    await fs.writeFile(path.join(output, 'smoke.json'), JSON.stringify({ passed: ['encrypted real directory', 'encrypted Unicode file bytes/hash', 'canonical symlink rejection'], boundaries: runtime.boundaries }, null, 2));
    await startEnvironmentWeb(environment, { warmBundle: true }); await import('../goal-board/repair-router-types.mjs');
    originalLog(JSON.stringify({ ready: true, webUrl: runtime.webUrl, sessionIds, controllerUrl: runtime.controllerUrl, authUrlFile: runtime.authUrlFile }));
}
async function runModel(client, message, project) {
    const text = message.content?.text; if (!text) return;
    const turn = randomUUID(); client.sendAgentMessage('codex', { type: 'task_started', id: turn }); client.keepAlive(true, 'remote');
    const record = { sessionId: client.sessionId, started: Date.now(), referenced: text.includes('[Workspace file context]') }; metrics.model.push(record);
    const logPath = path.join(output, `model-${turn}.log`); const resultPath = path.join(output, `model-${turn}.txt`);
    const log = await fs.open(logPath, 'w', 0o600);
    let code;
    try {
        await runArtifactTurn(artifactStore,{directory:project,sessionId:client.sessionId,prompt:text,runId:turn},async()=>{
            const child = spawn(process.env.PAWS_WORKSPACE_CODEX_BIN || 'codex', ['exec', '--model', 'gpt-6.1-sol', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', project, '-o', resultPath, '-'], { cwd: project, env: process.env, stdio: ['pipe', log.fd, log.fd] }); jobs.add(child);
            await artifactStore.trackWriterProcess(turn,child.pid);
            child.stdin.end('This is an authorized synthetic file-edit acceptance test. Work only inside this fixture project. Do not read external files or change tools/config.\n\n' + text);
            code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }); jobs.delete(child); return {aborted:code!==0};
        });
    } catch(error) {code=1; record.error=String(error);}
    await log.close();
    record.finished = Date.now(); record.exitCode = code;
    if (code === 0) { const result = await fs.readFile(resultPath, 'utf8'); client.sendAgentMessage('codex', { type: 'message', message: result }); client.sendAgentMessage('codex', { type: 'task_complete', id: turn }); }
    else client.sendAgentMessage('codex', { type: 'turn_aborted', id: turn, status: 'failed' });
    client.keepAlive(false, 'remote');
}
function once(emitter, event, predicate = () => true) { return new Promise((resolve, reject) => { const timer = setTimeout(() => { emitter.off(event, listener); reject(new Error(`Timeout ${event}`)); }, 30000); const listener = value => { if (!predicate(value)) return; clearTimeout(timer); emitter.off(event, listener); resolve(value); }; emitter.on(event, listener); }); }
async function rpc(sessionId, method, input = {}) { assert(['workspaceReadFile', 'workspaceWriteFile', 'workspaceListDirectory'].includes(method) || method.startsWith('artifact')); const params = encryption.encodeBase64(encryption.encryptLegacy(input, key)); const response = await accountSocket.timeout(30000).emitWithAck('rpc-call', { method: `${sessionId}:${method}`, params }); assert(response.ok, response.error); return encryption.decryptLegacy(new Uint8Array(Buffer.from(response.result, 'base64')), key); }
let closing = false;
async function cleanup(code = 0) { if (closing) return; closing = true; for (const child of jobs) child.kill('SIGTERM'); for (const client of clients.values()) { client.sendSessionDeath(); await client.close(); } accountSocket?.disconnect(); machineSocket?.disconnect(); controller?.close(); if (environment) { stopEnvironment(environment); removeEnvironment(environment); } process.exit(code); }
process.on('SIGINT', () => { void cleanup(); }); process.on('SIGTERM', () => { void cleanup(); }); main().catch(error => { console.error(error); void cleanup(1); });
