import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, watch, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import net from 'node:net';
// Run from the repository root after building happy-wire and happy-cli. Uses native Codex login.
const root = process.cwd();
const require = createRequire(join(root, 'packages/happy-cli/package.json'));
const nacl = require('tweetnacl'); const { io } = require('socket.io-client');
const runtime = resolve(root, '.webhook-validation/runtime-' + Date.now());
mkdirSync(runtime, { recursive: true, mode: 0o700 });
const home = join(runtime, 'home'); mkdirSync(join(home, 'logs'), { recursive: true, mode: 0o700 });
const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const origin = `http://127.0.0.1:${port}`;
const env = { ...process.env, DB_PROVIDER: 'pglite', PGLITE_DIR: join(runtime, 'db'), HANDY_MASTER_SECRET: randomBytes(32).toString('hex'), PORT: String(port), HOST: '127.0.0.1', HAPPY_HOME_DIR: home, HAPPY_SERVER_URL: origin, HAPPY_WEBAPP_URL: origin, HAPPY_DISABLE_CAFFEINATE: '1', NO_PROXY: 'localhost,127.0.0.1,::1' };
const server = spawn('pnpm', ['--filter', 'happy-server-self-host', 'exec', 'tsx', 'scripts/taskWebhookSmokeServer.mts'], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', b => { serverLog += b; }); server.stderr.on('data', b => { serverLog += b; });
let daemon, socket, logWatcher;
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
    daemon = spawn(process.execPath, [join(root, 'packages/happy-cli/dist/index.mjs'), 'daemon', 'start-sync'], { cwd: '/Users/jacky', env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let daemonLog = ''; daemon.stdout.on('data', b => { daemonLog += b; }); daemon.stderr.on('data', b => { daemonLog += b; });
    await deadline(logReady, 40000, 'daemon connection timeout');
    const { machineId } = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    const taskId = randomUUID();
    const config = { title: 'Webhook harmless verification', prompt: 'Read the external event data value and reply with exactly WEBHOOK_OK followed by that value. Do not use tools. Do not edit files.', directory: runtime, agent: 'codex', permissionMode: 'read-only' };
    const nonce = randomBytes(24); const encryptedConfig = Buffer.concat([nonce, Buffer.from(nacl.secretbox(Buffer.from(JSON.stringify(config)), nonce, secret))]).toString('base64');
    await api(`/v1/scheduled-tasks/${taskId}`, { id: taskId, machineId, rule: { type: 'interval', anchor: Date.now(), hours: 1, timezone: 'UTC' }, enabled: false, encryptedConfig, newChatEachRun: true, notificationPolicy: 'none', expectedVersion: -1 }, 'PUT');
    const { token: webhookToken } = await api(`/v1/scheduled-tasks/${taskId}/webhook`, { enabled: true });
    let events = 0; const waiters = new Set();
    socket.on('ephemeral', event => { if (event.type === 'scheduled-tasks-changed' && event.taskId === taskId) { events++; for (const notify of waiters) notify(); } });
    const terminal = runId => deadline(new Promise((ok, fail) => {
        let checking = false, dirty = false;
        const check = async () => {
            if (checking) { dirty = true; return; } checking = true;
            try { do { dirty = false; const { runs } = await api(`/v1/scheduled-tasks/${taskId}/runs`, undefined, 'GET'); const run = runs.find(r => r.id === runId); if (run && ['completed', 'failed', 'uncertain', 'cancelled'].includes(run.status)) { waiters.delete(check); ok(run); return; } } while (dirty); } catch (e) { fail(e); } finally { checking = false; }
        }; waiters.add(check); void check();
    }), 180000, 'execution terminal timeout');
    const payload = { requestId: randomUUID(), input: { value: 'FIRST' } };
    const first = await api(`/v1/task-webhooks/${taskId}`, payload, 'POST', webhookToken);
    const duplicate = await api(`/v1/task-webhooks/${taskId}`, payload, 'POST', webhookToken);
    if (first.runId !== duplicate.runId) throw new Error('duplicate delivery');
    const secondPayload = { requestId: randomUUID(), input: { value: 'SECOND' } };
    let busy = false; try { await api(`/v1/task-webhooks/${taskId}`, secondPayload, 'POST', webhookToken); } catch (e) { if (e.status !== 409) throw e; busy = true; }
    const firstRun = await terminal(first.runId); console.log('FIRST_TERMINAL', firstRun.id, firstRun.status);
    if (firstRun.status !== 'completed') throw new Error('first run did not complete');
    const second = await api(`/v1/task-webhooks/${taskId}`, secondPayload, 'POST', webhookToken);
    const secondRun = await terminal(second.runId); console.log('SECOND_TERMINAL', secondRun.id, secondRun.status);
    if (secondRun.status !== 'completed') throw new Error('second run did not complete');
    for (const [run, expected] of [[firstRun, 'FIRST'], [secondRun, 'SECOND']]) {
        const { messages } = await api('/v1/sessions/' + run.sessionId + '/messages', undefined, 'GET');
        const decoded = messages.map(message => {
            const bundle = Buffer.from(message.content.c, 'base64');
            const plain = nacl.secretbox.open(bundle.subarray(24), bundle.subarray(0, 24), secret);
            return plain ? JSON.parse(Buffer.from(plain).toString()) : null;
        });
        const text = JSON.stringify(decoded);
        if (!text.includes('WEBHOOK_OK ' + expected)) throw new Error('Missing actual model output: ' + expected);
        const prompts = decoded.filter(message => message?.role === 'user' && message?.meta?.scheduledRun?.runId === run.id);
        if (prompts.length !== 1) throw new Error('Scheduled prompt count is not one');
        console.log('MODEL_OUTPUT_VERIFIED', JSON.stringify({ runId: run.id, sessionId: run.sessionId, output: 'WEBHOOK_OK ' + expected, promptCount: prompts.length }));
    }
    console.log('WEBHOOK_SMOKE_SUCCESS', JSON.stringify({ origin, machineId, taskId, runIds: [firstRun.id, secondRun.id], busy, events, node: process.version }));
} catch (error) { console.error('WEBHOOK_SMOKE_FAILED', error.message); process.exitCode = 1; }
finally {
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
