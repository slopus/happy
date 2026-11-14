// Reuses serve.mjs's isolated App/account. No production data or model calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { encodeBase64, encryptLegacy, decryptLegacy, decodeBase64 } from '../../../../happy-cli/src/api/encryption.ts';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const output = path.join(root, 'packages/happy-app/test-results/codex-settings');
const runtime = JSON.parse(await fs.readFile(path.join(output, 'runtime.json'), 'utf8'));
assert.equal(runtime.boundaries?.production, false);
assert.match(runtime.serverUrl, /^http:\/\/localhost:\d+$/);
const auth = JSON.parse(await fs.readFile(path.join(root, 'environments/data/envs', runtime.environment, 'cli/home/access.key'), 'utf8'));
const key = new Uint8Array(Buffer.from(auth.secret, 'base64'));
const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
const encode = value => encodeBase64(encryptLegacy(value, key));
const snapshot = await (await fetch(`${runtime.serverUrl}/v2/sessions/${runtime.sessionId}`, { headers })).json();
const baseMetadata = decryptLegacy(decodeBase64(snapshot.session.metadata), key);
const sessions = [];
async function append(id, envelopes) {
    const response = await fetch(`${runtime.serverUrl}/v3/sessions/${id}/messages`, { method: 'POST', headers,
        body: JSON.stringify({ messages: envelopes.map(content => ({ localId: randomUUID(), content: encode({ role: 'session', content }) })) }) });
    assert(response.ok, `append: ${response.status}`);
}
for (const name of ['切换验收 A', '切换验收 B']) {
    const metadata = { ...baseMetadata, name, summary: { text: name, updatedAt: Date.now() } };
    const response = await fetch(`${runtime.serverUrl}/v1/sessions`, { method: 'POST', headers,
        body: JSON.stringify({ tag: randomUUID(), metadata: encode(metadata), dataEncryptionKey: null }) });
    assert(response.ok); const row = (await response.json()).session;
    const now = Date.now() - 600_000;
    const messages = Array.from({ length: 180 }, (_, index) => {
        const turn = randomUUID();
        return [
            { id: randomUUID(), role: 'user', time: now + index * 2000, turn,
                ev: { t: 'text', text: `${name} 提问 ${index + 1}。${'用于核验会话切换与历史阅读位置。'.repeat(8)}` } },
            { id: randomUUID(), role: 'agent', time: now + index * 2000 + 1000, turn,
                ev: { t: 'text', text: `${name} 回答 ${index + 1}。${'合成回复，无外部模型调用。'.repeat(10)}` } },
        ];
    }).flat();
    for (let offset = 0; offset < messages.length; offset += 100) await append(row.id, messages.slice(offset, offset + 100));
    sessions.push({ id: row.id, name, latest: `${name} 回答 180。` });
}
const controller = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST' && request.url === '/append') {
        try {
            await append(sessions[0].id, [{ id: randomUUID(), role: 'agent', time: Date.now(), turn: randomUUID(),
                ev: { t: 'text', text: '新增回复 · 用户阅读历史时保持位置' } }]);
            response.end('{"appended":true}');
        } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); }
        return;
    }
    if (request.method === 'POST' && request.url === '/shutdown') { response.end('{}'); controller.close(); return; }
    response.writeHead(404); response.end('{}');
});
await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve));
const result = { sessions, controllerUrl: `http://127.0.0.1:${controller.address().port}` };
await fs.writeFile(path.join(output, 'scroll-switch-runtime.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
