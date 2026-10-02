// Run with `ego-browser nodejs < scripts/verify-codex-native-queue.ego.mjs`.
// The full isolated Expo Web + server + real CLI session must already exist.
const required = name => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing ${name}`);
    return value;
};
const spaceId = Number(required('EGO_TASK_SPACE_ID'));
if (!Number.isSafeInteger(spaceId)) throw new Error('Invalid task space ID');
const targetId = required('EGO_TARGET_ID');
const expectedUrl = required('EGO_SESSION_URL');
const sessionId = new URL(expectedUrl).pathname.split('/').pop();
const task = await taskSpace(spaceId);
const page = task.page('p1');
if ((await task.tabs()).find(tab => tab.label === 'p1')?.targetId !== targetId
    || await page.url() !== expectedUrl) throw new Error('Task target or URL changed');

const input = 'loc=css:textarea[data-testid="session-message-input"]';
const queueButton = 'loc=css:button[aria-label="加入待发送队列（Tab）"]';
const waitEmpty = () => page.waitForFunction(
    () => document.querySelector('[data-testid="session-message-input"]')?.value === '',
    undefined, { timeout: 15_000 },
);
const nativeTurn = () => page.evaluate(id => {
    // Read the real Expo application's synchronized session; never inject state.
    for (const module of globalThis.__r.getModules().values()) {
        const storage = module.publicModule.exports?.storage;
        const session = storage?.getState?.().sessions[id];
        if (session) return session.agentState?.turnStatus;
    }
    throw new Error('Session storage unavailable');
}, sessionId);
const enqueue = async text => {
    await page.fill(input, text);
    await page.click(queueButton);
    await waitEmpty();
};
await page.fill(input, '隔离验收：仅运行 python3 -c "import time; time.sleep(45)"，不修改文件，完成回复 EGO_ORIGINAL_DONE。');
await page.click('loc=css:button[data-testid="message-composer-send-button"]');
await page.waitForSelector(queueButton, { timeout: 30_000 });
const originalTurn = await nativeTurn();
if (!originalTurn?.turnId) throw new Error('No native turn ID');
await page.fill(input, 'EGO_EDIT_DRAFT');
await page.press(input, 'Tab');
await waitEmpty();
await page.click('loc=css:[data-testid^="queued-message-"] button[aria-label="取回编辑"]');
await page.waitForFunction(
    () => document.querySelector('[data-testid="session-message-input"]')?.value === 'EGO_EDIT_DRAFT',
    undefined, { timeout: 10_000 },
);
await enqueue('EGO_DELETE_EDITED');
await page.click('loc=css:[data-testid^="queued-message-"] button[aria-label="删除"]');
await enqueue('/skills');
await enqueue('仅回复 EGO_QUEUED_DONE。');
await page.fill(input, '插话：保留等待任务，在最终答复追加 EGO_STEER_DONE。');
await page.press(input, 'Enter');
await waitEmpty();
const guidedTurn = await nativeTurn();
if (guidedTurn?.turnId !== originalTurn.turnId) throw new Error('Guidance replaced the native turn');
await page.reload();
await page.waitForFunction(
    () => document.querySelectorAll('[data-testid^="queued-message-"]').length === 2,
    undefined, { timeout: 25_000 },
);
await page.waitForFunction(() => {
    const text = document.body.innerText;
    return !document.querySelector('[data-testid="message-staging-queue"]')
        && text.includes('EGO_ORIGINAL_DONE\nEGO_STEER_DONE')
        && text.includes('EGO_QUEUED_DONE\n')
        && !document.querySelector('button[aria-label="停止正在运行的 Agent"]');
}, undefined, { timeout: 60_000 });
const { captureVerifiedBrowserStep } = await import(required('EGO_CAPTURE_HELPER_PATH'));
cliLog(await captureVerifiedBrowserStep(
    { cdp, pageInfo, currentTab, listTaskSpaces, useOrCreateTaskSpace }, expectedUrl,
    { sessionId: required('HAPPY_CAPTURE_SESSION_ID'), runId: required('EGO_RUN_ID'),
        skillName: 'ego-browser', taskSpaceId: spaceId, targetId },
));
console.log({ result: 'pass', originalNativeTurnId: originalTurn.turnId });
// The caller reports the exact returned screenshot and finishes this same space.
