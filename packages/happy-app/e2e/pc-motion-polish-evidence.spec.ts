import { expect, test, type APIRequestContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io } from 'socket.io-client';
import { decodeBase64, decryptLegacy, encodeBase64, encryptLegacy } from '../../happy-cli/src/api/encryption';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const e2eServerUrl = process.env.HAPPY_E2E_SERVER_URL!;
const evidenceDir = process.env.HAPPY_PC_MOTION_EVIDENCE_DIR;
const evidencePhase = process.env.HAPPY_PC_MOTION_EVIDENCE_PHASE === 'before' ? 'before' : 'after';
const isAfter = evidencePhase === 'after';
const fileTransitionPhase = process.env.HAPPY_PC_FILE_TRANSITION_PHASE === 'after' ? 'after' : 'before';
const isFileTransitionAfter = fileTransitionPhase === 'after';

if (evidenceDir) test.use({ video: 'on' });

function authenticatedRoute(pathname: string): string {
    const url = new URL(authenticatedWebUrl);
    url.pathname = pathname;
    return url.toString();
}

function evidencePath(testInfo: TestInfo, fileName: string): string {
    if (!evidenceDir) return testInfo.outputPath(fileName);
    mkdirSync(evidenceDir, { recursive: true });
    return join(evidenceDir, fileName);
}

async function createSession(request: APIRequestContext): Promise<string> {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    const secret = authUrl.searchParams.get('dev_secret');
    if (!token || !secret || !e2eServerUrl) {
        throw new Error('缺少创建动效验收会话所需的本地认证配置。');
    }

    const encryptionKey = new Uint8Array(Buffer.from(secret, 'base64url'));
    const metadata = encodeBase64(encryptLegacy({
        path: '/workspace/pc-motion-polish',
        host: 'playwright-motion',
        name: 'PC motion acceptance',
        summary: { text: 'PC motion acceptance', updatedAt: Date.now() },
        flavor: 'codex',
        lifecycleState: 'running',
        startedBy: 'terminal',
    }, encryptionKey));
    const response = await request.post(new URL('/v1/sessions', e2eServerUrl).toString(), {
        data: {
            tag: `pc-motion-e2e-${Date.now()}-${Math.random()}`,
            metadata,
            agentState: null,
            dataEncryptionKey: null,
        },
        headers: {
            Authorization: `Bearer ${token}`,
            'X-Happy-Client': 'playwright-pc-motion',
        },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json() as { session: { id: string } };
    return body.session.id;
}

async function createConnectedFileSession(request: APIRequestContext): Promise<{
    changedFile: string;
    close: () => void;
    rpcCalls: Array<{ method: string; params: { command?: string; path?: string } | null }>;
    secondFile: string;
    sessionId: string;
    workspace: string;
}> {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    const secret = authUrl.searchParams.get('dev_secret');
    if (!token || !secret || !e2eServerUrl) {
        throw new Error('缺少创建文件动效验收会话所需的本地认证配置。');
    }

    const workspace = mkdtempSync(join(tmpdir(), 'happy-file-motion-e2e-'));
    const changedFile = 'src/changed-motion.ts';
    const secondFile = 'src/second-motion.ts';
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, changedFile), 'export const changedMotion = true;\n', 'utf8');
    writeFileSync(join(workspace, secondFile), 'export const secondMotion = true;\n', 'utf8');
    const bashReplies = (command: string) => {
        if (command.includes('status --porcelain=v2')) {
            return '# branch.head main\n? src/changed-motion.ts\n';
        }
        if (command.includes('diff --numstat')) {
            return '1\t0\tsrc/changed-motion.ts\n---STAGED---\n';
        }
        if (command.includes('ls-files')) {
            return `${changedFile}\n${secondFile}\n`;
        }
        return '';
    };

    const encryptionKey = new Uint8Array(Buffer.from(secret, 'base64url'));
    const metadata = encodeBase64(encryptLegacy({
        path: workspace,
        homeDir: workspace,
        host: 'playwright-file-motion',
        machineId: 'playwright-file-motion-machine',
        name: 'File motion',
        summary: { text: 'File motion', updatedAt: Date.now() },
        flavor: 'codex',
        lifecycleState: 'running',
        startedBy: 'terminal',
    }, encryptionKey));
    const response = await request.post(new URL('/v1/sessions', e2eServerUrl).toString(), {
        data: {
            tag: `pc-file-motion-e2e-${Date.now()}-${Math.random()}`,
            metadata,
            agentState: null,
            dataEncryptionKey: null,
        },
        headers: {
            Authorization: `Bearer ${token}`,
            'X-Happy-Client': 'playwright-file-motion',
        },
    });
    if (!response.ok()) {
        rmSync(workspace, { force: true, recursive: true });
        throw new Error(`创建文件动效验收会话失败：HTTP ${response.status()}`);
    }
    const body = await response.json() as { session: { id: string } };
    const sessionId = body.session.id;
    const rpcCalls: Array<{ method: string; params: { command?: string; path?: string } | null }> = [];
    const rpcSocket = io(e2eServerUrl, {
        auth: {
            token,
            clientType: 'session-scoped',
            sessionId,
            happyClient: 'playwright-file-motion-rpc',
        },
        autoConnect: false,
        path: '/v1/updates',
        reconnection: false,
        transports: ['websocket'],
    });
    rpcSocket.on('rpc-request', (
        data: { method: string; params: string },
        callback: (responseValue: string) => void,
    ) => {
        const params = decryptLegacy(decodeBase64(data.params), encryptionKey) as {
            command?: string;
            path?: string;
        } | null;
        rpcCalls.push({ method: data.method, params });
        let result: unknown;
        if (data.method === `${sessionId}:bash`) {
            result = {
                success: true,
                stdout: bashReplies(params?.command ?? ''),
                stderr: '',
                exitCode: 0,
            };
        } else if (data.method === `${sessionId}:readFile`) {
            const fileContent = params?.path === changedFile || params?.path === join(workspace, changedFile)
                ? 'export const changedMotion = true;\n'
                : params?.path === secondFile || params?.path === join(workspace, secondFile)
                    ? 'export const secondMotion = true;\n'
                    : null;
            result = fileContent === null
                ? { success: false, error: 'Unknown E2E file' }
                : { success: true, content: Buffer.from(fileContent, 'utf8').toString('base64') };
        } else {
            result = { success: false, error: 'Unknown E2E RPC request' };
        }
        callback(encodeBase64(encryptLegacy(result, encryptionKey)));
    });

    try {
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('文件动效 E2E RPC 连接超时。')), 10_000);
            const handleConnectError = (error: Error) => {
                clearTimeout(timeout);
                reject(error);
            };
            rpcSocket.once('connect_error', handleConnectError);
            rpcSocket.once('connect', () => {
                rpcSocket.off('connect_error', handleConnectError);
                const pendingMethods = new Set([
                    `${sessionId}:bash`,
                    `${sessionId}:readFile`,
                ]);
                const handleRegistered = ({ method }: { method: string }) => {
                    pendingMethods.delete(method);
                    if (pendingMethods.size === 0) {
                        clearTimeout(timeout);
                        rpcSocket.off('rpc-registered', handleRegistered);
                        resolve();
                    }
                };
                rpcSocket.on('rpc-registered', handleRegistered);
                rpcSocket.emit('rpc-register', { method: `${sessionId}:bash` });
                rpcSocket.emit('rpc-register', { method: `${sessionId}:readFile` });
            });
            rpcSocket.connect();
        });
    } catch (error) {
        rpcSocket.close();
        rmSync(workspace, { force: true, recursive: true });
        throw error;
    }

    return {
        changedFile,
        close: () => {
            rpcSocket.close();
            rmSync(workspace, { force: true, recursive: true });
        },
        secondFile,
        rpcCalls,
        sessionId,
        workspace,
    };
}

type PresenceLayerReading = {
    direction: string | null;
    opacity: string;
    phase: string | null;
    pointerEvents: string;
    transform: string;
};

type PresenceTransitionReading = {
    intermediate: PresenceLayerReading[];
    settled: PresenceLayerReading[];
};

type TabTransitionReading = {
    transitionDuration: string;
    transitionProperty: string;
};

async function enableFileDiffsSidebar(page: Page): Promise<void> {
    await page.goto(authenticatedRoute('/settings/features'));
    const toggle = page.getByRole('switch', { name: 'File Diffs Sidebar' });
    await expect(toggle).toBeVisible();
    if (!await toggle.isChecked()) {
        const settingsSaved = page.waitForResponse((response) => (
            response.request().method() === 'POST'
            && new URL(response.url()).pathname === '/v1/account/settings'
        ));
        await toggle.click();
        const response = await settingsSaved;
        expect(response.ok()).toBe(true);
        expect(await response.finished()).toBeNull();
    }
    await expect(toggle).toBeChecked();
}

async function readPresenceLayers(page: Page, hostTestId: string): Promise<PresenceLayerReading[]> {
    // Expo Router can retain earlier route trees, so the last matching Host is
    // the active route. Only read direct layers: a right-panel layer can contain
    // another Presence Host for the FilesSidebar tabs.
    return page.getByTestId(hostTestId).last().locator(':scope > [data-happy-presence-phase]').evaluateAll((layers) => (
        layers.map((layer) => {
            const style = getComputedStyle(layer);
            return {
                direction: layer.getAttribute('data-happy-presence-direction'),
                opacity: style.opacity,
                phase: layer.getAttribute('data-happy-presence-phase'),
                pointerEvents: style.pointerEvents,
                transform: style.transform,
            };
        })
    ));
}

async function clickAndReadPresence(
    page: Page,
    trigger: Locator,
    hostTestId: string,
): Promise<PresenceTransitionReading> {
    await trigger.click();
    await page.waitForTimeout(40);
    const intermediate = await readPresenceLayers(page, hostTestId);
    await page.waitForTimeout(180);
    const settled = await readPresenceLayers(page, hostTestId);
    return { intermediate, settled };
}

async function pressEnterAndReadPresence(
    page: Page,
    trigger: Locator,
    hostTestId: string,
): Promise<PresenceTransitionReading> {
    await trigger.focus();
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(40);
    const intermediate = await readPresenceLayers(page, hostTestId);
    await page.waitForTimeout(180);
    const settled = await readPresenceLayers(page, hostTestId);
    await expect(trigger).toBeFocused();
    expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true);
    return { intermediate, settled };
}

async function rapidSwitchAndReadPresence(
    page: Page,
    firstTrigger: Locator,
    secondTrigger: Locator,
    hostTestId: string,
): Promise<PresenceLayerReading[][]> {
    await firstTrigger.click();
    await page.waitForTimeout(30);
    const afterFirst = await readPresenceLayers(page, hostTestId);
    await secondTrigger.click();
    await page.waitForTimeout(30);
    const afterSecond = await readPresenceLayers(page, hostTestId);
    await page.waitForTimeout(190);
    const settled = await readPresenceLayers(page, hostTestId);
    return [afterFirst, afterSecond, settled];
}

async function readTabTransition(trigger: Locator): Promise<TabTransitionReading> {
    return trigger.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
            transitionDuration: style.transitionDuration,
            transitionProperty: style.transitionProperty,
        };
    });
}

function expectPresenceTransition(
    reading: PresenceTransitionReading,
    expected: {
        direction: 'back' | 'forward';
        exitingCount: number;
        intermediateCount: number;
        settledCount: number;
    },
): void {
    if (!isFileTransitionAfter) {
        expect(reading.intermediate).toEqual([]);
        expect(reading.settled).toEqual([]);
        return;
    }
    expect(reading.intermediate).toHaveLength(expected.intermediateCount);
    expect(new Set(reading.intermediate.map((layer) => layer.direction))).toEqual(new Set([expected.direction]));
    const exiting = reading.intermediate.filter((layer) => layer.phase === 'exiting');
    expect(exiting).toHaveLength(expected.exitingCount);
    if (expected.exitingCount === 1) expect(exiting[0]?.pointerEvents).toBe('none');
    expect(reading.settled).toHaveLength(expected.settledCount);
    if (expected.settledCount === 1) expect(reading.settled[0]?.phase).toBe('settled');
}

function expectRapidPresence(readings: PresenceLayerReading[][], reducedMotion: boolean): void {
    expect(Math.max(...readings.map((layers) => layers.length))).toBeLessThanOrEqual(2);
    if (!isFileTransitionAfter) {
        expect(readings.flat()).toEqual([]);
        return;
    }
    if (reducedMotion) {
        expect(readings.flat().some((layer) => layer.phase === 'entering' || layer.phase === 'exiting')).toBe(false);
    }
    expect(readings.at(-1)).toHaveLength(1);
}

function expectTabTransition(reading: TabTransitionReading): void {
    if (!isFileTransitionAfter) return;
    expect(reading.transitionDuration.split(',').map((duration) => duration.trim())).toContain('0.12s');
    const properties = reading.transitionProperty.split(',').map((property) => property.trim());
    expect(properties.length).toBeGreaterThan(0);
    expect(properties.every((property) => property === 'background-color' || property === 'color')).toBe(true);
}

function presenceDirection(reading: PresenceTransitionReading): string | null {
    return reading.intermediate.find((layer) => layer.direction)?.direction ?? null;
}

async function pauseForReview(page: Page, duration = 850): Promise<void> {
    if (process.env.HAPPY_E2E_RECORD === '1') {
        await page.waitForTimeout(duration);
    }
}

async function largestCanvas(page: Page) {
    const index = await page.locator('canvas').evaluateAll((canvases) => {
        let bestIndex = -1;
        let bestArea = 0;
        canvases.forEach((canvas, candidateIndex) => {
            const rect = canvas.getBoundingClientRect();
            const area = rect.width * rect.height;
            if (area > bestArea) {
                bestArea = area;
                bestIndex = candidateIndex;
            }
        });
        return bestIndex;
    });
    if (index < 0) throw new Error('没有找到首页粒子 Canvas。');
    return page.locator('canvas').nth(index);
}

async function canvasPixelHash(page: Page): Promise<number> {
    const canvas = await largestCanvas(page);
    return canvas.evaluate((node) => {
        const target = node as HTMLCanvasElement;
        const context = target.getContext('2d');
        if (!context) throw new Error('首页粒子 Canvas 没有 2D context。');
        const pixels = context.getImageData(0, 0, target.width, target.height).data;
        let hash = 2166136261;
        for (let index = 0; index < pixels.length; index += 16) {
            hash ^= pixels[index] ?? 0;
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    });
}

type PanelMotionReading = {
    opacity: string;
    state: string | null;
    transform: string;
    transitionDuration: string;
    visibility: string;
};

async function toggleAndSamplePanelMotion(
    page: Page,
    triggerTestId: string,
    panelSelectors: string[],
): Promise<{ motion: string | null; readings: PanelMotionReading[] }> {
    return page.evaluate(async ({ panelSelectors: selectors, triggerTestId: triggerId }) => {
        const findPanel = () => selectors
            .flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector)))
            .map((element) => {
                const rect = element.getBoundingClientRect();
                return { area: rect.width * rect.height, element };
            })
            .sort((left, right) => right.area - left.area)[0]?.element;
        const panel = findPanel();
        const trigger = Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${triggerId}"]`))
            .map((element) => {
                const rect = element.getBoundingClientRect();
                return { area: rect.width * rect.height, element };
            })
            .sort((left, right) => right.area - left.area)[0]?.element;
        if (!panel || !trigger) throw new Error(`缺少侧栏动效采样目标：${triggerId}`);
        const motion = panel.getAttribute('data-happy-motion');
        const readings: PanelMotionReading[] = [];
        const read = () => {
            const current = findPanel() ?? panel;
            const style = getComputedStyle(current);
            readings.push({
                opacity: style.opacity,
                state: current.getAttribute('data-happy-motion-state'),
                transform: style.transform,
                transitionDuration: style.transitionDuration,
                visibility: style.visibility,
            });
        };
        const wait = (duration: number) => new Promise<void>((resolve) => window.setTimeout(resolve, duration));

        trigger.click();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        read();
        for (const duration of [40, 45, 55, 70]) {
            await wait(duration);
            read();
        }
        return { motion, readings };
    }, { panelSelectors, triggerTestId });
}

function distinctMotionFrames(readings: PanelMotionReading[]): number {
    return new Set(readings.map((reading) => `${reading.opacity}|${reading.transform}|${reading.visibility}`)).size;
}

test('[PC-MOTION] PC/Web 动效优化逐项视觉验收', async ({ page, request }, testInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('requestfailed', (requestValue) => {
        failedRequests.push(`${requestValue.method()} ${new URL(requestValue.url()).pathname}: ${requestValue.failure()?.errorText ?? 'failed'}`);
    });

    const result: Record<string, unknown> = {
        motionPhase: evidencePhase,
        fileTransitionPhase,
        viewport: { width: 1280, height: 720, dpr: 1 },
    };

    // PC-MOTION-01 — keyboard-first surfaces must close without a cosmetic delay.
    await page.goto(authenticatedRoute('/new'));
    await expect(page.locator('[data-testid="new-session-message-input"]:visible')).toBeVisible();

    // PC-MOTION-04 — the permanent left sidebar animates on the compositor
    // while its flex width still snaps only once.
    const leftSidebar = page.getByTestId('desktop-left-sidebar');
    const leftToggle = page.getByTestId('desktop-navigation-sidebar-button');
    const desktopMain = page.locator('[data-testid="desktop-workspace-main"]:visible');
    await expect(leftSidebar).toBeVisible();
    const leftMainWidthOpen = (await desktopMain.boundingBox())?.width ?? 0;
    const leftMotion = await toggleAndSamplePanelMotion(page, 'desktop-navigation-sidebar-button', [
        '[data-testid="desktop-left-sidebar"]',
    ]);
    await expect(leftToggle).toHaveAttribute('aria-expanded', 'false');
    const leftMainWidthClosed = (await desktopMain.boundingBox())?.width ?? 0;
    expect(leftMainWidthClosed).toBeGreaterThan(leftMainWidthOpen + 200);
    expect(leftMotion.motion).toBe(isAfter ? 'desktop-panel' : null);
    expect(distinctMotionFrames(leftMotion.readings) > 1).toBe(isAfter);
    await leftToggle.click();
    await expect(leftToggle).toHaveAttribute('aria-expanded', 'true');
    await page.waitForTimeout(220);
    await leftToggle.click();
    await page.mouse.move(640, 360);
    await page.waitForTimeout(isAfter ? 70 : 0);
    await page.screenshot({
        path: evidencePath(testInfo, `pc-motion-04-${evidencePhase}-left-sidebar-collapse.png`),
        fullPage: true,
    });
    await page.waitForTimeout(180);
    await leftToggle.click();
    await expect(leftToggle).toHaveAttribute('aria-expanded', 'true');
    await page.waitForTimeout(220);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await leftToggle.click();
    await expect(leftToggle).toHaveAttribute('aria-expanded', 'false');
    const leftReducedTransition = await leftSidebar.evaluate((element) => getComputedStyle(element).transitionDuration);
    if (isAfter) expect(leftReducedTransition.split(',').every((duration) => duration.trim() === '0s')).toBe(true);
    await leftToggle.click();
    await expect(leftToggle).toHaveAttribute('aria-expanded', 'true');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    result.leftSidebar = {
        mainWidthOpen: leftMainWidthOpen,
        mainWidthClosed: leftMainWidthClosed,
        motion: leftMotion.motion,
        motionFrames: distinctMotionFrames(leftMotion.readings),
        readings: leftMotion.readings,
        reducedTransition: leftReducedTransition,
    };

    await page.keyboard.press('Control+K');
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await pauseForReview(page);
    await page.keyboard.press('Escape');
    const paletteVisibleImmediately = await page.getByTestId('command-palette').isVisible().catch(() => false);
    await page.screenshot({
        path: evidencePath(testInfo, `pc-motion-01-${evidencePhase}-palette-close.png`),
        fullPage: true,
    });
    expect(paletteVisibleImmediately).toBe(!isAfter);
    await expect(page.getByTestId('command-palette')).toHaveCount(0);
    result.commandPalette = { paletteVisibleImmediately };

    // PC-MOTION-02 — popovers stay inside the viewport and originate at their trigger side.
    const sessionId = await createSession(request);
    await page.goto(authenticatedRoute(`/session/${sessionId}`));
    const sessionInfoTrigger = page.locator(
        '[data-testid="session-header-more-button"]:visible, [data-testid="session-header-chip"]:visible',
    );
    await expect(sessionInfoTrigger).toBeVisible();
    await sessionInfoTrigger.click();
    const infoPanel = page.locator('[data-testid="session-agent-panel"]:visible');
    await expect(infoPanel).toBeVisible();
    const infoMotion = await infoPanel.evaluate((element) => ({
        motion: element.getAttribute('data-happy-motion'),
        origin: getComputedStyle(element).transformOrigin,
        transitionDuration: getComputedStyle(element).transitionDuration,
    }));
    await page.waitForTimeout(350);
    const infoBox = await infoPanel.boundingBox();
    if (!infoBox) throw new Error('会话信息面板没有可测量边界。');
    expect(infoBox.x).toBeGreaterThanOrEqual(0);
    expect(infoBox.y).toBeGreaterThanOrEqual(0);
    expect(infoBox.x + infoBox.width).toBeLessThanOrEqual(1280);
    expect(infoBox.y + infoBox.height).toBeLessThanOrEqual(720);
    expect(infoMotion.motion).toBe(isAfter ? 'popover' : null);
    await page.screenshot({
        path: evidencePath(testInfo, `pc-motion-02-${evidencePhase}-session-info.png`),
        fullPage: true,
    });
    await pauseForReview(page);
    await sessionInfoTrigger.click();
    await expect(infoPanel).toHaveCount(0);

    const row = page.getByTestId(`session-row-${sessionId}`);
    await expect(row).toBeVisible();
    await row.dispatchEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 300,
    });
    const selectLabel = page.getByText('Select', { exact: true });
    await expect(selectLabel).toBeVisible();
    await page.waitForTimeout(350);
    const menuMeasurement = await selectLabel.evaluate((element) => {
        let current: HTMLElement | null = element as HTMLElement;
        while (current) {
            const rect = current.getBoundingClientRect();
            if (rect.width >= 200 && current.querySelectorAll('[role="button"]').length >= 6) {
                return {
                    box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                    motion: {
                        motion: current.getAttribute('data-happy-motion'),
                        align: current.getAttribute('data-happy-motion-align'),
                        origin: getComputedStyle(current).transformOrigin,
                    },
                };
            }
            current = current.parentElement;
        }
        return null;
    });
    if (!menuMeasurement) throw new Error('会话操作菜单没有可测量边界。');
    const { box: menuBox, motion: menuMotion } = menuMeasurement;
    expect(menuBox.x).toBeGreaterThanOrEqual(11.5);
    expect(menuBox.y).toBeGreaterThanOrEqual(11.5);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(1268.5);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(708.5);
    if (isAfter) {
        expect(menuMotion.motion).toBe('popover');
        expect(menuMotion.align).toBe('left');
        const originX = Number.parseFloat(menuMotion.origin.split(' ')[0] ?? '0');
        expect(Math.abs(originX)).toBeLessThanOrEqual(2);
    }
    await page.screenshot({
        path: evidencePath(testInfo, `pc-motion-02-${evidencePhase}-session-menu.png`),
        fullPage: true,
    });
    await pauseForReview(page);
    await page.keyboard.press('Escape');
    result.popovers = { infoBox, infoMotion, menuBox, menuMotion };

    // PC-MOTION-05 — the persistent right panel follows the same directional
    // motion contract without width tweening the message list.
    const rightToggle = page.locator('[data-testid="desktop-right-panel-toggle-button"]:visible');
    const rightMotionTarget = await page.locator(
        '[data-testid="desktop-right-panel-motion"]:visible, [data-testid="desktop-right-panel"]:visible',
    ).first().elementHandle();
    if (!rightMotionTarget) throw new Error('缺少右侧栏动效目标。');
    await expect(rightToggle).toHaveAttribute('aria-expanded', 'true');
    const rightMainWidthOpen = (await desktopMain.boundingBox())?.width ?? 0;
    const rightMotion = await toggleAndSamplePanelMotion(page, 'desktop-right-panel-toggle-button', [
        '[data-testid="desktop-right-panel-motion"]',
        '[data-testid="desktop-right-panel"]',
    ]);
    await expect(rightToggle).toHaveAttribute('aria-expanded', 'false');
    const rightMainWidthClosed = (await desktopMain.boundingBox())?.width ?? 0;
    expect(rightMainWidthClosed).toBeGreaterThan(rightMainWidthOpen + 200);
    expect(rightMotion.motion).toBe(isAfter ? 'desktop-panel' : null);
    expect(distinctMotionFrames(rightMotion.readings) > 1).toBe(isAfter);
    await rightToggle.click();
    await expect(rightToggle).toHaveAttribute('aria-expanded', 'true');
    await page.waitForTimeout(220);
    await rightToggle.click();
    await page.mouse.move(640, 360);
    await page.waitForTimeout(isAfter ? 70 : 0);
    await page.screenshot({
        path: evidencePath(testInfo, `pc-motion-05-${evidencePhase}-right-sidebar-collapse.png`),
        fullPage: true,
    });
    await page.waitForTimeout(180);
    await rightToggle.click();
    await expect(rightToggle).toHaveAttribute('aria-expanded', 'true');
    await page.waitForTimeout(220);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await rightToggle.click();
    await expect(rightToggle).toHaveAttribute('aria-expanded', 'false');
    const rightReducedTransition = await rightMotionTarget.evaluate((element) => getComputedStyle(element).transitionDuration);
    if (isAfter) expect(rightReducedTransition.split(',').every((duration) => duration.trim() === '0s')).toBe(true);
    await rightToggle.click();
    await expect(rightToggle).toHaveAttribute('aria-expanded', 'true');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    result.rightSidebar = {
        mainWidthOpen: rightMainWidthOpen,
        mainWidthClosed: rightMainWidthClosed,
        motion: rightMotion.motion,
        motionFrames: distinctMotionFrames(rightMotion.readings),
        readings: rightMotion.readings,
        reducedTransition: rightReducedTransition,
    };

    // PC-MOTION-03 — reduced-motion keeps the ambient particle field static.
    await page.goto(authenticatedRoute('/new'));
    await expect(page.locator('[data-testid="new-session-message-input"]:visible')).toBeVisible();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForTimeout(150);
    const normalHashA = await canvasPixelHash(page);
    await page.waitForTimeout(220);
    const normalHashB = await canvasPixelHash(page);
    expect(normalHashB).not.toBe(normalHashA);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(150);
    const reducedHashA = await canvasPixelHash(page);
    await page.waitForTimeout(260);
    const reducedHashB = await canvasPixelHash(page);
    expect(reducedHashB === reducedHashA).toBe(isAfter);
    await page.screenshot({
        path: evidencePath(testInfo, `pc-motion-03-${evidencePhase}-reduced-motion.png`),
        fullPage: true,
    });
    await pauseForReview(page);
    result.particles = { normalHashA, normalHashB, reducedHashA, reducedHashB };

    const fileTransitionResults: Record<string, {
        fileTransitionPhase: typeof fileTransitionPhase;
        viewports: Record<string, unknown>;
    }> = {
        'PC-MOTION-06': { fileTransitionPhase, viewports: {} },
        'PC-MOTION-07': { fileTransitionPhase, viewports: {} },
        'PC-MOTION-08': { fileTransitionPhase, viewports: {} },
    };
    const fixture = await createConnectedFileSession(request);
    try {
        for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
            const viewportKey = `${viewport.width}x${viewport.height}`;
            await page.setViewportSize(viewport);
            await page.emulateMedia({ reducedMotion: 'no-preference' });
            await enableFileDiffsSidebar(page);
            await page.goto(authenticatedRoute(`/session/${fixture.sessionId}`));
            // Expo Router retains earlier session route trees in the DOM; the last
            // desktop panel is the active route reached by the page navigation.
            const rightPanel = page.getByTestId('desktop-right-panel').last();
            const workspaceMain = page.getByTestId('desktop-workspace-main').last();
            await expect(rightPanel).toBeVisible();

            // PC-MOTION-06 — the right-panel content follows the primary tab direction.
            const filesTab = rightPanel.getByTestId('desktop-right-panel-files-tab');
            const capabilitiesTab = rightPanel.getByTestId('desktop-right-panel-capabilities-tab');
            const filesSwitch = await clickAndReadPresence(
                page,
                filesTab,
                'desktop-right-panel-content-transition',
            );
            expectPresenceTransition(filesSwitch, {
                direction: 'forward',
                exitingCount: 1,
                intermediateCount: 2,
                settledCount: 1,
            });
            await expect(rightPanel.getByTestId('session-files-sidebar')).toBeVisible();
            if (isFileTransitionAfter) {
                const activeRightPanelHost = page.getByTestId('desktop-right-panel-content-transition').last();
                const directLayers = activeRightPanelHost.locator(':scope > [data-happy-presence-phase]');
                const descendantLayers = activeRightPanelHost.locator('[data-happy-presence-phase]');
                await expect(directLayers).toHaveCount(1);
                expect(await descendantLayers.count()).toBeGreaterThan(await directLayers.count());
            }
            const primaryTabStyles = {
                capabilities: await readTabTransition(capabilitiesTab),
                files: await readTabTransition(filesTab),
            };
            expectTabTransition(primaryTabStyles.capabilities);
            expectTabTransition(primaryTabStyles.files);
            const case06Screenshot = evidencePath(
                testInfo,
                `pc-motion-06-${fileTransitionPhase}-${viewportKey}-right-panel-tabs.png`,
            );
            await page.screenshot({ path: case06Screenshot, fullPage: true });
            await pauseForReview(page, 650);

            const capabilitiesKeyboard = await pressEnterAndReadPresence(
                page,
                capabilitiesTab,
                'desktop-right-panel-content-transition',
            );
            expectPresenceTransition(capabilitiesKeyboard, {
                direction: 'back',
                exitingCount: 1,
                intermediateCount: 2,
                settledCount: 1,
            });
            await expect(rightPanel.getByTestId('session-files-sidebar')).toHaveCount(0);
            const filesKeyboard = await pressEnterAndReadPresence(
                page,
                filesTab,
                'desktop-right-panel-content-transition',
            );
            expectPresenceTransition(filesKeyboard, {
                direction: 'forward',
                exitingCount: 1,
                intermediateCount: 2,
                settledCount: 1,
            });
            await expect(rightPanel.getByTestId('session-files-sidebar')).toBeVisible();
            if (isFileTransitionAfter) {
                expect(presenceDirection(capabilitiesKeyboard)).not.toBe(presenceDirection(filesKeyboard));
            }

            const primaryRapid = await rapidSwitchAndReadPresence(
                page,
                capabilitiesTab,
                filesTab,
                'desktop-right-panel-content-transition',
            );
            expectRapidPresence(primaryRapid, false);
            await page.emulateMedia({ reducedMotion: 'reduce' });
            const primaryReduced = await rapidSwitchAndReadPresence(
                page,
                capabilitiesTab,
                filesTab,
                'desktop-right-panel-content-transition',
            );
            expectRapidPresence(primaryReduced, true);
            await page.emulateMedia({ reducedMotion: 'no-preference' });
            await expect(rightPanel.getByTestId('session-files-sidebar')).toBeVisible();

            fileTransitionResults['PC-MOTION-06'].viewports[viewportKey] = {
                fileTransitionPhase,
                filesSwitch,
                keyboard: { capabilities: capabilitiesKeyboard, files: filesKeyboard },
                rapid: primaryRapid,
                reducedMotion: primaryReduced,
                screenshot: case06Screenshot,
                tabStyles: primaryTabStyles,
            };

            // PC-MOTION-07 — the file body moves while its header remains stable.
            const allFilesTab = rightPanel.getByTestId('session-files-all-tab');
            const changesTab = rightPanel.getByTestId('session-files-changes-tab');
            const allFilesSwitch = await clickAndReadPresence(
                page,
                allFilesTab,
                'session-files-mode-transition',
            );
            expectPresenceTransition(allFilesSwitch, {
                direction: 'forward',
                exitingCount: 1,
                intermediateCount: 2,
                settledCount: 1,
            });
            await expect(rightPanel.getByPlaceholder('Search files...')).toBeVisible();
            await expect(rightPanel.getByText('second-motion.ts', { exact: true })).toBeVisible();
            expect(fixture.rpcCalls.some((call) => call.params?.command?.includes('ls-files'))).toBe(true);
            const fileTabStyles = {
                allFiles: await readTabTransition(allFilesTab),
                changes: await readTabTransition(changesTab),
            };
            expectTabTransition(fileTabStyles.allFiles);
            expectTabTransition(fileTabStyles.changes);
            const case07Screenshot = evidencePath(
                testInfo,
                `pc-motion-07-${fileTransitionPhase}-${viewportKey}-file-tabs.png`,
            );
            await page.screenshot({ path: case07Screenshot, fullPage: true });
            await pauseForReview(page, 650);

            const changesKeyboard = await pressEnterAndReadPresence(
                page,
                changesTab,
                'session-files-mode-transition',
            );
            expectPresenceTransition(changesKeyboard, {
                direction: 'back',
                exitingCount: 1,
                intermediateCount: 2,
                settledCount: 1,
            });
            await expect(rightPanel.getByPlaceholder('Search files...')).toHaveCount(0);
            const allFilesKeyboard = await pressEnterAndReadPresence(
                page,
                allFilesTab,
                'session-files-mode-transition',
            );
            expectPresenceTransition(allFilesKeyboard, {
                direction: 'forward',
                exitingCount: 1,
                intermediateCount: 2,
                settledCount: 1,
            });
            await expect(rightPanel.getByPlaceholder('Search files...')).toBeVisible();
            if (isFileTransitionAfter) {
                expect(presenceDirection(changesKeyboard)).not.toBe(presenceDirection(allFilesKeyboard));
            }

            const fileTabsRapid = await rapidSwitchAndReadPresence(
                page,
                changesTab,
                allFilesTab,
                'session-files-mode-transition',
            );
            expectRapidPresence(fileTabsRapid, false);
            await page.emulateMedia({ reducedMotion: 'reduce' });
            const fileTabsReduced = await rapidSwitchAndReadPresence(
                page,
                changesTab,
                allFilesTab,
                'session-files-mode-transition',
            );
            expectRapidPresence(fileTabsReduced, true);
            await page.emulateMedia({ reducedMotion: 'no-preference' });
            await expect(rightPanel.getByPlaceholder('Search files...')).toBeVisible();

            fileTransitionResults['PC-MOTION-07'].viewports[viewportKey] = {
                fileTransitionPhase,
                keyboard: { allFiles: allFilesKeyboard, changes: changesKeyboard },
                modeSwitch: allFilesSwitch,
                rapid: fileTabsRapid,
                reducedMotion: fileTabsReduced,
                screenshot: case07Screenshot,
                tabStyles: fileTabStyles,
            };

            // PC-MOTION-08 — push/back/forward carries directional workspace intent.
            const secondFileSwitch = await clickAndReadPresence(
                page,
                rightPanel.getByText('second-motion.ts', { exact: true }),
                'workspace-overlay-transition',
            );
            expectPresenceTransition(secondFileSwitch, {
                direction: 'forward',
                exitingCount: 0,
                intermediateCount: 1,
                settledCount: 1,
            });
            if (isFileTransitionAfter) {
                await expect(workspaceMain.getByTestId('workspace-file-panel')).toBeVisible();
            } else {
                await expect(workspaceMain.getByText('export const secondMotion = true;', { exact: true }).last()).toBeVisible();
            }

            const backSwitch = await clickAndReadPresence(
                page,
                page.getByTestId('desktop-navigation-back-button').last(),
                'workspace-overlay-transition',
            );
            expectPresenceTransition(backSwitch, {
                direction: 'back',
                exitingCount: 1,
                intermediateCount: 1,
                settledCount: 0,
            });
            const forwardSwitch = await clickAndReadPresence(
                page,
                page.getByTestId('desktop-navigation-forward-button').last(),
                'workspace-overlay-transition',
            );
            expectPresenceTransition(forwardSwitch, {
                direction: 'forward',
                exitingCount: 0,
                intermediateCount: 1,
                settledCount: 1,
            });
            if (isFileTransitionAfter) {
                expect(presenceDirection(backSwitch)).not.toBe(presenceDirection(forwardSwitch));
            }

            const changesSwitch = await clickAndReadPresence(
                page,
                rightPanel.getByTestId('session-files-changes-tab'),
                'session-files-mode-transition',
            );
            expectPresenceTransition(changesSwitch, {
                direction: 'back',
                exitingCount: 1,
                intermediateCount: 2,
                settledCount: 1,
            });
            await expect(rightPanel.getByText('changed-motion.ts', { exact: true })).toBeVisible();
            const diffAssetsFinished = viewport.width === 1280
                ? Promise.all([
                    'typescript.bundle',
                    'github-light-default.bundle',
                ].map(async (assetName) => {
                    const response = await page.waitForResponse((candidate) => (
                        new URL(candidate.url()).pathname.endsWith(assetName)
                    ));
                    expect(response.ok()).toBe(true);
                    expect(await response.finished()).toBeNull();
                }))
                : Promise.resolve();
            const changedFileSwitch = await clickAndReadPresence(
                page,
                rightPanel.getByText('changed-motion.ts', { exact: true }),
                'workspace-overlay-transition',
            );
            await diffAssetsFinished;
            expectPresenceTransition(changedFileSwitch, {
                direction: 'forward',
                exitingCount: 1,
                intermediateCount: 2,
                settledCount: 1,
            });
            if (isFileTransitionAfter) {
                await expect(workspaceMain.getByTestId('workspace-diff-panel')).toBeVisible();
            } else {
                await expect(workspaceMain.getByText('src/changed-motion.ts', { exact: true })).toBeVisible();
            }
            const finalPresenceLayers = {
                fileMode: await readPresenceLayers(page, 'session-files-mode-transition'),
                rightPanel: await readPresenceLayers(page, 'desktop-right-panel-content-transition'),
                workspace: await readPresenceLayers(page, 'workspace-overlay-transition'),
            };
            if (isFileTransitionAfter) {
                expect(finalPresenceLayers.fileMode).toHaveLength(1);
                expect(finalPresenceLayers.rightPanel).toHaveLength(1);
                expect(finalPresenceLayers.workspace).toHaveLength(1);
            } else {
                expect(finalPresenceLayers.fileMode).toEqual([]);
                expect(finalPresenceLayers.rightPanel).toEqual([]);
                expect(finalPresenceLayers.workspace).toEqual([]);
            }
            const case08Screenshot = evidencePath(
                testInfo,
                `pc-motion-08-${fileTransitionPhase}-${viewportKey}-workspace-history.png`,
            );
            await page.screenshot({ path: case08Screenshot, fullPage: true });
            await pauseForReview(page, 650);

            fileTransitionResults['PC-MOTION-08'].viewports[viewportKey] = {
                fileTransitionPhase,
                back: backSwitch,
                changes: changesSwitch,
                changedFile: changedFileSwitch,
                finalPresenceLayers,
                forward: forwardSwitch,
                screenshot: case08Screenshot,
                secondFile: secondFileSwitch,
            };
        }
    } finally {
        fixture.close();
    }
    result.fileTransitions = fileTransitionResults;

    const unexpectedFailedRequests = failedRequests.filter((requestValue) => (
        !requestValue.startsWith('POST /logs:')
        && !requestValue.startsWith('GET /assets/: net::ERR_ABORTED')
    ));
    const unexpectedConsoleErrors = unexpectedFailedRequests.length > 0
        ? consoleErrors
        : consoleErrors.filter((message) => message !== 'Failed to load resource: net::ERR_CONNECTION_REFUSED');
    result.runtime = {
        consoleErrors,
        failedRequests,
        pageErrors,
        unexpectedConsoleErrors,
        unexpectedFailedRequests,
    };
    writeFileSync(
        evidencePath(testInfo, `pc-motion-${evidencePhase}-results.json`),
        `${JSON.stringify(result, null, 2)}\n`,
        'utf8',
    );
    expect(unexpectedConsoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(unexpectedFailedRequests).toEqual([]);
});
