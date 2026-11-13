// Ego only. Complete App with an isolated account, synthetic tasks, no model messages.
// Set globalThis.projectPanelContinuityConfig = { runtimePath, taskSpaceId, targetId, runId, record?, onlySwitch? }.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const config = globalThis.projectPanelContinuityConfig;
assert(config?.runtimePath && Number.isInteger(config.taskSpaceId) && config.targetId && config.runId);
const runtime = JSON.parse(await fs.readFile(config.runtimePath, 'utf8'));
const task = await taskSpace(config.taskSpaceId), page = task.page('p1');
assert.equal((await task.tabs()).find(tab => tab.label === 'p1')?.targetId, config.targetId);
const directory = path.join(path.dirname(config.runtimePath), config.record ? 'panel-continuity-replay' : 'panel-continuity');
await fs.mkdir(directory, { recursive: true });
const previous = config.onlySwitch ? JSON.parse(await fs.readFile(path.join(directory, 'results.json'), 'utf8')) : null;
const results = previous?.cases ?? [], frames = previous?.frames ?? [];
const route = runtime.webUrl + '/projects?' + new URLSearchParams({ machine: runtime.machineId, project: runtime.projectPath, feature: runtime.featurePath }).toString();
const card = target => `[data-testid="project-task-card-${target.id}"] button[aria-label="${target.title}"]`;
const input = '[data-testid="project-task-chat"] textarea[data-testid="session-message-input"]';
const scopeInput = '[data-testid="project-scope-chat"] textarea[data-testid="session-message-input"]';
const metrics = async () => (await fetch(runtime.controllerUrl + '/metrics')).json();
const record = async (id, evidence) => {
    results.push({ id, status: 'pass', evidence });
    await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify({ cases: results, frames, boundaries: runtime.boundaries }, null, 2));
    console.log({ case: id, status: 'pass', evidence });
};
const frame = async (label, expectedTask, expectedConversation = null) => {
    const url = await page.url(), parsed = new URL(url);
    assert.equal(parsed.origin, runtime.webUrl); assert.equal(parsed.pathname, '/projects');
    assert.equal(parsed.searchParams.get('machine'), runtime.machineId);
    assert.equal(parsed.searchParams.get('feature'), runtime.featurePath);
    assert.equal(parsed.searchParams.get('task'), expectedTask);
    assert.equal(parsed.searchParams.get('conversation'), expectedConversation);
    if (config.record) {
        await new Promise(resolve => setTimeout(resolve, 900));
        const screenshot = await page.screenshot({ path: path.join(directory, `${frames.length + 1}-${label}.png`) });
        frames.push({ label, path: screenshot }); return;
    }
    const { captureVerifiedBrowserStep } = await import('file:///Users/jacky/Deployments/paws-cli/releases/project-goals-r11-candidate-20261111/packages/happy-cli/scripts/capture-browser-step.mjs');
    const receipt = await captureVerifiedBrowserStep({
        cdp: (m, p) => page.cdp(m, p),
        pageInfo: () => page.evaluate(() => ({ url: location.href, w: innerWidth, h: innerHeight })),
        currentTab: async () => (await task.tabs()).find(tab => tab.active),
        listTaskSpaces,
        useOrCreateTaskSpace: async id => ({ id: (await taskSpace(id)).spaceId }),
    }, url, { sessionId: 'cmwc5io1o1ayumga8lelgtk42', runId: config.runId, skillName: 'ego-browser', taskSpaceId: config.taskSpaceId, targetId: config.targetId });
    frames.push({ label, ...receipt }); console.log({ frame: label, ...receipt });
};
const select = async target => {
    if (new URL(await page.url()).searchParams.get('task') === target.id) return;
    await page.click(card(target));
    await page.waitForFunction(id => new URL(location.href).searchParams.get('task') === id && !!document.querySelector('[data-testid="project-task-panel"]'), target.id, { timeout: 30000 });
};
const switchMeasured = async target => {
    // Observe the actual click and every animation frame, including the first frame after remount.
    await page.evaluate(selector => {
        const boxes = [], sample = () => {
            const panel = document.querySelector('[data-testid="project-task-panel"]');
            const r = panel?.getBoundingClientRect();
            boxes.push(r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null);
        };
        window.__panelContinuity = { boxes, done: false };
        const listener = event => {
            if (!event.target.closest(selector)) return;
            document.removeEventListener('click', listener, true);
            sample();
            let remaining = 12;
            const next = () => { sample(); if (--remaining) requestAnimationFrame(next); else window.__panelContinuity.done = true; };
            requestAnimationFrame(next);
        };
        document.addEventListener('click', listener, true);
    }, card(target));
    await select(target);
    await page.waitForFunction(() => window.__panelContinuity?.done, undefined, { timeout: 25000 });
    const samples = await page.evaluate(() => window.__panelContinuity.boxes);
    assert.equal(samples.length, 13); assert(samples.every(Boolean), 'details panel disappeared during switch');
    for (const box of samples) for (const key of ['x', 'y', 'width']) assert(Math.abs(box[key] - samples[0][key]) <= 1, `${key} changed: ${JSON.stringify(samples)}`);
    return { samples: samples.length, first: samples[0], maxDelta: Math.max(...samples.flatMap(box => ['x', 'y', 'width'].map(key => Math.abs(box[key] - samples[0][key])))) };
};
if (!config.onlySwitch) {
await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1680, height: 960, deviceScaleFactor: 1, mobile: false });
await page.goto(route, { timeout: 60000 });
await page.waitForSelector('[data-testid="project-task-board"]', { state: 'visible', timeout: 30000 });
const initial = await metrics();
await select(runtime.taskA);
await page.waitForSelector('[data-testid="project-task-brief"]', { state: 'visible', timeout: 10000 });
if (config.record) await frame('task-details-chat-closed', runtime.taskA.id);
await page.click(card(runtime.taskA));
await page.waitForFunction(() => !new URL(location.href).searchParams.has('task') && !new URL(location.href).searchParams.has('conversation') && !!document.querySelector('[data-testid="project-scope-panel"] [data-testid="workspace-directory-tree"]'), undefined, { timeout: 30000 });
await page.waitForSelector(`[data-testid="project-scope-panel"] button[aria-label="${runtime.featurePath}/tasks"]`, { state: 'visible', timeout: 30000 });
await page.waitForSelector(`[data-testid="project-scope-panel"] button[aria-label="${runtime.featurePath}/index.md"]`, { state: 'visible', timeout: 30000 });
assert.equal(await page.evaluate(() => !!document.querySelector('[data-testid="project-scope-chat"]')), false);
assert.equal((await metrics()).spawned.length, initial.spawned.length);
await frame('closed-chat-stays-closed', null);
await record('PC1-deselect-chat-closed', { globalTreeVisible: true, chatVisible: false, newSessions: 0 });

await page.waitForFunction(id => document.querySelector(`[data-testid="project-task-chat-${id}"]`)?.disabled === false, runtime.taskA.id, { timeout: 30000 });
await page.click(`[data-testid="project-task-card-${runtime.taskA.id}"] button[aria-label="Open conversation"]`);
await page.waitForSelector(input, { state: 'visible', timeout: 30000 });
const taskConversation = new URL(await page.url()).searchParams.get('conversation');
await page.fill(input, 'PANEL-TASK-UNSENT');
if (config.record) await frame('task-chat-open', runtime.taskA.id, taskConversation);
const beforeGlobal = await metrics();
await page.click(card(runtime.taskA));
await page.waitForSelector(scopeInput, { state: 'visible', timeout: 30000 });
await page.waitForSelector('[data-testid="project-scope-panel"] [data-testid="workspace-directory-tree"]', { state: 'visible', timeout: 30000 });
const globalConversation = new URL(await page.url()).searchParams.get('conversation');
assert(globalConversation && globalConversation !== taskConversation);
const globalMetrics = await metrics();
assert(globalMetrics.spawned.some(session => session.sessionId === globalConversation && session.directory === runtime.featurePath));
assert(globalMetrics.spawned.length <= beforeGlobal.spawned.length + 1);
await page.fill(scopeInput, 'PANEL-GLOBAL-UNSENT');
await page.click('[data-testid="project-navigation-back"]');
await page.waitForFunction(() => document.querySelector('[data-testid="project-task-chat"] textarea')?.value === 'PANEL-TASK-UNSENT', undefined, { timeout: 30000 });
await page.click('[data-testid="project-navigation-forward"]');
await page.waitForFunction(() => document.querySelector('[data-testid="project-scope-chat"] textarea')?.value === 'PANEL-GLOBAL-UNSENT', undefined, { timeout: 30000 });
assert.equal(new URL(await page.url()).searchParams.get('conversation'), globalConversation);
assert.equal((await metrics()).spawned.length, globalMetrics.spawned.length);
await frame('open-chat-switches-global', null, globalConversation);
await record('PC2-deselect-chat-open', { globalConversation, globalTreeVisible: true, taskAndGlobalDraftsPreserved: true, backForward: true, newGlobalSessions: globalMetrics.spawned.length - beforeGlobal.spawned.length });

}
// Switching Task details should preserve panel geometry at desktop and laptop widths.
await select(runtime.taskA);
await page.evaluate(() => new Promise(resolve => { let remaining = 4; const next = () => --remaining ? requestAnimationFrame(next) : resolve(); requestAnimationFrame(next); }));
const desktopAB = await switchMeasured(runtime.taskB), desktopBA = await switchMeasured(runtime.taskA);
await frame('stable-task-details-desktop', runtime.taskA.id);
await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await page.waitForFunction(() => innerWidth === 1280 && document.querySelector('[data-testid="project-task-panel"]')?.getBoundingClientRect().right <= 1280, undefined, { timeout: 10000 });
await page.evaluate(() => new Promise(resolve => { let remaining = 4; const next = () => --remaining ? requestAnimationFrame(next) : resolve(); requestAnimationFrame(next); }));
const laptopAB = await switchMeasured(runtime.taskB), laptopBA = await switchMeasured(runtime.taskA);
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
await frame('stable-task-details-laptop', runtime.taskA.id);
await record('PC3-task-switch-stable-panel', { desktopAB, desktopBA, laptopAB, laptopBA, noHorizontalOverflow: true });
const final = await metrics();
assert.equal(final.submitted.length, 0); assert.equal(final.received.length, 0);
await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify({ cases: results, frames, boundaries: runtime.boundaries, submitted: 0, received: 0 }, null, 2));
console.log({ complete: true, results: path.join(directory, 'results.json'), modelMessages: 0 });
console.log(await page.snapshot());
