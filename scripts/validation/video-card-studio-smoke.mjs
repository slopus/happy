import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, watch, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { createStudio } from '../../examples/video-card-studio/server.mjs';
import { readCredential } from '../../examples/video-card-studio/credentials.mjs';
// Run from the repository root after building happy-wire and happy-cli. Uses native Codex login.
const root = process.cwd();
// Reuse the worker's non-secret runtime references; never commit machine paths
// or a Happy session's capture identity into this portable validation harness.
if (!process.env.CARD_STUDIO_CONFIG) throw new Error('CARD_STUDIO_CONFIG must name a non-secret worker configuration file');
const workerSettings = JSON.parse(readFileSync(process.env.CARD_STUDIO_CONFIG, 'utf8'));
const poolModulePath = workerSettings.workerCredential?.modulePath;
if (!poolModulePath?.startsWith('/') || !workerSettings.runtime) throw new Error('Worker runtime and Account Pool modulePath are required');
const require = createRequire(join(root, 'packages/happy-cli/package.json'));
const nacl = require('tweetnacl'); const { io } = require('socket.io-client');
const runtime = resolve(root, '.card-studio-validation/runtime-' + Date.now());
mkdirSync(runtime, { recursive: true, mode: 0o700 });
const home = join(runtime, 'home'); mkdirSync(join(home, 'logs'), { recursive: true, mode: 0o700 });
const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const origin = `http://127.0.0.1:${port}`;
const env = { ...process.env, DB_PROVIDER: 'pglite', PGLITE_DIR: join(runtime, 'db'), HANDY_MASTER_SECRET: randomBytes(32).toString('hex'), PORT: String(port), HOST: '127.0.0.1', HAPPY_HOME_DIR: home, HAPPY_SERVER_URL: origin, HAPPY_WEBAPP_URL: origin, HAPPY_DISABLE_CAFFEINATE: '1', NO_PROXY: 'localhost,127.0.0.1,::1' };
const server = spawn('pnpm', ['--filter', 'happy-server-self-host', 'exec', 'tsx', 'scripts/taskWebhookSmokeServer.mts'], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', b => { serverLog += b; }); server.stderr.on('data', b => { serverLog += b; });
let daemon, socket, logWatcher, studio;
function deadline(p, ms, label) { let timer; return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]).finally(() => clearTimeout(timer)); }
try {
    await deadline(new Promise((ok, fail) => { server.stdout.on('data', b => { if (String(b).includes('WEBHOOK_TEST_SERVER_READY')) ok(); }); server.once('exit', () => fail(new Error('server exited: ' + serverLog.slice(-2000)))); }), 60000, 'server startup timeout');
    const secret = randomBytes(32), keys = nacl.sign.keyPair.fromSeed(secret), challenge = randomBytes(32);
    const response = await fetch(origin + '/v1/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: Buffer.from(keys.publicKey).toString('base64'), challenge: challenge.toString('base64'), signature: Buffer.from(nacl.sign.detached(challenge, keys.secretKey)).toString('base64') }) });
    const { token } = await response.json(); if (!token) throw new Error('test auth failed');
    writeFileSync(join(home, 'access.key'), JSON.stringify({ secret: secret.toString('base64'), token }), { mode: 0o600 });
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ schemaVersion: 2, onboardingCompleted: true, machineId: randomUUID() }));
    const api = async (path, body, method = 'POST', credential = token) => { const r = await fetch(origin + path, { method, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const data = await r.json(); if (!r.ok) throw Object.assign(new Error(JSON.stringify(data)), { status: r.status }); return data; };
    socket = io(origin, { path: '/v1/updates', transports: ['websocket'], auth: { token, clientType: 'user-scoped' }, reconnection: false });
    await deadline(new Promise((ok, fail) => { socket.once('connect', ok); socket.once('connect_error', fail); }), 10000, 'user socket timeout');
    const logReady = new Promise(ok => {
        const watcher = logWatcher = watch(join(home, 'logs'), () => {
            for (const name of readdirSync(join(home, 'logs')).filter(n => n.endsWith('-daemon.log'))) {
                if (readFileSync(join(home, 'logs', name), 'utf8').includes('[API MACHINE] Connected to server')) { watcher.close(); ok(); }
            }
        });
    });
    daemon = spawn(process.execPath, [join(root, 'packages/happy-cli/dist/index.mjs'), 'daemon', 'start-sync'], { cwd: homedir(), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let daemonLog = ''; daemon.stdout.on('data', b => { daemonLog += b; }); daemon.stderr.on('data', b => { daemonLog += b; });
    await deadline(logReady, 40000, 'daemon connection timeout');
    const { machineId } = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));

    const taskId = randomUUID();
    const entry = process.env.CARD_STUDIO_WORKER_ENTRY || 'validation-' + Date.now();
    const workerToken = process.env.CARD_STUDIO_WORKER_ENTRY ? await readCredential({ modulePath: poolModulePath, platform: 'paws-card-studio', entry }) : randomBytes(32).toString('base64url');
    if (!process.env.CARD_STUDIO_WORKER_ENTRY) await new Promise((ok, fail) => {
        const child = spawn('/usr/bin/python3', ['-c', 'import sys;sys.path.insert(0,sys.argv[1]);from account_pool import Pool;Pool().import_key("paws-card-studio",sys.stdin.read(),entry=sys.argv[2])', poolModulePath, entry], { stdio: ['pipe', 'ignore', 'ignore'] });
        child.stdin.end(workerToken); child.once('error', fail); child.once('exit', code => code === 0 ? ok() : fail(new Error('Keychain import failed')));
    });
    const workerDir = join(runtime, 'worker'); mkdirSync(workerDir, { recursive: true });
    const configPath = join(runtime, 'worker-config.json');
    const config = { title: '原话卡片隔离验证', prompt: 'Owner-registered deterministic video-card workflow.', directory: workerDir, agent: 'codex', permissionMode: 'read-only', localHandlerId: 'video-cards' };
    const nonce = randomBytes(24); const encryptedConfig = Buffer.concat([nonce, Buffer.from(nacl.secretbox(Buffer.from(JSON.stringify(config)), nonce, secret))]).toString('base64');
    await api(`/v1/scheduled-tasks/${taskId}`, { id: taskId, machineId, executionKind: 'local-handler', rule: { type: 'interval', anchor: Date.now(), hours: 1, timezone: 'UTC' }, enabled: false, encryptedConfig, newChatEachRun: true, notificationPolicy: 'none', expectedVersion: -1 }, 'PUT');
    const scope = createHash('sha256').update(origin).update('\0').update(secret).digest('hex');
    const journal = join(home, 'scheduled-tasks', scope); mkdirSync(journal, { recursive: true, mode: 0o700 });
    writeFileSync(join(journal, 'handlers.json'), JSON.stringify({ handlers: { 'video-cards': { taskId, directory: workerDir, executable: process.execPath,
        args: [join(root, 'examples/video-card-studio/worker.mjs'), configPath], timeoutMs: 45 * 60_000 } } }), { mode: 0o600 });
    const { token: webhookToken } = await api(`/v1/scheduled-tasks/${taskId}/webhook`, { enabled: true });
    studio = await createStudio({ dataDir: process.env.CARD_STUDIO_DATA_DIR || join(runtime, 'website'), workerToken, taskId, pawsOrigin: origin, webhookToken, perMinute: 10 });
    const siteOrigin = await studio.listen(Number(process.env.CARD_STUDIO_PORT || 0));
    writeFileSync(configPath, JSON.stringify({ siteOrigin, taskId, dataRoot: join(runtime, 'jobs'),
        workerCredential: { modulePath: poolModulePath, platform: 'paws-card-studio', entry },
        browserContextPath: workerSettings.browserContextPath,
        happyCapture: workerSettings.happyCapture,
        runtime: workerSettings.runtime }), { mode: 0o600 });
    const info = { pid: process.pid, runtime, pawsOrigin: origin, siteOrigin, machineId, taskId, entry, node: process.version };
    writeFileSync(join(root, '.card-studio-validation/current.json'), JSON.stringify(info, null, 2));
    console.log('CARD_STUDIO_READY', JSON.stringify(info));
    let eventCount = 0;
    socket.on('ephemeral', event => {
        if (event.type === 'scheduled-tasks-changed' && event.taskId === taskId) {
            eventCount++;
            void api(`/v1/scheduled-tasks/${taskId}/runs`, undefined, 'GET').then(({ runs }) => {
                const evidence = { eventCount, runs: runs.map(({ id, status, reason, webhookRequestId, executionKind, machineId }) => ({ id, status, reason, requestId: webhookRequestId, executionKind, machineId })) };
                writeFileSync(join(runtime, 'paws-events.json'), JSON.stringify(evidence, null, 2));
                console.log('CARD_TASK_EVENT', JSON.stringify(evidence));
            }).catch(() => {});
        }
    });
    await new Promise(ok => { process.once('SIGTERM', ok); process.once('SIGINT', ok); });
} catch (error) { console.error('CARD_STUDIO_FAILED', error.message); process.exitCode = 1; }
finally {
    await studio?.close();
    socket?.disconnect(); logWatcher?.close();
    // Control only this run's local daemon and sessions; workers own separate process groups.
    try {
        const state = JSON.parse(readFileSync(join(home, 'daemon.state.json'), 'utf8'));
        if (state.pid === daemon?.pid) {
            const control = async (path, body = {}) => (await fetch('http://127.0.0.1:' + state.httpPort + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) })).json();
            const { children = [] } = await control('/list');
            for (const child of children) await control('/stop-session', { sessionId: child.happySessionId ?? 'PID-' + child.pid });
            await control('/stop');
        }
    } catch { if (daemon?.pid) process.kill(-daemon.pid, 'SIGTERM'); }
    if (server.pid) process.kill(-server.pid, 'SIGTERM');
    if (daemon?.pid && daemon.exitCode === null) {
        try { await deadline(new Promise(ok => daemon.once('exit', ok)), 2000, 'isolated daemon exit timeout'); }
        catch { process.kill(-daemon.pid, 'SIGKILL'); }
    }
    rmSync(join(home, 'access.key'), { force: true });
    // Own isolated children only; logs and DB remain for diagnosis.
    setTimeout(() => process.exit(process.exitCode ?? 0), 1000).unref();
}
