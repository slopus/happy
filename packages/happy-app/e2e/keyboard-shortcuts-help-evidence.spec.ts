import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { encodeBase64, encryptLegacy } from '../../happy-cli/src/api/encryption';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const e2eServerUrl = process.env.HAPPY_E2E_SERVER_URL!;
const evidenceDirectory = process.env.HAPPY_KEYBOARD_SHORTCUTS_HELP_EVIDENCE_DIR;
const evidencePhase = process.env.HAPPY_KEYBOARD_SHORTCUTS_HELP_EVIDENCE_PHASE ?? 'after';

function screenshotPath(testInfo: TestInfo, caseId: number): string {
    const filename = `case-${caseId}-${evidencePhase}.png`;
    if (!evidenceDirectory) return testInfo.outputPath(filename);
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    return path.join(evidenceDirectory, filename);
}

function authenticatedRoute(pathname: string): string {
    const url = new URL(authenticatedWebUrl);
    url.pathname = pathname;
    return url.toString();
}

async function createSession(request: APIRequestContext, suffix: string): Promise<string> {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    const secret = authUrl.searchParams.get('dev_secret');
    if (!token || !secret || !e2eServerUrl) {
        throw new Error('缺少创建 E2E 会话所需的本地认证配置。');
    }

    const encryptionKey = new Uint8Array(Buffer.from(secret, 'base64url'));
    const metadata = encodeBase64(encryptLegacy({
        path: '/workspace/keyboard-shortcuts-e2e',
        host: 'keyboard-shortcuts-e2e.local',
        name: `Keyboard shortcuts ${suffix}`,
        summary: { text: 'Keyboard shortcut help evidence', updatedAt: Date.now() },
        flavor: 'codex',
        lifecycleState: 'running',
        startedBy: 'terminal',
    }, encryptionKey));
    const response = await request.post(new URL('/v1/sessions', e2eServerUrl).toString(), {
        data: {
            tag: `keyboard-shortcuts-${suffix}-${Date.now()}-${Math.random()}`,
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
    return (await response.json() as { session: { id: string } }).session.id;
}

async function pauseForRecordedReview(page: Page): Promise<void> {
    if (process.env.HAPPY_E2E_RECORD === '1') {
        await page.waitForTimeout(900);
    }
}

test('[KEYBOARD-SHORTCUTS-HELP] KH-01 sidebar help menu makes shortcut reference discoverable', async ({ page, request }, testInfo) => {
    const sessionId = await createSession(request, 'menu');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(authenticatedRoute(`/session/${sessionId}`));
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

    if (evidencePhase === 'before') {
        await page.getByTestId('sidebar-account-trigger').click();
        await expect(page.getByTestId('sidebar-account-menu')).toBeVisible();
        await expect(page.getByTestId('sidebar-account-help-action')).toBeVisible();
        await expect(page.getByTestId('sidebar-help-trigger')).toHaveCount(0);
        await pauseForRecordedReview(page);
        await page.screenshot({ path: screenshotPath(testInfo, 1), fullPage: true });
        return;
    }

    const trigger = page.getByTestId('sidebar-help-trigger');
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    await trigger.click();
    const menu = page.getByTestId('sidebar-help-menu');
    await expect(menu).toBeVisible();
    await expect(page.getByTestId('sidebar-help-shortcuts-action')).toBeVisible();
    await expect(page.getByTestId('sidebar-help-report-action')).toBeVisible();
    await pauseForRecordedReview(page);
    await page.screenshot({ path: screenshotPath(testInfo, 1), fullPage: true });

    await page.getByTestId('sidebar-help-shortcuts-action').click();
    await expect(page.getByTestId('keyboard-shortcuts-dialog')).toBeVisible();
    await page.getByTestId('keyboard-shortcuts-close').click();
    await expect(page.getByTestId('keyboard-shortcuts-dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused();
});

test('[KEYBOARD-SHORTCUTS-HELP] KH-02 Ctrl or Command slash opens the Web shortcut reference', async ({ page, request }, testInfo) => {
    const sessionId = await createSession(request, 'shortcut');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(authenticatedRoute(`/session/${sessionId}`));
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

    await page.keyboard.press('Control+/');

    if (evidencePhase === 'before') {
        await expect(page.getByTestId('keyboard-shortcuts-dialog')).toHaveCount(0);
        await pauseForRecordedReview(page);
        await page.screenshot({ path: screenshotPath(testInfo, 2), fullPage: true });
        return;
    }

    const dialog = page.getByTestId('keyboard-shortcuts-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('keyboard-shortcut-row-open-settings')).toContainText('Open app settings');
    await expect(dialog.getByTestId('keyboard-shortcut-row-open-keyboard-shortcuts')).toContainText('Open keyboard shortcuts');
    await expect(dialog.getByTestId('keyboard-shortcut-row-open-settings')).toContainText('⌘');
    await expect(dialog.getByTestId('keyboard-shortcut-row-open-keyboard-shortcuts')).toContainText('/');
    await pauseForRecordedReview(page);
    await page.screenshot({ path: screenshotPath(testInfo, 2), fullPage: true });

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press('Meta+/');
    await expect(dialog).toBeVisible();
});
