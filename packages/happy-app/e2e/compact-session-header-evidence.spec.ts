import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { encodeBase64, encryptLegacy } from '../../happy-cli/src/api/encryption';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const e2eServerUrl = process.env.HAPPY_E2E_SERVER_URL!;
const evidenceDirectory = process.env.HAPPY_COMPACT_HEADER_EVIDENCE_DIR;
const evidencePhase = process.env.HAPPY_COMPACT_HEADER_EVIDENCE_PHASE ?? 'after';

function screenshotPath(testInfo: TestInfo): string {
    const filename = `case-1-${evidencePhase}.png`;
    return evidenceDirectory ? `${evidenceDirectory}/${filename}` : testInfo.outputPath(filename);
}

function authenticatedRoute(pathname: string): string {
    const url = new URL(authenticatedWebUrl);
    url.pathname = pathname;
    return url.toString();
}

async function countHitTestableRightPanels(page: Page): Promise<number> {
    return page.getByTestId('desktop-right-panel').evaluateAll((elements) => elements.filter((element) => {
        const rect = element.getBoundingClientRect();
        if (
            rect.width <= 0
            || rect.height <= 0
            || rect.right <= 0
            || rect.bottom <= 0
            || rect.left >= window.innerWidth
            || rect.top >= window.innerHeight
        ) {
            return false;
        }
        const hit = document.elementFromPoint(
            Math.min(window.innerWidth - 1, rect.left + rect.width / 2),
            Math.min(window.innerHeight - 1, rect.top + rect.height / 2),
        );
        return hit !== null && element.contains(hit);
    }).length);
}

async function createSession(request: APIRequestContext): Promise<string> {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    const secret = authUrl.searchParams.get('dev_secret');
    if (!token || !secret) {
        throw new Error('Missing local E2E authentication.');
    }

    const encryptionKey = new Uint8Array(Buffer.from(secret, 'base64url'));
    const title = 'Refactor the desktop session header while preserving every existing task context and Agent control';
    const metadata = encodeBase64(encryptLegacy({
        path: '/workspace/paws-desktop-header',
        host: 'paws-mac-mini.local',
        name: 'Compact header fixture',
        summary: { text: title, updatedAt: Date.now() },
        flavor: 'codex',
        currentOperatingModeCode: 'acceptEdits',
        models: [{ code: 'gpt-5.6-sol', value: 'gpt-5.6-sol' }],
        currentModelCode: 'gpt-5.6-sol',
        thoughtLevels: [{ code: 'xhigh', value: 'xhigh' }],
        currentThoughtLevelCode: 'xhigh',
        lifecycleState: 'running',
        startedBy: 'terminal',
    }, encryptionKey));
    const response = await request.post(new URL('/v1/sessions', e2eServerUrl).toString(), {
        data: {
            tag: `compact-header-${Date.now()}-${Math.random()}`,
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

test('T14-01 desktop header stays compact and keeps every required control', async ({ page, request }, testInfo) => {
    const sessionId = await createSession(request);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(authenticatedRoute(`/session/${sessionId}`));
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
    await expect(page.getByTestId('session-message-input')).toBeVisible();

    if (evidencePhase === 'before') {
        const agentChip = page.locator('[data-testid="session-header-chip"]:visible');
        await expect(agentChip).toBeVisible();
        await agentChip.click();
        await expect(page.getByTestId('session-agent-panel')).toBeVisible();
        await page.screenshot({ path: screenshotPath(testInfo), fullPage: true });
        return;
    }

    await expect(page.getByTestId('session-header-chip')).toHaveCount(0);

    const title = page.locator('[data-testid="session-header-title"]:visible');
    await expect(title).toHaveAccessibleName(/Refactor the desktop session header/);
    await expect(title.locator('div').first()).toHaveCSS('text-overflow', 'ellipsis');
    await title.hover();
    await expect(page.getByTestId('session-header-title-tooltip')).toHaveCount(0);
    await page.mouse.move(1, 1);
    await title.focus();
    await expect(page.getByTestId('session-header-title-tooltip')).toHaveCount(0);

    const more = page.locator('[data-testid="session-header-more-button"]:visible');
    await expect(more).toHaveAccessibleName('Session details');
    await more.hover();
    await expect(page.getByTestId('session-header-more-tooltip')).toHaveCount(0);
    await more.focus();
    await expect(page.getByTestId('session-header-more-tooltip')).toHaveCount(0);
    await more.click();
    await expect(page.getByTestId('session-agent-panel')).toBeVisible();

    const rightToggle = page.locator('[data-testid="desktop-right-panel-toggle-button"]:visible');
    const leftToggle = page.getByTestId('desktop-navigation-sidebar-button');
    const zenToggle = page.getByTestId('desktop-navigation-zen-button');
    for (const control of [leftToggle, zenToggle, more, rightToggle]) {
        const box = await control.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThanOrEqual(40);
        expect(box!.height).toBeGreaterThanOrEqual(40);
        expect(await control.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return hit === element || element.contains(hit);
        })).toBe(true);
    }

    // The long title must never sit above the adjacent More or panel controls
    // in the hit-test tree after the desktop Agent chip is removed.
    for (const control of [more, rightToggle]) {
        await control.click();
        await control.click();
    }

    await more.click();
    await expect(rightToggle).toHaveAttribute('aria-expanded', 'true');
    await rightToggle.click();
    await expect.poll(() => countHitTestableRightPanels(page)).toBe(0);
    await expect(rightToggle).toHaveAttribute('aria-expanded', 'false');
    await rightToggle.click();
    await expect.poll(() => countHitTestableRightPanels(page)).toBe(1);
    await expect(page.getByTestId('desktop-right-panel-collapse-button')).toHaveCount(0);

    await leftToggle.click();
    await expect(leftToggle).toHaveAttribute('aria-expanded', 'false');
    await leftToggle.click();
    await expect(leftToggle).toHaveAttribute('aria-expanded', 'true');
    await zenToggle.focus();
    await expect(page.getByTestId('desktop-navigation-zen-tooltip')).toContainText('Zen mode');

    await expect(page.getByTestId('session-header-new-session-button')).toHaveCount(0);
    await expect(page.getByTestId('sidebar-new-session-button')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await more.click();
    await expect(page.getByTestId('session-agent-panel')).toBeVisible();
    await page.screenshot({ path: screenshotPath(testInfo), fullPage: true });
});

test('T14-02 phone header keeps its existing controls outside the desktop-only scope', async ({ page, request }) => {
    const sessionId = await createSession(request);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(authenticatedRoute(`/session/${sessionId}`));
    await expect(page.getByTestId('session-message-input')).toBeVisible();

    const agentChip = page.locator('[data-testid="session-header-chip"]:visible');
    const newSession = page.locator('[data-testid="session-header-new-session-button"]:visible');
    await expect(agentChip).toBeVisible();
    await expect(newSession).toBeVisible();
    await expect(page.getByTestId('session-header-title')).toHaveCount(0);
    await expect(page.getByTestId('session-header-more-button')).toHaveCount(0);
    await expect(page.getByTestId('desktop-right-panel-toggle-button')).toHaveCount(0);

    for (const control of [agentChip, newSession]) {
        expect(await control.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return hit === element || element.contains(hit);
        })).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await newSession.click();
    await expect(page).toHaveURL(/\/new(?:\?|$)/);
});
