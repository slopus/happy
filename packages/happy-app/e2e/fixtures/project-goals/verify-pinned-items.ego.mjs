// Only run via Ego against the isolated complete App fixture. No production writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const config = globalThis.pinnedItemsConfig;
assert(config?.runtimePath && config.contextPath);
const runtime = JSON.parse(await fs.readFile(config.runtimePath, 'utf8'));
const context = JSON.parse(await fs.readFile(config.contextPath, 'utf8'));
const task = await taskSpace(context.taskSpaceId), page = task.page('p1');
assert.equal((await task.tabs()).find(tab => tab.label === 'p1')?.targetId, context.targetId);
const rootURL = runtime.webUrl + '/projects?machine=' + encodeURIComponent(runtime.machineId);
assert.equal(await page.url(), rootURL);
const dir = path.dirname(config.runtimePath), results = [], evidence = [];
const selector = id => `[data-testid=${JSON.stringify(id)}]`;
const wait = id => page.waitForSelector(selector(id), { state: 'visible', timeout: 30000 });
const pause = async () => { if (config.record) await new Promise(resolve => setTimeout(resolve, 800)); };
const click = async css => {
    await page.waitForSelector(css, { state: 'visible', timeout: 30000 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
    await page.click(css); await pause();
};
const exists = css => page.evaluate(css => [...document.querySelectorAll(css)].some(node => node.getBoundingClientRect().width && node.getBoundingClientRect().height), css);
const capture = async (label, expected) => {
    // Expected ownership and the complete intended route are checked before capture.
    const actual = new URL(await page.url());
    assert.equal(actual.origin + actual.pathname, runtime.webUrl + '/projects');
    assert.deepEqual(Object.fromEntries(actual.searchParams), { machine: runtime.machineId, ...expected });
    await useOrCreateTaskSpace(context.taskSpaceId);
    assert.equal((await currentTab()).targetId, context.targetId);
    const { captureVerifiedBrowserStep } = await import('file:///Users/jacky/Deployments/paws-cli/releases/project-task-flow-candidate-20261112/packages/happy-cli/scripts/capture-browser-step.mjs');
    const frame = await captureVerifiedBrowserStep({ cdp, pageInfo, currentTab, listTaskSpaces, useOrCreateTaskSpace }, actual.href, context);
    evidence.push({ ...frame, label });
    await fs.writeFile(path.join(dir, config.record ? 'pinned-record-evidence.json' : 'pinned-evidence.json'), JSON.stringify(evidence, null, 2));
};
const pass = async (id, details) => { results.push({ id, status: 'pass', details }); await fs.writeFile(path.join(dir, config.record ? 'pinned-record-results.json' : 'pinned-results.json'), JSON.stringify({ results, boundaries: runtime.boundaries }, null, 2)); console.log({ id, status: 'pass', details }); };
const original = new Map();
for (const file of [path.join(runtime.projectPath, 'index.md'), path.join(runtime.featurePath, 'index.md'), runtime.taskA.indexPath, path.join(runtime.taskDirectory, '产品方案.md')]) original.set(file, await fs.readFile(file));
let recording = false, pump;
const frames = [], videoDir = path.join(dir, 'pinned-video');
let sequence = 0, started = 0;
const appendFrame = async data => { const file = path.join(videoDir, 'frames', String(sequence++).padStart(6, '0') + '.jpg'); frames.push({path:file,time:(Date.now()-started)/1000}); await fs.writeFile(file, Buffer.from(data,'base64')); };
const checkpoint = async () => { if (!recording) return; const result = await page.cdp('Page.captureScreenshot', {format:'jpeg',quality:85}); await appendFrame(result.data); await pause(); };
if (config.record) {
    await fs.mkdir(path.join(videoDir, 'frames'), { recursive: true });
    await page.events(); await page.cdp('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1680, maxHeight: 960, everyNthFrame: 1 });
    recording = true; started = Date.now();
    pump = (async () => { while (recording) { for (const event of await page.events()) if (event.method === 'Page.screencastFrame') {
        await appendFrame(event.params.data);
        await page.cdp('Page.screencastFrameAck', { sessionId: event.params.sessionId });
    } await new Promise(resolve => setTimeout(resolve, 80)); } })();
}
try {
    await page.waitForSelector(`${selector('project-library-main')} ${selector('project-favorite-1')}`, { state: 'visible', timeout: 30000 });
    assert.equal(await exists(selector('project-filter-favorites')), false);
    await click(`${selector('project-library-main')} ${selector('project-favorite-1')}`);
    await page.waitForSelector(`${selector('project-favorites-section')} button[aria-label="Paws 项目工作区"]`, { timeout: 30000 });
    assert.equal(await page.url(), rootURL);
    await page.reload(); await page.waitForSelector(`${selector('project-favorites-section')} button[aria-label="Paws 项目工作区"]`, { timeout: 30000 });
    const order = await page.evaluate(() => {
        const top = document.querySelector('[data-testid="project-favorites-section"]'), main = document.querySelector('[data-testid="project-library-filters"]');
        return top.getBoundingClientRect().top < main.getBoundingClientRect().top;
    }); assert(order);
    await checkpoint();
    await pass('PF1', { favoriteBeforeLibrary: true, noFavoritesTab: true, survivesReload: true });
    if (!config.record) await capture('首页收藏项目直接置顶，刷新后保留', {});
    await click(`${selector('project-library-main')} button[aria-label="Paws 项目工作区"]`);
    await wait('project-feature-library');
    await click(selector('library-favorite-' + runtime.featurePath));
    await click(selector('library-delete-' + runtime.featurePath));
    await page.waitForSelector('text="Cancel"', { timeout: 10000 }); await click('text="Cancel"');
    assert(await exists(selector('project-feature-gallery') + ' button[aria-label="桌面工作区"]'));
    await click(selector('library-delete-' + runtime.featurePath)); await page.waitForSelector('text="Delete"', { timeout: 10000 }); await click('text="Delete"');
    await page.reload(); await wait('project-feature-library');
    assert.equal(await exists(selector('project-feature-gallery') + ' button[aria-label="桌面工作区"]'), false);
    await click(selector('feature-filter-deleted')); await wait('project-saved-items');
    await click(selector('library-delete-' + runtime.featurePath));
    await click('button[aria-label="Subprojects"]');
    await page.waitForSelector(selector('project-feature-gallery') + ' button[aria-label="桌面工作区"]', { timeout: 10000 });
    const star = await page.evaluate(css => document.querySelector(css)?.getAttribute('aria-label'), selector('library-favorite-' + runtime.featurePath)); assert.equal(star, 'Unfavorite 桌面工作区');
    await checkpoint();
    await pass('PF2', { cancelKeepsFeature: true, deletedAfterReload: true, restoredFavorite: true });
    if (!config.record) await capture('子项目收藏、删除与恢复已核验', { project: runtime.projectPath });
    // The project's own index is organized through the real scope directory RPC.
    await click(selector('project-scope-files-tab')); await wait('project-archive-tree');
    const index = path.join(runtime.projectPath, 'index.md');
    await click(`${selector('workspace-directory-tree')} ${selector('library-favorite-' + index)}`);
    await page.goto(rootURL); await wait('project-favorites-section');
    await click(`${selector('project-favorites-section')} button[aria-label="桌面工作区"]`);
    await wait('project-task-board');
    await click(selector('project-scope-files-tab')); await wait('project-archive-tree');
    const featureIndex = path.join(runtime.featurePath, 'index.md');
    await click(`${selector('workspace-directory-tree')} ${selector('library-favorite-' + featureIndex)}`);
    // Enter the actual Task file tree, preserving its read context for homepage open.
    await page.goto(runtime.webUrl + '/projects?' + new URLSearchParams({ machine: runtime.machineId, project: runtime.projectPath, feature: runtime.featurePath, task: runtime.taskA.id }));
    await wait('project-task-panel'); await click(selector('project-task-files-tab'));
    const file = path.join(runtime.taskDirectory, '产品方案.md');
    await page.waitForSelector(`${selector('workspace-directory-tree')} ${selector('library-favorite-' + file)}`, { timeout: 30000 });
    await click(`${selector('workspace-directory-tree')} ${selector('library-favorite-' + file)}`);
    await click(`${selector('workspace-directory-tree')} ${selector('library-delete-' + file)}`);
    await page.waitForSelector('text="Delete"', { timeout: 10000 }); await click('text="Delete"');
    await page.reload(); await wait('project-task-panel'); await click(selector('project-task-files-tab'));
    await wait('project-archive-tree');
    assert.equal(await exists(`${selector('workspace-directory-tree')} button[aria-label=${JSON.stringify(file)}]`), false);
    await click(selector('file-filter-deleted')); await click(selector('library-delete-' + file));
    await click(`${selector('project-archive-tree')} button[aria-label="Files"]`);
    await page.waitForSelector(`${selector('workspace-directory-tree')} button[aria-label=${JSON.stringify(file)}]`, { timeout: 10000 });
    await checkpoint();
    await pass('PF3', { projectIndexFavorite: true, featureIndexFavorite: true, taskDocumentDeleteRestore: true });
    if (!config.record) await capture('任务文档收藏、删除及恢复可用', { project: runtime.projectPath, feature: runtime.featurePath, task: runtime.taskA.id });
    await page.goto(rootURL); await wait('project-favorites-section');
    await click(`${selector('project-favorites-section')} button[aria-label="产品方案.md"]`); await wait('project-saved-file');
    await page.waitForFunction(() => document.querySelector('[data-testid="project-saved-file"]')?.textContent.includes('END-PROJECT-DELIVERY-V1'), undefined, { timeout: 30000 });
    await click(`${selector('project-saved-file')} ${selector('library-delete-' + file)}`);
    await page.waitForSelector('text="Delete"', { timeout: 10000 });
    await page.keyboard.press('Escape');
    await wait('project-saved-file');
    assert.equal(await exists('[role="dialog"][aria-label="Move to Deleted"]'), false);
    assert(await exists(`${selector('project-saved-file')} ${selector('library-favorite-' + file)}`));
    await checkpoint();
    await pass('PF4', { directDocumentOpen: true, nestedEscapeKeepsReader: true, sourceBytesPreserved: true });
    if (!config.record) await capture('首页直开收藏文档，Esc只取消删除确认', {});
    await click(`${selector('project-saved-file')} button[aria-label="Back"]`);
    for (const [file, bytes] of original) assert((await fs.readFile(file)).equals(bytes), 'Source bytes changed: ' + file);
    // Final root state is ready for responsive checks and a separate recorded replay.
    await pause();
    if (config.record) { await checkpoint(); await capture('首页直接展示收藏项目、子项目和真实文档', {}); }
    else {
        // Restore initial preferences by user-visible actions, without clearing browser storage.
        const ids = [index, featureIndex, file, runtime.featurePath];
        for (const itemPath of ids) await click(`${selector('project-favorites-section')} ${selector('library-favorite-' + itemPath)}`);
        await click(`${selector('project-favorites-section')} ${selector('library-favorite-' + runtime.projectPath)}`);
        await wait('project-favorites-empty');
    }
} finally {
    if (recording) { recording = false; await pump; await page.cdp('Page.stopScreencast'); await fs.writeFile(path.join(videoDir, 'frames.json'), JSON.stringify(frames.sort((a,b)=>a.time-b.time), null, 2)); console.log({ frames: frames.length, videoDir }); }
}
