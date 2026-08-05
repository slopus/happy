import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io } from 'socket.io-client';
import { decodeBase64, decryptLegacy, encodeBase64, encryptLegacy } from '../../happy-cli/src/api/encryption';
import {
    expectProductionRedactionReady,
    installProductionRedaction,
} from '../e2e-production/productionRedaction';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const e2eServerUrl = process.env.HAPPY_E2E_SERVER_URL!;

function authenticatedRoute(pathname: string): string {
    const url = new URL(authenticatedWebUrl);
    url.pathname = pathname;
    return url.toString();
}

async function pauseForRecordedReview(page: Page, duration = 650): Promise<void> {
    // These pauses only pace human-review recordings; readiness remains covered
    // by the surrounding assertions, and normal CI runs do not wait here.
    if (process.env.HAPPY_E2E_RECORD === '1') {
        await page.waitForTimeout(duration);
    }
}

async function createE2ESession(request: APIRequestContext): Promise<string> {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    const secret = authUrl.searchParams.get('dev_secret');
    if (!token || !secret || !e2eServerUrl) {
        throw new Error('缺少创建 E2E 会话所需的本地认证配置。');
    }

    const encryptionKey = new Uint8Array(Buffer.from(secret, 'base64url'));
    const metadata = encodeBase64(encryptLegacy({
        path: '/tmp/paws-sidebar-e2e',
        host: 'playwright',
        name: 'Sidebar active-session regression',
        flavor: 'codex',
        lifecycleState: 'running',
        startedBy: 'terminal',
    }, encryptionKey));
    const response = await request.post(new URL('/v1/sessions', e2eServerUrl).toString(), {
        data: {
            tag: `sidebar-e2e-${Date.now()}-${Math.random()}`,
            metadata,
            agentState: null,
            dataEncryptionKey: null,
        },
        headers: {
            Authorization: `Bearer ${token}`,
            'X-Happy-Client': 'playwright-e2e',
        },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json() as { session: { id: string } };
    return body.session.id;
}

async function createConnectedE2EFileSession(request: APIRequestContext): Promise<{
    client: { close: () => void };
    fileContent: string;
    fileName: string;
    filePath: string;
    sessionId: string;
    workspace: string;
}> {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    const secret = authUrl.searchParams.get('dev_secret');
    if (!token || !secret || !e2eServerUrl) {
        throw new Error('缺少创建文件详情 E2E 会话所需的本地认证配置。');
    }

    const workspace = mkdtempSync(join(tmpdir(), 'paws-file-layout-e2e-'));
    const fileName = 'staged-cinematic-motion-blur-edit.md';
    const filePath = join(workspace, fileName);
    const fileContent = 'Keep the central photographer completely unchanged.';
    writeFileSync(filePath, fileContent, 'utf8');

    const encryptionKey = new Uint8Array(Buffer.from(secret, 'base64url'));
    const metadata = {
        path: workspace,
        homeDir: workspace,
        host: 'playwright',
        name: 'File viewer layout regression',
        flavor: 'codex',
        lifecycleState: 'running',
        startedBy: 'terminal',
    };
    const response = await request.post(new URL('/v1/sessions', e2eServerUrl).toString(), {
        data: {
            tag: `file-viewer-e2e-${Date.now()}-${Math.random()}`,
            metadata: encodeBase64(encryptLegacy(metadata, encryptionKey)),
            agentState: null,
            dataEncryptionKey: null,
        },
        headers: {
            Authorization: `Bearer ${token}`,
            'X-Happy-Client': 'playwright-e2e',
        },
    });
    if (!response.ok()) {
        rmSync(workspace, { force: true, recursive: true });
        throw new Error(`创建文件详情 E2E 会话失败：HTTP ${response.status()}`);
    }
    const body = await response.json() as { session: { id: string } };

    const sessionId = body.session.id;
    const messageResponse = await request.post(
        new URL(`/v3/sessions/${encodeURIComponent(sessionId)}/messages`, e2eServerUrl).toString(),
        {
            data: {
                messages: [{
                    content: encodeBase64(encryptLegacy({
                        role: 'agent',
                        content: {
                            type: 'acp',
                            provider: 'codex',
                            data: {
                                type: 'tool-call',
                                callId: 'file-viewer-layout-write',
                                id: 'file-viewer-layout-write',
                                input: { file_path: filePath, content: fileContent },
                                name: 'Write',
                            },
                        },
                        meta: { sentFrom: 'cli' },
                    }, encryptionKey)),
                    localId: `file-viewer-layout-${Date.now()}`,
                }],
            },
            headers: {
                Authorization: `Bearer ${token}`,
                'X-Happy-Client': 'playwright-e2e',
            },
        },
    );
    if (!messageResponse.ok()) {
        rmSync(workspace, { force: true, recursive: true });
        throw new Error(`写入文件详情 E2E 消息失败：HTTP ${messageResponse.status()}`);
    }

    const rpcSocket = io(e2eServerUrl, {
        auth: {
            token,
            clientType: 'session-scoped',
            sessionId,
            happyClient: 'playwright-file-rpc',
        },
        autoConnect: false,
        path: '/v1/updates',
        reconnection: false,
        transports: ['websocket'],
    });
    rpcSocket.on('rpc-request', (data: { method: string; params: string }, callback: (response: string) => void) => {
        const params = decryptLegacy(decodeBase64(data.params), encryptionKey) as { path?: string } | null;
        const result = data.method === `${sessionId}:readFile` && params?.path === filePath
            ? { success: true, content: Buffer.from(fileContent, 'utf8').toString('base64') }
            : data.method === `${sessionId}:bash`
                ? { success: true, stdout: '', stderr: '', exitCode: 0 }
                : { success: false, error: 'Unknown E2E RPC request' };
        callback(encodeBase64(encryptLegacy(result, encryptionKey)));
    });
    try {
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('文件详情 E2E RPC 连接超时。')), 10_000);
            const handleConnectError = (error: Error) => {
                clearTimeout(timeout);
                reject(error);
            };
            rpcSocket.once('connect_error', handleConnectError);
            rpcSocket.once('connect', () => {
                clearTimeout(timeout);
                rpcSocket.off('connect_error', handleConnectError);
                rpcSocket.emit('rpc-register', { method: `${sessionId}:readFile` });
                rpcSocket.emit('rpc-register', { method: `${sessionId}:bash` });
                resolve();
            });
            rpcSocket.connect();
        });
    } catch (error) {
        rpcSocket.close();
        rmSync(workspace, { force: true, recursive: true });
        throw error;
    }

    return {
        client: { close: () => rpcSocket.close() },
        fileContent,
        fileName,
        filePath,
        sessionId,
        workspace,
    };
}

async function dragHorizontalResizeHandle(page: Page, handle: Locator, deltaX: number): Promise<void> {
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + Math.min(100, box!.height / 2));
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + deltaX, box!.y + Math.min(100, box!.height / 2), {
        steps: 10,
    });
    await page.mouse.up();
}

async function renderedLineTexts(locator: Locator): Promise<string[]> {
    return locator.evaluate((element) => {
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

const viewports = [
    { name: '窄屏', width: 799, height: 900 },
    { name: '断点宽度', width: 800, height: 900 },
    { name: '宽屏', width: 1280, height: 900 },
] as const;

const expectedIsolatedDevRouteLoadEvidence = {
    warningCount: 0,
    errorCount: 6,
    failedRequestCount: 6,
    consoleErrorKinds: Array(6).fill('resource-load'),
    failedRequestTypes: Array(6).fill('fetch'),
    failedRequestReasons: Array(6).fill('net::ERR_CONNECTION_REFUSED'),
};

test('中文欢迎页在四档桌面视口没有孤字收尾', async ({ browser }, testInfo) => {
    const context = await browser.newContext({ locale: 'zh-CN', deviceScaleFactor: 1 });
    const page = await context.newPage();
    const url = new URL(authenticatedWebUrl);
    url.pathname = '/';
    url.search = '';
    url.hash = '';

    try {
        for (const viewport of [
            { width: 1024, height: 768 },
            { width: 1280, height: 720 },
            { width: 1440, height: 900 },
            { width: 1920, height: 1080 },
        ]) {
            await page.setViewportSize(viewport);
            await page.goto(url.toString());
            const titleLines = await renderedLineTexts(page.getByTestId('welcome-title'));
            const subtitleLines = await renderedLineTexts(page.getByTestId('welcome-subtitle'));
            expect(titleLines.at(-1)?.length ?? 0, '欢迎页标题不得以一到两个字孤行收尾').toBeGreaterThan(2);
            expect(subtitleLines.at(-1)?.length ?? 0, '欢迎页说明不得以一到两个字孤行收尾').toBeGreaterThan(2);
            await page.screenshot({
                path: testInfo.outputPath(`welcome-after-${viewport.width}x${viewport.height}.png`),
                fullPage: true,
            });
        }
    } finally {
        await context.close();
    }
});

for (const viewport of viewports) {
    test(`${viewport.name}首页可输入且没有 OTA 蒙层`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(authenticatedWebUrl);

        const composer = page.getByRole('textbox');
        await expect(composer).toHaveCount(1);
        await expect(composer).toBeVisible();
        await expect(page.getByRole('button', { name: /OTA/i })).toHaveCount(0);

        const hitTargetIsComposer = await composer.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const hitTarget = document.elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
            );
            return hitTarget === element;
        });
        expect(hitTargetIsComposer).toBe(true);

        await composer.click();
        await expect(composer).toBeFocused();
        await composer.fill('浏览器 E2E 点击探针');
        await expect(composer).toHaveValue('浏览器 E2E 点击探针');
    });
}

test('Web 启动不会注册无效的 push token listener', async ({ page }) => {
    const unsupportedPushTokenWarnings: string[] = [];
    page.on('console', (message) => {
        if (message.type() === 'warning' && message.text().includes('Listening to push token changes')) {
            unsupportedPushTokenWarnings.push(message.text());
        }
    });

    await page.goto(new URL('/new', authenticatedWebUrl).toString());
    await expect(page.getByRole('textbox')).toBeVisible();

    expect(unsupportedPushTokenWarnings).toEqual([]);
});

test('Web 启动不会使用已弃用的 pointerEvents 组件属性', async ({ page }) => {
    const deprecatedPointerEventsWarnings: string[] = [];
    page.on('console', (message) => {
        if (message.type() === 'warning' && message.text().includes('props.pointerEvents is deprecated')) {
            deprecatedPointerEventsWarnings.push(message.text());
        }
    });

    await page.goto(new URL('/new', authenticatedWebUrl).toString());
    await expect(page.getByRole('textbox')).toBeVisible();

    expect(deprecatedPointerEventsWarnings).toEqual([]);
});

test('Web 外观设置不会使用已弃用的 shadow 样式或 pointerEvents 组件属性', async ({ page }) => {
    const deprecatedShadowWarnings: string[] = [];
    const deprecatedPointerEventsWarnings: string[] = [];
    page.on('console', (message) => {
        if (message.type() === 'warning' && message.text().includes('"shadow*" style props are deprecated')) {
            deprecatedShadowWarnings.push(message.text());
        }
        if (message.type() === 'warning' && message.text().includes('props.pointerEvents is deprecated')) {
            deprecatedPointerEventsWarnings.push(message.text());
        }
    });

    await page.goto(new URL('/settings/appearance', authenticatedWebUrl).toString());
    await page.waitForFunction(() => document.querySelectorAll('[role="switch"]').length > 0);

    expect(deprecatedShadowWarnings).toEqual([]);
    expect(deprecatedPointerEventsWarnings).toEqual([]);
});

test('Web 弹窗不会触发已弃用样式、组件或原生动画警告', async ({ page }) => {
    const modalWarnings: string[] = [];
    page.on('console', (message) => {
        if (
            message.type() === 'warning'
            && (
                message.text().includes('"shadow*" style props are deprecated')
                || message.text().includes('TouchableWithoutFeedback is deprecated')
                || message.text().includes('useNativeDriver` is not supported')
            )
        ) {
            modalWarnings.push(message.text());
        }
    });

    await page.goto(authenticatedWebUrl);
    await expect(page.getByRole('textbox')).toBeVisible();
    await page.goto(new URL('/settings/account', authenticatedWebUrl).toString());
    await page.getByText('Logout', { exact: true }).click();
    await expect(page.getByText('Are you sure you want to logout?', { exact: false })).toBeVisible();
    await page.getByText('Cancel', { exact: true }).click();

    await page.goto(new URL('/dev/modal-demo', authenticatedWebUrl).toString());
    await page.getByText('Custom Modal', { exact: true }).first().click();
    const customModalMessage = page.getByText(
        'This is a completely custom modal component. You can put anything in here!',
        { exact: true },
    );
    await expect(customModalMessage).toBeVisible();
    await page.getByText('Custom Modal', { exact: true }).last().click();
    await expect(customModalMessage).toBeVisible();
    await page.mouse.click(10, 10);
    await expect(customModalMessage).toHaveCount(0);

    expect(modalWarnings).toEqual([]);
});

test('Web 深色命令面板跟随主题并支持完整关闭交互', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(new URL('/settings/appearance', authenticatedWebUrl).toString());
    await page.getByText('Terminal', { exact: true }).click();
    await page.goto(new URL('/settings/features', authenticatedWebUrl).toString());

    const featureSwitches = page.getByRole('switch');
    await expect(featureSwitches).toHaveCount(10);
    const commandPaletteSwitch = page.getByRole('switch', { name: 'Command Palette' });
    await expect(commandPaletteSwitch).not.toBeChecked();
    await commandPaletteSwitch.click();

    await page.keyboard.press('Meta+KeyK');
    const commandInput = page.getByTestId('command-palette-input');
    await expect(commandInput).toBeVisible();

    const paletteColors = await page.evaluate(() => {
        const input = document.querySelector('[data-testid="command-palette-input"]');
        const palette = document.querySelector('[data-testid="command-palette"]');
        const selected = document.querySelector('[data-testid="command-palette-item-new-session"]');
        if (!input || !palette || !selected) {
            throw new Error('找不到命令面板主题探针');
        }
        return {
            input: window.getComputedStyle(input).color,
            surface: window.getComputedStyle(palette).backgroundColor,
            selected: window.getComputedStyle(selected).backgroundColor,
        };
    });
    expect(paletteColors).toEqual({
        input: 'rgb(229, 229, 231)',
        surface: 'rgb(19, 19, 22)',
        selected: 'rgb(32, 32, 38)',
    });

    await commandInput.press('Escape');
    await expect(commandInput).toHaveCount(0);

    await page.keyboard.press('Meta+KeyK');
    await expect(page.getByTestId('command-palette-input')).toBeVisible();
    await page.mouse.click(10, 10);
    await expect(page.getByTestId('command-palette-input')).toHaveCount(0);

    await commandPaletteSwitch.click();
    await expect(commandPaletteSwitch).not.toBeChecked();

    await page.goto(new URL('/settings/appearance', authenticatedWebUrl).toString());
    await page.getByText('Caramel', { exact: true }).click();
});

test.describe('中文 Web 命令面板', () => {
    test.use({ locale: 'zh-CN' });

    test('静态命令、类别和空结果均完成本地化', async ({ page }) => {
        await page.goto(new URL('/settings/features', authenticatedWebUrl).toString());

        const commandPaletteSwitch = page.getByRole('switch', { name: '命令面板' });
        await expect(commandPaletteSwitch).not.toBeChecked();
        await commandPaletteSwitch.click();
        await page.keyboard.press('Meta+KeyK');

        const commandInput = page.getByTestId('command-palette-input');
        await expect(commandInput).toHaveAttribute('placeholder', '输入命令或搜索...');
        await expect(page.getByText('导航', { exact: true })).toBeVisible();
        await expect(page.getByText('开始新会话', { exact: true })).toBeVisible();
        await expect(page.getByText('配置应用偏好', { exact: true })).toBeVisible();

        await commandInput.fill('不会匹配任何命令的关键词');
        await expect(page.getByText('未找到命令', { exact: true })).toBeVisible();

        await commandInput.press('Escape');
        await commandPaletteSwitch.click();
        await expect(commandPaletteSwitch).not.toBeChecked();
    });
});

test('Web 账户页不会让用户触发不支持的推送重新注册', async ({ page }) => {
    await page.goto(authenticatedWebUrl);
    await expect(page.getByRole('textbox')).toBeVisible();
    await page.goto(new URL('/settings/account', authenticatedWebUrl).toString());
    await expect(page.getByText('Unavailable', { exact: true })).toBeVisible();

    const reRegisterAction = page.getByText('Re-register This Device', { exact: true });
    const isDisabled = await reRegisterAction.evaluate((element) => {
        let current: HTMLElement | null = element as HTMLElement;
        while (current) {
            if (
                current.getAttribute('aria-disabled') === 'true'
                || ('disabled' in current && (current as HTMLButtonElement).disabled)
            ) {
                return true;
            }
            current = current.parentElement;
        }
        return false;
    });
    expect(isDisabled).toBe(true);

    await reRegisterAction.click({ force: true });
    await page.waitForTimeout(300);

    await expect(
        page.getByText('Push notifications are not enabled for this device yet.', { exact: true }),
    ).toHaveCount(0);
});

test('桌面侧栏导航控件不覆盖底部账户入口', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(authenticatedWebUrl);

    await expect(page.getByRole('textbox')).toBeVisible();

    const zenButton = page.locator('[data-testid="desktop-navigation-controls"]');
    const accountFooter = page.locator('[data-testid="sidebar-account-footer"]');
    await expect(zenButton).toHaveCount(1);
    await expect(accountFooter).toHaveCount(1);
    const controls = await zenButton.boundingBox();
    const footer = await accountFooter.boundingBox();
    expect(controls).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(controls!.x).toBeGreaterThanOrEqual(footer!.x + footer!.width);

    await page.screenshot({ path: 'test-results/desktop-sidebar-navigation.png', fullPage: true });
});

test('桌面三栏工作区支持独立折叠并保留禅模式前的偏好', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(authenticatedRoute('/new'));
    await expect(page.getByRole('textbox')).toBeVisible();

    const sidebarToggle = page.getByTestId('desktop-navigation-sidebar-button');
    const zenToggle = page.getByTestId('desktop-navigation-zen-button');
    const accountFooter = page.getByTestId('sidebar-account-footer');

    if (await zenToggle.getAttribute('aria-selected') === 'true') {
        await zenToggle.click();
    }
    if (await sidebarToggle.getAttribute('aria-expanded') === 'false') {
        await sidebarToggle.click();
    }
    if (!await page.locator('[data-testid="desktop-right-panel"]:visible').isVisible()) {
        await page.locator('[data-testid="desktop-right-panel-restore-button"]:visible').click();
    }

    const rightPanel = page.locator('[data-testid="desktop-right-panel"]:visible');
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(rightPanel).toBeVisible();
    await expect(rightPanel.getByText('Capability Hub', { exact: true })).toHaveCount(2);
    await expect(rightPanel.getByText('Quick Prompts', { exact: true })).toBeVisible();
    await expect(page.getByTestId('sidebar-desktop-density')).toBeVisible();
    await pauseForRecordedReview(page);

    await sidebarToggle.hover();
    await expect(page.getByTestId('desktop-navigation-sidebar-tooltip')).toContainText('⌘B');
    await expect(sidebarToggle).toHaveAttribute('aria-keyshortcuts', 'Meta+B');
    await pauseForRecordedReview(page);

    const rightPanelCollapse = page.locator('[data-testid="desktop-right-panel-collapse-button"]:visible');
    await rightPanelCollapse.hover();
    await expect(page.getByTestId('desktop-right-panel-collapse-tooltip')).toContainText('⌥⌘B');
    await expect(rightPanelCollapse).toHaveAttribute('aria-keyshortcuts', 'Alt+Meta+B');
    await pauseForRecordedReview(page);

    await page.keyboard.press('Meta+KeyB');
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'false');
    await pauseForRecordedReview(page);
    await page.keyboard.press('Meta+KeyB');
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'true');
    await pauseForRecordedReview(page);

    await page.keyboard.press('Alt+Meta+KeyB');
    await expect(rightPanel).toHaveCount(0);
    const rightPanelRestore = page.locator('[data-testid="desktop-right-panel-restore-button"]:visible');
    await expect(rightPanelRestore).toHaveAttribute('aria-keyshortcuts', 'Alt+Meta+B');
    await rightPanelRestore.hover();
    await expect(page.getByTestId('desktop-right-panel-restore-tooltip')).toContainText('⌥⌘B');
    await pauseForRecordedReview(page);
    await page.keyboard.press('Alt+Meta+KeyB');
    await expect(rightPanel).toBeVisible();
    await pauseForRecordedReview(page);

    const leftPanel = page.getByTestId('desktop-left-sidebar');
    const mainPanel = page.locator('[data-testid="desktop-workspace-main"]:visible');
    const leftWidthBefore = (await leftPanel.boundingBox())!.width;
    const leftHandleBox = await page.getByTestId('desktop-left-panel-resize-handle').boundingBox();
    expect(leftHandleBox).not.toBeNull();
    await page.mouse.move(leftHandleBox!.x + leftHandleBox!.width / 2, leftHandleBox!.y + 100);
    await page.mouse.down();
    await page.mouse.move(leftHandleBox!.x + 85, leftHandleBox!.y + 100, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await leftPanel.boundingBox())?.width ?? 0).toBeGreaterThan(leftWidthBefore + 60);
    const resizedLeftWidth = (await leftPanel.boundingBox())!.width;
    const leftResizeHandle = page.getByTestId('desktop-left-panel-resize-handle');
    await expect(leftResizeHandle).toHaveAttribute('aria-valuenow', String(Math.round(resizedLeftWidth)));
    await leftResizeHandle.focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await leftPanel.boundingBox())?.width ?? 0).toBeLessThan(resizedLeftWidth);
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => Math.abs(((await leftPanel.boundingBox())?.width ?? 0) - resizedLeftWidth)).toBeLessThanOrEqual(1);
    await sidebarToggle.hover();
    if (process.env.HAPPY_E2E_RECORD === '1') {
        await page.screenshot({
            path: 'test-results/pc-sidebar-left-after-1280x720.png',
            fullPage: true,
        });
    }
    await pauseForRecordedReview(page);

    await page.keyboard.press('Meta+KeyB');
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'false');
    const rightWidthBefore = (await rightPanel.boundingBox())!.width;
    const rightHandleBox = await rightPanel.getByTestId('desktop-right-panel-resize-handle').boundingBox();
    expect(rightHandleBox).not.toBeNull();
    await page.mouse.move(rightHandleBox!.x + rightHandleBox!.width / 2, rightHandleBox!.y + 100);
    await page.mouse.down();
    await page.mouse.move(rightHandleBox!.x - 280, rightHandleBox!.y + 100, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await rightPanel.boundingBox())?.width ?? 0).toBeGreaterThan(rightWidthBefore + 20);
    const resizedRightWidth = (await rightPanel.boundingBox())!.width;
    const rightResizeHandle = rightPanel.getByTestId('desktop-right-panel-resize-handle');
    await expect(rightResizeHandle).toHaveAttribute('aria-valuenow', String(Math.round(resizedRightWidth)));
    await rightResizeHandle.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await rightPanel.boundingBox())?.width ?? 0).toBeLessThan(resizedRightWidth);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => Math.abs(((await rightPanel.boundingBox())?.width ?? 0) - resizedRightWidth)).toBeLessThanOrEqual(1);
    await expect.poll(async () => (await mainPanel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(479);
    await rightPanelCollapse.hover();
    if (process.env.HAPPY_E2E_RECORD === '1') {
        await page.screenshot({
            path: 'test-results/pc-sidebar-right-after-1280x720.png',
            fullPage: true,
        });
    }
    await pauseForRecordedReview(page);
    await page.keyboard.press('Meta+KeyB');
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(async () => (await mainPanel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(479);

    const renderedLeftWidthAfterBoth = (await leftPanel.boundingBox())!.width;
    const renderedRightWidthAfterBoth = (await rightPanel.boundingBox())!.width;

    await page.screenshot({
        path: 'test-results/pc-workspace-panels-after-1280x720.png',
        fullPage: true,
    });

    const initialMainBox = await mainPanel.boundingBox();
    expect(initialMainBox).not.toBeNull();

    await page.locator('[data-testid="desktop-right-panel-collapse-button"]:visible').click();
    await expect(rightPanel).toHaveCount(0);
    await expect(page.locator('[data-testid="desktop-right-panel-restore-button"]:visible')).toBeVisible();

    const rightCollapsedMainBox = await mainPanel.boundingBox();
    expect(rightCollapsedMainBox).not.toBeNull();
    expect(rightCollapsedMainBox!.width).toBeGreaterThan(initialMainBox!.width + 100);
    await pauseForRecordedReview(page);

    await page.locator('[data-testid="desktop-right-panel-restore-button"]:visible').click();
    await expect(rightPanel).toBeVisible();
    await expect.poll(async () => (await mainPanel.boundingBox())?.width ?? 0).toBeLessThanOrEqual(initialMainBox!.width + 1);
    await pauseForRecordedReview(page);

    await sidebarToggle.click();
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(async () => {
        const box = await accountFooter.boundingBox();
        return box ? box.x + box.width : 0;
    }).toBeLessThanOrEqual(0);

    const leftCollapsedMainBox = await mainPanel.boundingBox();
    expect(leftCollapsedMainBox).not.toBeNull();
    expect(leftCollapsedMainBox!.x).toBeLessThan(initialMainBox!.x - 20);
    expect(leftCollapsedMainBox!.width).toBeGreaterThan(initialMainBox!.width + 100);
    await pauseForRecordedReview(page);

    await zenToggle.click();
    await expect(zenToggle).toHaveAttribute('aria-selected', 'true');
    await expect(rightPanel).toHaveCount(0);
    await pauseForRecordedReview(page);

    await zenToggle.click();
    await expect(zenToggle).toHaveAttribute('aria-selected', 'false');
    await expect(rightPanel).toBeVisible();
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'false');
    await pauseForRecordedReview(page);

    await sidebarToggle.click();
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'true');

    await page.reload();
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(rightPanel).toBeVisible();
    await expect.poll(async () => Math.abs(((await leftPanel.boundingBox())?.width ?? 0) - renderedLeftWidthAfterBoth)).toBeLessThanOrEqual(1);
    await expect.poll(async () => Math.abs(((await rightPanel.boundingBox())?.width ?? 0) - renderedRightWidthAfterBoth)).toBeLessThanOrEqual(1);
    await expect.poll(async () => (await mainPanel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(479);
    await page.keyboard.press('Meta+KeyB');
    await expect.poll(async () => Math.abs(((await rightPanel.boundingBox())?.width ?? 0) - resizedRightWidth)).toBeLessThanOrEqual(1);
    await page.keyboard.press('Meta+KeyB');
    await pauseForRecordedReview(page, 900);
});

test('超宽桌面侧栏只受中间最小宽度约束', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(authenticatedRoute('/new'));
    await expect(page.getByRole('textbox')).toBeVisible();

    const leftPanel = page.getByTestId('desktop-left-sidebar');
    const mainPanel = page.locator('[data-testid="desktop-workspace-main"]:visible');
    const rightPanel = page.locator('[data-testid="desktop-right-panel"]:visible');
    const leftHandle = page.getByTestId('desktop-left-panel-resize-handle');
    const sidebarToggle = page.getByTestId('desktop-navigation-sidebar-button');

    const leftBefore = (await leftPanel.boundingBox())!.width;
    await dragHorizontalResizeHandle(page, leftHandle, 520);
    await expect.poll(async () => (await leftPanel.boundingBox())?.width ?? 0).toBeGreaterThan(leftBefore + 450);
    await expect.poll(async () => (await leftPanel.boundingBox())?.width ?? 0).toBeGreaterThan(640);
    await expect.poll(async () => (await mainPanel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(479);

    await sidebarToggle.click();
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'false');
    const rightBefore = (await rightPanel.boundingBox())!.width;
    await dragHorizontalResizeHandle(page, rightPanel.getByTestId('desktop-right-panel-resize-handle'), -520);
    await expect.poll(async () => (await rightPanel.boundingBox())?.width ?? 0).toBeGreaterThan(rightBefore + 450);
    await expect.poll(async () => (await rightPanel.boundingBox())?.width ?? 0).toBeGreaterThan(640);
    await expect.poll(async () => (await mainPanel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(479);
});

test('活跃会话页面复用左右拖拽与折叠约束', async ({ page, request }) => {
    const sessionId = await createE2ESession(request);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(authenticatedRoute(`/session/${sessionId}`));

    const leftPanel = page.getByTestId('desktop-left-sidebar');
    const mainPanel = page.locator('[data-testid="desktop-workspace-main"]:visible');
    const rightPanel = page.locator('[data-testid="desktop-right-panel"]:visible');
    await expect(mainPanel).toBeVisible();
    await expect(rightPanel).toBeVisible();

    const leftBefore = (await leftPanel.boundingBox())!.width;
    await dragHorizontalResizeHandle(page, page.getByTestId('desktop-left-panel-resize-handle'), 70);
    await expect.poll(async () => (await leftPanel.boundingBox())?.width ?? 0).toBeGreaterThan(leftBefore + 40);

    const rightBefore = (await rightPanel.boundingBox())!.width;
    await dragHorizontalResizeHandle(page, rightPanel.getByTestId('desktop-right-panel-resize-handle'), -70);
    await expect.poll(async () => (await rightPanel.boundingBox())?.width ?? 0).toBeGreaterThan(rightBefore + 20);
    await expect.poll(async () => (await mainPanel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(479);

    const sidebarToggle = page.getByTestId('desktop-navigation-sidebar-button');
    await sidebarToggle.click();
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'false');
    const mainBeforeRightCollapse = (await mainPanel.boundingBox())!.width;
    await rightPanel.getByTestId('desktop-right-panel-collapse-button').click();
    const rightRestore = page.locator('[data-testid="desktop-right-panel-restore-button"]:visible');
    await expect(rightRestore).toBeVisible();
    await expect.poll(async () => (await mainPanel.boundingBox())?.width ?? 0).toBeGreaterThan(mainBeforeRightCollapse + 100);
    await sidebarToggle.click();
    await rightRestore.click();
    await expect(leftPanel).toBeVisible();
    await expect(rightPanel).toBeVisible();
});

test('PC 从右侧文件列表打开详情后标题与正文保持正确对齐', async ({ page, request }, testInfo) => {
    const fixture = await createConnectedE2EFileSession(request);

    try {
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.goto(authenticatedRoute(`/session/${fixture.sessionId}`));

        const rightPanel = page.locator('[data-testid="desktop-right-panel"]:visible');
        await expect(rightPanel).toBeVisible();
        await expect(rightPanel.getByText(fixture.fileName, { exact: true })).toBeVisible();

        const filesLabels = rightPanel.getByText('Files', { exact: true });
        await expect(filesLabels).toHaveCount(1);
        await filesLabels.click();
        await rightPanel.getByText(fixture.fileName, { exact: true }).click();

        await expect.poll(() => new URL(page.url()).pathname).toBe(`/session/${fixture.sessionId}/file`);
        const title = page.getByText('File Viewer', { exact: true });
        const content = page.getByTestId('file-viewer-content');
        const navigationControls = page.getByTestId('desktop-navigation-controls');
        await expect(title).toBeVisible();
        await expect(content).toBeVisible();
        await expect(content).toContainText(fixture.fileContent);

        const titleBox = await title.boundingBox();
        const controlsBox = await navigationControls.boundingBox();
        expect(titleBox).not.toBeNull();
        expect(controlsBox).not.toBeNull();
        expect(
            titleBox!.x,
            '文件详情标题不得与桌面导航控件重叠',
        ).toBeGreaterThanOrEqual(controlsBox!.x + controlsBox!.width + 4);

        const sidebarBox = await page.getByTestId('desktop-left-sidebar').boundingBox();
        const contentBox = await content.boundingBox();
        expect(sidebarBox).not.toBeNull();
        expect(contentBox).not.toBeNull();
        expect(
            contentBox!.x - (sidebarBox!.x + sidebarBox!.width),
            '文件正文应贴近主内容区左侧，而不是被 maxWidth 容器居中推远',
        ).toBeLessThanOrEqual(24);

        await page.screenshot({
            path: testInfo.outputPath('pc-file-viewer-after-1280x720.png'),
            fullPage: true,
        });
    } finally {
        await fixture.client.close();
        rmSync(fixture.workspace, { force: true, recursive: true });
    }
});

test('桌面问候语与输入框内容列对齐且代表性中文标题保持单行', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(new URL('/new', authenticatedWebUrl).toString());
    await expect(page.getByRole('textbox')).toBeVisible();

    const greeting = page.locator('[data-testid="compose-home-greeting"]:visible');
    const composerContent = page.locator('[data-testid="message-composer-content"]:visible');
    const greetingBox = await greeting.boundingBox();
    const composerContentBox = await composerContent.boundingBox();

    expect(greetingBox).not.toBeNull();
    expect(composerContentBox).not.toBeNull();
    expect(Math.abs(greetingBox!.x - composerContentBox!.x)).toBeLessThanOrEqual(1);

    const representativeGreetingFitsOneLine = await greeting.evaluate((element) => {
        const probe = element.cloneNode() as HTMLElement;
        probe.removeAttribute('data-testid');
        probe.textContent = '嗨 jacky，今天和 Paws 做点什么';
        probe.style.position = 'fixed';
        probe.style.visibility = 'hidden';
        probe.style.pointerEvents = 'none';
        element.parentElement!.appendChild(probe);

        const { height } = probe.getBoundingClientRect();
        const lineHeight = Number.parseFloat(window.getComputedStyle(probe).lineHeight);
        probe.remove();
        return height <= lineHeight + 1;
    });
    expect(representativeGreetingFitsOneLine).toBe(true);
});

test('桌面图片效果使用有边界的居中弹窗且支持 Escape 关闭', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const imageModeUrl = new URL(authenticatedRoute('/new'));
    imageModeUrl.searchParams.set('mode', 'image-styles');
    await page.goto(imageModeUrl.toString());

    const imagePanel = page.getByTestId('compose-home-image-agent-panel');
    await expect(imagePanel).toBeVisible();
    const imagePanelBox = await imagePanel.boundingBox();
    expect(imagePanelBox).not.toBeNull();
    expect(imagePanelBox!.width).toBeLessThanOrEqual(800);

    await page.getByTestId('compose-home-image-effect-action').click();
    const dialog = page.getByTestId('image-style-gallery-dialog');
    await expect(dialog).toBeVisible();

    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.width).toBeLessThanOrEqual(1040);
    expect(dialogBox!.height).toBeLessThanOrEqual(760);
    expect(dialogBox!.x).toBeGreaterThanOrEqual(32);
    expect(dialogBox!.y).toBeGreaterThanOrEqual(32);

    const categoriesFit = await page.getByTestId('image-style-gallery-categories').evaluate((element) => ({
        horizontal: element.scrollWidth <= element.clientWidth,
        vertical: element.scrollHeight <= element.clientHeight,
    }));
    expect(categoriesFit).toEqual({ horizontal: true, vertical: true });

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
});

test('手机首页保留菜单按钮并能打开抽屉', async ({ page }) => {
    await page.setViewportSize({ width: 799, height: 900 });
    await page.goto(authenticatedWebUrl);
    await expect(page.getByRole('textbox')).toBeVisible();

    const phoneDrawerButton = page.getByTestId('compose-home-drawer-button');
    const accountFooter = page.getByTestId('sidebar-account-footer');
    await expect(phoneDrawerButton).toBeVisible();
    const closedSidebarBox = await accountFooter.boundingBox();
    expect(closedSidebarBox).not.toBeNull();
    expect(closedSidebarBox!.x + closedSidebarBox!.width).toBeLessThanOrEqual(0);

    await phoneDrawerButton.click();
    await expect.poll(async () => (await accountFooter.boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0);
});

test('侧栏底部账户菜单统一提供身份与系统操作并恢复焦点', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(authenticatedWebUrl);
    await expect(page.getByRole('textbox')).toBeVisible();

    const footer = page.getByTestId('sidebar-account-footer');
    const trigger = page.getByTestId('sidebar-account-trigger');
    await expect(footer).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    const footerBox = await footer.boundingBox();
    const viewport = page.viewportSize();
    expect(footerBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(viewport!.height);
    expect(footerBox!.y).toBeGreaterThan(viewport!.height / 2);

    await trigger.click();
    const menu = page.getByTestId('sidebar-account-menu');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(menu).toBeVisible();
    await expect(page.getByTestId('sidebar-account-profile-action')).toBeFocused();
    await expect(page.getByTestId('sidebar-account-settings-action')).toBeVisible();
    await expect(page.getByTestId('sidebar-account-details-action')).toBeVisible();
    await expect(page.getByTestId('sidebar-account-help-action')).toBeVisible();
    await expect(page.getByTestId('sidebar-account-logout-action')).toBeVisible();
    await page.screenshot({
        path: testInfo.outputPath('desktop-account-menu-after-1280x900.png'),
        fullPage: true,
    });

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await page.setViewportSize({ width: 799, height: 900 });
    await page.goto(authenticatedWebUrl);
    await page.getByTestId('compose-home-drawer-button').click();
    await expect(page.getByTestId('sidebar-account-trigger')).toBeVisible();
    await page.getByTestId('sidebar-account-trigger').click();
    await expect(page.getByTestId('sidebar-account-menu')).toBeVisible();
});

test('生产截图脱敏锚点随底部账户入口更新', async ({ page }) => {
    await installProductionRedaction(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(authenticatedWebUrl);
    await expect(page.getByRole('textbox')).toBeVisible();
    await expectProductionRedactionReady(page);
});

for (const width of [800, 1280]) {
    test(`宽度 ${width}px 的桌面首页不显示手机抽屉菜单`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(authenticatedWebUrl);
        await expect(page.getByRole('textbox')).toBeVisible();

        await expect(page.getByTestId('compose-home-drawer-button')).toHaveCount(0);
    });
}

for (const width of [800, 1280]) {
    test(`宽度 ${width}px 的 /new 使用全局返回，且头部控件命中区域不重叠`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(authenticatedWebUrl);
        await expect(page.getByRole('textbox')).toBeVisible();
        await page.getByTestId('sidebar-new-session-button').click();
        await expect(page).toHaveURL(new URL('/new', authenticatedWebUrl).toString());

        await expect(page.getByTestId('compose-home-back-button')).toHaveCount(0);
        const navigationControls = page.getByTestId('desktop-navigation-controls');
        const backButton = page.getByTestId('desktop-navigation-back-button');
        const modelChip = page.locator('[data-testid="compose-home-model-chip"]:visible');
        const controlsBox = await navigationControls.boundingBox();
        const modelChipBox = await modelChip.boundingBox();
        expect(controlsBox).not.toBeNull();
        expect(modelChipBox).not.toBeNull();
        expect(modelChipBox!.x - 8).toBeGreaterThanOrEqual(controlsBox!.x + controlsBox!.width + 10);
        await expect(backButton).toBeEnabled();
        await backButton.click();

        await expect(page).toHaveURL(authenticatedWebUrl);
        await expect(page.getByRole('textbox')).toBeVisible();
    });
}

for (const width of [1024, 1280, 1440]) {
    test(`宽度 ${width}px 的模型选择器使用有边界的 PC 弹窗`, async ({ page }) => {
        await page.setViewportSize({ width, height: 720 });
        await page.goto(authenticatedRoute('/new'));
        await expect(page.getByRole('textbox')).toBeVisible();

        await page.locator('[data-testid="compose-home-model-chip"]:visible').click();
        const configPanel = page.getByTestId('compose-home-config-panel');
        await expect(configPanel).toBeVisible();
        const configBox = await configPanel.boundingBox();
        expect(configBox).not.toBeNull();
        expect(configBox!.width).toBeLessThanOrEqual(800);

        await page.getByTestId('session-config-model-trigger').click();
        const dialog = page.getByTestId('session-config-picker-model');
        await expect(dialog).toBeVisible();

        const dialogBox = await dialog.boundingBox();
        expect(dialogBox).not.toBeNull();
        expect(dialogBox!.width).toBeLessThanOrEqual(520);
        expect(dialogBox!.x).toBeGreaterThanOrEqual(32);
        expect(dialogBox!.y).toBeGreaterThanOrEqual(32);
        expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(width - 32);
        expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(720 - 32);

        const searchInput = dialog.getByRole('textbox');
        await expect(searchInput).toBeFocused();
        const fontSize = await searchInput.evaluate((element) => Number.parseFloat(
            window.getComputedStyle(element).fontSize,
        ));
        expect(fontSize).toBeLessThanOrEqual(14);

        const options = dialog.getByRole('radio');
        expect(await options.count()).toBeGreaterThan(1);
        await expect(dialog.getByRole('radio', { checked: true })).toHaveCount(1);

        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
    });
}

test('桌面 Machine Picker 各关闭入口重复退出后都把焦点返回触发器', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(authenticatedRoute('/new'));
    await expect(page.getByRole('textbox')).toBeVisible();

    const machineTrigger = page.getByTestId('session-config-machine-trigger');
    if (!await machineTrigger.isVisible()) {
        await page.locator('[data-testid="compose-home-model-chip"]:visible').click();
    }
    await expect(machineTrigger).toBeVisible();

    const dialog = page.getByTestId('session-config-picker-machine');
    for (const closeMethod of ['escape', 'close-button', 'scrim'] as const) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            await machineTrigger.click();
            await expect(dialog.getByRole('textbox')).toBeFocused();

            if (closeMethod === 'escape') {
                await page.keyboard.press('Escape');
            } else if (closeMethod === 'close-button') {
                await dialog.getByRole('button', { name: /^(Close|关闭)$/ }).click();
            } else {
                await page.getByTestId('session-config-picker-scrim').click({
                    position: { x: 8, y: 8 },
                });
            }

            await expect(dialog).toHaveCount(0);
            await expect(machineTrigger).toBeFocused();
        }
    }
});

test('桌面 Machine 与 Agent Picker 支持标准键盘激活并在关闭后回焦', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(authenticatedRoute('/new'));
    await expect(page.getByRole('textbox')).toBeVisible();

    const machineTrigger = page.getByTestId('session-config-machine-trigger');
    if (!await machineTrigger.isVisible()) {
        await page.locator('[data-testid="compose-home-model-chip"]:visible').click();
    }

    for (const picker of [
        {
            trigger: machineTrigger,
            dialog: page.getByTestId('session-config-picker-machine'),
        },
        {
            trigger: page.getByTestId('session-config-agent-trigger'),
            dialog: page.getByTestId('session-config-picker-agent'),
        },
    ]) {
        await expect(picker.trigger).toHaveAttribute('role', 'button');
        await expect(picker.trigger).toHaveAccessibleName(/.+/);
        await expect(picker.trigger).toHaveAttribute('aria-expanded', 'false');

        for (const activationKey of ['Space', 'Enter'] as const) {
            await picker.trigger.focus();
            await page.screenshot({
                path: testInfo.outputPath(`${await picker.trigger.getAttribute('data-testid')}-${activationKey}-before.png`),
                fullPage: true,
            });
            await picker.trigger.press(activationKey);
            await expect(picker.dialog).toBeVisible();
            await expect(picker.trigger).toHaveAttribute('aria-expanded', 'true');
            await page.screenshot({
                path: testInfo.outputPath(`${await picker.trigger.getAttribute('data-testid')}-${activationKey}-open.png`),
                fullPage: true,
            });

            await page.keyboard.press('Escape');
            await expect(picker.dialog).toHaveCount(0);
            await expect(picker.trigger).toBeFocused();
            await expect(picker.trigger).toHaveAttribute('aria-expanded', 'false');
            await page.screenshot({
                path: testInfo.outputPath(`${await picker.trigger.getAttribute('data-testid')}-${activationKey}-after.png`),
                fullPage: true,
            });
        }
    }
});

for (const width of [1024, 1280, 1440]) {
    test(`宽度 ${width}px 的禅模式导航与会话目标不重叠`, async ({ page }) => {
        await page.setViewportSize({ width, height: 720 });
        await page.goto(authenticatedRoute('/new'));
        await expect(page.getByRole('textbox')).toBeVisible();

        const zenButton = page.getByTestId('desktop-navigation-zen-button');
        const selected = await zenButton.getAttribute('aria-selected');
        if (selected === 'true') {
            await zenButton.click();
        }
        await zenButton.click();

        const controlsBox = await page.getByTestId('desktop-navigation-controls').boundingBox();
        const targetBox = await page.locator('[data-testid="compose-home-model-chip"]:visible').boundingBox();
        expect(controlsBox).not.toBeNull();
        expect(targetBox).not.toBeNull();
        expect(controlsBox!.x).toBeLessThanOrEqual(32);
        expect(targetBox!.x - 8).toBeGreaterThanOrEqual(controlsBox!.x + controlsBox!.width + 10);

        await zenButton.click();
    });
}

test.describe('中文 Web 语音设置', () => {
    test.use({ locale: 'zh-CN' });

    test('开发者诊断完成本地化、保持紧凑且页面加载没有失败 Fetch', async ({ page }) => {
        await page.goto(authenticatedWebUrl);
        await expect(page.getByRole('textbox')).toBeVisible();

        const voicePage = await page.context().newPage();
        const failedFetchStatuses: number[] = [];
        const failedUsageFetchRequests: string[] = [];
        voicePage.on('response', (response) => {
            if (response.request().resourceType() === 'fetch' && response.status() >= 400) {
                failedFetchStatuses.push(response.status());
            }
        });
        voicePage.on('requestfailed', (request) => {
            if (request.resourceType() === 'fetch' && request.method() === 'GET') {
                failedUsageFetchRequests.push(request.failure()?.errorText ?? 'unknown');
            }
        });

        await voicePage.setViewportSize({ width: 1280, height: 900 });
        await voicePage.goto(new URL('/settings/voice', authenticatedWebUrl).toString());

        await expect(voicePage.getByText('开发者', { exact: true })).toBeVisible();
        const statusTitle = voicePage.getByText('语音实验状态', { exact: true });
        await expect(statusTitle).toBeVisible();
        await expect(voicePage.getByText('重置语音计数', { exact: true })).toBeVisible();
        await expect(voicePage.getByText(/Voice 升级推荐：对照组/)).toBeVisible();
        await expect(voicePage.getByText(/来源：默认值/)).toBeVisible();
        await expect(voicePage.getByText(/访问方式：Paws 服务器访问控制/)).toBeVisible();
        await expect(voicePage.getByText(/实验功能设置：(开启|关闭)/)).toBeVisible();
        await expect(voicePage.getByText(/软付费墙展示次数：0/)).toBeVisible();
        await expect(voicePage.getByText(/新手引导提示词加载次数：0/)).toBeVisible();
        await expect(voicePage.getByText(/Voice 消息数：0/)).toBeVisible();

        await expect(voicePage.getByTestId('voice-usage-loading')).toHaveCount(0);
        const statusRowBox = await voicePage.getByTestId('voice-experiment-status-row').boundingBox();
        const resetRowBox = await voicePage.getByTestId('voice-reset-counters-row').boundingBox();
        const developerFooterBox = await voicePage.getByText(
            '当前 Voice 灰度发布的开发者诊断与本地控制。除非同时启用“直接连接”和自定义 ElevenLabs 代理，否则付费 Voice 的访问控制由 Paws 服务器处理。',
            { exact: true },
        ).boundingBox();
        expect(statusRowBox).not.toBeNull();
        expect(resetRowBox).not.toBeNull();
        expect(developerFooterBox).not.toBeNull();
        expect(statusRowBox!.height).toBeLessThanOrEqual(resetRowBox!.height + 1);
        expect(statusRowBox!.y + statusRowBox!.height).toBeLessThanOrEqual(resetRowBox!.y);
        expect(resetRowBox!.y + resetRowBox!.height).toBeLessThanOrEqual(developerFooterBox!.y);
        expect(failedFetchStatuses).toEqual([]);
        expect(failedUsageFetchRequests).toEqual([]);
        await voicePage.screenshot({
            path: 'test-results/voice-settings-desktop-zh.png',
            fullPage: true,
        });
    });
});

test.describe('中文 Web 语言设置', () => {
    test.use({ locale: 'zh-CN' });

    test('切换语言前使用待确认语义并允许取消', async ({ page }) => {
        await page.goto(new URL('/settings/language', authenticatedWebUrl).toString());
        await page.getByText('English', { exact: true }).click();

        await expect(page.getByText('需要重启应用', { exact: true })).toBeVisible();
        await page.getByText('取消', { exact: true }).click();
        await expect(page.getByText('需要重启应用', { exact: true })).toHaveCount(0);
    });
});

test.describe('中文 Web 资料与使用情况设置', () => {
    test.use({ locale: 'zh-CN' });

    test('使用情况提供可见标题、周期按钮语义和空数据反馈', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(authenticatedRoute('/settings/usage'));

        const visibleTitle = page.getByText('使用情况', { exact: true }).filter({ visible: true });
        await expect(visibleTitle).toBeVisible();
        const titleBox = await visibleTitle.boundingBox();
        expect(titleBox).not.toBeNull();
        expect(titleBox!.width).toBeGreaterThan(0);
        expect(titleBox!.height).toBeGreaterThan(0);

        await expect(page.getByText('暂无使用数据', { exact: true })).toBeVisible();
        await expect(page.getByRole('tablist', { name: '使用情况' })).toBeVisible();
        const todayButton = page.getByRole('tab', { name: '今天' });
        const weekButton = page.getByRole('tab', { name: '过去 7 天' });
        const monthButton = page.getByRole('tab', { name: '过去 30 天' });
        await expect(todayButton).toBeVisible();
        await expect(weekButton).toBeVisible();
        await expect(monthButton).toBeVisible();
        await expect(weekButton).toHaveAttribute('aria-selected', 'true');

        await todayButton.click();
        await expect(todayButton).toHaveAttribute('aria-selected', 'true');
        await expect(weekButton).toHaveAttribute('aria-selected', 'false');
    });

    test('资料保存操作暴露按钮语义并在可逆编辑后恢复禁用', async ({ page }) => {
        await page.goto(authenticatedRoute('/settings/profile'));

        const saveButton = page.getByRole('button', { name: '保存' });
        const nameInput = page.getByRole('textbox', { name: '姓名' });
        await expect(saveButton).toBeDisabled();

        const originalName = await nameInput.inputValue();
        await nameInput.fill(`${originalName}x`);
        await expect(saveButton).toBeEnabled();

        await nameInput.fill(originalName);
        await expect(saveButton).toBeDisabled();
    });
});

test.describe('中文 Web 自定义指令与 Skills 设置', () => {
    test.use({ locale: 'zh-CN' });

    test('自定义指令输入框使用可见标签且适配 800px 桌面断点', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings/custom-instructions'));

        const instructions = page.getByRole('textbox', { name: '指令内容' });
        await expect(instructions).toBeVisible();
        const inputBox = await instructions.boundingBox();
        expect(inputBox).not.toBeNull();
        expect(inputBox!.width).toBeGreaterThan(450);

        await instructions.focus();
        await expect(instructions).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(instructions).not.toBeFocused();
    });

    test('Skills 空态或搜索交互不会产生 key 或文本节点错误', async ({ page }) => {
        const renderErrors: string[] = [];
        page.on('console', (message) => {
            if (
                message.type() === 'error'
                && (
                    message.text().includes('Encountered two children with the same key')
                    || message.text().includes('Unexpected text node')
                )
            ) {
                renderErrors.push(message.text());
            }
        });

        await page.goto(authenticatedRoute('/settings/skills'));
        const search = page.getByRole('textbox', { name: '搜索名称或触发词…' });
        const noMachine = page.getByText('无在线机器，请先连接一台机器', { exact: true });
        await expect(search.or(noMachine)).toBeVisible();

        if (await search.isVisible()) {
            await search.fill('zzzz-audit-no-match');
            await expect(search).toHaveValue('zzzz-audit-no-match');
            // 隔离环境里的机器可能仍在扫描本机 Skills。搜索交互不应把
            // 合法的加载态误判为“无匹配”，两种可观察状态都属于稳定 UI。
            const noMatches = page.getByText('无匹配的 Skills', { exact: true });
            const loading = page.getByRole('progressbar');
            await expect(noMatches.or(loading)).toBeVisible();
            await search.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
            await search.press('Backspace');
            await expect(search).toHaveValue('');
        } else {
            await expect(noMachine).toBeVisible();
        }

        expect(renderErrors).toEqual([]);
    });
});

test.describe('中文 Web 功能与账户设置语义', () => {
    test.use({ locale: 'zh-CN' });

    test('所有功能开关使用可见标题作为名称并支持可逆切换', async ({ page }) => {
        await page.goto(authenticatedRoute('/settings/features'));

        const switchNames = [
            '文件差异侧边栏',
            '分组工具调用',
            '实验功能',
            'Markdown 复制 v2',
            '隐藏非活跃会话',
            '恢复会话',
            '桌面截图',
            '禁用分析',
            '回车发送',
            '命令面板',
        ];
        await expect(page.getByRole('switch')).toHaveCount(switchNames.length);
        for (const name of switchNames) {
            await expect(page.getByRole('switch', { name, exact: true })).toHaveCount(1);
        }

        const analyticsSwitch = page.getByRole('switch', { name: '禁用分析', exact: true });
        const wasChecked = await analyticsSwitch.isChecked();
        await analyticsSwitch.click();
        try {
            await expect(analyticsSwitch).toBeChecked({ checked: !wasChecked });
        } finally {
            if (await analyticsSwitch.isChecked() !== wasChecked) {
                await analyticsSwitch.click();
            }
        }
        await expect(analyticsSwitch).toBeChecked({ checked: wasChecked });
    });

    test('账户分析开关和破坏性确认框使用稳定按钮语义', async ({ page }) => {
        await page.goto(authenticatedRoute('/settings/account'));

        await expect(page.getByRole('switch', { name: '分析', exact: true })).toBeVisible();
        await page.getByText('登出', { exact: true }).click();

        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeVisible();
        await expect(dialog.getByRole('button', { name: '登出', exact: true })).toBeVisible();
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
        await expect(dialog).toHaveCount(0);
    });
});

test.describe('中文 Web 服务配置设置语义', () => {
    test.use({ locale: 'zh-CN' });

    test('Ask API 输入框使用可见标题且不修改配置', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings/ask'));

        const apiKey = page.locator('input[aria-label="API Key"]');
        const apiUrl = page.locator('input[aria-label="API URL"]');
        const searchKey = page.locator('input[aria-label="Tavily API Key"]');

        await expect(apiKey).toHaveAttribute('type', 'password');
        await expect(apiUrl).toHaveAttribute('type', 'url');
        await expect(searchKey).toHaveAttribute('type', 'password');
        await expect(page.getByRole('button', { name: '清除 Ask API' })).toBeDisabled();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
    });

    test('公开图片网关区分外部入口与只读状态', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings/public-image-gateway'));

        await expect(page.getByRole('button', { name: '打开公开页面' })).toHaveCount(1);
        await expect(page.getByRole('button', { name: '打开审核后台' })).toHaveCount(1);
        await expect(page.getByRole('button', { name: 'Mac mini worker' })).toHaveCount(0);
        await expect(page.getByText('Mac mini worker', { exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
    });
});

test.describe('中文 Web Agent 配置语义', () => {
    test.use({ locale: 'zh-CN' });

    test('智能体默认设置暴露展开状态与单选语义', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings/agents'));

        const permissionField = page.getByRole('button', { name: /权限/ }).first();
        await expect(permissionField).toHaveAttribute('aria-expanded', 'false');

        await permissionField.click();
        await expect(permissionField).toHaveAttribute('aria-expanded', 'true');

        const permissionGroup = page.getByRole('radiogroup', { name: '权限' }).first();
        await expect(permissionGroup).toBeVisible();
        await expect(permissionGroup.getByRole('radio', { name: /使用代码默认值/ })).toBeChecked();

        await permissionField.click();
        await expect(permissionField).toHaveAttribute('aria-expanded', 'false');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
    });

    test('新建 Agent 表单具备输入与选择语义且不保存配置', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings/my-agent-edit'));

        await expect(page.getByRole('textbox', { name: '名称' })).toHaveCount(1);
        await expect(page.getByRole('textbox', { name: '文件夹' })).toHaveAttribute('placeholder', '文件夹路径，如 ~');
        await expect(page.getByText('using custom path above', { exact: true })).toHaveCount(0);
        await expect(page.getByText('Recent', { exact: true })).toHaveCount(0);
        await expect(page.getByText('no recent projects yet', { exact: true })).toHaveCount(0);

        const kindGroup = page.getByRole('radiogroup', { name: 'Agent 类型' });
        await expect(kindGroup.getByRole('radio', { name: /标准 Agent/ })).toBeChecked();
        await expect(kindGroup.getByRole('radio', { name: /GPT Image 2 风格/ })).not.toBeChecked();

        await kindGroup.getByRole('radio', { name: /GPT Image 2 风格/ }).click();
        await expect(kindGroup.getByRole('radio', { name: /GPT Image 2 风格/ })).toBeChecked();
        await expect(page.getByRole('checkbox', { name: '山野旅行速写手帐' })).toBeChecked();

        const variants = page.getByRole('radiogroup', { name: '生成张数' });
        await expect(variants.getByRole('radio', { name: '每种风格 1 张' })).toBeChecked();

        await kindGroup.getByRole('radio', { name: /标准 Agent/ }).click();
        const flavorGroup = page.getByRole('radiogroup', { name: '编码 Agent' });
        await expect(flavorGroup.getByRole('radio', { name: '跟随默认' })).toBeChecked();

        await page.getByRole('button', { name: '添加预设' }).click();
        await expect(page.getByRole('textbox', { name: '标签' })).toHaveCount(1);
        await expect(page.getByRole('textbox', { name: '指令内容' })).toHaveCount(1);
        await page.getByRole('button', { name: '删除' }).click();

        await expect(page.getByRole('button', { name: '保存' })).toBeDisabled();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
    });
});

test.describe('中文 Web 工件与生成图片语义', () => {
    test.use({ locale: 'zh-CN' });

    test('工件空态、新建表单和校验提示均具备稳定语义', async ({ page }) => {
        const debugLogs: string[] = [];
        page.on('console', (message) => {
            if (message.text().includes('ArtifactsScreen:')) {
                debugLogs.push(message.text());
            }
        });

        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/artifacts'));

        await expect(page.getByText('暂无工件', { exact: true })).toBeVisible();
        const createButton = page.getByRole('button', { name: '新建工件', exact: true });
        await expect(createButton).toHaveCount(1);
        await expect(createButton).toBeVisible();
        await expect(createButton.getByText('新建工件', { exact: true })).toBeVisible();
        await createButton.focus();
        await expect(createButton).toBeFocused();
        await createButton.press('Enter');
        await expect.poll(() => new URL(page.url()).pathname).toBe('/artifacts/new');

        await expect(page.getByRole('textbox', { name: '标题', exact: true })).toHaveCount(1);
        await expect(page.getByRole('textbox', { name: '内容', exact: true })).toHaveCount(1);
        const saveButton = page.getByRole('button', { name: '保存', exact: true });
        await expect(saveButton).toHaveCount(1);
        await saveButton.click();

        const dialog = page.getByRole('dialog', { name: '错误', exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog).toHaveAccessibleDescription('请输入标题或内容');
        await dialog.getByRole('button', { name: '确定', exact: true }).click();
        await expect(dialog).toHaveCount(0);

        await page.getByRole('textbox', { name: '标题', exact: true }).fill('隔离测试工件');
        await page.getByRole('textbox', { name: '内容', exact: true }).fill('仅用于本次隔离 E2E，环境结束后自动删除。');
        await saveButton.click();
        await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/artifacts\/[^/]+$/);

        await page.goto(authenticatedRoute('/artifacts'));
        await expect.poll(() => new URL(page.url()).pathname).toBe('/artifacts');
        await expect(page.getByText('隔离测试工件', { exact: true })).toBeVisible();
        await expect(page.getByText('新建工件', { exact: true })).toHaveCount(0);
        const artifactFab = page.getByRole('button', { name: '新建工件', exact: true });
        await expect(artifactFab).toHaveCount(1);
        await expect(artifactFab).toBeVisible();
        await page.getByRole('button', { name: '隔离测试工件', exact: true }).click();
        await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/artifacts\/[^/]+$/);

        const editButton = page.getByRole('button', { name: '编辑工件', exact: true });
        const deleteButton = page.getByRole('button', { name: '删除', exact: true });
        await expect(editButton).toHaveCount(1);
        await expect(deleteButton).toHaveCount(1);

        await editButton.click();
        await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/artifacts\/edit\/[^/]+$/);
        await expect(page.getByRole('textbox', { name: '标题', exact: true })).toHaveCount(1);
        await expect(page.getByRole('textbox', { name: '内容', exact: true })).toHaveCount(1);
        await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
        await page.goBack();

        await deleteButton.click();
        const deleteDialog = page.getByRole('dialog', { name: '删除工件？', exact: true });
        await expect(deleteDialog).toBeVisible();
        await deleteDialog.getByRole('button', { name: '取消', exact: true }).click();
        await expect(deleteDialog).toHaveCount(0);

        await deleteButton.click();
        await page.getByRole('dialog', { name: '删除工件？', exact: true })
            .getByRole('button', { name: '删除', exact: true })
            .click();
        await expect.poll(() => new URL(page.url()).pathname).toBe('/artifacts');
        await expect(page.getByText('暂无工件', { exact: true })).toBeVisible();

        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
        expect(debugLogs).toEqual([]);
    });

    test('生成图片空态适配 800px 且不产生水平溢出', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/generated-images'));

        await expect(page.getByText('还没有生成图片', { exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
    });
});

test.describe('中文 Web 收件箱与好友语义', () => {
    test.use({ locale: 'zh-CN' });

    test('空态添加入口和好友搜索输入框具备稳定语义', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/inbox'));

        await expect(page.getByText('收件箱为空', { exact: true })).toBeVisible();
        const inboxAddButton = page.getByRole('button', {
            name: '添加好友',
            exact: true,
        });
        await expect(inboxAddButton).toHaveCount(1);
        await inboxAddButton.click();
        await expect.poll(() => new URL(page.url()).pathname).toBe('/friends/search');

        const searchInput = page.getByRole('textbox', {
            name: '输入用户名搜索好友',
            exact: true,
        });
        await expect(searchInput).toHaveCount(1);
        await searchInput.click();
        await expect(searchInput).toBeFocused();

        await page.goto(authenticatedRoute('/friends'));
        await expect(page.getByText('您还没有好友', { exact: true })).toBeVisible();
        const friendsAddButton = page.getByRole('button', {
            name: '添加好友',
            exact: true,
        });
        await expect(friendsAddButton).toHaveCount(1);
        await friendsAddButton.click();
        await expect.poll(() => new URL(page.url()).pathname).toBe('/friends/search');

        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
    });
});

test.describe('中文 Web 设置总览与开发者工具语义', () => {
    test.use({ locale: 'zh-CN' });

    test('列表入口排除装饰节点并保留业务详情，且更新日志导航正常', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings'));

        for (const name of ['更新日志, 查看最新更新和改进', '报告问题', '隐私政策', '服务条款']) {
            await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
        }
        await expect(page.getByRole('button', { name: /^主题设置, .+/ })).toHaveCount(1);
        await expect(page.getByRole('button', { name: /^语言切换, .+/ })).toHaveCount(1);
        await expect(page.getByRole('button', { name: /^Claude Code, (活跃|连接账户)$/ })).toHaveCount(1);
        await expect(page.getByRole('button', { name: /^GitHub, (已连接为 @.+|连接您的 GitHub 账户)$/ })).toHaveCount(1);
        await expect(page.getByRole('button', { name: /^版本, .+/ })).toHaveCount(1);

        await page.getByRole('button', { name: '更新日志, 查看最新更新和改进', exact: true }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe('/changelog');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);

        await page.goto(authenticatedRoute('/dev'));
        for (const name of [
            '列表组件, Item、ItemGroup 和 ItemList 演示',
            '排版, 所有排版样式',
            '颜色, 调色板和主题',
            '工具视图, 工具调用可视化组件',
            '输入样式, 10+ 种不同的输入框样式',
            '模态系统, Alert、confirm 和自定义弹窗',
        ]) {
            await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
    });
});

test.describe('中文 Web 安全组件演示主题与语义', () => {
    test.use({ locale: 'zh-CN' });

    test('排版、颜色和闪烁页跟随深色主题，列表开关有名称且可恢复', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Terminal', { exact: true }).click();

        for (const demo of [
            {
                path: '/dev/typography',
                screen: 'dev-typography-screen',
                heading: 'dev-typography-heading',
                background: 'rgb(19, 19, 22)',
                secondary: 'dev-typography-secondary',
                elevated: 'dev-typography-elevated',
                elevatedBackground: 'rgb(24, 24, 28)',
            },
            {
                path: '/dev/colors',
                screen: 'dev-colors-screen',
                heading: 'dev-colors-heading',
                background: 'rgb(19, 19, 22)',
                elevated: 'dev-colors-elevated',
                elevatedBackground: 'rgb(24, 24, 28)',
            },
            {
                path: '/dev/shimmer-demo',
                screen: 'dev-shimmer-screen',
                heading: 'dev-shimmer-heading',
                background: 'rgb(10, 10, 11)',
                secondary: 'dev-shimmer-secondary',
                elevated: 'dev-shimmer-elevated',
                elevatedBackground: 'rgb(19, 19, 22)',
            },
        ]) {
            await page.goto(authenticatedRoute(demo.path));
            const screen = page.getByTestId(demo.screen);
            const heading = page.getByTestId(demo.heading);
            await expect(screen).toBeVisible();
            await expect(screen).toHaveCSS('background-color', demo.background);
            await expect(heading).toHaveCSS('color', 'rgb(229, 229, 231)');
            if (demo.secondary) {
                await expect(page.getByTestId(demo.secondary)).toHaveCSS('color', 'rgb(107, 107, 118)');
            }
            await expect(page.getByTestId(demo.elevated)).toHaveCSS(
                'background-color',
                demo.elevatedBackground,
            );
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
        }

        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto(authenticatedRoute('/dev/typography'));
        await expect(page.getByTestId('dev-typography-screen')).toHaveCSS(
            'background-color',
            'rgb(255, 255, 255)',
        );
        await expect(page.getByTestId('dev-typography-heading')).toHaveCSS('color', 'rgb(22, 32, 26)');
        await expect(page.getByTestId('dev-typography-secondary')).toHaveCSS('color', 'rgb(107, 122, 112)');
        await expect(page.getByTestId('dev-typography-elevated')).toHaveCSS(
            'background-color',
            'rgb(237, 241, 237)',
        );

        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto(authenticatedRoute('/dev/list-demo'));
        const toggle = page.getByRole('switch', { name: '开关', exact: true });
        await expect(toggle).toHaveCount(1);
        await expect(toggle).not.toBeChecked();
        await toggle.click();
        await expect(toggle).toBeChecked();
        await toggle.click();
        await expect(toggle).not.toBeChecked();

        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Caramel', { exact: true }).click();
        await page.goto(authenticatedRoute('/dev/typography'));
        await expect(page.getByTestId('dev-typography-screen')).toHaveCSS(
            'background-color',
            'rgb(36, 28, 23)',
        );
    });
});

test.describe('中文 Web 消息与工具演示', () => {
    test.use({ locale: 'zh-CN' });

    test('宽屏图片消息与正文阅读列对齐，不再横向铺满', async ({ page }) => {
        await page.setViewportSize({ width: 1600, height: 900 });
        await page.goto(authenticatedRoute('/dev/messages-demo'));

        const host = page.getByTestId('dev-featured-gallery-host');
        const gallery = page.getByTestId('attachment-gallery-featured');
        await expect(host).toBeVisible();
        await expect(gallery).toBeVisible();

        const layout = await host.evaluate((hostElement) => {
            const galleryElement = hostElement.querySelector(
                '[data-testid="attachment-gallery-featured"]',
            );
            if (!(galleryElement instanceof HTMLElement)) {
                throw new Error('找不到特色图片消息容器');
            }
            const hostRect = hostElement.getBoundingClientRect();
            const galleryRect = galleryElement.getBoundingClientRect();
            return {
                hostWidth: hostRect.width,
                galleryWidth: galleryRect.width,
                leftGap: galleryRect.left - hostRect.left,
                rightGap: hostRect.right - galleryRect.right,
            };
        });

        expect(layout.hostWidth).toBeGreaterThan(800);
        expect(layout.galleryWidth).toBeLessThanOrEqual(800);
        expect(Math.abs(layout.leftGap - layout.rightGap)).toBeLessThanOrEqual(1);
    });

    test('消息表格与代码在窄屏内横向滚动，图片操作具备名称', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/dev/messages-demo'));

        const tableScroll = page.getByTestId('markdown-table-scroll').first();
        const codeScroll = page.getByTestId('markdown-code-scroll').first();
        await expect(tableScroll).toBeVisible();
        await expect(codeScroll).toBeVisible();

        for (const scrollArea of [tableScroll, codeScroll]) {
            const dimensions = await scrollArea.evaluate((element) => ({
                clientWidth: element.clientWidth,
                scrollWidth: element.scrollWidth,
            }));
            expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
        }

        await expect(page.getByRole('button', {
            name: 'Markdown renderable image',
            exact: true,
        })).toHaveCount(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
    });

    test('工具页跟随深色主题并让七组筛选呈现完整示例', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Terminal', { exact: true }).click();
        await page.goto(authenticatedRoute('/dev/tools2'));

        await expect(page.getByTestId('dev-tools-screen')).toHaveCSS(
            'background-color',
            'rgb(10, 10, 11)',
        );
        await expect(page.getByTestId('dev-tools-heading')).toHaveCSS('color', 'rgb(229, 229, 231)');
        await expect(page.getByTestId('dev-tools-description')).toHaveCSS('color', 'rgb(107, 107, 118)');

        for (const filter of [
            { id: 'all', keys: ['read', 'readError', 'edit', 'bash', 'bashRunning', 'bashError', 'bashLongCommand', 'bashMultiline', 'bashLargeOutput', 'bashNoOutput', 'bashWithWarnings', 'search', 'write', 'toolPending', 'toolApproved', 'toolDenied', 'toolCanceled'] },
            { id: 'read', keys: ['read', 'readError'] },
            { id: 'edit', keys: ['edit'] },
            { id: 'bash', keys: ['bash', 'bashRunning', 'bashError', 'bashLongCommand', 'bashMultiline', 'bashLargeOutput', 'bashNoOutput', 'bashWithWarnings'] },
            { id: 'other', keys: ['search', 'write'] },
            { id: 'permissions', keys: ['toolPending', 'toolApproved', 'toolDenied', 'toolCanceled'] },
            { id: 'status', keys: ['bashRunning', 'bash', 'bashError', 'toolDenied', 'toolCanceled'] },
        ]) {
            const radio = page.getByTestId(`dev-tools-filter-${filter.id}`);
            await expect(radio).toHaveAttribute('role', 'radio');
            await radio.click();
            await expect(radio).toHaveAttribute('aria-checked', 'true');
            const renderedKeys = await page.locator('[data-testid^="dev-tool-example-"]')
                .evaluateAll((elements) => elements.map((element) => (
                    element.getAttribute('data-testid')?.replace('dev-tool-example-', '')
                )));
            expect(renderedKeys).toEqual(filter.keys);
            expect(new Set(renderedKeys).size).toBe(renderedKeys.length);
        }

        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);

        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Caramel', { exact: true }).click();
        await page.goto(authenticatedRoute('/dev/tools2'));
        await expect(page.getByTestId('dev-tools-screen')).toHaveCSS(
            'background-color',
            'rgb(26, 21, 18)',
        );
    });
});

test.describe('中文 Web 输入与倒序列表演示', () => {
    test.use({ locale: 'zh-CN' });

    test('倒序列表控件具备选择语义且 Web 不会启用 LegendList', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Terminal', { exact: true }).click();
        await page.goto(authenticatedRoute('/dev/inverted-list'));

        await expect(page.getByTestId('dev-inverted-list-screen')).toHaveCSS(
            'background-color',
            'rgb(10, 10, 11)',
        );
        await expect(page.getByRole('radiogroup', { name: '列表实现：' })).toHaveCount(1);
        await expect(page.getByRole('radiogroup', { name: '内边距方式：' })).toHaveCount(1);
        await expect(page.getByRole('radio')).toHaveCount(6);

        const flatList = page.getByTestId('dev-inverted-list-type-flat');
        await flatList.click();
        await expect(flatList).toHaveAttribute('aria-checked', 'true');

        const headerFooter = page.getByTestId('dev-inverted-list-padding-header-footer');
        await headerFooter.click();
        await expect(headerFooter).toHaveAttribute('aria-checked', 'true');

        const legendList = page.getByTestId('dev-inverted-list-type-legend');
        await expect(legendList).toHaveAttribute('role', 'radio');
        await expect(legendList).toHaveAttribute('aria-disabled', 'true');
        await expect(legendList).toHaveAttribute('aria-checked', 'false');
        await expect(legendList).toHaveAccessibleName('LegendList, 仅原生端可用');

        const input = page.getByRole('textbox', { name: '输入消息...' });
        const send = page.getByRole('button', { name: '发送', exact: true });
        await expect(send).toBeDisabled();
        await input.fill('本地倒序列表回归');
        await expect(send).toBeEnabled();
        await send.click();
        await expect(page.getByText('本地倒序列表回归', { exact: true })).toBeVisible();
        await expect(input).toHaveValue('');

        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
    });

    test('多行输入与输入样式在深色主题下可操作且不会污染 Tab 顺序', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Terminal', { exact: true }).click();
        await page.goto(authenticatedRoute('/dev/multi-text-input'));

        await expect(page.getByTestId('dev-multi-text-input-screen')).toHaveCSS(
            'background-color',
            'rgb(10, 10, 11)',
        );
        const inputNames = [
            '基础用法',
            '带初始值',
            '限制高度（60px）',
            '更大高度（200px）',
            '键盘处理',
        ];
        for (const name of inputNames) {
            await expect(page.getByRole('textbox', { name, exact: true })).toHaveCount(1);
        }

        const basicInput = page.getByRole('textbox', { name: '基础用法', exact: true });
        await basicInput.fill('可访问名称回归');
        await expect(basicInput).toHaveValue('可访问名称回归');

        const keyboardInput = page.getByRole('textbox', { name: '键盘处理', exact: true });
        await keyboardInput.fill('按键清空回归');
        await keyboardInput.press('Escape');
        await expect(keyboardInput).toHaveValue('');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);

        await page.goto(authenticatedRoute('/dev/input-styles'));
        await expect(page.getByTestId('dev-input-styles-screen')).toHaveCSS(
            'background-color',
            'rgb(10, 10, 11)',
        );
        await expect(page.getByTestId('dev-input-styles-heading')).toHaveCSS(
            'color',
            'rgb(229, 229, 231)',
        );
        await expect(page.getByTestId('dev-input-styles-description')).toHaveCSS(
            'color',
            'rgb(107, 107, 118)',
        );

        const styleCards = page.locator('[data-testid^="dev-input-style-"]');
        await expect(styleCards).toHaveCount(22);
        for (let index = 0; index < 22; index += 1) {
            const card = styleCards.nth(index);
            await expect(card).toHaveAttribute('role', 'radio');
            await card.click();
            await expect(card).toHaveAttribute('aria-checked', 'true');
        }

        const nestedFocusableCount = await styleCards.evaluateAll((cards) => (
            cards.reduce(
                (count, card) => count + card.querySelectorAll('[tabindex="0"]').length,
                0,
            )
        ));
        expect(nestedFocusableCount).toBe(0);

        const previewInputs = page
            .getByTestId('dev-input-styles-screen')
            .getByRole('textbox', { includeHidden: true });
        await expect(previewInputs).toHaveCount(23);
        for (let index = 0; index < 23; index += 1) {
            await expect(previewInputs.nth(index)).toHaveAttribute('tabindex', '-1');
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);

        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Caramel', { exact: true }).click();
        await page.goto(authenticatedRoute('/dev/input-styles'));
        await expect(page.getByTestId('dev-input-styles-screen')).toHaveCSS(
            'background-color',
            'rgb(26, 21, 18)',
        );
    });
});

test.describe('中文 Web 运行时演示', () => {
    test.use({ locale: 'zh-CN' });

    test('日志操作具备稳定名称且应用内测试汇总跟随深色主题', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Terminal', { exact: true }).click();
        await page.goto(authenticatedRoute('/dev/logs'));

        await expect(page.getByTestId('dev-logs-screen')).toHaveCSS(
            'background-color',
            'rgb(10, 10, 11)',
        );
        await expect(page.getByTestId('dev-logs-surface')).toHaveCSS(
            'background-color',
            'rgb(19, 19, 22)',
        );
        await expect(page.getByRole('button', { name: '添加测试日志', exact: true })).toHaveCount(1);
        await expect(page.getByRole('button', { name: '复制全部日志', exact: true })).toHaveCount(1);
        const clearLogs = page.getByRole('button', { name: '清除全部日志', exact: true });
        await expect(clearLogs).toHaveCount(1);

        await page.getByRole('button', { name: '添加测试日志', exact: true }).click();
        await clearLogs.click();
        const clearDialog = page.getByRole('dialog', { name: '清除日志', exact: true });
        await expect(clearDialog).toBeVisible();
        await clearDialog.getByRole('button', { name: '取消', exact: true }).click();
        await expect(clearDialog).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);

        await page.goto(authenticatedRoute('/dev/tests'));
        await page.getByRole('button', { name: /运行全部测试/ }).click();
        const summary = page.getByTestId('dev-tests-summary');
        await expect(summary).toBeVisible();
        await expect(summary).toHaveCSS('background-color', 'rgb(19, 19, 22)');
        const totalTests = Number(await page.getByTestId('dev-tests-total').textContent());
        const passedTests = Number(await page.getByTestId('dev-tests-passed').textContent());
        const failedTests = Number(await page.getByTestId('dev-tests-failed').textContent());
        expect(totalTests).toBeGreaterThan(0);
        expect(passedTests).toBe(totalTests);
        expect(failedTests).toBe(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
    });

    test('Unistyles 主题选择保留主题包并暴露实时状态', async ({ page }) => {
        const deprecatedShadowWarnings: string[] = [];
        page.on('console', (message) => {
            if (
                message.type() === 'warning'
                && message.text().includes('"shadow*" style props are deprecated')
            ) {
                deprecatedShadowWarnings.push(message.text());
            }
        });
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Terminal', { exact: true }).click();
        await page.goto(authenticatedRoute('/dev/unistyles-demo'));

        await expect(page.getByTestId('dev-unistyles-screen')).toHaveCSS(
            'background-color',
            'rgb(10, 10, 11)',
        );
        await expect(page.getByTestId('dev-unistyles-theme-heading')).toHaveCSS(
            'color',
            'rgb(229, 229, 231)',
        );
        const themeGroup = page.getByRole('radiogroup', { name: '主题系统', exact: true });
        const lightTheme = themeGroup.getByRole('radio', { name: '浅色', exact: true });
        const darkTheme = themeGroup.getByRole('radio', { name: '深色', exact: true });
        await expect(lightTheme).toHaveAttribute('aria-checked', 'false');
        await expect(darkTheme).toHaveAttribute('aria-checked', 'true');

        await lightTheme.click();
        await expect(page.getByText('当前主题：terminalLight', { exact: true })).toBeVisible();
        await expect(lightTheme).toHaveAttribute('aria-checked', 'true');
        await darkTheme.click();
        await expect(page.getByText('当前主题：terminalDark', { exact: true })).toBeVisible();
        await expect(darkTheme).toHaveAttribute('aria-checked', 'true');

        const runtimeSwitch = page.getByRole('switch', { name: '显示运行时详情', exact: true });
        await expect(runtimeSwitch).toBeChecked();
        await runtimeSwitch.click();
        await expect(runtimeSwitch).not.toBeChecked();
        await runtimeSwitch.click();
        await expect(runtimeSwitch).toBeChecked();

        await expect(page.getByTestId('dev-unistyles-color-scheme')).toHaveCount(0);
        await expect(page.getByTestId('dev-unistyles-breakpoint-description')).toContainText('800');
        await expect(page.getByTestId('dev-unistyles-breakpoint-description')).not.toContainText('1440');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
        expect(deprecatedShadowWarnings).toEqual([]);

        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Caramel', { exact: true }).click();
    });
});

test.describe('中文 Web 二维码与会话编辑器演示', () => {
    test.use({ locale: 'zh-CN' });

    test('二维码空输入保持页面稳定且所有图形都有持久名称', async ({ page }) => {
        let warningCount = 0;
        let errorCount = 0;
        let failedRequestCount = 0;
        const consoleErrorKinds: string[] = [];
        const failedRequestTypes: string[] = [];
        const failedRequestReasons: string[] = [];
        page.on('console', (message) => {
            if (message.type() === 'warning') warningCount += 1;
            if (message.type() === 'error') {
                errorCount += 1;
                consoleErrorKinds.push(
                    message.text().includes('Failed to load resource')
                        ? 'resource-load'
                        : 'other',
                );
            }
        });
        page.on('requestfailed', (request) => {
            if (['fetch', 'xhr'].includes(request.resourceType())) {
                failedRequestCount += 1;
                failedRequestTypes.push(request.resourceType());
                const reason = request.failure()?.errorText;
                failedRequestReasons.push(
                    reason?.startsWith('net::')
                        ? reason.split(' ')[0]
                        : 'other',
                );
            }
        });

        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/dev/qr-test'));

        const screen = page.getByTestId('dev-qr-screen');
        const input = page.getByTestId('dev-qr-custom-input');
        await expect(screen).toBeVisible();
        await expect(input).toHaveAccessibleName(/.+/);
        await expect(screen.getByRole('img')).toHaveCount(17);
        await page.waitForTimeout(300);
        const loadEvidence = {
            warningCount,
            errorCount,
            failedRequestCount,
            consoleErrorKinds: [...consoleErrorKinds].sort(),
            failedRequestTypes: [...failedRequestTypes].sort(),
            failedRequestReasons: [...failedRequestReasons].sort(),
        };
        expect(loadEvidence).toEqual(expectedIsolatedDevRouteLoadEvidence);
        const actionBaseline = { warningCount, errorCount, failedRequestCount };

        await input.fill('');

        await expect(screen).toBeVisible();
        await expect(screen.getByRole('img')).toHaveCount(16);
        await expect(page).toHaveURL(authenticatedRoute('/dev/qr-test'));
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
        expect({
            warningCount: warningCount - actionBaseline.warningCount,
            errorCount: errorCount - actionBaseline.errorCount,
            failedRequestCount: failedRequestCount - actionBaseline.failedRequestCount,
        }).toEqual({
            warningCount: 0,
            errorCount: 0,
            failedRequestCount: 0,
        });
    });

    test('会话编辑器配置与选择器暴露完整语义且没有空操作焦点', async ({ page }) => {
        let warningCount = 0;
        let errorCount = 0;
        let failedRequestCount = 0;
        const consoleErrorKinds: string[] = [];
        const failedRequestTypes: string[] = [];
        const failedRequestReasons: string[] = [];
        page.on('console', (message) => {
            if (message.type() === 'warning') warningCount += 1;
            if (message.type() === 'error') {
                errorCount += 1;
                consoleErrorKinds.push(
                    message.text().includes('Failed to load resource')
                        ? 'resource-load'
                        : 'other',
                );
            }
        });
        page.on('requestfailed', (request) => {
            if (['fetch', 'xhr'].includes(request.resourceType())) {
                failedRequestCount += 1;
                failedRequestTypes.push(request.resourceType());
                const reason = request.failure()?.errorText;
                failedRequestReasons.push(
                    reason?.startsWith('net::')
                        ? reason.split(' ')[0]
                        : 'other',
                );
            }
        });

        await page.setViewportSize({ width: 800, height: 900 });
        await page.goto(authenticatedRoute('/dev/session-composer'));

        const screen = page.getByTestId('dev-composer-screen');
        await expect(screen).toBeVisible();
        for (const testID of [
            'dev-composer-machine',
            'dev-composer-path',
            'dev-composer-agent',
            'dev-composer-model',
            'dev-composer-effort',
            'dev-composer-permission',
            'dev-composer-worktree',
        ]) {
            const trigger = page.getByTestId(testID);
            await expect(trigger).toHaveAttribute('role', 'button');
            await expect(trigger).toHaveAccessibleName(/.+/);
        }
        await page.waitForTimeout(300);
        const loadEvidence = {
            warningCount,
            errorCount,
            failedRequestCount,
            consoleErrorKinds: [...consoleErrorKinds].sort(),
            failedRequestTypes: [...failedRequestTypes].sort(),
            failedRequestReasons: [...failedRequestReasons].sort(),
        };
        expect(loadEvidence).toEqual(expectedIsolatedDevRouteLoadEvidence);
        const actionBaseline = { warningCount, errorCount, failedRequestCount };

        const machine = page.getByTestId('dev-composer-machine');
        await expect(machine).toHaveAttribute('aria-expanded', 'false');
        await machine.click();
        await expect(machine).toHaveAttribute('aria-expanded', 'true');

        const picker = page.getByTestId('dev-composer-picker');
        await expect(picker).toHaveAttribute('role', 'dialog');
        await expect(picker).toHaveAccessibleName(/.+/);
        await expect(picker.getByRole('radiogroup')).toHaveCount(1);
        await expect(picker.getByRole('radio')).toHaveCount(3);
        await expect(picker.getByRole('radio', { checked: true })).toHaveCount(1);
        await expect(picker.getByRole('textbox')).toHaveAccessibleName(/.+/);
        await picker.getByRole('radio').nth(1).click();
        await expect(picker).toHaveCount(0);

        const input = page.getByTestId('dev-composer-input');
        await expect(input).toHaveAccessibleName(/.+/);
        await input.fill('本地演示');
        const collapsedConfig = page.getByTestId('dev-composer-config-toggle');
        await expect(collapsedConfig).toHaveAttribute('role', 'button');
        await expect(collapsedConfig).toHaveAttribute('aria-expanded', 'false');
        const sendVisual = page.getByTestId('dev-composer-send-visual');
        await expect(sendVisual).not.toHaveAttribute('role', /.+/);
        await expect(sendVisual).not.toHaveAttribute('tabindex', /.+/);
        await expect(sendVisual).not.toHaveAttribute('aria-label', /.+/);
        await expect(sendVisual.locator('[role="button"], [tabindex="0"]')).toHaveCount(0);
        await expect(screen.locator('[tabindex="0"]:not([role]):not([aria-label])')).toHaveCount(0);
        await input.fill('');

        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
        expect({
            warningCount: warningCount - actionBaseline.warningCount,
            errorCount: errorCount - actionBaseline.errorCount,
            failedRequestCount: failedRequestCount - actionBaseline.failedRequestCount,
        }).toEqual({
            warningCount: 0,
            errorCount: 0,
            failedRequestCount: 0,
        });
    });
});
