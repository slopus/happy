import { expect, test, type APIRequestContext, type Locator, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { encodeBase64, encryptLegacy } from '../../happy-cli/src/api/encryption';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const e2eServerUrl = process.env.HAPPY_E2E_SERVER_URL!;
const evidenceDirectory = process.env.HAPPY_THEME_SURFACES_EVIDENCE_DIR;
const evidencePhase = process.env.HAPPY_THEME_SURFACES_EVIDENCE_PHASE ?? 'after';

function auth(): { encryptionKey: Uint8Array; token: string } {
    const url = new URL(authenticatedWebUrl);
    const token = url.searchParams.get('dev_token');
    const secret = url.searchParams.get('dev_secret');
    if (!token || !secret) throw new Error('Missing local E2E authentication.');
    return {
        token,
        encryptionKey: new Uint8Array(Buffer.from(secret, 'base64url')),
    };
}

function route(pathname: string): string {
    const url = new URL(authenticatedWebUrl);
    url.pathname = pathname;
    return url.toString();
}

function screenshotPath(testInfo: TestInfo): string {
    const filename = `case-1-${evidencePhase}.png`;
    if (!evidenceDirectory) return testInfo.outputPath(filename);
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    return path.join(evidenceDirectory, filename);
}

async function createSession(
    request: APIRequestContext,
    options: { name: string; path: string },
): Promise<string> {
    const credentials = auth();
    const metadata = encodeBase64(encryptLegacy({
        path: options.path,
        host: 'theme-evidence.local',
        name: options.name,
        flavor: 'codex',
        lifecycleState: 'running',
        startedBy: 'terminal',
    }, credentials.encryptionKey));
    const response = await request.post(new URL('/v1/sessions', e2eServerUrl).toString(), {
        data: {
            tag: `theme-surfaces-${Date.now()}-${Math.random()}`,
            metadata,
            agentState: null,
            dataEncryptionKey: null,
        },
        headers: {
            Authorization: `Bearer ${credentials.token}`,
            'X-Happy-Client': 'playwright-theme-surfaces',
        },
    });
    expect(response.ok()).toBe(true);
    return (await response.json() as { session: { id: string } }).session.id;
}

async function removeSession(request: APIRequestContext, sessionId: string): Promise<void> {
    const headers = {
        Authorization: `Bearer ${auth().token}`,
        'X-Happy-Client': 'playwright-theme-surfaces',
    };
    const archiveResponse = await request.post(
        new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/archive`, e2eServerUrl).toString(),
        { headers },
    );
    expect(archiveResponse.ok()).toBe(true);
    const deleteResponse = await request.delete(
        new URL(`/v1/sessions/${encodeURIComponent(sessionId)}`, e2eServerUrl).toString(),
        { headers },
    );
    expect(deleteResponse.ok()).toBe(true);
}

async function backgroundColor(locator: Locator, useParent = false): Promise<string> {
    return locator.evaluate((element, parent) => {
        const target = parent ? element.parentElement : element;
        if (!target) throw new Error('Missing theme surface target.');
        return window.getComputedStyle(target).backgroundColor;
    }, useParent);
}

test('[THEME-SURFACES] 深蓝主题的交互背景不再继承焦糖色', async ({ page, request }, testInfo) => {
    const selectedSessionId = await createSession(request, {
        name: 'Theme selected surface',
        path: '/workspace/theme-selected',
    });
    const hoveredSessionId = await createSession(request, {
        name: 'Theme hovered surface',
        path: '/workspace/theme-hovered',
    });

    try {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(route('/settings/appearance'));
        await page.getByText('Gingham', { exact: true }).click();
        await expect.poll(() => page.locator('body').evaluate((element) => (
            window.getComputedStyle(element).backgroundColor
        ))).toBe('rgb(18, 24, 33)');

        await page.goto(route(`/session/${selectedSessionId}`));
        await expect(page.getByTestId('session-message-input')).toBeVisible();
        expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

        const layoutToggle = page.getByTestId('session-list-layout-toggle');
        await layoutToggle.click();
        await expect(page.getByTestId('session-list-layout-toggle-icon')).toHaveAttribute('data-icon-name', 'folder');

        const sidebarToggle = page.getByTestId('desktop-navigation-sidebar-button');
        const selectedRow = page.getByTestId(`session-row-${selectedSessionId}`);
        const hoveredRow = page.getByTestId(`session-row-${hoveredSessionId}`);
        await expect(sidebarToggle).toBeVisible();
        await expect(selectedRow).toHaveAttribute('aria-current', 'page');
        await hoveredRow.hover();

        const expectedPressed = evidencePhase === 'before'
            ? 'rgb(47, 37, 29)'
            : 'rgb(31, 42, 56)';
        const expectedSelected = evidencePhase === 'before'
            ? 'rgb(47, 37, 29)'
            : 'rgb(40, 53, 68)';
        expect(await backgroundColor(sidebarToggle)).toBe(expectedPressed);
        expect(await backgroundColor(layoutToggle)).toBe(expectedSelected);
        expect(await backgroundColor(selectedRow, true)).toBe(expectedSelected);
        expect(await backgroundColor(hoveredRow, true)).toBe(expectedSelected);

        await page.screenshot({ path: screenshotPath(testInfo), fullPage: true });
    } finally {
        await removeSession(request, selectedSessionId);
        await removeSession(request, hoveredSessionId);
    }
});
