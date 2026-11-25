// A disposable transport peer on the authorized backend. No model is invoked.
// Invoke with HAPPY_THINKING_E2E=1 and the CLI tsconfig. Credentials never leave memory.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
if (!process.env.HAPPY_SERVER_URL) throw new Error('Explicit authorized backend required');
if (process.env.HAPPY_THINKING_E2E !== '1') throw new Error('Explicit E2E opt-in required');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const output = path.join(root, 'packages/happy-app/test-results/thinking-mode');
await fs.mkdir(output, { recursive: true });
const { readCredentials, readSettings } = await import('../../../../happy-cli/src/persistence.ts');
const { ApiClient } = await import('../../../../happy-cli/src/api/api.ts');
const { ApiSessionClient } = await import('../../../../happy-cli/src/api/apiSession.ts');
const credentials = await readCredentials(); assert(credentials);
const settings = await readSettings();
const metadata = { path: output, host: 'thinking-mode-e2e.local', name: '思维模式 · 传输验收', machineId: settings.machineId, flavor: 'codex', lifecycleState: 'running', startedBy: 'terminal', models: [{ code: 'gpt-6.1-sol', value: 'GPT-6.1 Sol' }], currentModelCode: 'gpt-6.1-sol', thoughtLevels: [{ code: 'low', value: 'Low' }] };
const api = await ApiClient.create(credentials);
const session = await api.getOrCreateSession({ tag: randomUUID(), metadata, state: { turnStatus: { status: 'completed', turnId: randomUUID(), updatedAt: Date.now() } } });
assert(session);
const client = new ApiSessionClient(credentials.token, session);
const sent = [];
let count = 0;
client.onUserMessage(message => {
    sent.push({ text: message.content.text, meta: message.meta });
    const turn = randomUUID();
    client.sendAgentMessage('codex', { type: 'task_started', id: turn });
    const text = message.content.text;
    const result = text.includes('Show Me:')
        ? '传输验收 · 图解\n\n| 普通聊天 | AI Agent |\n|---|---|\n| 回答问题 | 计划、行动、观察反馈 |'
        : text.includes('one concrete worked example')
            ? '传输验收 · 例子：普通聊天机器人解释怎么订票；Agent 会查询、比较，再根据用户确认执行。'
            : text.includes('teach-me')
                ? `传输验收 · 持续学习 ${++count}：在同一个 Agent 主题上继续讲解反馈循环。`
                : '传输验收 · 双层解释\n\n通俗版：聊天机器人像顾问，Agent 像能执行步骤的助手。\n\n专业版：Agent 通过规划、工具调用和反馈循环推进目标。';
    client.sendAgentMessage('codex', { type: 'message', message: result });
    client.sendAgentMessage('codex', { type: 'task_complete', id: turn });
    client.keepAlive(false, 'remote');
});
client.keepAlive(false, 'remote');
client.socket.io.engine.on('packet', packet => { if (packet.type === 'ping') client.keepAlive(false, 'remote'); });
const controller = createServer(async (req, res) => {
    if (req.url !== '/state' || req.method !== 'GET') { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ sessionId: session.id, sent }));
});
await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve));
const runtime = { pid: process.pid, sessionId: session.id, controllerUrl: `http://127.0.0.1:${controller.address().port}`, appUrl: 'http://localhost:18187', boundary: 'real production encrypted transport; deterministic test peer, no model' };
await fs.writeFile(path.join(output, 'transport.json'), JSON.stringify(runtime, null, 2));
console.log(JSON.stringify(runtime));
async function cleanup() {
    controller.close();
    await client.close();
    const deletion = await fetch(`${process.env.HAPPY_SERVER_URL}/v1/sessions/${session.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${credentials.token}` } }).catch(() => null);
    const result = { sessionId: session.id, deleted: deletion?.ok === true, status: deletion?.status ?? null };
    await fs.writeFile(path.join(output, 'cleanup.json'), JSON.stringify(result));
    console.log(JSON.stringify({ cleanup: result }));
    process.exit(result.deleted ? 0 : 1);
}
process.on('SIGTERM', cleanup); process.on('SIGINT', cleanup);
