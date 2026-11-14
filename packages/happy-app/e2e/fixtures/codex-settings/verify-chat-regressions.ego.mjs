import assert from 'node:assert/strict';

/** Run only inside the recorded Ego Page on the isolated synthetic account. */
export async function verifyChatRegressions({ page, runtime, seed, controller, onState = async () => {} }) {
    const [a, b] = seed.sessions;
    const route = session => `${runtime.webUrl}/session/${session.id}`;
    const post = async (action, body = {}) => {
        const result = await fetch(`${controller.controllerUrl}/${action}`, { method: 'POST', body: JSON.stringify(body) });
        assert(result.ok, `fixture ${action}: ${result.status}`);
        return result.json();
    };
    const bottom = async () => {
        await page.waitForFunction(() => {
            const n = document.querySelector('[data-testid="conversation-transcript-list"]');
            return n && n.scrollHeight - n.clientHeight - n.scrollTop <= 1;
        }, undefined, { timeout: 10000 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        return metrics();
    };
    const metrics = () => page.evaluate(() => {
        const n = document.querySelector('[data-testid="conversation-transcript-list"]');
        return { bottom: n.scrollHeight - n.clientHeight - n.scrollTop, offset: n.scrollTop, height: n.scrollHeight,
            viewport: n.clientHeight, wheel: window.__chatRegressionWheel || 0, url: location.href };
    });
    const report = [];
    await page.goto(route(a)); await bottom();
    await page.evaluate(() => {
        window.__chatRegressionWheel = 0; window.__chatRegressionFrames = []; window.__chatRegressionSample = true;
        document.addEventListener('wheel', event => { if (event.target.closest('[data-testid="conversation-transcript-list"]')) window.__chatRegressionWheel++; }, { passive: true });
        const measure = () => {
            const n = document.querySelector('[data-testid="conversation-transcript-list"]');
            return n ? { at: performance.now(), route: location.pathname,
                bottom: n.scrollHeight - n.clientHeight - n.scrollTop, tail: n.innerText.slice(-60) } : null;
        };
        function sample() {
            // rAF runs before ResizeObserver and paint. A geometry read there
            // can itself discover a reflow; record that diagnostic separately.
            // The next task observes the completed layout/RO phase instead of
            // labelling its temporary pre-RO distance a painted regression.
            const beforeLayout = measure();
            setTimeout(() => {
                const frame = measure();
                if (frame) window.__chatRegressionFrames.push({ ...frame, beforeLayout });
                if (window.__chatRegressionSample) requestAnimationFrame(sample);
            }, 0);
        }
        requestAnimationFrame(sample);
    });
    for (const session of [b, a, b, a]) {
        await page.click(`loc=role:button[name*="${session.name},"]`);
        await page.waitForURL(route(session)); await bottom();
    }
    const frames = await page.evaluate(() => { window.__chatRegressionSample = false; return window.__chatRegressionFrames; });
    assert.equal((await metrics()).wheel, 0);
    assert.deepEqual(frames.filter(frame => frame.bottom > 2), [], 'session switch painted a nonlatest position');
    report.push({ case: 'SWITCH-FRAMES', pass: true, frames });
    await onState('四次切换均直接到最新', await metrics());

    // The same stream item grows without changing any durable message ID.
    let text = `流式跟随验收 ${Date.now()}`;
    const sizes = [];
    for (let i = 1; i <= 5; i++) {
        text += `\n\n第 ${i} 段：${'连续输出保持自动跟随。'.repeat(25)}`;
        await post('stream', { text });
        await page.waitForFunction(value => document.querySelector('[data-testid="conversation-transcript-list"]')?.innerText.includes(value), `第 ${i} 段：`);
        sizes.push(await bottom());
    }
    assert(sizes.at(-1).height > sizes[0].height);
    assert.equal((await metrics()).wheel, 0);
    report.push({ case: 'STREAM-FOLLOW', pass: true, sizes });
    await onState('流式输出自动跟随', await metrics());

    const point = await page.evaluate(() => { const r = document.querySelector('[data-testid="conversation-transcript-list"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, -700, { label: '上翻阅读暂停跟随' });
    await page.waitForFunction(() => { const n = document.querySelector('[data-testid="conversation-transcript-list"]'); return n.scrollHeight - n.clientHeight - n.scrollTop > 300; });
    // Wheel input may finish dispatching before Chromium's last smooth-scroll
    // frame. Wait for its scroll events to settle before taking the baseline.
    await page.evaluate(() => new Promise(resolve => {
        const node = document.querySelector('[data-testid="conversation-transcript-list"]');
        let quiet; const finish = () => { clearTimeout(quiet); clearTimeout(deadline); node.removeEventListener('scroll', changed); resolve(); };
        const changed = () => { clearTimeout(quiet); quiet = setTimeout(finish, 150); };
        const deadline = setTimeout(finish, 2000); node.addEventListener('scroll', changed, { passive: true }); changed();
    }));
    const before = await metrics();
    text += `\n\n上翻后新增：${'这段输出应保留阅读位置。'.repeat(20)}`;
    await post('stream', { text });
    await page.waitForFunction(() => document.querySelector('[data-testid="conversation-transcript-list"]')?.innerText.includes('上翻后新增：'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after = await metrics();
    assert(Math.abs(after.offset - before.offset) < 2, JSON.stringify({ before, after }));
    report.push({ case: 'READING-PAUSE', pass: true, before, after });
    await onState('主动阅读时保留位置', after);
    // Explicit session navigation restores latest; reload also clears ephemeral stream.
    await page.click(`loc=role:button[name*="${b.name},"]`); await page.waitForURL(route(b));
    await page.click(`loc=role:button[name*="${a.name},"]`); await page.waitForURL(route(a));
    await page.reload(); await bottom();

    const label = `持久卡片 ${Date.now()}`;
    await post('question', { label }); await page.waitForSelector('[data-testid="question-option-1"]'); await bottom();
    await page.click('[data-testid="question-option-1"]'); await page.click('[data-testid="question-send"]');
    await page.waitForFunction(value => [...document.querySelectorAll('[data-testid="markdown-question-card"]')].some(n => n.innerText.includes(value) && n.innerText.includes('已回答')), label);
    await page.click(`loc=role:button[name*="${b.name},"]`); await page.waitForURL(route(b));
    await page.click(`loc=role:button[name*="${a.name},"]`); await page.waitForURL(route(a));
    await page.reload(); await bottom();
    await page.waitForFunction(value => [...document.querySelectorAll('[data-testid="markdown-question-card"]')].some(n => n.innerText.includes(value) && n.innerText.includes('已回答') && !n.querySelector('[role="radio"],textarea,button')), label);
    report.push({ case: 'ANSWER-PERSISTENCE', pass: true });
    await onState('已回答卡片刷新后只读', await metrics());

    const skipped = `跳过卡片 ${Date.now()}`;
    await post('question', { label: skipped }); await page.waitForSelector('[data-testid="question-skip"]'); await bottom();
    await page.click('[data-testid="question-skip"]');
    await page.waitForFunction(value => [...document.querySelectorAll('[data-testid="markdown-question-card"]')].some(n => n.innerText.includes(value) && n.innerText.includes('已跳过')), skipped);
    await page.reload(); await bottom();
    await page.waitForFunction(value => [...document.querySelectorAll('[data-testid="markdown-question-card"]')].some(n => n.innerText.includes(value) && n.innerText.includes('已跳过') && !n.querySelector('[role="radio"],textarea,button')), skipped);
    report.push({ case: 'SKIP-PERSISTENCE', pass: true });
    await onState('已跳过卡片刷新后只读', await metrics());

    const legacy = `旧历史卡片 ${Date.now()}`;
    await post('question', { label: legacy }); await page.waitForSelector('[data-testid="question-send"]');
    await post('text', { role: 'user', text: '从普通输入框回复的历史答案' });
    await page.reload(); await bottom();
    await page.waitForFunction(value => [...document.querySelectorAll('[data-testid="markdown-question-card"]')].some(n => n.innerText.includes(value) && n.innerText.includes('已回答') && !n.querySelector('[role="radio"],textarea,button')), legacy);
    report.push({ case: 'LEGACY-ANSWER', pass: true });
    await onState('旧历史回复也锁定卡片', await metrics());
    await post('tool');
    await page.waitForSelector('[data-testid="terminal-failure-summary"]');
    await bottom();
    await page.reload(); await bottom();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="terminal-failure-summary"]')].some(n => n.innerText.includes('ls: /fixture/missing: No such file or directory')));
    report.push({ case: 'TOOL-DIAGNOSTIC', pass: true });
    await onState('混合命令保留终端失败和具体诊断', await metrics());
    return report;
}
