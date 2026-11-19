// Run via Ego only against a fresh project-goals fixture; never use production data.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const config = globalThis.sessionActionsConfig;
assert(config?.contextPath && ['task', 'global'].includes(config.scope));
const context = JSON.parse(await fs.readFile(config.contextPath, 'utf8'));
const runtime = JSON.parse(await fs.readFile(context.runtimePath, 'utf8'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const output = path.join(root, 'packages/happy-app/test-results/project-goals/session-actions');
await fs.mkdir(output, { recursive: true });
const task = await taskSpace(context.taskSpaceId), page = task.page(context.pageLabel);
assert.equal((await task.tabs()).find(tab => tab.label === context.pageLabel)?.targetId, context.targetId);
assert.equal(new URL(await page.url()).origin, new URL(runtime.webUrl).origin);
assert(['localhost', '127.0.0.1'].includes(new URL(runtime.serverUrl).hostname), 'Synthetic fixture must stay on loopback');
// Only this fixture account's newly created IDs are mutated. Credentials stay in memory.
const auth = JSON.parse(await fs.readFile(path.join(root, 'environments/data/envs', runtime.environment, 'cli/home/access.key'), 'utf8'));
const { decryptLegacy } = await import(pathToFileURL(path.join(root, 'packages/happy-cli/src/api/encryption.ts')).href);
const secret = new Uint8Array(Buffer.from(auth.secret, 'base64'));
const snapshot = async id => {
    const response = await fetch(runtime.serverUrl + '/v2/sessions/' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + auth.token } });
    if (response.status === 404) return { status: 404 };
    assert.equal(response.status, 200);
    const value = (await response.json()).session;
    const metadata = decryptLegacy(new Uint8Array(Buffer.from(value.metadata, 'base64')), secret);
    return { status: 200, lifecycleState: metadata?.lifecycleState, directory: metadata?.path };
};
const rpc = async (method, input) => {
    const response = await fetch(runtime.controllerUrl + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, input }) });
    assert(response.ok); return response.json();
};
const before = await (await fetch(runtime.controllerUrl + '/metrics')).json();
// Retire only IDs issued by this disposable fixture, so each pass starts clean.
for (const id of new Set([...runtime.sessionIds, ...before.spawned.map(session => session.sessionId)])) {
    const response = await fetch(runtime.serverUrl + '/v1/sessions/' + encodeURIComponent(id), { method: 'DELETE', headers: { Authorization: 'Bearer ' + auth.token } });
    assert([200, 404].includes(response.status));
}
const ids = [];
for (let index = 0; index < 3; index++) {
    const input = { requestId: 'session-actions-' + randomUUID(), agent: 'codex', ...(config.scope === 'global' ? { scopePath: runtime.featurePath } : { featurePath: runtime.featurePath, taskId: runtime.taskA.id, action: 'chat' }) };
    const result = await rpc(config.scope === 'global' ? 'goalProjectAuthor' : 'goalTaskLaunch', input);
    assert.equal(result.type, 'success'); ids.push(result.sessionId);
}
const toDelete = ids[2];
let retained = ids[0], toArchive = ids[1];
const scope = config.scope === 'global' ? 'project-scope' : 'project-task';
const route = id => runtime.webUrl + '/projects?' + new URLSearchParams({ machine: runtime.machineId, project: runtime.projectPath, feature: runtime.featurePath, ...(config.scope === 'task' ? { task: runtime.taskA.id } : {}), conversation: id }).toString().replace(/\+/g, '%20');
let expectedUrl = route(toDelete);
const selector = suffix => `[data-testid="${scope}-${suffix}"]`;
const selected = async () => new URL(await page.url()).searchParams.get('conversation');
const waitSelected = id => page.waitForFunction(({ id, scope }) => new URL(location.href).searchParams.get('conversation') === id && [...document.querySelectorAll(`[data-testid="${scope}-delete-conversation"]`)].some(node => node.getBoundingClientRect().width > 0), { id, scope }, { timeout: 60000 });
const frames = [], cases = [];
let stopRecording, videoDirectory;
const stateFrames = [];
const videoFrame = async label => {
    if (!config.record) return;
    assert.equal((await task.tabs()).find(tab => tab.label === context.pageLabel)?.targetId, context.targetId);
    assert.equal(await page.url(), expectedUrl);
    const frame = await page.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 85, captureBeyondViewport: false });
    const name = 'state-' + randomUUID() + '.jpg';
    await fs.writeFile(path.join(videoDirectory, name), Buffer.from(frame.data, 'base64'));
    stateFrames.push({ name, timestamp: Date.now() / 1000, label });
};
const checkpoint = async (id, label) => {
    assert.equal(await selected(), expectedUrl === route(toDelete) ? toDelete : new URL(expectedUrl).searchParams.get('conversation'));
    if (config.record) { await new Promise(resolve => setTimeout(resolve, 900)); await videoFrame(id); }
    if (config.capture && (!config.captureCases || config.captureCases.includes(id))) {
        const { captureVerifiedBrowserStep } = await import('file:///Users/jacky/Deployments/paws-cli/releases/model-catalog-refresh-6747c235-20261116/packages/happy-cli/scripts/capture-browser-step.mjs');
        const result = await captureVerifiedBrowserStep({ cdp: (method, params) => page.cdp(method, params), pageInfo: () => page.evaluate(() => ({ url: location.href, w: innerWidth, h: innerHeight })), currentTab: async () => (await task.tabs()).find(tab => tab.active), listTaskSpaces, useOrCreateTaskSpace: async id => ({ id: (await taskSpace(id)).spaceId }) }, expectedUrl, { sessionId: context.sessionId, runId: context.runId, skillName: 'ego-browser', taskSpaceId: context.taskSpaceId, targetId: context.targetId });
        frames.push({ id, label, ...result }); console.log({ frame: id, label, ...result });
    }
};
const record = (id, evidence) => { cases.push({ id, status: 'pass', evidence }); console.log({ case: id, status: 'pass', ...evidence }); };
await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1680, height: 960, deviceScaleFactor: 1, mobile: false });
await page.goto(expectedUrl, { timeout: 60000 });
await waitSelected(toDelete);
await page.waitForSelector(`${selector('chat')} textarea[data-testid="session-message-input"]`, { state: 'visible', timeout: 60000 });
const settleControls = async () => {
    await page.waitForSelector(`${selector('chat')} textarea[data-testid="session-message-input"]`, { state: 'visible', timeout: 60000 });
    await page.evaluate(async scope => {
        await document.fonts.ready;
        const started = performance.now(); let previous = '', settledAt = started;
        while (performance.now() - started < 5000) {
            await new Promise(requestAnimationFrame);
            const value = [...document.querySelectorAll(`[data-testid="${scope}-conversation-header"] button`)].map(node => {
                const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].join(':');
            }).join('|');
            if (value !== previous) { previous = value; settledAt = performance.now(); }
            if (performance.now() - settledAt >= 350) return;
        }
        throw new Error('Conversation toolbar did not settle');
    }, scope);
};
const clickControl = async suffix => { await settleControls(); await page.click(selector(suffix)); };
await settleControls();
if (config.record) {
    const { recordEgoPage } = await import(pathToFileURL(path.join(root, 'packages/happy-app/e2e/fixtures/codex-settings/record-chat-regressions.ego.mjs')).href);
    videoDirectory = path.join(output, config.scope + '-video-' + randomUUID());
    stopRecording = await recordEgoPage(page, videoDirectory);
}
const caption = async label => {
    if (!config.record) return;
    await page.evaluate(label => {
        let node = document.querySelector('[data-paws-e2e-caption]');
        if (!node) { node = document.createElement('div'); node.setAttribute('data-paws-e2e-caption', ''); document.body.appendChild(node); }
        Object.assign(node.style, { position: 'fixed', bottom: '12px', left: '80px', maxWidth: '700px', padding: '9px 14px', borderRadius: '8px', background: 'rgba(0,0,0,.82)', color: 'white', font: '16px system-ui', zIndex: '100000', pointerEvents: 'none' });
        node.textContent = label;
    }, (config.scope === 'task' ? '任务会话' : '全局会话') + ' · ' + label);
};
try {
    await caption('C1：直接显示删除 / 归档，取消删除保留会话');
    const controls = await page.evaluate(scope => {
        const header = document.querySelector(`[data-testid="${scope}-conversation-header"]`);
        const buttons = [...header.querySelectorAll('[role="button"]')].map(node => ({ label: node.getAttribute('aria-label'), id: node.getAttribute('data-testid'), width: node.getBoundingClientRect().width }));
        return { buttons, legacyMenu: !!header.querySelector(`[data-testid="${scope}-conversation-actions"]`) };
    }, scope);
    assert(!controls.legacyMenu);
    const direct = controls.buttons.filter(button => [scope + '-delete-conversation', scope + '-archive-conversation'].includes(button.id));
    assert.equal(direct.length, 2); assert(direct.every(button => button.width > 0));
    assert.deepEqual(direct.map(button => button.id), [scope + '-delete-conversation', scope + '-archive-conversation']);
    assert.equal(await page.evaluate(scope => !!document.querySelector(`[data-testid="${scope}-delete-conversation-tooltip"]`), scope), false);
    await clickControl('delete-conversation');
    await page.waitForSelector('[aria-modal="true"][aria-label="Delete Session"]', { state: 'visible', timeout: 10000 });
    const confirmation = await page.snapshot(); assert(confirmation.includes('Cancel') && confirmation.includes('Delete Session'));
    await videoFrame('C1-confirmation');
    await page.click('loc=css:[aria-modal="true"][aria-label="Delete Session"] button >> nth=0');
    await page.waitForSelector('[aria-modal="true"][aria-label="Delete Session"]', { state: 'hidden', timeout: 10000 });
    assert.equal(await selected(), toDelete); assert.equal((await snapshot(toDelete)).status, 200);
    record(config.scope + '-C1-direct-icons', { directLabels: direct.map(button => button.label), menuAbsent: true, cancelPreservesSession: true });
    await checkpoint('C1', (config.scope === 'task' ? '任务' : '全局') + '会话直接显示删除与归档图标，取消删除保留会话');

    await caption('C2：确认删除后，剩余可用会话自动补位');
    await clickControl('delete-conversation');
    await page.waitForSelector('[aria-modal="true"][aria-label="Delete Session"]', { state: 'visible', timeout: 10000 });
    await videoFrame('C2-confirmation');
    await page.click('loc=css:[aria-modal="true"][aria-label="Delete Session"] button >> nth=1');
    await page.waitForFunction(({ previous, ids, scope }) => {
        const id = new URL(location.href).searchParams.get('conversation');
        return id !== previous && ids.includes(id) && !!document.querySelector(`[data-testid="${scope}-delete-conversation"]`);
    }, { previous: toDelete, ids, scope }, { timeout: 60000 });
    toArchive = await selected(); retained = ids.find(id => id !== toDelete && id !== toArchive);
    expectedUrl = route(toArchive);
    assert.equal((await snapshot(toDelete)).status, 404); assert.equal((await snapshot(toArchive)).status, 200);
    record(config.scope + '-C2-delete-successor', { deletedHttp: 404, retainedHttp: 200, selectedAvailableSuccessor: true });
    await checkpoint('C2', (config.scope === 'task' ? '任务' : '全局') + '会话删除成功，可用会话自动补位');

    await caption('C3：归档后自动切换，刷新后历史仍过滤归档项');
    await clickControl('archive-conversation');
    await waitSelected(retained); expectedUrl = route(retained);
    const archived = await snapshot(toArchive); assert(['archiveRequested', 'archived'].includes(archived.lifecycleState));
    const history = await rpc(config.scope === 'global' ? 'goalScopeHistory' : 'goalTaskHistory', config.scope === 'global' ? { scopePath: runtime.featurePath } : { featurePath: runtime.featurePath, taskId: runtime.taskA.id });
    assert(history.success); assert(!history.sessions.some(session => session.sessionId === toArchive));
    await clickControl('history');
    await page.waitForSelector(selector('history-menu'), { state: 'visible', timeout: 10000 });
    const visibleIds = await page.evaluate(scope => [...document.querySelectorAll(`[data-testid^="${scope}-history-"]`)].filter(node => node.getBoundingClientRect().width > 0).map(node => node.getAttribute('data-testid')), scope);
    assert(!visibleIds.includes(`${scope}-history-${toArchive}`)); assert(!visibleIds.includes(`${scope}-history-${toDelete}`)); assert(visibleIds.includes(`${scope}-history-${retained}`));
    await page.keyboard.press('Escape');
    await page.waitForSelector(selector('history-menu'), { state: 'hidden', timeout: 10000 });
    await page.reload({ timeout: 60000 }); await waitSelected(retained);
    await caption('C3：已刷新，历史仅显示可用会话');
    await clickControl('history');
    await page.waitForSelector(selector('history-menu'), { state: 'visible', timeout: 10000 });
    assert.equal(await page.evaluate(({ scope, id }) => !![...document.querySelectorAll(`[data-testid="${scope}-history-${id}"]`)].find(node => node.getBoundingClientRect().width > 0), { scope, id: toArchive }), false);
    record(config.scope + '-C3-archive-filter', { lifecycleState: archived.lifecycleState, excludedFromMachineHistory: true, excludedFromMenu: true, excludedAfterReload: true, availableSessionRemains: true });
    await checkpoint('C3', (config.scope === 'task' ? '任务' : '全局') + '归档会话已过滤，刷新后历史仍只显示可用会话');
} finally {
    const video = stopRecording ? await stopRecording() : undefined;
    if (video) {
        const sampled = JSON.parse(await fs.readFile(path.join(videoDirectory, 'frames.json'), 'utf8'));
        const combined = [...sampled, ...stateFrames].sort((a, b) => a.timestamp - b.timestamp);
        const lines = combined.map((frame, index) => `file '${frame.name}'\nduration ${Math.max(1 / 30, Math.min(5, (combined[index + 1]?.timestamp ?? frame.timestamp + 1) - frame.timestamp))}`).join('\n');
        await fs.writeFile(path.join(videoDirectory, 'frames.txt'), lines + `\nfile '${combined.at(-1).name}'\n`);
        await fs.writeFile(path.join(videoDirectory, 'state-frames.json'), JSON.stringify(stateFrames, null, 2));
        video.frames = combined.length; video.keyStates = stateFrames.map(frame => frame.label);
    }
    const after = await (await fetch(runtime.controllerUrl + '/metrics')).json();
    assert.equal(after.submitted.length, before.submitted.length); assert.equal(after.received.length, before.received.length);
    const result = { scope: config.scope, phase: config.record ? 'record' : 'normal', cases, frames, video, created: ids, modelInstructions: 0, boundaries: runtime.boundaries };
    await fs.writeFile(path.join(output, `${config.scope}-${config.record ? 'record' : 'normal'}.json`), JSON.stringify(result, null, 2));
    console.log({ completed: cases.length === 3, scope: config.scope, cases: cases.length, video });
}
console.log((await page.snapshot()).split('\n').slice(-22).join('\n'));
