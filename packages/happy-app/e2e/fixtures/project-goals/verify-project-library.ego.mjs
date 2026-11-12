// Run only through Ego against a fresh, isolated project-goals fixture.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const config = globalThis.projectLibraryConfig;
assert(config?.runtimePath && Number.isInteger(config.taskSpaceId) && config.targetId);
const runtime = JSON.parse(await fs.readFile(config.runtimePath, 'utf8'));
const task = await taskSpace(config.taskSpaceId), page = task.page('p1');
assert.equal((await task.tabs()).find(tab => tab.label === 'p1')?.targetId, config.targetId);
const url = runtime.webUrl + '/projects?machine=' + encodeURIComponent(runtime.machineId);
assert.equal(await page.url(), url);
const output = path.join(path.dirname(config.runtimePath), 'library-results.json');
const results = [];
const record = async (id, evidence) => {
    results.push({ id, status: 'pass', evidence });
    await fs.writeFile(output, JSON.stringify({ results, boundaries: runtime.boundaries }, null, 2));
    console.log({ id, status: 'pass', evidence });
};
const count = () => page.evaluate(() => document.querySelectorAll('[data-testid^="project-cover-"]').length);
const control = id => `[data-testid="${id}"]`;
const click = async id => {
    await page.click(control(id));
    if (config.record) await new Promise(resolve => setTimeout(resolve, 700));
};
const wait = id => page.waitForSelector(control(id), { state: 'visible', timeout: 30000 });
const empty = () => wait('project-library-empty');
// RN Web omits aria-selected on role=button; the toggle's accessible label
// reflects the current state in this deliberately English fixture.
const favorite = () => page.evaluate(() => document.querySelector('[data-testid="project-favorite-0"]')?.getAttribute('aria-label') === 'Remove from favorites');
await wait('project-cover-0');
const initial = await count();
assert(initial >= 2);
const projectTitle = await page.evaluate(() => document.querySelector('[data-testid="project-cover-0"]').getAttribute('aria-label'));
const catalog = await (await fetch(runtime.controllerUrl + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'goalProjects', input: {} }) })).json();
assert(catalog.success);
const sourceProject = catalog.projects.find(project => project.title === projectTitle);
assert(sourceProject && sourceProject.projectPath.startsWith(path.dirname(runtime.projectPath) + path.sep));
const sourceIndex = path.join(sourceProject.projectPath, 'index.md');
const originalBytes = await fs.readFile(sourceIndex);
assert.equal(await favorite(), false, 'Use a fresh fixture account');

// The ordinary case must pass before this optional, readable recording replay.
const videoDirectory = path.join(path.dirname(output), 'library-video');
let recording = false, pump;
const frames = [];
if (config.record) {
    await fs.mkdir(path.join(videoDirectory, 'frames'), { recursive: true });
    await page.events();
    await page.cdp('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1680, maxHeight: 960, everyNthFrame: 1 });
    recording = true;
    const started = Date.now();
    pump = (async () => {
        while (recording) {
            for (const event of await page.events()) if (event.method === 'Page.screencastFrame') {
                const file = path.join(videoDirectory, 'frames', String(frames.length).padStart(6, '0') + '.jpg');
                await fs.writeFile(file, Buffer.from(event.params.data, 'base64'));
                frames.push({ path: file, time: (Date.now() - started) / 1000 });
                await page.cdp('Page.screencastFrameAck', { sessionId: event.params.sessionId });
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    })();
}

await click('project-favorite-0'); assert.equal(await page.url(), url);
await click('project-filter-favorites'); assert.equal(await count(), 1); assert(await favorite());
await page.reload({ timeout: 60000 }); await wait('project-cover-0');
await click('project-filter-favorites'); assert.equal(await count(), 1); assert(await favorite());
await record('PL1-favorites', { survivesReload: true, separateCardAction: true });

await click('project-more-0'); await wait('project-card-menu');
await page.keyboard.press('Escape');
await page.waitForSelector(control('project-card-menu'), { state: 'hidden' });
assert.equal(await page.url(), url);
await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'project-more-0');
await click('project-more-0'); await click('project-menu-archive'); await empty();
await click('project-filter-archived'); await wait('project-cover-0');
await click('project-more-0'); await click('project-menu-archive'); await empty();
await click('project-filter-favorites'); await wait('project-cover-0'); assert(await favorite());
await record('PL2-archive', { activeViewsExcludeArchived: true, restoredFavorite: true, escapeRestoresFocus: true });

await click('project-more-0'); await click('project-menu-delete');
console.log(await page.snapshot());
await page.click('text="Cancel"'); assert.equal(await count(), 1);
await click('project-more-0'); await click('project-menu-delete'); await page.click('text="Delete"'); await empty();
assert((await fs.readFile(sourceIndex)).equals(originalBytes), 'Deleting a library entry must preserve its source archive');
await page.reload({ timeout: 60000 }); await wait('project-cover-0'); assert.equal(await count(), initial - 1);
await click('project-filter-deleted'); await wait('project-cover-0');
assert.equal(await page.evaluate(() => document.querySelector('[data-testid="project-cover-0"]').getAttribute('aria-label')), projectTitle);
await click('project-more-0'); await click('project-menu-archive'); await empty();
await click('project-filter-favorites'); await wait('project-cover-0'); assert(await favorite());
await record('PL3-delete', { cancelledDeletionPreservesProject: true, deletionSurvivesReload: true, restorePreservesFavorite: true });

const search = 'input[placeholder="Search projects or tasks"]';
await page.fill(search, 'NO-MATCH-LIBRARY-19485'); await empty();
await page.fill(search, ''); await wait('project-cover-0');
await click('project-favorite-0'); await empty(); await click('project-filter-all');
assert.equal(await count(), initial);
await record('PL4-search-empty', { searchWithinFilter: true, unfavoriteEmptyState: true });
if (recording) {
    recording = false;
    await pump;
    await page.cdp('Page.stopScreencast');
    await fs.writeFile(path.join(videoDirectory, 'frames.json'), JSON.stringify(frames, null, 2));
    console.log({ videoFrames: frames.length, directory: videoDirectory });
}

// Keep emulation, readback and native input on the same Ego CDP target.
// Mixing the Page activation path with emulation did not preserve this viewport.
await useOrCreateTaskSpace(config.taskSpaceId);
assert.equal((await currentTab()).targetId, config.targetId);
assert.equal((await currentTab()).url, url);
const evaluate = async expression => (await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
const layouts = [];
for (const [width, height, columns] of [[1680, 885, 5], [1366, 768, 4], [390, 844, 1]]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false, dontSetVisibleSize: true });
    await settle();
    const layout = JSON.parse(await evaluate('JSON.stringify({width:innerWidth,height:innerHeight,columns:getComputedStyle(document.querySelector("[data-testid=project-gallery]")).gridTemplateColumns.split(" ").length,overflow:document.documentElement.scrollWidth-innerWidth})'));
    assert.equal(layout.width, width); assert.equal(layout.columns, columns); assert(layout.overflow <= 1);
    const point = JSON.parse(await evaluate('JSON.stringify((()=>{const r=document.querySelector("[data-testid=project-more-0]").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})())'));
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await settle();
    const menu = JSON.parse(await evaluate('JSON.stringify((()=>{const r=document.querySelector("[data-testid=project-card-menu]")?.getBoundingClientRect();return r?{x:r.x,y:r.y,right:r.right,bottom:r.bottom,inside:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight}:null})())'));
    assert(menu?.inside);
    layouts.push({ ...layout, menu });
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await settle();
}
await record('PL5-responsive', layouts);
await cdp('Emulation.clearDeviceMetricsOverride', {});
assert((await fs.readFile(sourceIndex)).equals(originalBytes));
