import { expect, test, type Locator } from '@playwright/test';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const productionEnabled = process.env.HAPPY_E2E_PRODUCTION === '1';
const secretKeyFile = process.env.HAPPY_E2E_SECRET_KEY_FILE
    ?? path.resolve(process.cwd(), '../..', '.paws-e2e-production.key');

async function renderedLineTexts(locator: Locator): Promise<string[]> {
    return locator.evaluate((element: Element) => {
        const chars: Array<{ top: number; value: string }> = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
            const value = node.textContent ?? '';
            for (let index = 0; index < value.length; index += 1) {
                if (/\s/.test(value[index])) continue;
                const range = document.createRange();
                range.setStart(node, index);
                range.setEnd(node, index + 1);
                const rect = range.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    chars.push({ top: Math.round(rect.top), value: value[index] });
                }
            }
            node = walker.nextNode();
        }

        const lines: Array<{ top: number; value: string }> = [];
        for (const char of chars) {
            let line = lines.find((candidate) => Math.abs(candidate.top - char.top) <= 1);
            if (!line) {
                line = { top: char.top, value: '' };
                lines.push(line);
            }
            line.value += char.value;
        }
        return lines.sort((left, right) => left.top - right.top).map((line) => line.value);
    });
}

// Playwright 的 DOM Trace 会保存输入值，因此密钥输入阶段必须关闭自动 Trace。
// 成功离开恢复页后再手动启动 Trace，视频和截图只会看到密码掩码。
test.use({ trace: 'off', locale: 'zh-CN' });

test.describe('真实账号恢复', () => {
    test.beforeEach(() => {
        test.skip(!productionEnabled, '真实生产恢复仅在显式设置 HAPPY_E2E_PRODUCTION=1 时运行。');
        const url = new URL(authenticatedWebUrl);
        expect(['127.0.0.1', 'localhost']).toContain(url.hostname);

        if (process.platform !== 'win32') {
            const mode = statSync(secretKeyFile).mode & 0o777;
            expect(mode & 0o077, '生产 E2E 密钥文件不得允许组或其他用户读取').toBe(0);
        }
    });

    test('空白浏览器恢复真实账号并在刷新与返回后保持已登录', async ({ page, context }, testInfo) => {
        test.setTimeout(180_000);
        const browserErrors: string[] = [];
        const failedResponses: string[] = [];
        page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
        page.on('console', (message) => {
            if (message.type() === 'error') {
                browserErrors.push(`console: ${message.text()}`);
            }
        });
        page.on('response', (response) => {
            const resourceType = response.request().resourceType();
            if (response.status() >= 400 && ['document', 'fetch', 'xhr'].includes(resourceType)) {
                failedResponses.push(`${response.status()} ${response.url()}`);
            }
        });

        await page.setViewportSize({ width: 1470, height: 863 });
        await page.goto(authenticatedWebUrl);

        const loginButton = page.getByRole('button', { name: /Login with mobile app|使用移动应用登录/i });
        try {
            await expect(loginButton).toBeVisible({ timeout: 20_000 });
        } catch (error) {
            throw new Error(`应用启动后没有进入未登录首页：${browserErrors.join(' | ') || '浏览器未报告运行时错误'}`, {
                cause: error,
            });
        }

        for (const viewport of [
            { width: 1024, height: 768 },
            { width: 1280, height: 720 },
            { width: 1440, height: 900 },
            { width: 1920, height: 1080 },
        ]) {
            await page.setViewportSize(viewport);
            const titleLines = await renderedLineTexts(page.getByTestId('welcome-title'));
            const subtitleLines = await renderedLineTexts(page.getByTestId('welcome-subtitle'));
            expect(titleLines.at(-1)?.length ?? 0, '欢迎页标题不得以一到两个字孤行收尾').toBeGreaterThan(2);
            expect(subtitleLines.at(-1)?.length ?? 0, '欢迎页说明不得以一到两个字孤行收尾').toBeGreaterThan(2);
            await page.screenshot({
                path: testInfo.outputPath(`welcome-${viewport.width}x${viewport.height}.png`),
                fullPage: true,
            });
        }

        await loginButton.click();

        const restoreContent = page.getByTestId('restore-device-content');
        const instructions = page.getByTestId('restore-device-instructions');
        const qrPanel = page.getByTestId('restore-device-qr-panel');
        await expect(restoreContent).toBeVisible();
        await expect(page.getByTestId('restore-device-qr-code')).toBeVisible({ timeout: 20_000 });

        for (const viewport of [
            { width: 1470, height: 863 },
            { width: 2552, height: 1396 },
        ]) {
            await page.setViewportSize(viewport);
            const [contentBox, instructionsBox, qrBox] = await Promise.all([
                restoreContent.boundingBox(),
                instructions.boundingBox(),
                qrPanel.boundingBox(),
            ]);
            expect(contentBox).not.toBeNull();
            expect(instructionsBox).not.toBeNull();
            expect(qrBox).not.toBeNull();
            expect(contentBox!.width).toBeLessThanOrEqual(1040);
            expect(instructionsBox!.x + instructionsBox!.width).toBeLessThan(qrBox!.x);
            expect(qrBox!.width).toBeLessThanOrEqual(400);
            await page.screenshot({
                path: testInfo.outputPath(`connect-device-${viewport.width}x${viewport.height}.png`),
                fullPage: true,
            });
        }

        await page.getByRole('button', { name: /Restore with Secret Key Instead/i }).click();
        const secretInput = page.getByTestId('restore-secret-key-input');
        const restoreButton = page.getByRole('button', { name: /Restore Account|恢复账户/i });
        await expect(secretInput).toHaveAttribute('type', 'password');

        // 错误 Key 只走本地格式校验，不把真实密钥放进诊断材料。
        await secretInput.fill('INVALID-KEY');
        await restoreButton.click();
        await expect(page.getByText(/Invalid secret key|无效.*密钥/i)).toBeVisible();
        await page.getByRole('button', { name: /OK|确定/i }).click();
        const unexpectedValidationErrors = browserErrors.filter(
            (entry) => !entry.includes('Restore error:') || !entry.includes('Invalid key length'),
        );
        expect(unexpectedValidationErrors, '本地错误 Key 校验之外不应出现浏览器错误').toEqual([]);
        browserErrors.length = 0;

        const secretKey = readFileSync(secretKeyFile, 'utf8').trim();
        expect(secretKey.length).toBeGreaterThan(0);
        await secretInput.fill(secretKey);
        await restoreButton.click();

        // RoundButton 的 loading 状态会立即禁用按钮，重复点击不能发起第二次恢复。
        await expect(restoreButton).toBeDisabled();
        await restoreButton.click({ force: true });

        await expect(page).toHaveURL(new RegExp(`${new URL(authenticatedWebUrl).origin}/?$`), {
            timeout: 45_000,
        });
        await expect(page.getByRole('textbox')).toBeVisible({ timeout: 45_000 });
        await expect(page.getByText(/mac-mini/i).first()).toBeVisible({ timeout: 45_000 });

        // 密钥输入页面已经退出，此后生成的 Trace 不包含密钥字段值。
        const tracePath = testInfo.outputPath('post-auth-trace.zip');
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
        try {
            await page.reload();
            await expect(page.getByRole('textbox')).toBeVisible({ timeout: 45_000 });
            await expect(page.getByText(/mac-mini/i).first()).toBeVisible({ timeout: 45_000 });
            await expect(page).not.toHaveURL(/\/restore(?:\/manual)?$/);

            await page.goBack();
            await expect(page.getByRole('textbox')).toBeVisible({ timeout: 45_000 });
            await expect(page.getByText(/mac-mini/i).first()).toBeVisible({ timeout: 45_000 });
            await expect(page).not.toHaveURL(/\/restore(?:\/manual)?$/);

            await page.screenshot({
                path: testInfo.outputPath('authenticated-home.png'),
                fullPage: true,
            });
        } finally {
            await context.tracing.stop({ path: tracePath });
        }
        expect(browserErrors, '真实恢复、刷新与返回期间不应出现浏览器错误').toEqual([]);
        expect(failedResponses, '主链路不应出现意外的 document/fetch/xhr 4xx 或 5xx').toEqual([]);
        await context.close();
    });
});
