import assert from 'node:assert/strict';
const IDS = ['socratic', 'two-layer', 'reverse-engineer', 'vertical-horizontal', 'fact-check', 'expert-panel', 'first-principles', 'cross-domain', 'steelman', 'min-experiment', 'hidden-talent', 'life-design', 'teach-me'];
const input = 'textarea[data-testid="session-message-input"]';
const trigger = '[data-testid="thinking-mode-trigger"]';
const send = '[data-testid="message-composer-send-button"]';
export async function verifyThinkingMode({ page, sessionUrl, controllerUrl, selectionIds = IDS, navigate = true, onStep = async () => {} }) {
    const report = [];
    if (navigate) await page.goto(sessionUrl);
    else assert.equal(await page.url(), sessionUrl);
    await page.waitForSelector(trigger);
    const previous = (await (await fetch(`${controllerUrl}/state`)).json()).sent.length;
    if (previous) await page.waitForSelector('.tm-followup');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const draft = () => page.evaluate(() => [...document.querySelectorAll('textarea[data-testid="session-message-input"]')].find(n => n.getBoundingClientRect().width > 0)?.value);
    const open = async () => {
        await page.click(trigger);
        await page.waitForFunction(() => {
            const dialog = document.querySelector('[data-testid="thinking-mode-dialog"]');
            return dialog && dialog.contains(document.activeElement);
        });
    };
    const choose = async id => {
        await open(); await page.click('[data-testid="thinking-group-all"]');
        await page.click(`[data-testid="thinking-method-${id}"]`);
        await page.waitForFunction(() => !document.querySelector('[data-testid="thinking-mode-dialog"]'));
    };
    await page.fill(input, 'TM-KEEP 这段草稿不应被修改');
    await open();
    assert.equal(await page.evaluate(() => document.querySelectorAll('.tm-method-select').length), 13);
    await page.click('[data-testid="thinking-group-life"]');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.tm-method-select')].map(n => n.dataset.testid)), ['thinking-method-hidden-talent', 'thinking-method-life-design']);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'thinking-mode-trigger' && !document.querySelector('[data-testid="thinking-mode-dialog"]'));
    for (const id of selectionIds) { await choose(id); assert.equal(await draft(), 'TM-KEEP 这段草稿不应被修改'); }
    await choose('two-layer');
    const selectedLabel = await page.evaluate(() => document.querySelector('[data-testid="thinking-mode-trigger"]').textContent);
    report.push({ case: 'TM2', pass: true, selections: selectionIds.length, draftPreserved: true, escapeFocus: true });
    await onStep('classified-library');
    const replyCount = () => page.evaluate(() => [...document.querySelectorAll('.tm-followup')].at(-1)?.getAttribute('data-testid') ?? null);
    const waitReply = async before => page.waitForFunction(before => { const id = [...document.querySelectorAll('.tm-followup')].at(-1)?.getAttribute('data-testid'); return !!id && id !== before; }, before, { timeout: 45000 });
    let before = await replyCount();
    await page.fill(input, 'TM-E2E：用两层解释 AI Agent 与聊天机器人的区别。只讲解，不读写文件。');
    await page.click(send); await waitReply(before);
    const original = await page.evaluate(() => {
        const n = [...document.querySelectorAll('.tm-followup')].at(-1);
        return { id: n.dataset.testid.slice('thinking-followup-'.length), text: n.closest('[data-testid^="message-agent-"]').innerText.split('继续追问')[0].trim() };
    });
    await page.fill(input, 'TM-KEEP 追问不得覆盖草稿');
    const old = `[data-testid="thinking-followup-${original.id}"]`;
    await page.click(`${old} .tm-followup-toggle`);
    for (const action of ['draw', 'example', 'continue']) {
        before = await replyCount();
        await page.click(`${old} [data-testid="thinking-followup-${action}"]`); await waitReply(before);
        assert.equal(await draft(), 'TM-KEEP 追问不得覆盖草稿');
        assert.equal(await page.evaluate(() => document.querySelector('[data-testid="thinking-mode-trigger"]').textContent), selectedLabel);
    }
    const state = await (await fetch(`${controllerUrl}/state`)).json();
    const actions = state.sent.slice(-3).filter(item => item.text.includes('Referenced assistant reply (JSON):'));
    assert.equal(actions.length, 3);
    const expectedOriginal = '传输验收 · 双层解释\n\n通俗版：聊天机器人像顾问，Agent 像能执行步骤的助手。\n\n专业版：Agent 通过规划、工具调用和反馈循环推进目标。';
    for (const message of actions) {
        const reference = JSON.parse(message.text.split('Referenced assistant reply (JSON):\n')[1]);
        assert.equal(reference.messageId, original.id); assert.equal(reference.text, expectedOriginal);
    }
    report.push({ case: 'TM3/TM4', pass: true, queuedActions: 3, oldReplyBound: true, draftPreserved: true, selectedMethodPreserved: true });
    await onStep('reply-actions');
    await choose('teach-me');
    for (const text of ['我会聊天机器人，从这个基础教我 AI Agent。', '继续同一个 Agent 主题，解释反馈循环。']) {
        before = await replyCount(); await page.fill(input, text); await page.click(send); await waitReply(before);
    }
    const lesson = (await (await fetch(`${controllerUrl}/state`)).json()).sent.filter(item => item.text.includes('"teach-me"'));
    assert(lesson.length >= 2); assert(lesson.at(-1).text.includes('继续同一个 Agent 主题'));
    report.push({ case: 'TM3-LEARN', pass: true, sameConversation: true, methodSentEachTurn: true });
    await onStep('lesson-continuity');
    return report;
}
