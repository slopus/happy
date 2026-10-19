import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The same full-app Case runs normally and then again with new CDP video frames. */
export async function verifyMessageAnnotations(runtime, config) {
    const { taskSpace, cdp, pageInfo, currentTab, listTaskSpaces, useOrCreateTaskSpace } = runtime;
    const task = await taskSpace(config.taskSpaceId), page = task.page('p1');
    const state = JSON.parse(await readFile(config.runtimePath, 'utf8'));
    let expected = state.webUrl + '/session/' + state.sessionIds[0];
    const verify = async () => {
        assert.equal(task.ownership, 'agent');
        assert.equal((await task.tabs()).find(tab => tab.label === 'p1')?.targetId, config.targetId);
        assert.equal(await page.url(), expected);
    };
    await verify();
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const results = [], frames = [], captures = [];
    const mode = config.record ? 'recorded' : 'ordinary';
    const output = join(config.artifactDirectory, mode);
    await mkdir(output, { recursive: true });
    const passed = name => { results.push(name); console.log({ case: name, status: 'pass', mode }); };
    const frame = async label => {
        if (!config.record) return;
        await verify();
        await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'));
        const image = await page.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 92, captureBeyondViewport: false });
        await verify();
        const path = join(output, `frame-${String(frames.length).padStart(2, '0')}.jpg`);
        await writeFile(path, Buffer.from(image.data, 'base64'));
        frames.push({ label, path, seconds: 2.2 });
    };
    const capture = async label => {
        const { captureVerifiedBrowserStep } = await import(config.captureHelperUrl);
        const receipt = await captureVerifiedBrowserStep({ cdp, pageInfo, currentTab, listTaskSpaces, useOrCreateTaskSpace }, expected, { sessionId: config.sessionId, runId: config.runId, skillName: 'ego-browser', taskSpaceId: config.taskSpaceId, targetId: config.targetId });
        captures.push({ label, ...receipt });
        console.log({ label, ...receipt });
    };
    const settled = () => page.waitForFunction(() => {
        const source = document.querySelector('[data-testid=annotation-source-content]');
        if (!source || document.fonts.status !== 'loaded' || document.getAnimations().some(a => a.playState === 'running')) return false;
        const box = source.getBoundingClientRect();
        const key = [box.x, box.y, box.width, box.height, innerWidth, innerHeight].join(',');
        const old = window.__annotationLayoutProbe;
        if (!old || old.key !== key) { window.__annotationLayoutProbe = { key, since: performance.now() }; return false; }
        return performance.now() - old.since > 300;
    }, undefined, { timeout: 15000 });
    const goto = async pathname => { expected = state.webUrl + pathname; await page.goto(expected); await page.waitForSelector('[data-testid=annotation-source-content]', { timeout: 20000 }); await settled(); };
    const closeList = async () => { if (await page.evaluate(() => !!document.querySelector('[data-testid=annotation-list]'))) await page.keyboard.press('Escape'); };
    const count = () => page.evaluate(() => document.querySelector('[data-testid=annotation-summary]')?.textContent.match(/\d+/)?.[0] ?? '0');
    const openList = async () => { if (!await page.evaluate(() => !!document.querySelector('[data-testid=annotation-list]'))) await page.click('[data-testid=annotation-summary]'); };
    const clear = async () => {
        await closeList();
        const total = Number(await count());
        if (total) await openList();
        for (let i = 0; i < total; i++) await page.click('[data-testid=annotation-remove] >> nth=0');
        await page.fill('[data-testid=session-message-input]', '');
    };
    const select = async (phrase, occurrence = 0, mouse = false) => {
        await closeList();
        await page.evaluate(async ({ phrase, occurrence }) => {
            const root = document.querySelector('[data-testid=annotation-source-content]');
            const text = root.textContent;
            let start = -1;
            for (let i = 0; i <= occurrence; i++) start = text.indexOf(phrase, start + 1);
            if (start < 0) throw Error('Passage missing: ' + phrase);
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let n, offset = 0;
            while (n = walker.nextNode()) {
                if (start < offset + n.textContent.length) { n.parentElement.scrollIntoView({ block: 'center', inline: 'nearest' }); break; }
                offset += n.textContent.length;
            }
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }, { phrase, occurrence });
        await settled();
        const points = await page.evaluate(({ phrase, occurrence, mouse }) => {
            const root = document.querySelector('[data-testid=annotation-source-content]');
            const text = root.textContent; let start = -1;
            for (let i = 0; i <= occurrence; i++) start = text.indexOf(phrase, start + 1);
            const end = start + phrase.length, walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let n, pos = 0, a, b;
            while (n = walker.nextNode()) {
                const length = n.textContent.length;
                if (!a && start < pos + length) a = { node: n, offset: start - pos };
                if (end <= pos + length) { b = { node: n, offset: end - pos }; break; }
                pos += length;
            }
            const range = new Range(); range.setStart(a.node, a.offset); range.setEnd(b.node, b.offset);
            if (!mouse) { getSelection().removeAllRanges(); getSelection().addRange(range); root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return null; }
            const first = new Range(); first.setStart(a.node, a.offset); first.setEnd(a.node, a.offset + 1);
            const last = new Range(); last.setStart(b.node, b.offset - 1); last.setEnd(b.node, b.offset);
            return { a: first.getBoundingClientRect().toJSON(), b: last.getBoundingClientRect().toJSON() };
        }, { phrase, occurrence, mouse });
        if (mouse) { await page.mouse.move(points.a.x + 1, points.a.y + points.a.height / 2); await page.mouse.down(); await page.mouse.move(points.b.right - 1, points.b.y + points.b.height / 2, { steps: 14 }); await page.mouse.up(); }
        await page.waitForSelector('[data-testid=annotation-add]');
        await page.click('[data-testid=annotation-add]');
        await page.waitForSelector('[data-testid=annotation-comment-input]');
    };
    const save = async comment => { await page.fill('[data-testid=annotation-comment-input]', comment); await page.click('[data-testid=annotation-save]'); };
    const comments = async () => page.evaluate(() => [...document.querySelectorAll('[data-testid=annotation-saved-comment]')].map(e => e.textContent));
    const received = async () => { const response = await fetch(state.controllerUrl + '/messages'); assert(response.ok); return (await response.json()).filter(m => m?.role === 'user'); };
    const before = await received();
    await clear();
    await select('应用版本描述当前运行的是哪一份代码。', 0, true);
    await save('请用一个例子解释版本和环境的区别。');
    assert.equal(await count(), '1');
    assert(await page.evaluate(() => [...document.querySelectorAll('[data-testid=message-composer-send-button]')].some(e => e.getBoundingClientRect().width > 0 && e.getAttribute('aria-disabled') !== 'true')));
    passed('ANN-01 真实鼠标跨 Markdown 粗体选区，仅批注即可发送');
    await frame('第一条原文与评论已保存');
    await select('服务环境决定请求发往哪个 API。'); await save('这里切换环境会影响已有数据吗？');
    await select('先核对输入，再观察输出。', 1); await save('');
    await select('先核对输入，再观察输出。', 0); await save('这一句属于前一个位置。');
    assert.equal(await count(), '4');
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid=annotation-badge]').length), 4);
    passed('ANN-02 四条批注、可选空评论与相同原文的不同位置');
    await openList();
    await page.click('[data-testid=annotation-edit] >> nth=0');
    assert.equal(await page.evaluate(() => document.querySelector('[data-testid=annotation-comment-input]').value), '请用一个例子解释版本和环境的区别。');
    await frame('铅笔打开编辑器，原评论已回填');
    await save('请举例说明，同一个版本为什么能连接不同环境？');
    assert.equal(await count(), '4');
    await openList(); await page.click('[data-testid=annotation-edit] >> nth=0');
    await page.fill('[data-testid=annotation-comment-input]', '取消后不应该保存');
    await page.keyboard.press('Escape');
    await openList();
    assert((await comments()).includes('请举例说明，同一个版本为什么能连接不同环境？'));
    assert(!(await comments()).includes('取消后不应该保存'));
    passed('ANN-03 评论回填、保存同一条目、Escape 取消不覆盖');
    await page.click('[data-testid=annotation-remove] >> nth=3');
    assert.equal(await count(), '3');
    await closeList(); await page.reload(); await page.waitForSelector('[data-testid=annotation-summary]');
    assert.equal(await count(), '3');
    await openList(); assert((await comments()).includes('请举例说明，同一个版本为什么能连接不同环境？'));
    await frame('三条批注刷新后恢复，包含无评论的引用');
    passed('ANN-04 删除同步及刷新恢复');
    if (!config.record && config.captureMilestones !== false) await capture('真实页面：二次编辑、三条批注与刷新恢复');
    await goto('/session/' + state.sessionIds[1]); assert.equal(await count(), '0');
    await goto('/session/' + state.sessionIds[0]); assert.equal(await count(), '3');
    passed('ANN-05 会话 A→B→A 草稿隔离');
    await fetch(state.controllerUrl + '/activate', { method: 'POST' });
    await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        window.__annotationRestoreStorage = () => { Storage.prototype.setItem = original; };
        Storage.prototype.setItem = function (key, value) { if (key.includes('queue-v1')) throw new DOMException('Isolated E2E storage failure', 'QuotaExceededError'); return original.call(this, key, value); };
    });
    try {
        await page.click('[data-testid=message-composer-send-button] >> nth=-1');
        await page.waitForFunction(() => document.body.textContent.includes('重试'));
        assert.equal(await count(), '3');
        assert.equal((await received()).length, before.length);
        await page.click("loc=role:button[name='确定']");
    } finally { await page.evaluate(() => window.__annotationRestoreStorage?.()); }
    passed('ANN-06 实际暂存失败保留批注，服务端没有新增问题');
    await frame('失败后批注完整保留，可以再次提交');
    await page.fill('[data-testid=session-message-input]', '请按批注顺序回答，最后给出一个小结。');
    await fetch(state.controllerUrl + '/activate', { method: 'POST' });
    await page.click('[data-testid=message-composer-send-button] >> nth=-1');
    await page.waitForFunction(() => !document.querySelector('[data-testid=annotation-summary]') && !document.querySelector('[data-testid=message-staging-queue]') && document.querySelector('[data-testid=session-message-input]')?.value === '', undefined, { timeout: 20000 });
    const after = await received(); assert.equal(after.length, before.length + 1);
    const payload = after.at(-1).content.text;
    for (const text of ['应用版本描述当前运行的是哪一份代码。', '请举例说明，同一个版本为什么能连接不同环境？', '服务环境决定请求发往哪个 API。', '这里切换环境会影响已有数据吗？', '先核对输入，再观察输出。', '请解释这段内容。', '请按批注顺序回答，最后给出一个小结。']) assert(payload.includes(text), 'Missing submitted text: ' + text);
    assert(!payload.includes('取消后不应该保存'));
    assert(!payload.includes('这一句属于前一个位置。'));
    passed('ANN-07 真实 SessionView→暂存→加密→服务端，单次提交及原文/问题配对');
    await frame('真实服务端收到一条完整批量提问');
    if (!config.record && config.captureMilestones !== false) await capture('真实提交：服务端收到一条完整批量提问');
    // Prove annotation-only keyboard submission through the real composer, too.
    await select('构建阶段说明一次业务构建处于什么状态，例如准备、验证或发布。'); await save('请解释构建阶段。');
    await fetch(state.controllerUrl + '/activate', { method: 'POST' });
    await page.focus('[data-testid=session-message-input]'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('[data-testid=annotation-summary]') && !document.querySelector('[data-testid=message-staging-queue]'), undefined, { timeout: 20000 });
    const keyboard = await received(); assert.equal(keyboard.length, after.length + 1); assert(keyboard.at(-1).content.text.includes('请解释构建阶段。'));
    passed('ANN-08 仅批注时 Enter 提交');
    // Queue acceptance is final even when the later annotation cleanup fails.
    await select('服务环境决定请求发往哪个 API。'); await save('这一条只提交一次。');
    await page.fill('[data-testid=session-message-input]', '清理失败也不能重发这条已提交消息。');
    await fetch(state.controllerUrl + '/activate', { method: 'POST' });
    await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        window.__annotationRestoreStorage = () => { Storage.prototype.setItem = original; };
        Storage.prototype.setItem = function (key, value) { if (key.includes('message-annotation-v1:')) throw new DOMException('Isolated annotation cleanup failure', 'QuotaExceededError'); return original.call(this, key, value); };
    });
    try {
        await page.click('[data-testid=message-composer-send-button] >> nth=-1');
        await page.waitForFunction(() => document.body.textContent.includes('消息已提交，但本地批注清理失败。') && !document.querySelector('[data-testid=annotation-summary]') && !document.querySelector('[data-testid=message-staging-queue]') && document.querySelector('[data-testid=session-message-input]')?.value === '', undefined, { timeout: 20000 });
        const accepted = await received(); assert.equal(accepted.length, keyboard.length + 1);
        assert(accepted.at(-1).content.text.includes('这一条只提交一次。'));
        await frame('消息已提交：清理失败单独提示，当前草稿已退休，避免误导重试');
        await page.click("loc=role:button[name='确定']");
        await page.focus('[data-testid=session-message-input]'); await page.keyboard.press('Enter');
        assert.equal((await received()).length, accepted.length);
    } finally { await page.evaluate(() => window.__annotationRestoreStorage?.()); }
    // Verify the disclosed disk-failure boundary, then explicitly remove the old cache.
    await page.reload(); await page.waitForSelector('[data-testid=annotation-summary]');
    assert.equal(await count(), '1'); await clear();
    passed('ANN-11 消息已接受后清理失败不误报发送失败、不重复提交');
    // Theme selection is a real settings action, never a store or DOM-state injection.
    expected = state.webUrl + '/settings/appearance'; await page.goto(expected); await page.waitForSelector('[data-testid=appearance-theme-pack-gingham]');
    await page.click('[data-testid=appearance-theme-pack-gingham]');
    await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(18, 24, 33)');
    await goto('/session/' + state.sessionIds[0]);
    await select('应用版本描述当前运行的是哪一份代码。'); await save('深色主题下继续查看这条批注。');
    await openList();
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid=annotation-list]')).backgroundColor), 'rgb(26, 35, 48)');
    await page.hover('[data-testid=annotation-edit]');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid=annotation-edit]')).backgroundColor), 'rgb(31, 42, 56)');
    passed('ANN-09 Gingham 深色普通、hover 与原文高亮');
    await frame('非默认深色主题中的批注汇总');
    await page.click('[data-testid=annotation-edit]');
    await page.fill('[data-testid=annotation-comment-input]', '较长的评论：' + '请结合例子解释这一段的输入、过程与结果。'.repeat(25));
    await page.click('[data-testid=annotation-save]');
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await openList(); await page.click('[data-testid=annotation-edit]');
    const geometry = await page.evaluate(() => { const e = document.querySelector('[data-testid=annotation-editor]'), save = document.querySelector('[data-testid=annotation-save]'), input = document.querySelector('[data-testid=annotation-comment-input]');return { editor: e.getBoundingClientRect().toJSON(), save: save.getBoundingClientRect().toJSON(), input: input.getBoundingClientRect().toJSON(), width: innerWidth, height: innerHeight }; });
    assert(geometry.editor.left >= 0 && geometry.editor.right <= geometry.width && geometry.editor.bottom <= geometry.height);
    assert(geometry.save.right <= geometry.width && geometry.save.bottom <= geometry.height);
    assert(geometry.input.width > 200);
    await page.keyboard.press('Escape'); await openList();
    passed('ANN-10 390px 深色长评论、编辑器和保存按钮可达');
    if (!config.record) await capture('窄屏深色：长评论编辑与保存按钮边界通过');
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await closeList(); await openList(); await page.click('[data-testid=annotation-edit]'); await save('这条批注可以继续编辑，也可以统一提交。'); await openList();
    await frame('最终状态：真实 Happy 中可继续编辑的批注');
    if (config.record) await capture('最终验收：真实 Happy 批注与评论二次编辑');
    const report = { pass: true, mode, cases: results, frames, captures, serverUserMessagesBefore: before.length, serverUserMessagesAfter: (await received()).length, payload, scope: '完整真实页面、现有暂存与加密服务端提交；隔离账号与合成助手正文，无外部模型调用，无生产改动' };
    await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2));
    console.log({ pass: true, mode, cases: results.length, frames: frames.length, reportPath: join(output, 'result.json') });
    return report;
}
