import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const evidenceDir = process.env.HAPPY_RELATIONSHIP_ADVISOR_EVIDENCE_DIR
    ?? path.resolve('test-results/relationship-advisor-evidence');

const redImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAF0lEQVR4nGP8x0AaYCFR/aiGUQ1DSAMAaw8BPJLkRBUAAAAASUVORK5CYII=';

async function installPrivacyGuards(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const install = () => {
            if (document.getElementById('advisor-e2e-privacy-style')) return;
            const style = document.createElement('style');
            style.id = 'advisor-e2e-privacy-style';
            style.textContent = `
                [data-testid="sidebar-account-footer"],
                [data-testid^="session-row-"],
                [data-testid^="agent-sheet-agent-"] {
                    filter: blur(16px) !important;
                }
            `;
            document.documentElement.appendChild(style);

            const curtain = document.createElement('div');
            curtain.id = 'advisor-e2e-privacy-curtain';
            Object.assign(curtain.style, {
                position: 'fixed',
                inset: '0',
                background: '#111827',
                zIndex: '2147483647',
                pointerEvents: 'none',
            });
            document.documentElement.appendChild(curtain);

            const historyMask = document.createElement('div');
            historyMask.id = 'advisor-e2e-history-mask';
            Object.assign(historyMask.style, {
                position: 'fixed',
                background: '#111827',
                zIndex: '2147483646',
                pointerEvents: 'none',
                display: 'none',
            });
            document.documentElement.appendChild(historyMask);

            const updateHistoryMask = () => {
                const topAnchor = document.querySelector('[data-testid="sidebar-command-palette-button"]');
                const bottomAnchor = document.querySelector('[data-testid="sidebar-secondary-navigation"]');
                if (!(topAnchor instanceof HTMLElement) || !(bottomAnchor instanceof HTMLElement)) {
                    historyMask.style.display = 'none';
                    return;
                }
                const top = topAnchor.getBoundingClientRect();
                const bottom = bottomAnchor.getBoundingClientRect();
                if (bottom.width <= 0 || bottom.right <= 0 || bottom.left >= window.innerWidth) {
                    historyMask.style.display = 'none';
                    return;
                }
                const maskTop = Math.ceil(top.bottom + 2);
                const maskBottom = Math.floor(bottom.top - 2);
                if (maskBottom <= maskTop) {
                    historyMask.style.display = 'none';
                    return;
                }
                Object.assign(historyMask.style, {
                    display: 'block',
                    left: `${Math.max(0, Math.floor(bottom.left))}px`,
                    top: `${maskTop}px`,
                    width: `${Math.ceil(bottom.width)}px`,
                    height: `${maskBottom - maskTop}px`,
                });
            };
            updateHistoryMask();
            new MutationObserver(updateHistoryMask).observe(document.documentElement, {
                childList: true,
                subtree: true,
            });
            window.addEventListener('resize', updateHistoryMask);
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', install, { once: true });
        } else {
            install();
        }
    });
}

async function dismissPrivacyCurtain(page: Page): Promise<void> {
    await page.waitForFunction(() => {
        const curtain = document.getElementById('advisor-e2e-privacy-curtain');
        if (!curtain) return true;
        curtain.remove();
        return !document.getElementById('advisor-e2e-privacy-curtain');
    }, undefined, { timeout: 90_000 });
}

async function showStep(page: Page, label: string, holdMs = 800): Promise<void> {
    await page.evaluate(({ text }) => {
        document.getElementById('advisor-e2e-step')?.remove();
        const badge = document.createElement('div');
        badge.id = 'advisor-e2e-step';
        badge.textContent = text;
        Object.assign(badge.style, {
            position: 'fixed',
            right: '12px',
            top: '12px',
            zIndex: '2147483645',
            maxWidth: 'calc(100vw - 80px)',
            padding: '7px 10px',
            borderRadius: '6px',
            background: 'rgba(17, 24, 39, 0.92)',
            color: '#fff',
            font: '600 12px/16px system-ui, sans-serif',
            pointerEvents: 'none',
        });
        document.documentElement.appendChild(badge);
    }, { text: label });
    await page.waitForTimeout(holdMs);
}

async function clearConversation(page: Page): Promise<void> {
    console.log('[advisor-e2e] 检查并清理旧对话');
    const clearButton = page.getByTestId('relationship-advisor-clear-button');
    await expect(clearButton).toBeVisible();
    if (!await clearButton.isEnabled()) {
        console.log('[advisor-e2e] 当前已是空对话');
        return;
    }
    await clearButton.click();
    await expect(page.getByText(/清空这段对话|Clear this conversation/i)).toBeVisible();
    await page.getByRole('button', { name: /^(清空|Clear)$/i }).click();
    await expect(page.getByTestId('relationship-advisor-empty-state')).toBeVisible();
    console.log('[advisor-e2e] 旧对话已清理');
}

async function attachImage(page: Page, screen: Locator, imagePath: string): Promise<void> {
    console.log('[advisor-e2e] 打开图片选择器');
    const chooser = page.waitForEvent('filechooser', { timeout: 15_000 });
    await screen.getByRole('button', { name: /添加附件|Add attachment/i }).click({ timeout: 15_000 });
    await (await chooser).setFiles(imagePath);
    await expect(screen.getByTestId('message-composer-send-button')).toBeEnabled();
    console.log('[advisor-e2e] 测试图片已加入输入区');
}

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
    await page.screenshot({
        path: path.join(evidenceDir, name),
        fullPage: false,
    });
    await testInfo.attach(name, {
        path: path.join(evidenceDir, name),
        contentType: 'image/png',
    });
}

async function clickWithRealMouse(page: Page, locator: Locator): Promise<void> {
    const box = await locator.boundingBox({ timeout: 30_000 });
    if (!box) throw new Error('Expected a visible click target');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function armStreamingProbe(page: Page): Promise<void> {
    await page.evaluate(() => {
        type Probe = {
            startedAt: number;
            requestStartedAt: number | null;
            baselineUserCount: number;
            firstTokenAt: number | null;
            samples: string[];
            sawFormattedStrong: boolean;
            sawRawMarkdownMarker: boolean;
            observer?: MutationObserver;
        };
        const target = window as typeof window & { __advisorE2EStreamingProbe?: Probe };
        target.__advisorE2EStreamingProbe?.observer?.disconnect();
        const probe: Probe = {
            startedAt: performance.now(),
            requestStartedAt: null,
            baselineUserCount: document.querySelectorAll(
                '[data-testid="relationship-advisor-message-user"]',
            ).length,
            firstTokenAt: null,
            samples: [],
            sawFormattedStrong: false,
            sawRawMarkdownMarker: false,
        };
        const sample = () => {
            const userCount = document.querySelectorAll(
                '[data-testid="relationship-advisor-message-user"]',
            ).length;
            if (userCount > probe.baselineUserCount) {
                probe.requestStartedAt ??= performance.now();
            }
            const node = document.querySelector('[data-testid="relationship-advisor-streaming-text"]');
            const text = node?.textContent?.trim() ?? '';
            probe.sawFormattedStrong ||= Array.from(node?.querySelectorAll('*') ?? []).some((element) => {
                const weight = window.getComputedStyle(element).fontWeight;
                return weight === 'bold' || Number.parseInt(weight, 10) >= 600;
            });
            probe.sawRawMarkdownMarker ||= text.includes('**');
            if (!text || probe.samples.at(-1) === text) return;
            probe.samples.push(text);
            probe.firstTokenAt ??= performance.now();
        };
        probe.observer = new MutationObserver(sample);
        probe.observer.observe(document.body, { childList: true, characterData: true, subtree: true });
        target.__advisorE2EStreamingProbe = probe;
        sample();
    });
}

async function waitForFirstStreamToken(page: Page, timeout = 15_000): Promise<number> {
    await expect.poll(async () => page.evaluate(() => {
        const probe = (window as typeof window & {
            __advisorE2EStreamingProbe?: { firstTokenAt: number | null };
        }).__advisorE2EStreamingProbe;
        return probe?.firstTokenAt ?? null;
    }), { timeout }).not.toBeNull();

    return page.evaluate(() => {
        const probe = (window as typeof window & {
            __advisorE2EStreamingProbe?: {
                startedAt: number;
                requestStartedAt: number | null;
                firstTokenAt: number | null;
            };
        }).__advisorE2EStreamingProbe;
        if (!probe?.firstTokenAt) throw new Error('Streaming probe did not record a first token');
        return Math.round(probe.firstTokenAt - (probe.requestStartedAt ?? probe.startedAt));
    });
}

async function waitForInitialStreamOrError(page: Page, timeout = 20_000): Promise<'token' | 'error' | 'complete'> {
    let state: 'waiting' | 'token' | 'error' | 'complete' = 'waiting';
    await expect.poll(async () => {
        const hasToken = await page.evaluate(() => Boolean(
            (window as typeof window & {
                __advisorE2EStreamingProbe?: { firstTokenAt: number | null };
            }).__advisorE2EStreamingProbe?.firstTokenAt,
        ));
        const hasError = await page.getByTestId('relationship-advisor-error').isVisible();
        const completed = await page.getByTestId('relationship-advisor-message-assistant').count() >= 1;
        state = completed ? 'complete' : hasToken ? 'token' : hasError ? 'error' : 'waiting';
        return state;
    }, { timeout }).not.toBe('waiting');
    return state as 'token' | 'error' | 'complete';
}

async function streamingSampleCount(page: Page): Promise<number> {
    return page.evaluate(() => (
        (window as typeof window & {
            __advisorE2EStreamingProbe?: { samples: string[] };
        }).__advisorE2EStreamingProbe?.samples.length ?? 0
    ));
}

async function streamingMarkdownProbe(page: Page): Promise<{
    sawFormattedStrong: boolean;
    sawRawMarkdownMarker: boolean;
}> {
    return page.evaluate(() => {
        const probe = (window as typeof window & {
            __advisorE2EStreamingProbe?: {
                sawFormattedStrong: boolean;
                sawRawMarkdownMarker: boolean;
            };
        }).__advisorE2EStreamingProbe;
        return {
            sawFormattedStrong: probe?.sawFormattedStrong ?? false,
            sawRawMarkdownMarker: probe?.sawRawMarkdownMarker ?? false,
        };
    });
}

async function elapsedSinceRequestStarted(page: Page): Promise<number> {
    return page.evaluate(() => {
        const probe = (window as typeof window & {
            __advisorE2EStreamingProbe?: { startedAt: number; requestStartedAt: number | null };
        }).__advisorE2EStreamingProbe;
        const startedAt = probe?.requestStartedAt ?? probe?.startedAt;
        return startedAt === undefined ? 0 : Math.round(performance.now() - startedAt);
    });
}

test.use({ trace: 'off', locale: 'zh-CN' });

test('狗头军师 Mobile Web 真实文本、图片、停止、重试与本地历史链路', async ({ page, context }, testInfo) => {
    test.setTimeout(8 * 60_000);
    const markdownOnly = process.env.HAPPY_RELATIONSHIP_ADVISOR_MARKDOWN_ONLY === '1';
    await mkdir(evidenceDir, { recursive: true });
    const imagePath = path.join(evidenceDir, 'fixture-red-16x16.png');
    const imageBytes = Buffer.from(redImageBase64, 'base64');
    expect(imageBytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(imageBytes.subarray(-8).toString('hex')).toBe('49454e44ae426082');
    await writeFile(imagePath, imageBytes);

    const browserErrors: string[] = [];
    const advisorResponses: Array<{ status: number; pathname: string }> = [];
    const uploadDiagnostics: Array<{
        kind: 'response' | 'failure';
        method: string;
        target: string;
        status?: number;
        error?: string;
    }> = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    page.on('response', (response) => {
        const url = new URL(response.url());
        if (url.pathname.includes('/relationship-advisor/')) {
            advisorResponses.push({ status: response.status(), pathname: url.pathname });
        }
        if (url.hostname.endsWith('.aliyuncs.com') && ['POST', 'PUT'].includes(response.request().method())) {
            const diagnostic = {
                kind: 'response' as const,
                method: response.request().method(),
                target: `${url.origin}${url.pathname}`,
                status: response.status(),
            };
            uploadDiagnostics.push(diagnostic);
            console.log(`[advisor-e2e] OSS response ${diagnostic.method} ${diagnostic.status} ${diagnostic.target}`);
        }
    });
    page.on('requestfailed', (request) => {
        const url = new URL(request.url());
        if (!url.hostname.endsWith('.aliyuncs.com') || !['POST', 'PUT'].includes(request.method())) return;
        const diagnostic = {
            kind: 'failure' as const,
            method: request.method(),
            target: `${url.origin}${url.pathname}`,
            error: request.failure()?.errorText ?? 'unknown',
        };
        uploadDiagnostics.push(diagnostic);
        console.log(`[advisor-e2e] OSS failure ${diagnostic.method} ${diagnostic.error} ${diagnostic.target}`);
    });

    await installPrivacyGuards(page);

    // Sanitize any prior advisor transcript before evidence capture.
    console.log('[advisor-e2e] 打开隐藏的清理页面');
    await page.goto('/relationship-advisor', { waitUntil: 'domcontentloaded' });
    console.log('[advisor-e2e] 清理页面 DOM 已加载');
    await expect(page.getByTestId('relationship-advisor-screen')).toBeVisible({ timeout: 90_000 });
    console.log('[advisor-e2e] 狗头军师页面已渲染');
    await clearConversation(page);

    // Exercise the user-visible entry instead of treating the route as the feature proof.
    console.log('[advisor-e2e] 返回首页准备真实入口');
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    console.log('[advisor-e2e] 首页 DOM 已加载');
    await expect(page.getByTestId('compose-home-drawer-button')).toBeVisible({ timeout: 90_000 });
    console.log('[advisor-e2e] 首页已就绪，开始证据段');
    await dismissPrivacyCurtain(page);
    await showStep(page, markdownOnly
        ? '1 / 3  从「我的 Agent」进入狗头军师'
        : '1 / 7  从「我的 Agent」进入狗头军师');
    console.log('[advisor-e2e] 打开手机侧栏');
    await clickWithRealMouse(page, page.getByTestId('compose-home-drawer-button'));
    const myAgentsButton = page.getByTestId('sidebar-my-agents-button');
    await expect(myAgentsButton).toBeVisible({ timeout: 15_000 });
    console.log('[advisor-e2e] 打开我的 Agent');
    await myAgentsButton.click();
    const advisorEntry = page.getByTestId('agent-sheet-relationship-advisor');
    await expect(advisorEntry).toBeVisible({ timeout: 15_000 });
    console.log('[advisor-e2e] 点击狗头军师');
    await advisorEntry.click();

    await expect(page).toHaveURL(/\/relationship-advisor$/);
    await expect(page.getByTestId('relationship-advisor-empty-state')).toBeVisible();
    await showStep(page, markdownOnly ? '2 / 3  空态与输入区就绪' : '2 / 7  空态与输入区就绪');
    await screenshot(page, testInfo, '01-empty-state-mobile-web.png');

    const advisorScreen = page.locator('[data-testid="relationship-advisor-screen"]:visible');
    const input = advisorScreen.getByTestId('new-session-message-input');
    const sendButton = advisorScreen.getByTestId('message-composer-send-button');
    const textPrompt = '请严格以 **流式 Markdown 验证** 作为第一行，然后分析这个真实场景：她说“最近有点忙，晚点再聊”，我不想显得催。请给我自然、轻松、克制三种可直接发送的回复，并逐句说明差别。';
    console.log('[advisor-e2e] 输入真实文本场景');
    await input.fill(textPrompt, { timeout: 15_000 });
    await armStreamingProbe(page);
    console.log('[advisor-e2e] 发送真实文本场景');
    await sendButton.click({ timeout: 15_000 });
    await expect(page.getByTestId('relationship-advisor-message-user')).toContainText('最近有点忙');
    console.log('[advisor-e2e] 用户文本已进入消息区，等待首字');
    const streaming = page.getByTestId('relationship-advisor-streaming-text');
    let initialState = await waitForInitialStreamOrError(page);
    if (initialState === 'error') {
        console.log('[advisor-e2e] 首次文本请求临时失败，通过真实重试按钮再试一次');
        await armStreamingProbe(page);
        await page.getByTestId('relationship-advisor-retry-button').click();
        initialState = await waitForInitialStreamOrError(page);
        expect(initialState, '文本请求重试后仍未开始流式响应').not.toBe('error');
    }
    const firstTokenMs = await waitForFirstStreamToken(page);
    console.log(`[advisor-e2e] 文本首字 ${firstTokenMs}ms`);
    const firstTokenBudgetMs = process.env.HAPPY_E2E_RECORD === '1' ? 8_000 : 5_000;
    expect(firstTokenMs, `首个可见字符应在 ${firstTokenBudgetMs}ms 内出现`).toBeLessThan(firstTokenBudgetMs);
    await showStep(page, markdownOnly
        ? `3 / 3  Markdown 流式首字 ${firstTokenMs}ms`
        : `3 / 7  流式首字 ${firstTokenMs}ms`, markdownOnly ? 800 : 100);
    await screenshot(page, testInfo, '02-first-response-mobile-web.png');
    await expect(page.getByTestId('relationship-advisor-message-assistant')).toHaveCount(1, { timeout: 120_000 });
    await expect(streaming).toHaveCount(0);
    expect(await streamingSampleCount(page), 'E2E 应观察到临时流式文本节点').toBeGreaterThanOrEqual(1);
    const markdownProbe = await streamingMarkdownProbe(page);
    expect(markdownProbe.sawFormattedStrong, '流式阶段应出现格式化后的粗体 DOM').toBe(true);
    expect(markdownProbe.sawRawMarkdownMarker, '流式阶段不应露出原始 ** 标记').toBe(false);
    console.log('[advisor-e2e] 文本流式回复完成');
    const firstAssistant = page.getByTestId('relationship-advisor-message-assistant').first();
    await expect(firstAssistant).toBeVisible();
    expect((await firstAssistant.innerText()).trim().length).toBeGreaterThan(12);
    const textCompletedMs = await page.evaluate(() => {
        const probe = (window as typeof window & {
            __advisorE2EStreamingProbe?: { startedAt: number };
        }).__advisorE2EStreamingProbe;
        return probe ? Math.round(performance.now() - probe.startedAt) : 0;
    });
    await showStep(page, markdownOnly
        ? `3 / 3  Markdown 回复完成 ${textCompletedMs}ms`
        : `4 / 7  文本回复完成 ${textCompletedMs}ms`, 1_000);
    await screenshot(page, testInfo, '03-text-complete-mobile-web.png');

    if (markdownOnly) {
        await writeFile(path.join(evidenceDir, 'metrics.json'), JSON.stringify({
            firstTokenMs,
            textCompletedMs,
            markdownProbe,
            viewport: { width: 390, height: 844 },
        }, null, 2));
        await clearConversation(page);
        await expect(page.getByTestId('relationship-advisor-empty-state')).toBeVisible();
        await page.evaluate(() => document.getElementById('advisor-e2e-step')?.remove());
        await context.close();
        return;
    }

    await attachImage(page, advisorScreen, imagePath);
    await input.fill('只根据图片回答：图片最主要的颜色是什么？', { timeout: 15_000 });
    await armStreamingProbe(page);
    console.log('[advisor-e2e] 发送真实图片分析');
    await sendButton.click({ timeout: 15_000 });
    await expect(page.getByTestId('relationship-advisor-message-user').last()).toContainText(/1 张图片|1 image/i);
    await expect.poll(async () => {
        const hasToken = await page.evaluate(() => Boolean(
            (window as typeof window & {
                __advisorE2EStreamingProbe?: { firstTokenAt: number | null };
            }).__advisorE2EStreamingProbe?.firstTokenAt,
        ));
        const hasError = await page.getByTestId('relationship-advisor-error').isVisible();
        const completed = await page.getByTestId('relationship-advisor-message-assistant').count() >= 2;
        return completed ? 'complete' : hasToken ? 'token' : hasError ? 'error' : 'waiting';
    }, { timeout: 20_000 }).not.toBe('waiting');
    if (await page.getByTestId('relationship-advisor-error').isVisible()) {
        throw new Error(`Image request failed before streaming: ${JSON.stringify({ advisorResponses, uploadDiagnostics })}`);
    }
    await expect(page.getByTestId('relationship-advisor-message-assistant')).toHaveCount(2, { timeout: 120_000 });
    await expect(streaming).toHaveCount(0);
    const imageResponseMs = await elapsedSinceRequestStarted(page);
    console.log(`[advisor-e2e] 图片完整回复 ${imageResponseMs}ms`);
    expect(imageResponseMs, '图片识别应在 20 秒内完成').toBeLessThan(20_000);
    const imageAssistant = page.getByTestId('relationship-advisor-message-assistant').last();
    await expect(imageAssistant).toContainText(/红|red/i);
    await showStep(page, `5 / 7  图片识别完成 ${imageResponseMs}ms`, 1_100);
    await screenshot(page, testInfo, '04-image-analysis-mobile-web.png');

    await input.fill('请从三个角度展开分析这段关系，每个角度至少写一百字，并给出具体示例。', { timeout: 15_000 });
    await showStep(page, '6 / 7  下一条长回复将立即停止', 100);
    console.log('[advisor-e2e] 发送长回复请求以验证停止');
    await sendButton.click({ timeout: 15_000 });
    await expect(page.getByTestId('relationship-advisor-stop-button')).toBeVisible();
    await page.getByTestId('relationship-advisor-stop-button').click();
    console.log('[advisor-e2e] 已点击停止生成');
    await expect(page.getByTestId('relationship-advisor-stop-button')).toHaveCount(0, { timeout: 15_000 });
    const assistantCountAfterStop = await page.getByTestId('relationship-advisor-message-assistant').count();
    expect(assistantCountAfterStop).toBeGreaterThanOrEqual(2);
    await screenshot(page, testInfo, '05-stopped-mobile-web.png');

    // Make one upload fail before the provider starts, then verify the real retry succeeds.
    await attachImage(page, advisorScreen, imagePath);
    await input.fill('再次确认这张测试图的主色，只回答颜色。', { timeout: 15_000 });
    let injectedFailure = false;
    await page.route('**/v1/relationship-advisor/images/request-upload', async (route) => {
        if (!injectedFailure) {
            injectedFailure = true;
            await route.fulfill({ status: 503, body: 'temporary e2e failure' });
            return;
        }
        await route.continue();
    });
    console.log('[advisor-e2e] 注入一次图片上传 503');
    await sendButton.click({ timeout: 15_000 });
    await expect(page.getByTestId('relationship-advisor-error')).toBeVisible({ timeout: 15_000 });
    const assistantCountBeforeRetry = await page.getByTestId('relationship-advisor-message-assistant').count();
    await page.unroute('**/v1/relationship-advisor/images/request-upload');
    await armStreamingProbe(page);
    await page.getByTestId('relationship-advisor-retry-button').click();
    console.log('[advisor-e2e] 点击重试并恢复真实链路');
    await expect(page.getByTestId('relationship-advisor-message-assistant')).toHaveCount(
        assistantCountBeforeRetry + 1,
        { timeout: 120_000 },
    );
    await expect(streaming).toHaveCount(0);
    await expect(page.getByTestId('relationship-advisor-message-assistant').last()).toContainText(/红|red/i);

    const userCountBeforeReload = await page.getByTestId('relationship-advisor-message-user').count();
    const assistantCountBeforeReload = await page.getByTestId('relationship-advisor-message-assistant').count();
    await page.reload({ waitUntil: 'domcontentloaded' });
    console.log('[advisor-e2e] 已刷新，检查本地历史');
    await expect(page.getByTestId('relationship-advisor-screen')).toBeVisible({ timeout: 90_000 });
    await dismissPrivacyCurtain(page);
    await expect(page.getByTestId('relationship-advisor-message-user')).toHaveCount(userCountBeforeReload);
    await expect(page.getByTestId('relationship-advisor-message-assistant')).toHaveCount(assistantCountBeforeReload);
    await showStep(page, '7 / 7  刷新后本地历史仍在，随后清理测试数据', 1_100);
    await screenshot(page, testInfo, '06-history-after-reload-mobile-web.png');
    await clearConversation(page);
    await expect(page.getByTestId('relationship-advisor-empty-state')).toBeVisible();

    expect(injectedFailure).toBe(true);
    expect(advisorResponses.some(({ status, pathname }) => (
        status === 200 && pathname.endsWith('/images/request-upload')
    ))).toBe(true);
    expect(uploadDiagnostics.some(({ kind, method, status }) => (
        kind === 'response' && method === 'POST' && status === 204
    ))).toBe(true);
    expect(browserErrors, 'E2E 期间不应出现未处理的页面异常').toEqual([]);

    await writeFile(path.join(evidenceDir, 'metrics.json'), JSON.stringify({
        firstTokenMs,
        textCompletedMs,
        markdownProbe,
        imageResponseMs,
        userCountBeforeReload,
        assistantCountBeforeReload,
        advisorResponses,
        uploadDiagnostics,
        viewport: { width: 390, height: 844 },
    }, null, 2));

    await page.evaluate(() => document.getElementById('advisor-e2e-step')?.remove());
    await context.close();
});
