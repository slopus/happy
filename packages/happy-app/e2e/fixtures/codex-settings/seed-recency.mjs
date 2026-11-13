// Run only against serve.mjs's isolated synthetic environment. Never reads production credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const output = path.join(root, 'packages/happy-app/test-results/codex-settings');
const runtime = JSON.parse(await fs.readFile(path.join(output, 'runtime.json'), 'utf8'));
assert.equal(runtime.boundaries?.production, false);
assert.match(runtime.serverUrl, /^http:\/\/localhost:\d+$/);
const auth = JSON.parse(await fs.readFile(path.join(root, 'environments/data/envs', runtime.environment, 'cli/home/access.key'), 'utf8'));
const key = new Uint8Array(Buffer.from(auth.secret, 'base64'));
process.env.HAPPY_SERVER_URL = runtime.serverUrl;
process.env.HAPPY_HOME_DIR = path.join(root, 'environments/data/envs', runtime.environment, 'cli/home');
const crypto = await import('../../../../happy-cli/src/api/encryption.ts');
const { ApiSessionClient } = await import('../../../../happy-cli/src/api/apiSession.ts');
const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
const encode = value => crypto.encodeBase64(crypto.encryptLegacy(value, key));
const first = await (await fetch(`${runtime.serverUrl}/v2/sessions/${runtime.sessionId}`, { headers })).json();
const baseMetadata = crypto.decryptLegacy(crypto.decodeBase64(first.session.metadata), key);
const clients = [];
const sessions = [];
for (const [days, title] of [[1, '昨日对话 · 今日仅恢复'], [2, '前日对话 · 等待继续']]) {
    const date = new Date(); date.setDate(date.getDate() - days); date.setHours(12, 0, 0, 0);
    const at = date.getTime();
    const metadata = { ...baseMetadata, summary: { text: title, updatedAt: Date.now() } };
    const response = await fetch(`${runtime.serverUrl}/v1/sessions`, { method: 'POST', headers,
        body: JSON.stringify({ tag: randomUUID(), metadata: encode(metadata), dataEncryptionKey: null }) });
    assert(response.ok); const row = (await response.json()).session;
    const client = new ApiSessionClient(auth.token, { ...row, encryptionKey: key, encryptionVariant: 'legacy', metadata, agentState: null });
    if (!client.socket.connected) await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Session socket timeout')), 15000);
        client.socket.once('connect', () => { clearTimeout(timeout); resolve(); });
    });
    client.sendSessionProtocolMessage({ id: randomUUID(), role: 'user', time: at - 1000, ev: { t: 'text', text: '这是昨日的原始对话。' } });
    client.sendSessionProtocolMessage({ id: randomUUID(), role: 'agent', turn: randomUUID(), time: at, ev: { t: 'turn-end', status: 'completed' } });
    await client.flushOutboxAndAwait();
    client.sendSessionEvent({ type: 'ready' });
    await client.flushOutboxAndAwait();
    client.keepAlive(false, 'remote');
    clients.push(client); sessions.push({ id: row.id, title, at });
}
const controller = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    try {
        if (request.method === 'POST' && request.url === '/continue') {
            const target = sessions[1];
            const result = await fetch(`${runtime.serverUrl}/v3/sessions/${target.id}/messages`, { method: 'POST', headers,
                body: JSON.stringify({ messages: [{ localId: randomUUID(), content: encode({ role: 'user', content: { type: 'text', text: '今天继续这段对话。' } }) }] }) });
            assert(result.ok); return response.end(JSON.stringify({ continued: target.id, ...(await result.json()) }));
        }
        if (request.method === 'POST' && request.url === '/presence') {
            for (const client of clients) { client.keepAlive(false, 'remote'); await client.updateMetadataAndAwait(metadata => ({ ...metadata, fixtureMetadataWrite: Date.now() })); }
            return response.end('{"presenceAndMetadata":true}');
        }
        if (request.method === 'POST' && request.url === '/shutdown') { response.end('{}'); for (const client of clients) await client.close(); controller.close(); return; }
        if (request.url === '/sessions') return response.end(JSON.stringify(sessions));
        response.writeHead(404); response.end('{}');
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); }
});
await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve));
const result = { controllerUrl: `http://127.0.0.1:${controller.address().port}`, sessions };
await fs.writeFile(path.join(output, 'recency-runtime.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
