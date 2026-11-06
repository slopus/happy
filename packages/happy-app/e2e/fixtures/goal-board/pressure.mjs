import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { encodeBase64, encryptLegacy, decryptLegacy } from '../../../../happy-cli/src/api/encryption.ts';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const runtimePath = path.join(root, 'packages/happy-app/test-results/goal-board/runtime.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));
const sessionId = runtime.sessionIds[0];
const featurePath = path.join(path.dirname(runtime.featurePath), 'pressure-200');
const write = async (name, content) => { await fs.mkdir(path.dirname(name), { recursive: true }); await fs.writeFile(name, content); };
const links = [], statuses = ['running', 'review', 'pending', 'blocked', 'done'];
for (let index = 1; index <= 200; index++) {
    const code = `G${String(index).padStart(3, '0')}`;
    const relative = `tasks/${code}`;
    links.push(`| ${code} | [压力任务 ${index}](${relative}/index.md) |`);
    await write(path.join(featurePath, relative, 'index.md'), `---\nstatus: ${statuses[index % statuses.length]}\n---\n# ${code} 压力任务 ${index}\n目标摘要：验证 200 任务交互性能\n## 下一步\n保持完整原文，无摘要\n${index === 1 ? '## 当前产物\n[大型 Markdown 原件](大型 中文报告.md)\n[大型 TypeScript 原件](大型 code.ts)\n' : ''}`);
}
await write(path.join(featurePath, 'index.md'), '# 200 任务性能验收\n[任务地图](总任务地图.md)\n');
await write(path.join(featurePath, '总任务地图.md'), '# 200 任务导航\n' + links.join('\n'));
const taskDirectory = path.join(featurePath, 'tasks/G001');
const markdown = '# 大型 Markdown 完整原件\n\n' + Array.from({ length: 1800 }, (_, index) => `第 ${index + 1} 段：这份原始文件用于检测排版、源码切换与滚动中的长任务，正文不可截断或替换为摘要。\n\n`).join('') + '**LARGE_MARKDOWN_FULL_END**\n';
const code = '// Large original TypeScript fixture\n' + Array.from({ length: 2600 }, (_, index) => `export const measurement${index} = { index: ${index}, original: true, label: "中文性能验收" };\n`).join('') + '// LARGE_CODE_FULL_END\n';
await write(path.join(taskDirectory, '大型 中文报告.md'), markdown);
await write(path.join(taskDirectory, '大型 code.ts'), code);
assert(Buffer.byteLength(markdown) >= 128 * 1024); assert(Buffer.byteLength(code) >= 128 * 1024);
const started = performance.now();
let read;
if (process.argv.includes('--bind')) {
    const result = await fetch(runtime.controllerUrl + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'goalBoardRead', input: { featurePath } }) });
    read = await result.json();
} else {
    // Validate generated records without changing the active browser session's watcher/metadata.
    const { parseBoard } = await import('../../../../happy-cli/src/modules/goalBoard/parser.ts');
    const parsed = await parseBoard({ root: path.resolve(featurePath, '../../..'), featurePath, title: '200 任务性能验收', projectTitle: '隔离验收项目' });
    read = { success: true, snapshot: parsed.snapshot };
}
assert(read.success, read.error); assert.equal(read.snapshot.tasks.length, 200);
if (process.argv.includes('--bind')) {
    const auth = JSON.parse(await fs.readFile(path.join(root, 'environments/data/envs', runtime.environment, 'cli/home/access.key'), 'utf8'));
    const key = new Uint8Array(Buffer.from(auth.secret, 'base64'));
    const snapshot = await (await fetch(runtime.controllerUrl + '/snapshot')).json();
    const require = createRequire(path.join(root, 'packages/happy-cli/package.json'));
    const { io } = require('socket.io-client');
    const socket = io(runtime.serverUrl, { path: '/v1/updates', transports: ['websocket'], reconnection: false, auth: { token: auth.token, clientType: 'user-scoped' } });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    try {
        let metadata = snapshot.metadata, version = snapshot.metadataVersion, saved = false;
        for (let attempt = 0; attempt < 3; attempt++) {
            const next = { ...metadata, goalBoard: { featurePath }, goalBoardSnapshot: read.snapshot };
            const response = await socket.timeout(10000).emitWithAck('update-metadata', { sid: sessionId, expectedVersion: version, metadata: encodeBase64(encryptLegacy(next, key)) });
            if (response.result === 'success') { saved = true; break; }
            assert.equal(response.result, 'version-mismatch');
            metadata = decryptLegacy(new Uint8Array(Buffer.from(response.metadata, 'base64')), key); version = response.version;
        }
        assert(saved, 'Pressure binding metadata version remained busy');
    } finally { socket.disconnect(); }
}
const report = { featurePath, sessionId, bound: process.argv.includes('--bind'), taskCount: read.snapshot.tasks.length, actionMs: performance.now() - started, loadMode: process.argv.includes('--bind') ? 'encrypted-RPC-and-metadata-binding' : 'direct-real-CLI-parser', markdownBytes: Buffer.byteLength(markdown), codeBytes: Buffer.byteLength(code), marker: ['LARGE_MARKDOWN_FULL_END', 'LARGE_CODE_FULL_END'] };
await fs.writeFile(path.join(root, 'packages/happy-app/test-results/goal-board/pressure.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
