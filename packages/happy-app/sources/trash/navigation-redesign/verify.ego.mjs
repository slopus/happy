import fs from 'node:fs/promises';
import path from 'node:path';

// Invoke from an Ego round with an already authenticated isolated App page.
// This records verified states, not a continuous interaction recording.
export async function verifyNavigationRedesign({ task, page, targetId, baseUrl, artifactsRoot, colorScheme }) {
    await fs.mkdir(artifactsRoot, { recursive: true });
    const output = await fs.mkdtemp(path.join(artifactsRoot, 'paws-navigation-'));
    const states = [];
    const frame = async (label, route) => {
        const expected = `${baseUrl}${route}`;
        const tab = (await task.tabs()).find(item => item.label === page.label);
        if (tab?.targetId !== targetId || await page.url() !== expected) throw new Error('Evidence page changed');
        if (route === '/projects') {
            await page.waitForFunction(() => {
                const root = document.querySelector('[data-testid="project-goals-workspace"]');
                if (!root) return false;
                const text = root.textContent ?? '';
                const resolved = root.querySelector('[role="alert"]') || text.includes('尚未发现 Goal First 项目') || text.includes('这台机器已离线');
                return resolved && !text.includes('正在读取这台机器的项目') && !text.includes('正在连接，连接后读取这台机器的项目');
            }, undefined, { timeout: 30000 });
        }
        await page.evaluate(async () => {
            await Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
        });
        const screenshot = await page.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const file = path.join(output, `state-${String(states.length).padStart(2, '0')}.png`);
        await fs.writeFile(file, Buffer.from(screenshot.data, 'base64'), { flag: 'wx' });
        states.push({ label, route, file });
    };
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.goto(`${baseUrl}/new`);
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    if (colorScheme) await page.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: colorScheme }] });
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="desktop-sidebar-tab-lists"]')].some(el => el.getBoundingClientRect().width > 0));
    if (await page.evaluate(() => document.querySelector('[data-testid="desktop-navigation-sidebar-button"]')?.getAttribute('aria-pressed') !== 'true')) {
        await page.click('loc=css:[data-testid="sidebar-session-list-button"]', { label: '固定会话导航' });
    }
    for (const [mode, label] of [['projects', '项目视图'], ['lists', '清单视图'], ['timeline', '时间线视图']]) {
        if (mode === 'projects') {
            await page.click('loc=css:[data-testid="sidebar-session-list-button"]', { label: '返回项目视图' });
            await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="desktop-sidebar-tab-lists"], [data-testid="desktop-sidebar-tab-timeline"]')].filter(el => el.getBoundingClientRect().width > 0).every(el => el.getAttribute('aria-pressed') === 'false'));
        } else {
            await page.click(`loc=css:[data-testid="desktop-sidebar-tab-${mode}"]`, { label: '切换侧栏视图' });
            await page.waitForFunction(id => [...document.querySelectorAll(`[data-testid="desktop-sidebar-tab-${id}"]`)].some(el => el.getBoundingClientRect().width > 0 && el.getAttribute('aria-pressed') === 'true'), mode);
        }
        await page.mouse.move(700, 400);
        await frame(label, '/new');
    }
    await page.mouse.move(600, 250);
    await page.hover('loc=css:[data-testid="desktop-sidebar-tab-timeline"]', { label: '查看时间线提示' });
    await page.waitForSelector('loc=css:[data-testid="desktop-sidebar-header-tooltip-timeline"]');
    await frame('时间线提示', '/new');
    await page.click('loc=css:[data-testid="desktop-sidebar-header-search"]', { label: '打开会话搜索' });
    await page.waitForSelector('loc=css:[data-testid="command-palette"]');
    await frame('会话搜索', '/new');
    await page.keyboard.press('Escape');
    await page.click('loc=css:[data-testid="desktop-navigation-sidebar-button"]', { label: '收起侧栏回收空间' });
    await page.mouse.move(600, 250);
    await page.waitForFunction(() => document.querySelector('[data-testid="desktop-secondary-navigation-column"]')?.getAttribute('data-sidebar-visible') === 'false');
    await frame('收起侧栏', '/new');
    await page.click('loc=css:[data-testid="sidebar-session-list-button"]', { label: '恢复并固定侧栏' });
    await page.waitForFunction(() => document.querySelector('[data-testid="desktop-navigation-sidebar-button"]')?.getAttribute('aria-pressed') === 'true');
    await page.mouse.move(700, 400);
    await frame('恢复侧栏', '/new');
    await page.click('loc=css:[data-testid="sidebar-project-goals-button"]', { label: '打开项目工作区' });
    await page.waitForURL(`${baseUrl}/projects`);
    await frame('项目工作区全局导航', '/projects');
    await page.click('loc=css:[data-testid="desktop-navigation-sidebar-button"]', { label: '展开项目会话侧栏' });
    await page.click('loc=css:[data-testid="desktop-navigation-zen-button"]', { label: '进入禅模式' });
    await page.click('loc=css:[data-testid="desktop-navigation-sidebar-button"]', { label: '恢复项目侧栏' });
    await page.waitForFunction(() => document.querySelector('[data-testid="desktop-navigation-sidebar-button"]')?.getAttribute('aria-pressed') === 'true');
    await frame('项目禅模式恢复', '/projects');
    await page.click('loc=css:[data-testid="desktop-navigation-back-button"]', { label: '返回新建页' });
    await page.waitForURL(`${baseUrl}/new`);
    await page.waitForFunction(() => !document.querySelector('[data-testid="desktop-navigation-forward-button"]')?.disabled);
    await frame('顶部返回', '/new');
    await page.click('loc=css:[data-testid="desktop-navigation-forward-button"]', { label: '前进恢复项目页' });
    await page.waitForURL(`${baseUrl}/projects`);
    await frame('顶部前进', '/projects');
    await fs.writeFile(path.join(output, 'states.json'), JSON.stringify(states, null, 2));
    return { output, states: states.map(({ label, route }) => ({ label, route })), status: 'pass', recording: 'verified-state-demonstration' };
}
