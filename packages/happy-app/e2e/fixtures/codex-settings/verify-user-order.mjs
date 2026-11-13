// Headless transport acceptance: real isolated Server/PGlite, crypto, HTTP and Socket.IO.
// No production credentials, browser, daemon or external model.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import * as helpersModule from '../../../../../environments/environments.ts';
const helpers = helpersModule.default ?? helpersModule;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const output = path.join(root, 'packages/happy-app/test-results/user-session-order');
await fs.mkdir(output, { recursive: true });
delete process.env.TSX_TSCONFIG_PATH;
process.env.S3_HOST = '';
process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
const log = console.log;
console.log = (...args) => log(...args.map(v => typeof v === 'string' && v.includes('Auth URL:') ? 'Isolated auth URL saved privately' : v));
let environment, socket;
let completed = false;
const clients = [];
try {
    environment = await helpers.createEnvironment({ noSwitch: true });
    helpers.setEnvironmentTemplate(environment, 'authenticated-empty');
    await helpers.startEnvironmentServices(environment, { startWeb: false });
    await helpers.seedEnvironment(environment, { startDaemon: false });
    const config = helpers.getEnvironmentConfig(environment);
    const serverUrl = `http://localhost:${config.serverPort}`;
    const home = path.join(root, 'environments/data/envs', environment, 'cli/home');
    const auth = JSON.parse(await fs.readFile(path.join(home, 'access.key'), 'utf8'));
    const key = new Uint8Array(Buffer.from(auth.secret, 'base64'));
    process.env.HAPPY_SERVER_URL = serverUrl; process.env.HAPPY_HOME_DIR = home;
    const crypto = await import('../../../../happy-cli/src/api/encryption.ts');
    const { ApiSessionClient } = await import('../../../../happy-cli/src/api/apiSession.ts');
    const require = createRequire(path.join(root, 'packages/happy-cli/package.json'));
    const { io } = require('socket.io-client');
    const encode = value => crypto.encodeBase64(crypto.encryptLegacy(value, key));
    const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
    const once = (emitter, event) => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`${event} deadline`)), 15_000);
        emitter.once(event, value => { clearTimeout(timeout); resolve(value); });
    });
    socket = io(serverUrl, { path: '/v1/updates', transports: ['websocket'], reconnection: false, auth: { token: auth.token, clientType: 'user-scoped' } });
    await once(socket, 'connect');
    globalThis.__userSortSocket = { emitWithAck: (event, data) => socket.timeout(10_000).emitWithAck(event, data) };
    const appSources = path.join(root, 'packages/happy-app/sources');
    const bundle = path.join(output, 'app-clock.cjs');
    await build({ absWorkingDir: root, stdin: { contents: `
export { hydrateSessionSnapshots } from './packages/happy-app/sources/sync/sessionSnapshotHydration';
export { updateEncryptedSessionMetadata } from './packages/happy-app/sources/sync/sessionMetadata';
export { SessionEncryption } from './packages/happy-app/sources/sync/encryption/sessionEncryption';
export { EncryptionCache } from './packages/happy-app/sources/sync/encryption/encryptionCache';
export { sortSessionsForList } from './packages/happy-app/sources/utils/sessionPinning';
export { getUserMessageTime } from './packages/happy-app/sources/sync/sessionUserActivity';
`, resolveDir: root, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', alias: { '@': appSources },
        plugins: [{ name: 'headless-platform-transport', setup(b) {
            b.onResolve({ filter: /^react-native$/ }, () => ({ path: 'platform', namespace: 'fixture' }));
            b.onResolve({ filter: /^\.\/apiSocket$/ }, args => args.importer.endsWith('sessionMetadata.ts') ? ({ path: 'socket', namespace: 'fixture' }) : undefined);
            b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'platform' ? "export const Platform = { OS: 'web' };" : 'export const apiSocket = globalThis.__userSortSocket;', loader: 'js' }));
        } }],
    });
    const app = require(bundle);
    const encryptor = { encrypt: async values => values.map(value => crypto.encryptLegacy(value, key)), decrypt: async values => values.map(value => crypto.decryptLegacy(value, key)) };
    const freshEncryption = () => {
        const sessions = new Map();
        return { initializeSessions: async keys => { for (const id of keys.keys()) sessions.set(id, new app.SessionEncryption(id, encryptor, new app.EncryptionCache())); }, getSessionEncryption: id => sessions.get(id) };
    };
    async function create(name, userAt, state) {
        const metadata = { path: '/synthetic-project', host: 'synthetic-host', name, lastUserMessageAt: userAt };
        const response = await fetch(`${serverUrl}/v1/sessions`, { method: 'POST', headers, body: JSON.stringify({ tag: randomUUID(), metadata: encode(metadata), dataEncryptionKey: null }) });
        assert(response.ok); const row = (await response.json()).session;
        const client = new ApiSessionClient(auth.token, { ...row, encryptionKey: key, encryptionVariant: 'legacy', metadata, agentState: null });
        clients.push(client); if (!client.socket.connected) await once(client.socket, 'connect');
        await client.updateAgentState(() => ({ turnStatus: { status: state, updatedAt: Date.now() } }));
        return { id: row.id, client };
    }
    const now = Date.now();
    const a = await create('A', now - 100, 'running');
    const b = await create('B', now - 200, 'running');
    const done = await create('Done', now - 50, 'completed');
    const byId = new Map([[a.id, 'A'], [b.id, 'B'], [done.id, 'Done']]);
    async function cold() {
        const response = await fetch(`${serverUrl}/v2/sessions?limit=20`, { headers });assert(response.ok);
        const rows = (await response.json()).sessions.filter(row => byId.has(row.id));
        const encryption = freshEncryption();
        return { rows: await app.hydrateSessionSnapshots(rows, encryption), encryption };
    }
    const order = rows => app.sortSessionsForList(rows, []).map(row => byId.get(row.id));
    assert.deepEqual(order((await cold()).rows), ['A', 'B', 'Done']);
    for (const target of [b, a, b]) {
        target.client.sendSessionProtocolMessage({ id: randomUUID(), role: 'agent', time: Date.now(), ev: { t: 'text', text: 'synthetic agent output' } });
        await target.client.flushOutboxAndAwait();
        await target.client.updateAgentState(() => ({ turnStatus: { status: 'running', updatedAt: Date.now() } }));
        assert.deepEqual(order((await cold()).rows), ['A', 'B', 'Done']);
    }
    const before = await cold();const row = before.rows.find(row => row.id === b.id);
    const encryption = before.encryption.getSessionEncryption(b.id);const userSentAt = Date.now();
    const ciphertext = await encryption.encryptRawRecord({ role: 'user', content: { type: 'text', text: 'synthetic explicit user send' }, meta: { userSentAt } });
    const localId = randomUUID();
    const sent = await fetch(`${serverUrl}/v3/sessions/${b.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ messages: [{ localId, content: ciphertext }] }) });
    assert(sent.ok);assert((await sent.json()).messages.some(row => row.localId === localId));
    // Make the captured metadata version stale to exercise real encrypted CAS recovery.
    await b.client.updateMetadataAndAwait(metadata => ({ ...metadata, name: 'concurrent title' }));
    const result = await app.updateEncryptedSessionMetadata(b.id, row.metadata, row.metadataVersion, encryption,
        metadata => (metadata.lastUserMessageAt ?? 0) >= userSentAt ? metadata : ({ ...metadata, lastUserMessageAt: userSentAt }));
    assert.equal(result.metadata.name, 'concurrent title');assert.equal(result.metadata.lastUserMessageAt, userSentAt);
    assert.deepEqual(order((await cold()).rows), ['B', 'A', 'Done']);
    b.client.sendSessionProtocolMessage({ id: randomUUID(), role: 'agent', time: Date.now(), ev: { t: 'text', text: 'reply after user send' } });
    await b.client.flushOutboxAndAwait();
    assert.deepEqual(order((await cold()).rows), ['B', 'A', 'Done']);
    await b.client.updateAgentState(() => ({ turnStatus: { status: 'completed', updatedAt: Date.now() } }));
    assert.deepEqual(order((await cold()).rows), ['A', 'B', 'Done']);
    const resultSummary = { ok: true, production: false, browser: false, externalModels: false, cases: ['running-priority', 'alternating-agent-output-stable', 'explicit-user-send-promotes', 'encrypted-CAS-conflict-retains-title', 'cold-reload-after-assistant-tail', 'completion-only-leaves-priority-band'], serverPort: config.serverPort };
    await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify(resultSummary, null, 2));
    log(JSON.stringify(resultSummary));
    completed = true;
} finally {
    socket?.close();
    for (const client of clients) await client.close();
    if (environment) { await helpers.stopEnvironment(environment); await helpers.removeEnvironment(environment); }
}

// Imported CLI telemetry can retain process-global timers after all owned resources close.
if (completed) process.exit(0);
