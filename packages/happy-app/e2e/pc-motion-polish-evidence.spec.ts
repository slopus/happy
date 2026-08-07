import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeBase64, encryptLegacy } from '../../happy-cli/src/api/encryption';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const e2eServerUrl = process.env.HAPPY_E2E_SERVER_URL!;
const evidenceDir = process.env.HAPPY_PC_MOTION_EVIDENCE_DIR;
const evidencePhase = process.env.HAPPY_PC_MOTION_EVIDENCE_PHASE === 'before' ? 'before' : 'after';
const isAfter = evidencePhase === 'after';

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
    test.setTimeout(90_000);
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
        phase: evidencePhase,
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
