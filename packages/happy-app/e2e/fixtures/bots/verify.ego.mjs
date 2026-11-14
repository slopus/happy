import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Run inside ego-browser nodejs. The caller supplies the already-recorded space/target. */
export async function verifyBots({ taskSpace }, config) {
    const task = await taskSpace(config.taskSpaceId);
    const page = task.page(config.pageLabel);
    let expected = config.webOrigin + '/bots';
    const results = [], frames = [];
    await mkdir(config.artifactDirectory, { recursive: true });
    const verifyTarget = async () => {
        assert.equal(task.ownership, 'agent');
        assert.equal((await task.tabs()).find(tab => tab.label === config.pageLabel)?.targetId, config.targetId);
        assert.equal(await page.url(), expected);
    };
    const checkpoint = async label => {
        await verifyTarget();
        results.push(label);
        if (config.record) {
            await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.timeline instanceof DocumentTimeline && a.playState === 'running' && Number.isFinite(a.effect?.getTiming().iterations)).map(a => a.finished.catch(() => {}))));
            const tree = await page.cdp('Page.getFrameTree');
            const native = tree.frameTree.childFrames?.find(item => new URL(item.frame.url).origin === config.runtimeOrigin);
            if (native) {
                await page.cdp('Runtime.disable');
                await page.cdp('Runtime.enable');
                const context = (await page.events()).filter(event => event.method === 'Runtime.executionContextCreated')
                    .map(event => event.params.context).find(item => item.auxData?.isDefault && item.auxData.frameId === native.frame.id);
                assert(context, 'Native visual context missing');
                const result = await page.cdp('Runtime.evaluate', { contextId: context.id, awaitPromise: true, returnByValue: true,
                    expression: `Promise.all(document.getAnimations().filter(a => a.timeline instanceof DocumentTimeline && a.playState === 'running' && Number.isFinite(a.effect?.getTiming().iterations)).map(a => a.finished.catch(() => {}))).then(() => true)` });
                assert(!result.exceptionDetails, 'Native visual settling failed');
            }
            const bytes = await page.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 92, captureBeyondViewport: false });
            await verifyTarget();
            const file = path.join(config.artifactDirectory, `frame-${String(frames.length).padStart(2, '0')}.jpg`);
            await writeFile(file, Buffer.from(bytes.data, 'base64'));
            frames.push({ label, path: file, seconds: 2.2 });
        }
        console.log({ case: label, status: 'pass' });
    };
    const nativeReady = async () => {
        await page.waitForSelector('loc=css:textarea[name="chat-message"]', { state: 'visible', timeout: 45000 });
        assert((await page.snapshot()).includes('Message Paws'), 'Native chief must be selected');
    };
    const latest = async () => {
        const box = await page.evaluate(() => document.querySelector('[data-testid="bots-runtime-frame"]').getBoundingClientRect().toJSON());
        await page.mouse.move(box.x + box.width * 0.72, box.y + box.height * 0.4);
        await page.mouse.wheel(0, 10_000, { label: '查看最新 Bot 回复' });
    };
    await verifyTarget();
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await nativeReady();
    await latest();
    const rail = await page.evaluate(() => ({
        first: [...document.querySelectorAll('[data-testid="desktop-navigation-rail"] button')].slice(0, 2).map(node => node.getAttribute('data-testid')),
        width: document.querySelector('[data-testid="desktop-left-sidebar"]').getBoundingClientRect().width,
        selected: document.querySelector('[data-testid="sidebar-bots-button"]').getAttribute('aria-pressed'),
    }));
    assert.deepEqual(rail.first, ['sidebar-session-list-button', 'sidebar-bots-button']);
    assert.equal(rail.width, 60); assert.equal(rail.selected, 'true');
    await checkpoint('B1 首页下方Bots入口与独立原生工作区');

    const marker = config.replyMarker;
    assert(/^[A-Z0-9-]{8,60}$/.test(marker));
    await page.fill('loc=css:textarea[name="chat-message"]', `只回复以下标记：${marker}。不要调用工具，不要修改资料。`);
    await page.click('loc=css:button[aria-label="Send"]');
    await page.waitForSelector(`loc=css:p:text-is("${marker}")`, { state: 'visible', timeout: 90000 });
    await page.waitForSelector('loc=css:button[aria-label="Stop"]', { state: 'hidden', timeout: 45000 });
    await latest();
    await checkpoint('B2 本地GPT真实回复并结束运行');

    await page.fill('loc=css:textarea[name="chat-message"]', '@');
    await page.waitForSelector('loc=css:button[aria-label="@Paws"]', { state: 'visible', timeout: 10000 });
    assert((await page.snapshot()).includes('@' + config.otherBotName));
    await checkpoint('B3 原生@选择器包含chief与第二Bot');
    await page.fill('loc=css:textarea[name="chat-message"]', '');

    await page.click('[data-testid="sidebar-session-list-button"]');
    expected = config.webOrigin + '/';
    await page.waitForURL(expected);
    const home = await page.evaluate(() => ({
        frames: document.querySelectorAll('[data-testid="bots-runtime-frame"]').length,
        width: document.querySelector('[data-testid="desktop-left-sidebar"]').getBoundingClientRect().width,
    }));
    assert.equal(home.frames, 0); assert(home.width > 60);
    await checkpoint('B4 返回首页卸载Bots并恢复原侧栏');
    await page.click('[data-testid="sidebar-bots-button"]');
    expected = config.webOrigin + '/bots';
    await page.waitForURL(expected); await nativeReady();
    await page.waitForSelector(`loc=css:p:text-is("${marker}")`, { state: 'visible', timeout: 30000 });
    await latest();
    await checkpoint('B5 返回Bots恢复真实持久化历史');

    await page.reload(); await nativeReady();
    await page.waitForSelector(`loc=css:p:text-is("${marker}")`, { state: 'visible', timeout: 30000 });
    await latest();
    await checkpoint('B6 完整刷新后恢复相同chief与回复');

    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
    const layout = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth,
        frame: document.querySelector('[data-testid="bots-runtime-frame"]').getBoundingClientRect().toJSON() }));
    assert(layout.scroll <= layout.viewport + 1); assert(layout.frame.width > 700);
    await latest();
    await checkpoint('B7 窄桌面仍保留完整Bots工作区');
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await verifyTarget();
    const report = { results, frames, record: Boolean(config.record), model: 'real local GPT gateway',
        computers: 'disabled; not tested', nativeDevices: 'not tested', production: false };
    await writeFile(path.join(config.artifactDirectory, 'report.json'), JSON.stringify(report, null, 2));
    return report;
}
