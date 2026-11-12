// Run only through ego-browser nodejs. The fixture owns an isolated account and synthetic files.
// Supply globalThis.projectTaskFlowConfig = { runtimePath, taskSpaceId, targetId } before importing.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const config = globalThis.projectTaskFlowConfig;
assert(config?.runtimePath && Number.isInteger(config.taskSpaceId) && config.targetId);
const runtime = JSON.parse(await fs.readFile(config.runtimePath, 'utf8'));
const task = await taskSpace(config.taskSpaceId);
const page = task.page('p1');
assert.equal((await task.tabs()).find(tab => tab.label === 'p1')?.targetId, config.targetId);
const results = [];
const reportPath = path.join(path.dirname(config.runtimePath), 'task-flow-results.json');
const record = async (id, evidence) => {
    results.push({ id, status: 'pass', evidence });
    await fs.writeFile(reportPath, JSON.stringify({ cases: results, boundaries: runtime.boundaries }, null, 2));
    console.log({ case: id, status: 'pass', ...evidence });
};
const metrics = async () => (await fetch(runtime.controllerUrl + '/metrics')).json();
const featureBoard = async () => {
    await page.click('button[aria-label="桌面工作区"]');
    await page.waitForSelector('[data-testid="project-task-board"]', { state: 'visible', timeout: 30000 });
};
const card = id => `[data-testid="project-task-card-${id}"]`;

await page.goto((await fs.readFile(runtime.authUrlFile, 'utf8')).trim(), { timeout: 60000 });
await page.waitForSelector('[data-testid="sidebar-project-goals-button"]', { state: 'visible', timeout: 60000 });
await page.click('[data-testid="sidebar-project-goals-button"]');
await page.waitForSelector('button[aria-label="Paws 项目工作区"]', { state: 'visible', timeout: 30000 });
await page.click('button[aria-label="Paws 项目工作区"]');
await page.waitForSelector('button[aria-label="桌面工作区"]', { state: 'visible', timeout: 30000 });
await page.click('button[aria-label="桌面工作区"]');
await page.waitForSelector('[data-testid="project-task-board"]', { state: 'visible', timeout: 30000 });

const initial = await metrics();
await page.click(`${card(runtime.taskA.id)} button[aria-label="Open conversation"]`);
await page.waitForSelector('[data-testid="project-task-chat"] textarea[data-testid="session-message-input"]', { state: 'visible', timeout: 60000 });
assert(runtime.sessionIds.includes(new URL(await page.url()).searchParams.get('conversation')));
assert.equal((await metrics()).spawned.length, initial.spawned.length);
await record('TF2-existing-chat', { newConversations: 0 });

await featureBoard();
const beforeCreate = await metrics();
await page.click(`${card(runtime.taskB.id)} button[aria-label="Open conversation"]`);
await page.waitForSelector('[data-testid="project-task-chat"] textarea[data-testid="session-message-input"]', { state: 'visible', timeout: 60000 });
const conversation = new URL(await page.url()).searchParams.get('conversation');
assert(conversation);
const created = await metrics();
assert.equal(created.spawned.length, beforeCreate.spawned.length + 1);
assert.equal(created.submitted.length, 0); assert.equal(created.received.length, 0);
await page.fill('[data-testid="project-task-chat"] textarea[data-testid="session-message-input"]', 'TASK-FLOW-UNSENT-DRAFT');
await page.waitForSelector('[data-testid="project-task-navigation"]', { state: 'visible', timeout: 15000 });
await page.click(`[data-testid="project-task-navigation-${runtime.taskA.id}"]`);
await page.waitForFunction(id => new URL(location.href).searchParams.get('task') === id && document.querySelector('[data-testid="project-task-brief"]')?.textContent.includes('工作区方案'), runtime.taskA.id, { timeout: 30000 });
await page.waitForFunction(() => !document.querySelector('[data-testid="project-task-open-chat"]')?.disabled, undefined, { timeout: 30000 });
await page.click('[data-testid="project-task-open-chat"]');
await page.waitForSelector('[data-testid="project-task-chat"] textarea[data-testid="session-message-input"]', { state: 'visible', timeout: 60000 });
await page.click(`[data-testid="project-task-navigation-${runtime.taskB.id}"]`);
await page.waitForFunction(id => new URL(location.href).searchParams.get('task') === id && document.querySelector('[data-testid="project-task-brief"]')?.textContent.includes('首次执行任务'), runtime.taskB.id, { timeout: 30000 });
await page.waitForFunction(() => !document.querySelector('[data-testid="project-task-open-chat"]')?.disabled, undefined, { timeout: 30000 });
await page.click('[data-testid="project-task-open-chat"]');
await page.waitForFunction(id => new URL(location.href).searchParams.get('conversation') === id, conversation, { timeout: 60000 });
await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="project-task-chat"] textarea')].some(input => input.value === 'TASK-FLOW-UNSENT-DRAFT' && getComputedStyle(input).visibility !== 'hidden'), undefined, { timeout: 30000 });
assert.equal((await metrics()).spawned.length, created.spawned.length);
await record('TF3-create-reuse-draft', { newConversations: 1, submitted: 0, draftRestored: true, taskListPreserved: true });

await page.click('button[aria-label="Edit delivery"]');
await page.waitForSelector('[data-testid="project-delivery-expected"]', { state: 'visible', timeout: 30000 });
const beforeEscape = await page.url();
await page.press('[data-testid="project-delivery-expected"]', 'Escape');
await page.waitForSelector('[data-testid="project-delivery-editor"]', { state: 'hidden', timeout: 10000 });
assert.equal(await page.url(), beforeEscape);
await page.click('button[aria-label="Edit delivery"]');
await page.waitForSelector('[data-testid="project-delivery-expected"]', { state: 'visible', timeout: 30000 });
const original = await fs.readFile(runtime.taskB.indexPath, 'utf8');
await page.fill('[data-testid="project-delivery-finals"]', '../outside.md');
await page.click('[data-testid="project-delivery-save"]');
await page.waitForSelector('[data-testid="project-delivery-editor"] [role="alert"]', { state: 'visible', timeout: 10000 });
assert.equal(await fs.readFile(runtime.taskB.indexPath, 'utf8'), original);
await fs.writeFile(path.join(path.dirname(runtime.taskB.indexPath), '结果.md'), '# 实际结果\n\nTASK-FLOW-FINAL\n');
await page.fill('[data-testid="project-delivery-expected"]', '一份真实结果文档');
await page.fill('[data-testid="project-delivery-criteria"]', '打开结果.md看到 TASK-FLOW-FINAL');
await page.fill('[data-testid="project-delivery-finals"]', '结果.md');
await page.click('[data-testid="project-delivery-save"]');
await page.waitForSelector('text="Delivery saved"', { state: 'visible', timeout: 30000 });
await page.waitForFunction(() => !document.querySelector('[data-testid="project-delivery-save"]')?.disabled, undefined, { timeout: 30000 });
const saved = await fs.readFile(runtime.taskB.indexPath, 'utf8');
assert(saved.startsWith(original.trimEnd())); assert(saved.includes('一份真实结果文档'));
await page.press('[data-testid="project-delivery-expected"]', 'Escape');
await page.waitForSelector('[data-testid="project-delivery-editor"]', { state: 'hidden', timeout: 10000 });
await page.waitForSelector('text="一份真实结果文档"', { state: 'visible', timeout: 30000 });
assert(await page.evaluate(() => document.querySelector('[data-testid="project-task-brief"]')?.innerText.includes('Awaiting your confirmation')));
await page.click('button[aria-label="Edit delivery"]');
await page.waitForFunction(() => document.querySelector('[data-testid="project-delivery-expected"]')?.value === '一份真实结果文档', undefined, { timeout: 30000 });
await page.press('[data-testid="project-delivery-expected"]', 'Escape');
await record('TF4-delivery-save', { sourcePreserved: true, reopenedAgreement: true, unsafePathRejected: true, automaticallyAccepted: false, escapeKeptRoute: true });

await featureBoard();
await page.click('[data-testid="project-batch-delivery"]');
await page.waitForSelector('[data-testid="project-delivery-expected"]', { state: 'visible', timeout: 30000 });
await page.fill('[data-testid="project-delivery-expected"]', 'BATCH-UNSAVED-A');
await page.click('[data-testid="project-delivery-editor"] button[aria-label="首次执行任务"]');
await page.waitForFunction(() => document.querySelector('[data-testid="project-delivery-expected"]')?.value === '一份真实结果文档', undefined, { timeout: 30000 });
await page.click('[data-testid="project-delivery-editor"] button[aria-label="工作区方案"]');
await page.waitForFunction(() => document.querySelector('[data-testid="project-delivery-expected"]')?.value === 'BATCH-UNSAVED-A', undefined, { timeout: 10000 });
await page.press('[data-testid="project-delivery-expected"]', 'Escape');
await record('TF5-batch-delivery', { taskDraftsIsolated: true, unsavedDraftNotWritten: !(await fs.readFile(runtime.taskA.indexPath, 'utf8')).includes('BATCH-UNSAVED-A') });

await page.click('[data-testid="project-feature-files"]');
await page.waitForFunction(() => { const panel = document.querySelector('[data-testid="project-feature-files-panel"]'); return panel?.innerText.includes('Saved to machine') && panel.innerText.includes('index.md') && !panel.querySelector('[role="progressbar"]'); }, undefined, { timeout: 30000 });
assert(await page.evaluate(() => document.querySelector('[data-testid="project-feature-files-panel"] button[aria-label="Save file"]')?.disabled));
const fileUrl = await page.url(); await page.keyboard.press('Escape');
await page.waitForSelector('[data-testid="project-feature-files-panel"]', { state: 'hidden', timeout: 10000 });
assert.equal(await page.url(), fileUrl);
await record('TF6-feature-files', { goalIndexVisible: true, folderTreeVisible: true, readOnly: true, escapeKeptRoute: true });

await page.click(`${card(runtime.taskA.id)} button[aria-label="工作区方案"]`);
await page.waitForSelector('[data-testid="project-task-files-tab"]', { state: 'visible', timeout: 15000 });
await page.click('[data-testid="project-task-files-tab"]');
const reportFile = `[aria-label="${runtime.taskDirectory}/产品方案.md"]`;
await page.waitForSelector(reportFile, { state: 'visible', timeout: 30000 });
await page.click('[data-testid="project-task-details-tab"]');
await fetch(runtime.controllerUrl + '/directory-error', { method: 'POST' });
await page.click('[data-testid="project-task-files-tab"]');
await page.waitForSelector('text="Could not update. Showing previously loaded files."', { state: 'visible', timeout: 30000 });
await page.waitForSelector(reportFile, { state: 'visible', timeout: 10000 });
await record('TF7-cached-directory', { cachedFilesSurvivedRefreshFailure: true });

await page.click('[data-testid="sidebar-session-list-button"]');
await page.waitForURL(runtime.webUrl + '/', { timeout: 15000 });
await page.waitForSelector('[data-testid="desktop-sidebar-session-navigation"]', { state: 'visible', timeout: 15000 });
await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="desktop-sidebar-session-navigation"] button')].some(button => button.textContent?.includes('New chat') && button.getBoundingClientRect().height > 0 && !button.closest('[aria-hidden="true"]')), undefined, { timeout: 15000 });
await record('TF1-list-entry', { navigatedHome: true, populatedSessionListVisible: true });
const final = await metrics();
assert.equal(final.submitted.length, 0); assert.equal(final.received.length, 0);
console.log({ completed: true, cases: results.length, reportPath, modelInvocations: 0 });
console.log(await page.snapshot());
