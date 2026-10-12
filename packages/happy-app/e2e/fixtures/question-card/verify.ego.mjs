import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function verifyQuestionCard(runtime, config) {
    const { taskSpace, cdp, pageInfo, currentTab, listTaskSpaces, useOrCreateTaskSpace } = runtime;
    const { captureVerifiedBrowserStep } = await import(config.captureHelperUrl);
    const task = await taskSpace(config.taskSpaceId);
    const page = task.page('p1');
    const tabs = await task.tabs();
    assert.equal(tabs.find(tab => tab.label === 'p1')?.targetId, config.targetId);
    assert.equal(task.ownership, 'agent');
    const artifacts = config.record ? await mkdtemp(join(tmpdir(), 'paws-question-card-video-')) : null;
    const steps = [];
    const url = theme => `http://127.0.0.1:49827/?theme=${theme}`;
    let expected = url('dark');
    const state = () => page.evaluate(() => {
        const card = document.querySelector('[data-testid="markdown-question-card"]');
        const send = document.querySelector('[data-testid="question-send"]');
        const input = document.querySelector('[data-testid="question-custom-input"]');
        return {
            card: Boolean(card), disabled: send?.disabled,
            selected: [...document.querySelectorAll('[role="radio"]')].filter(node => node.getAttribute('aria-checked') === 'true').map(node => node.getAttribute('data-testid')),
            draft: input?.value, count: Number(document.querySelector('#sent-count').dataset.count),
            replies: document.querySelector('#sent-replies').textContent,
            error: document.querySelector('#error').textContent,
            overflow: document.documentElement.scrollWidth > innerWidth,
            cardRect: card?.getBoundingClientRect().toJSON(),
            sendRect: send?.getBoundingClientRect().toJSON(),
            inputRect: input?.getBoundingClientRect().toJSON(),
            inputRowRect: document.querySelector('[data-testid="question-input-row"]')?.getBoundingClientRect().toJSON(),
            actionsRect: document.querySelector('[data-testid="question-actions"]')?.getBoundingClientRect().toJSON(),
            outline: input ? getComputedStyle(input).outlineStyle : null,
            inputClipped: input ? input.scrollHeight > input.clientHeight + 2 && input.clientHeight < 100 : false,
        };
    });
    const capture = async label => {
        assert.equal(await page.url(), expected);
        assert.equal((await task.tabs()).find(tab => tab.label === 'p1')?.targetId, config.targetId);
        if (!config.record) {
            const receipt = await captureVerifiedBrowserStep({ cdp, pageInfo, currentTab, listTaskSpaces, useOrCreateTaskSpace }, expected, config);
            steps.push({ label, ...receipt });
        } else {
            const shot = await page.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 92, captureBeyondViewport: false });
            assert.equal(await page.url(), expected);
            assert.equal((await task.tabs()).find(tab => tab.label === 'p1')?.targetId, config.targetId);
            const path = join(artifacts, `frame-${String(steps.length).padStart(2, '0')}.jpg`);
            await writeFile(path, Buffer.from(shot.data, 'base64'));
            steps.push({ label, path });
        }
    };
    const reset = async () => { await page.click('#reset'); await page.waitForSelector('[data-testid="question-send"]'); };
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.goto(expected);
    await page.waitForFunction(() => document.fonts.status === 'loaded');
    assert.equal((await state()).disabled, true);
    assert.equal((await state()).overflow, false);
    await capture('桌面最终布局：空回答禁止发送，输入图标对齐');
    await page.click('[data-testid="question-option-1"]');
    assert.deepEqual((await state()).selected, ['question-option-1']);
    assert.equal((await state()).count, 0);
    assert.equal((await state()).disabled, false);
    await capture('选择第二项：选中反馈明确，尚未发送');
    await page.click('[data-testid="question-send"]');
    assert.equal((await state()).disabled, true);
    await page.waitForFunction(() => document.querySelector('#sent-count').dataset.count === '1');
    assert.equal((await state()).card, false);
    assert.equal((await state()).replies, '我逐个选择任务并开启');
    await capture('确认发送：接口收到准确回答，卡片收起');
    await reset();
    await page.click('[data-testid="question-option-0"]');
    await page.fill('[data-testid="question-custom-input"]', '  先确认任务边界，再决定是否并行。  ');
    assert.deepEqual((await state()).selected, []);
    await page.click('#fail-next');
    await page.click('[data-testid="question-send"]');
    await page.waitForFunction(() => document.querySelector('#error').textContent.length > 0);
    assert.equal((await state()).count, 0);
    assert.equal((await state()).draft, '  先确认任务边界，再决定是否并行。  ');
    await capture('发送失败：自由回答保留，可以重试');
    await page.click('[data-testid="question-send"]');
    await page.waitForFunction(() => document.querySelector('#sent-count').dataset.count === '1');
    assert.equal((await state()).replies, '先确认任务边界，再决定是否并行。');
    await capture('重试成功：仅提交去掉首尾空格的自由回答');
    for (const control of ['question-skip', 'question-close']) {
        await reset(); await page.click(`[data-testid="${control}"]`);
        assert.equal((await state()).card, false); assert.equal((await state()).count, 0);
    }
    await capture('关闭与跳过：卡片收起，接口没有收到回答');
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await reset();
    await page.fill('[data-testid="question-custom-input"]', '在手机上填写自己的回答');
    await page.mouse.move(190, 600);
    await page.mouse.wheel(0, 400);
    await page.mouse.move(380, 20);
    assert.equal((await state()).overflow, false);
    assert.equal((await state()).disabled, false);
    assert.ok((await state()).cardRect.width <= 350);
    assert.equal((await state()).inputClipped, false);
    assert.equal((await state()).outline, 'none');
    assert.ok((await state()).actionsRect.top >= (await state()).inputRowRect.bottom + 10);
    assert.ok((await state()).inputRowRect.width >= (await state()).cardRect.width - 26);
    assert.ok((await state()).sendRect.bottom <= 844);
    await capture('390px 深色：编号和长选项换行，输入与发送可达');
    await page.click('[data-testid="question-send"]');
    await page.waitForFunction(() => document.querySelector('#sent-count').dataset.count === '1');
    assert.equal((await state()).replies, '在手机上填写自己的回答');
    expected = url('light');
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.goto(expected);
    await page.waitForFunction(() => document.fonts.status === 'loaded');
    await page.click('[data-testid="question-option-2"]');
    await page.mouse.move(160, 600);
    await page.mouse.wheel(0, 400);
    await page.mouse.move(310, 20);
    assert.equal((await state()).overflow, false);
    assert.deepEqual((await state()).selected, ['question-option-2']);
    assert.ok((await state()).sendRect.bottom <= 844);
    assert.ok((await state()).actionsRect.top >= (await state()).inputRowRect.bottom + 10);
    await capture('320px 浅色最终状态：长选项完整，选中与发送可见');
    console.log(JSON.stringify({ status: 'pass', cases: ['OPTION-SELECT-SEND', 'CUSTOM-FAIL-RETRY', 'DISMISS-WITHOUT-SEND', 'DARK-DESKTOP', 'DARK-390', 'LIGHT-320'], record: Boolean(config.record), artifacts, steps }));
    return steps;
}
