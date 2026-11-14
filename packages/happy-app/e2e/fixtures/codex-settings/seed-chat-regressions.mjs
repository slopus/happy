// Event-driven synthetic cases on the isolated full-App fixture; no model/daemon.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { encodeBase64, encryptLegacy } from '../../../../happy-cli/src/api/encryption.ts';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const output = path.join(root, 'packages/happy-app/test-results/codex-settings');
const runtime = JSON.parse(await fs.readFile(path.join(output, 'runtime.json'), 'utf8'));
const seed = JSON.parse(await fs.readFile(path.join(output, 'scroll-switch-runtime.json'), 'utf8'));
assert.equal(runtime.boundaries?.production, false);
assert.match(runtime.serverUrl, /^http:\/\/localhost:\d+$/);
const auth = JSON.parse(await fs.readFile(path.join(root, 'environments/data/envs', runtime.environment, 'cli/home/access.key'), 'utf8'));
const key = new Uint8Array(Buffer.from(auth.secret, 'base64'));
const encode = value => encodeBase64(encryptLegacy(value, key));
const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
const require = createRequire(path.join(root, 'packages/happy-cli/package.json'));
const { io } = require('socket.io-client');
const sessionId = seed.sessions[0].id;
const socket = io(runtime.serverUrl, { path: '/v1/updates', transports: ['websocket'], reconnection: false,
    auth: { token: auth.token, clientType: 'session-scoped', sessionId } });
await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
let clock = Date.now();
const stream = { turnId: randomUUID(), itemId: randomUUID() };
async function append(role, text) {
    clock = Math.max(clock + 1, Date.now());
    const content = { id: randomUUID(), role, time: clock, turn: randomUUID(), ev: { t: 'text', text } };
    const response = await fetch(`${runtime.serverUrl}/v3/sessions/${sessionId}/messages`, { method: 'POST', headers,
        body: JSON.stringify({ messages: [{ localId: randomUUID(), content: encode({ role: 'session', content }) }] }) });
    assert(response.ok, `append: ${response.status}`);
    return content.id;
}
const controller = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    try {
        if (request.method !== 'POST') { response.writeHead(404); response.end('{}'); return; }
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        if (request.url === '/text') { const id = await append(body.role === 'user' ? 'user' : 'agent', String(body.text)); response.end(JSON.stringify({ id })); return; }
        if (request.url === '/question') { const id = await append('agent', `${body.label || '选择卡片验收'}：由谁决定？\n<options>\n<option>由你决定</option>\n<option>我选择</option>\n</options>`); response.end(JSON.stringify({ id })); return; }
        if (request.url === '/stream') {
            const text = String(body.text);
            socket.emit('session-stream', { sid: sessionId, content: { t: 'encrypted', c: encode({ type: 'text-delta', ...stream, text, delta: text }) } });
            response.end(JSON.stringify({ sent: true, ...stream })); return;
        }
        if (request.url === '/tool') {
            clock = Math.max(clock + 1, Date.now());
            const call = randomUUID(), turn = randomUUID();
            const messages = [
                { t: 'tool-call-start', call, name: 'Skill', title: 'release-ops', description: '', args: { skill: 'release-ops', command: 'cat /fixture/skills/release-ops/SKILL.md; ls /fixture/missing' } },
                { t: 'tool-call-end', call, status: 'failed', error: { summary: 'Command exited with code 1.', detail: 'ls: /fixture/missing: No such file or directory' } },
            ].map(ev => ({ localId: randomUUID(), content: encode({ role: 'session', content: { id: randomUUID(), role: 'agent', time: ++clock, turn, ev } }) }));
            const result = await fetch(`${runtime.serverUrl}/v3/sessions/${sessionId}/messages`, { method: 'POST', headers, body: JSON.stringify({ messages }) });
            assert(result.ok); response.end(JSON.stringify({ call })); return;
        }
        if (request.url === '/shutdown') { response.end('{}'); socket.disconnect(); controller.close(); return; }
        response.writeHead(404); response.end('{}');
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); }
});
await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve));
const result = { sessionId, controllerUrl: `http://127.0.0.1:${controller.address().port}` };
await fs.writeFile(path.join(output, 'chat-regressions-runtime.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
