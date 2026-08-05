import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expectProductionRedactionReady, installProductionRedaction } from './productionRedaction';

const viewports = [
    { name: 'pc-narrow', width: 1470, height: 863 },
    { name: 'pc-wide', width: 2552, height: 1396 },
] as const;

const repeats = Number.parseInt(process.env.HAPPY_E2E_PRODUCTION_REPEATS ?? '2', 10);
const navigationBudgetMs = Number.parseInt(
    process.env.HAPPY_E2E_SESSION_NAVIGATION_BUDGET_MS ?? '60000',
    10,
);
const recordingEnabled = process.env.HAPPY_E2E_RECORD === '1';

type SafeDiagnostic = {
    kind: 'console' | 'request-failed' | 'response';
    level?: string;
    method?: string;
    status?: number;
    resourceType?: string;
    message?: string;
    url?: string;
};

type SafeTraceEvent = {
    at: string;
    step: string;
    data?: Record<string, string | number | boolean>;
};

function safeUrl(rawUrl: string): string {
    try {
        const url = new URL(rawUrl);
        const redactedPath = url.pathname
            .split('/')
            .map((segment) => (
                segment.length >= 16 && /^[a-z0-9._-]+$/i.test(segment)
                    ? '<redacted-id>'
                    : segment
            ))
            .join('/');
        return `${url.origin}${redactedPath}`;
    } catch {
        return '<invalid-url>';
    }
}

function safeText(value: string, maxLength = 500): string {
    return value
        .replace(/[A-Z2-7]{5}(?:-[A-Z2-7]{5}){5,}/gi, '<redacted-secret>')
        .replace(/(?:bearer|token|authorization)\s*[:=]?\s*[^\s,;]+/gi, '$1=<redacted>')
        .slice(0, maxLength);
}

function captureSafeDiagnostics(page: Page): SafeDiagnostic[] {
    const diagnostics: SafeDiagnostic[] = [];

    page.on('console', (message) => {
        if (message.type() !== 'error' && message.type() !== 'warning') return;
        diagnostics.push({
            kind: 'console',
            level: message.type(),
            message: safeText(message.text()),
        });
    });
    page.on('requestfailed', (request) => {
        diagnostics.push({
            kind: 'request-failed',
            method: request.method(),
            resourceType: request.resourceType(),
            message: safeText(request.failure()?.errorText ?? 'unknown'),
            url: safeUrl(request.url()),
        });
    });
    page.on('response', (response) => {
        if (response.status() < 400) return;
        diagnostics.push({
            kind: 'response',
            method: response.request().method(),
            resourceType: response.request().resourceType(),
            status: response.status(),
            url: safeUrl(response.url()),
        });
    });

    return diagnostics;
}

function addTrace(trace: SafeTraceEvent[], step: string, data?: SafeTraceEvent['data']): void {
    trace.push({ at: new Date().toISOString(), step, data });
}

async function showVideoStep(page: Page, label: string, durationMs = 1_200): Promise<void> {
    if (!recordingEnabled) return;
    await page.evaluate((text) => {
        document.getElementById('paws-e2e-step-badge')?.remove();
        const badge = document.createElement('div');
        badge.id = 'paws-e2e-step-badge';
        badge.textContent = text;
        Object.assign(badge.style, {
            position: 'fixed',
            left: '50%',
            bottom: '24px',
            transform: 'translateX(-50%)',
            padding: '12px 18px',
            border: '1px solid rgba(255,255,255,0.24)',
            borderRadius: '12px',
            background: 'rgba(10,10,11,0.92)',
            color: '#e5e5e7',
            fontFamily: 'sans-serif',
            fontSize: '16px',
            fontWeight: '700',
            boxShadow: '0 10px 32px rgba(0,0,0,0.42)',
            zIndex: '2147483646',
            pointerEvents: 'none',
        });
        document.documentElement.appendChild(badge);
    }, label);
    await page.waitForTimeout(durationMs);
    await page.evaluate(() => {
        document.getElementById('paws-e2e-step-badge')?.remove();
    });
}

async function blurNonTargetRadios(page: Page, targetPattern: RegExp): Promise<void> {
    await page.getByRole('radio').evaluateAll((nodes, serializedPattern) => {
        const pattern = new RegExp(serializedPattern.source, serializedPattern.flags);
        for (const node of nodes) {
            if (!(node instanceof HTMLElement)) continue;
            const label = node.getAttribute('aria-label') ?? node.textContent ?? '';
            node.style.filter = pattern.test(label) ? '' : 'blur(12px)';
        }
    }, { source: targetPattern.source, flags: targetPattern.flags });
}

async function selectProductionTarget(page: Page): Promise<void> {
    const machineTrigger = page.locator('[data-testid="session-config-machine-trigger"]:visible');
    if (!await machineTrigger.isVisible()) {
        await page.locator('[data-testid="compose-home-model-chip"]:visible').click();
    }
    await expect(machineTrigger).toBeVisible({ timeout: 90_000 });
    await machineTrigger.click();
    const machine = page.getByRole('radio', { name: /^mac-mini, (在线|Online)$/i });
    await expect(machine).toBeVisible({ timeout: 90_000 });
    await blurNonTargetRadios(page, /^mac-mini, (在线|Online)$/i);
    await showVideoStep(page, '1 / 6　选择真实在线设备：mac-mini');
    await machine.click();
    await showVideoStep(page, '已选择真实设备 mac-mini', 800);

    await page.locator('[data-testid="session-config-agent-trigger"]:visible').click();
    const agent = page.getByRole('radio', { name: /^codex$/i });
    await expect(agent).toBeVisible();
    await blurNonTargetRadios(page, /^codex$/i);
    await showVideoStep(page, '2 / 6　选择 Agent：codex');
    await agent.click();
    await showVideoStep(page, '已选择 Agent codex', 800);
}

async function expectKeyboardAccessiblePicker(
    page: Page,
    trigger: Locator,
    pickerTestId: string,
): Promise<void> {
    await expect(trigger).toHaveAttribute('role', 'button');
    await expect(trigger).toHaveAccessibleName(/.+/);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    for (const activationKey of ['Space', 'Enter'] as const) {
        await trigger.focus();
        await trigger.press(activationKey);

        const picker = page.getByTestId(pickerTestId);
        await expect(picker).toBeVisible();
        await expect(trigger).toHaveAttribute('aria-expanded', 'true');

        await page.keyboard.press('Escape');
        await expect(picker).toHaveCount(0);
        await expect(trigger).toBeFocused();
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    }
}

async function expectUniqueRoundTrip(
    page: Page,
    prompt: string,
    runMarker: string,
    input: Locator,
): Promise<void> {
    await input.fill(prompt);
    await input.press('Enter');

    await expect(input).toHaveValue('');
    await expect(
        page.locator('[data-testid^="message-user-"]').filter({ hasText: runMarker }),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(
        page.locator('[data-testid^="message-agent-"]').filter({ hasText: runMarker }),
    ).toHaveCount(1, { timeout: 3 * 60_000 });
    await expect(
        page.locator('[data-testid^="message-agent-"]').filter({ hasText: '链路已打通' }).filter({ hasText: runMarker }),
    ).toHaveCount(1);
    await showVideoStep(page, '6 / 6　刷新后第二次真实消息往返成功', 1_800);
}

async function assertRealFilePanelAndHeaderGeometry(
    page: Page,
    testInfo: TestInfo,
    runId: string,
): Promise<void> {
    for (const viewport of viewports) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await expectProductionRedactionReady(page);

        const filesSidebar = page.locator('[data-testid="session-files-sidebar"]:visible');
        await expect(filesSidebar).toBeVisible();
        await page.locator('[data-testid="session-files-all-tab"]:visible').click();
        await expect(page.locator('[data-testid="session-files-all-tab"]:visible')).toBeVisible();
        await page.locator('[data-testid="session-files-changes-tab"]:visible').click();

        const controls = page.locator('[data-testid="desktop-navigation-controls"]:visible');
        const chip = page.locator('[data-testid="session-header-chip"]:visible');
        await expect(controls).toBeVisible();
        await expect(chip).toBeVisible();
        const [controlsBox, chipBox, sidebarBox] = await Promise.all([
            controls.boundingBox(),
            chip.boundingBox(),
            filesSidebar.boundingBox(),
        ]);
        expect(controlsBox).not.toBeNull();
        expect(chipBox).not.toBeNull();
        expect(sidebarBox).not.toBeNull();

        const controlsHitRight = controlsBox!.x + controlsBox!.width + 10;
        const chipHitLeft = chipBox!.x - 8;
        expect(controlsHitRight + 4).toBeLessThanOrEqual(chipHitLeft);
        expect(sidebarBox!.width).toBeGreaterThan(200);

        await showVideoStep(
            page,
            `4 / 6　${viewport.name === 'pc-narrow' ? '窄屏' : '宽屏'} ${viewport.width}×${viewport.height}：头部命中区域不重叠`,
            1_800,
        );
        await page.screenshot({
            path: testInfo.outputPath(`${runId}-${viewport.name}.png`),
            fullPage: true,
        });
    }
}

test('生产账号真实 Session 链路可重复、刷新后仍可继续并覆盖两档 PC 布局', async ({ page }, testInfo) => {
    const diagnostics = captureSafeDiagnostics(page);
    const trace: SafeTraceEvent[] = [];
    await installProductionRedaction(page);

    await page.goto('/settings/features');
    const filePanelSwitch = page.getByRole('switch', {
        name: /^(文件差异侧边栏|File Diffs Sidebar)$/,
    });
    await expect(filePanelSwitch).toBeVisible({ timeout: 90_000 });
    const filePanelWasEnabled = await filePanelSwitch.isChecked();
    if (!filePanelWasEnabled) {
        await filePanelSwitch.click();
        await expect(filePanelSwitch).toBeChecked();
    }
    const enterToSendSwitch = page.getByRole('switch', {
        name: /^(回车发送|Enter to Send)$/,
    });
    await expect(enterToSendSwitch).toBeVisible();
    const enterToSendWasEnabled = await enterToSendSwitch.isChecked();
    if (!enterToSendWasEnabled) {
        await enterToSendSwitch.click();
        await expect(enterToSendSwitch).toBeChecked();
    }

    try {
        for (let iteration = 1; iteration <= repeats; iteration += 1) {
            const runId = `PAWS-E2E-${Date.now()}-${iteration}`;
            const firstMarker = `${runId}-ROUND-1`;
            const secondMarker = `${runId}-ROUND-2`;
            addTrace(trace, 'iteration-start', { iteration, runId });

            await page.goto('/new');
            const machineTrigger = page.locator('[data-testid="session-config-machine-trigger"]:visible');
            if (!await machineTrigger.isVisible()) {
                await page.locator('[data-testid="compose-home-model-chip"]:visible').click();
            }
            await expect(machineTrigger).toBeVisible({ timeout: 90_000 });
            await expectKeyboardAccessiblePicker(
                page,
                machineTrigger,
                'session-config-picker-machine',
            );
            await expectKeyboardAccessiblePicker(
                page,
                page.locator('[data-testid="session-config-agent-trigger"]:visible'),
                'session-config-picker-agent',
            );

            await selectProductionTarget(page);
            const newSessionInput = page.locator('[data-testid="new-session-message-input"]:visible');
            await expect(newSessionInput).toBeVisible();

            const navigationStartedAt = Date.now();
            await newSessionInput.fill(`你好，只回复：链路已打通 ${firstMarker}`);
            await expect(
                page.locator('[data-testid="message-composer-send-button"]:visible'),
            ).toBeEnabled();
            await showVideoStep(page, '3 / 6　Enter 创建真实 Session 并发送指定消息');
            await expect.poll(
                () => page.evaluate(() => window.matchMedia('(pointer: coarse)').matches),
            ).toBe(false);
            await newSessionInput.press('Enter');
            await page.waitForTimeout(250);
            const valueAfterEnter = await newSessionInput.inputValue();
            const enterInsertedNewline = valueAfterEnter.includes('\n');
            addTrace(trace, 'enter-dispatched', { iteration, enterInsertedNewline });
            expect(
                enterInsertedNewline,
                'Enter 被当作换行，未进入新建 Session 提交流程',
            ).toBe(false);
            await expect(page).toHaveURL(/\/session\/[^/?#]+$/, { timeout: navigationBudgetMs });
            const navigationMs = Date.now() - navigationStartedAt;
            addTrace(trace, 'new-session-navigated', { iteration, navigationMs });
            expect(navigationMs).toBeLessThanOrEqual(navigationBudgetMs);

            const sessionUrl = page.url();
            await expect(
                page.locator('[data-testid^="message-user-"]').filter({ hasText: firstMarker }),
            ).toHaveCount(1);
            await expect(
                page.locator('[data-testid^="message-agent-"]').filter({ hasText: firstMarker }),
            ).toHaveCount(1, { timeout: 3 * 60_000 });
            addTrace(trace, 'first-round-trip-complete', { iteration });
            await showVideoStep(page, '真实 Codex 已回复“链路已打通”', 1_800);

            await assertRealFilePanelAndHeaderGeometry(page, testInfo, runId);

            await page.reload();
            await expect(page).toHaveURL(sessionUrl);
            await expect(
                page.locator('[data-testid^="message-user-"]').filter({ hasText: firstMarker }),
            ).toHaveCount(1, { timeout: 90_000 });
            await expect(
                page.locator('[data-testid^="message-agent-"]').filter({ hasText: firstMarker }),
            ).toHaveCount(1);
            addTrace(trace, 'refresh-persistence-confirmed', { iteration });
            await showVideoStep(page, '5 / 6　刷新后历史消息仍存在，开始第二次往返', 1_600);

            const sessionInput = page.locator('[data-testid="session-message-input"]:visible');
            await expect(sessionInput).toBeVisible();
            await expectUniqueRoundTrip(
                page,
                `你好，只回复：链路已打通 ${secondMarker}`,
                secondMarker,
                sessionInput,
            );
            addTrace(trace, 'second-round-trip-complete', { iteration });
        }

        const unexpectedDiagnostics = diagnostics.filter((entry) => (
            (entry.kind === 'console' && entry.level === 'error')
            || (entry.kind === 'response' && (entry.status ?? 0) >= 400)
        ));
        expect(unexpectedDiagnostics, '回归过程中出现意外控制台 error 或 HTTP 4xx/5xx').toEqual([]);
    } finally {
        if (!filePanelWasEnabled) {
            await page.goto('/settings/features');
            const switchToRestore = page.getByRole('switch', {
                name: /^(文件差异侧边栏|File Diffs Sidebar)$/,
            });
            if (await switchToRestore.isChecked()) {
                await switchToRestore.click();
            }
        }
        if (!enterToSendWasEnabled) {
            if (!page.url().includes('/settings/features')) {
                await page.goto('/settings/features');
            }
            const enterSwitchToRestore = page.getByRole('switch', {
                name: /^(回车发送|Enter to Send)$/,
            });
            if (await enterSwitchToRestore.isChecked()) {
                await enterSwitchToRestore.click();
            }
        }

        const evidenceDir = testInfo.outputDir;
        await fs.mkdir(evidenceDir, { recursive: true });
        await Promise.all([
            fs.writeFile(
                path.join(evidenceDir, 'safe-trace.json'),
                JSON.stringify(trace, null, 2),
                'utf8',
            ),
            fs.writeFile(
                path.join(evidenceDir, 'safe-diagnostics.json'),
                JSON.stringify(diagnostics, null, 2),
                'utf8',
            ),
        ]);
        await testInfo.attach('safe-trace', {
            path: path.join(evidenceDir, 'safe-trace.json'),
            contentType: 'application/json',
        });
        await testInfo.attach('safe-diagnostics', {
            path: path.join(evidenceDir, 'safe-diagnostics.json'),
            contentType: 'application/json',
        });

        if (testInfo.status !== testInfo.expectedStatus) {
            await page.screenshot({
                path: path.join(evidenceDir, 'failure-redacted.png'),
                fullPage: true,
            }).catch(() => undefined);
        }
    }
});
