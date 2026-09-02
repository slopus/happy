import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { pluginPackages } from '@paws/plugins/catalog';
import fs from 'node:fs';
import path from 'node:path';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const evidenceDirectory = process.env.HAPPY_PLUGIN_SECRET_REVEAL_EVIDENCE_DIR;
const evidencePhase = process.env.HAPPY_PLUGIN_SECRET_REVEAL_EVIDENCE_PHASE === 'before'
    ? 'before'
    : 'after';
const fixtureSecret = 'e2e-deepseek-secret-1234';
const pageReadyTimeout = process.env.HAPPY_E2E_CLOCK_SKEW_TOLERANT === '1'
    ? 86_400_000
    : 120_000;

function authenticatedRoute(pathname: string): string {
    const url = new URL(authenticatedWebUrl);
    url.pathname = pathname;
    return url.toString();
}

function evidencePath(testInfo: TestInfo, state: 'masked' | 'revealed' | 'cleared' | 'dark'): string {
    const filename = evidencePhase === 'before'
        ? 'case-1-before-masked.png'
        : `case-1-after-${state}.png`;
    if (!evidenceDirectory) return testInfo.outputPath(filename);
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    return path.join(evidenceDirectory, filename);
}

async function pauseForRecordedReview(page: Page): Promise<void> {
    if (process.env.HAPPY_E2E_RECORD === '1') await page.waitForTimeout(1_000);
}

const catalogFixture = {
    plugins: pluginPackages.map(({ manifest }) => ({
        manifest,
        status: manifest.id === 'relationship-advisor'
            ? {
                installed: true,
                version: manifest.version,
                grantedPermissions: [...manifest.permissions],
                configuration: {
                    baseUrl: 'https://api.deepseek.com',
                    model: 'deepseek-v4-flash-vision-exp',
                },
                secretHints: { apiKey: '1234' },
            }
            : { installed: false },
    })),
};

async function installDevelopmentRefreshIndicatorSuppression(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const suppress = () => {
            document.querySelectorAll<HTMLElement>('.__expo_fast_refresh').forEach((element) => {
                element.style.setProperty('visibility', 'hidden', 'important');
            });
        };
        new MutationObserver(suppress).observe(document, {
            attributes: true,
            attributeFilter: ['class'],
            childList: true,
            subtree: true,
        });
        suppress();
    });
}

test.setTimeout(pageReadyTimeout);

test('[PLUGIN-SECRET-REVEAL] 已保存密钥仅在显式点击后回显，隐藏和重开页面后清除', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installDevelopmentRefreshIndicatorSuppression(page);
    let revealRequests = 0;

    await page.route('**/v1/plugins', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            status: 200,
            body: JSON.stringify(catalogFixture),
        });
    });
    await page.route('**/v1/plugins/relationship-advisor/secrets/apiKey/reveal', async (route) => {
        revealRequests += 1;
        await route.fulfill({
            contentType: 'application/json',
            headers: { 'Cache-Control': 'no-store' },
            status: 200,
            body: JSON.stringify({ value: fixtureSecret }),
        });
    });

    await page.goto(authenticatedRoute('/'));
    const pluginButton = page.getByTestId('sidebar-plugins-button');
    await expect(pluginButton).toBeVisible({ timeout: pageReadyTimeout });
    await pluginButton.click();
    await page.getByTestId('plugin-marketplace-plugin-relationship-advisor').click();

    const apiKeyInput = page.getByTestId('relationship-advisor-plugin-api-key');
    const visibilityToggle = page.getByTestId('relationship-advisor-plugin-api-key-visibility-toggle');
    await expect(apiKeyInput).toHaveValue('');
    await expect(apiKeyInput).toHaveAttribute('type', 'password');

    if (evidencePhase === 'before') {
        await expect(visibilityToggle).toBeDisabled();
        await page.screenshot({ path: evidencePath(testInfo, 'masked'), fullPage: true });
        return;
    }

    await expect(visibilityToggle).toBeEnabled();
    const revealResponsePromise = page.waitForResponse((response) => (
        response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/v1/plugins/relationship-advisor/secrets/apiKey/reveal'
    ));
    await visibilityToggle.click();
    const revealResponse = await revealResponsePromise;
    expect(revealResponse.status()).toBe(200);
    expect(revealResponse.headers()['cache-control']).toBe('no-store');
    expect(revealRequests).toBe(1);
    await expect(apiKeyInput).toHaveValue(fixtureSecret);
    await expect(apiKeyInput).not.toHaveAttribute('type', 'password');
    await expect(page.getByTestId('relationship-advisor-plugin-unsaved-changes')).toHaveCount(0);
    await pauseForRecordedReview(page);
    await page.screenshot({ path: evidencePath(testInfo, 'revealed'), fullPage: true });

    await visibilityToggle.click();
    await expect(apiKeyInput).toHaveValue('');
    await expect(apiKeyInput).toHaveAttribute('type', 'password');
    await pauseForRecordedReview(page);
    await page.screenshot({ path: evidencePath(testInfo, 'cleared'), fullPage: true });

    await page.getByTestId('plugin-marketplace-back').click();
    await page.getByTestId('plugin-marketplace-plugin-relationship-advisor').click();
    await expect(page.getByTestId('relationship-advisor-plugin-api-key')).toHaveValue('');
    expect(revealRequests).toBe(1);

    await page.evaluate(() => {
        window.localStorage.setItem(
            'mmkv.default\\local-settings',
            JSON.stringify({ themePreference: 'dark', themePack: 'gingham' }),
        );
    });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    await expect(pluginButton).toBeVisible({ timeout: pageReadyTimeout });
    await pluginButton.click();
    await page.getByTestId('plugin-marketplace-plugin-relationship-advisor').click();
    await expect(page.getByTestId('relationship-advisor-plugin-api-key')).toHaveValue('');
    await expect.poll(() => page.locator('body').evaluate((element) => (
        window.getComputedStyle(element).backgroundColor
    ))).toBe('rgb(18, 24, 33)');
    await page.screenshot({ path: evidencePath(testInfo, 'dark'), fullPage: true });
});
