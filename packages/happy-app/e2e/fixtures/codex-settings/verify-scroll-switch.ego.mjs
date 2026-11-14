import assert from 'node:assert/strict';

// Call from Ego with this fixture's Page and private runtime/seed JSON.
export async function verifyScrollSwitch({ page, runtime, seed, onState = async () => {} }) {
    const [a, b] = seed.sessions;
    const route = session => `${runtime.webUrl}/session/${session.id}`;
    const metrics = () => page.evaluate(() => {
        const node = document.querySelector('[data-testid="conversation-transcript-list"]');
        let fiber = node[Object.keys(node).find(key => key.startsWith('__reactFiber$'))];
        let data;
        for (let i = 0; fiber && i < 35; i++, fiber = fiber.return) {
            if (Array.isArray(fiber.memoizedProps?.data)) { data = fiber.memoizedProps.data; break; }
        }
        const viewport = node.getBoundingClientRect();
        const visible = [...node.querySelectorAll('[data-transcript-key]')].find(row => {
            const rect = row.getBoundingClientRect();
            return rect.bottom > viewport.top && rect.top < viewport.bottom;
        });
        return { offset: node.scrollTop, bottom: node.scrollHeight - node.clientHeight - node.scrollTop,
            height: node.scrollHeight, viewport: node.clientHeight, wheel: window.__scrollSwitchWheel,
            latestId: data?.at(-1)?.id, visibleKey: visible?.dataset.transcriptKey,
            visibleTop: visible ? visible.getBoundingClientRect().top - viewport.top : null, url: location.href };
    });
    const latest = async session => {
        await page.waitForURL(route(session));
        await page.waitForFunction(text => {
            const node = document.querySelector('[data-testid="conversation-transcript-list"]');
            return node && node.innerText.includes(text) && node.scrollHeight - node.clientHeight - node.scrollTop < 30;
        }, session.latest, { timeout: 30000 });
        return metrics();
    };
    const wheel = async () => {
        const point = await page.evaluate(() => {
            const rect = document.querySelector('[data-testid="conversation-transcript-list"]').getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        });
        await page.mouse.move(point.x, point.y);
        await page.mouse.wheel(0, -1400, { label: '向上阅读历史消息' });
        await page.waitForFunction(() => {
            const node = document.querySelector('[data-testid="conversation-transcript-list"]');
            return node.scrollHeight - node.clientHeight - node.scrollTop > 500;
        });
        // Wait for the existing 250ms reading-state capture, not a business poll.
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 450)));
        return metrics();
    };
    const report = [];
    await page.goto(route(a));
    await latest(a);
    await page.evaluate(() => {
        window.__scrollSwitchWheel = 0;
        document.addEventListener('wheel', event => {
            if (event.target.closest('[data-testid="conversation-transcript-list"]')) window.__scrollSwitchWheel++;
        }, { passive: true });
    });
    const reading = await wheel();
    await onState('A 阅读历史', reading);
    await page.click(`loc=role:button[name*="${b.name},"]`);
    const bLatest = await latest(b);
    await onState('切换 B 显示最新', bLatest);
    await page.click(`loc=role:button[name*="${a.name},"]`);
    const aLatest = await latest(a);
    await onState('切回 A 显示最新', aLatest);
    assert.equal(aLatest.wheel, reading.wheel);
    assert.equal(bLatest.wheel, reading.wheel);
    report.push({ case: 'SWITCH-LATEST', pass: true, reading, bLatest, aLatest });

    const before = await wheel();
    const response = await fetch(`${seed.controllerUrl}/append`, { method: 'POST' });
    assert(response.ok);
    // A new offscreen row need not mount in a virtualized DOM. Wait for the
    // actual transcript data to commit, then compare the viewport geometry.
    await page.waitForFunction(previousId => {
        const node = document.querySelector('[data-testid="conversation-transcript-list"]');
        let fiber = node[Object.keys(node).find(key => key.startsWith('__reactFiber$'))];
        for (let i = 0; fiber && i < 35; i++, fiber = fiber.return) {
            const data = fiber.memoizedProps?.data;
            if (Array.isArray(data)) return data.at(-1)?.id !== previousId;
        }
        return false;
    }, before.latestId, { timeout: 30000 });
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 350)));
    const after = await metrics();
    assert(Math.abs(after.offset - before.offset) < 2);
    assert(after.bottom > 500);
    report.push({ case: 'USER-READING', pass: true, before, after });
    await onState('新增回复保留历史位置', after);

    await page.click('loc=role:button[name="会话详情"]');
    await page.waitForSelector('text=运行位置');
    await page.click('button[aria-label="会话详情"] >> nth=1');
    await page.waitForURL(`${route(a)}/info`);
    await page.evaluate(() => history.back());
    await page.waitForURL(route(a));
    await page.waitForSelector('[data-testid="conversation-transcript-list"]');
    await page.waitForFunction(({ key, top }) => {
        const node = document.querySelector('[data-testid="conversation-transcript-list"]');
        const row = [...node.querySelectorAll('[data-transcript-key]')].find(row => row.dataset.transcriptKey === key);
        return row && Math.abs(row.getBoundingClientRect().top - node.getBoundingClientRect().top - top) < 2;
    }, { key: after.visibleKey, top: after.visibleTop }, { timeout: 30000 });
    const returned = await metrics();
    assert.equal(returned.visibleKey, after.visibleKey);
    assert(Math.abs(returned.visibleTop - after.visibleTop) < 2, JSON.stringify({ after, returned }));
    report.push({ case: 'DETAIL-RETURN', pass: true, before: after, returned });
    await onState('详情返回保留阅读位置', returned);

    await page.reload();
    const reloaded = await latest(a);
    report.push({ case: 'RELOAD-LATEST', pass: true, reloaded });
    await onState('刷新显示最新', reloaded);
    return report;
}
