import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { pluginPackages } from '@paws/plugins/catalog';
import type { PluginPermission } from '@slopus/happy-wire';
import fs from 'node:fs';
import path from 'node:path';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const evidenceDirectory = process.env.HAPPY_PLUGIN_CONNECTION_EVIDENCE_DIR;
const evidencePhase = process.env.HAPPY_PLUGIN_CONNECTION_EVIDENCE_PHASE === 'before'
    ? 'before'
    : 'after';

function authenticatedRoute(pathname: string): string {
    const url = new URL(authenticatedWebUrl);
    url.pathname = pathname;
    return url.toString();
}

function evidencePath(testInfo: TestInfo, state: 'draft' | 'saved' | 'dark'): string {
    const filename = evidencePhase === 'before'
        ? 'case-1-before.png'
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
                    baseUrl: 'https://api.example.com/v1',
                    model: 'example/model-mini',
                },
                secretHints: { apiKey: 'LLPq' },
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

test.setTimeout(120_000);

test('[PLUGIN-CONNECTION-TEST] 配置草稿跨页面保留且测试成功后自动保存', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installDevelopmentRefreshIndicatorSuppression(page);
    let installedStatus = catalogFixture.plugins.find(({ manifest }) => (
        manifest.id === 'relationship-advisor'
    ))!.status;
    let testedConfiguration: Record<string, string> | undefined;
    let savedConfiguration: Record<string, string> | undefined;
    await page.route('**/v1/plugins', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            status: 200,
            body: JSON.stringify({
                plugins: catalogFixture.plugins.map((plugin) => plugin.manifest.id === 'relationship-advisor'
                    ? { ...plugin, status: installedStatus }
                    : plugin),
            }),
        });
    });
    await page.route('**/v1/plugins/relationship-advisor/test-connection', async (route) => {
        testedConfiguration = (route.request().postDataJSON() as {
            configuration: Record<string, string>;
        }).configuration;
        await route.fulfill({
            contentType: 'application/json',
            status: 200,
            body: JSON.stringify({ success: true, latencyMs: 31 }),
        });
    });
    await page.route('**/v1/plugins/relationship-advisor', async (route) => {
        if (route.request().method() !== 'PUT') {
            await route.fallback();
            return;
        }
        const payload = route.request().postDataJSON() as {
            configuration: Record<string, string>;
            grantedPermissions: PluginPermission[];
            version: string;
        };
        savedConfiguration = payload.configuration;
        installedStatus = {
            installed: true,
            version: payload.version,
            grantedPermissions: payload.grantedPermissions,
            configuration: {
                baseUrl: payload.configuration.baseUrl,
                model: payload.configuration.model,
            },
            secretHints: { apiKey: payload.configuration.apiKey.slice(-4) },
        };
        await route.fulfill({
            contentType: 'application/json',
            status: 200,
            body: JSON.stringify(installedStatus),
        });
    });

    try {
        await page.goto(authenticatedRoute('/'));
        const pluginButton = page.getByTestId('sidebar-plugins-button');
        await expect(pluginButton).toBeVisible({ timeout: 120_000 });
        await pluginButton.click();

        await expect(page.getByTestId('plugin-marketplace-desktop-dialog')).toBeVisible();
        await page.getByTestId('plugin-marketplace-plugin-relationship-advisor').click();
        await expect(page.getByTestId('relationship-advisor-plugin-api-key')).toBeVisible();

        const testConnectionButton = page.getByTestId('relationship-advisor-plugin-test-connection');
        if (evidencePhase === 'before') {
            await expect(testConnectionButton).toBeVisible();
            await page.screenshot({ path: evidencePath(testInfo, 'draft'), fullPage: true });
        } else {
            const baseUrlInput = page.getByTestId('relationship-advisor-plugin-base-url');
            const modelInput = page.getByTestId('relationship-advisor-plugin-model');
            const apiKeyInput = page.getByTestId('relationship-advisor-plugin-api-key');
            await expect(baseUrlInput).toHaveAttribute('placeholder', /deepseek\.com/i);
            await expect(modelInput).toHaveAttribute('placeholder', /deepseek-v4-flash-vision-exp/i);
            await expect(page.getByTestId('relationship-advisor-plugin-model-recommendation'))
                .toContainText(/多模态|multimodal/i);

            await apiKeyInput.fill('e2e-deepseek-secret');
            await baseUrlInput.fill('https://api.deepseek.com');
            await modelInput.fill('deepseek-v4-flash-vision-exp');
            const unsavedChanges = page.getByTestId('relationship-advisor-plugin-unsaved-changes');
            await expect(unsavedChanges).toBeVisible();
            await expect(unsavedChanges).toContainText(/尚未保存|not been saved/i);

            const actionBox = await page.getByTestId('relationship-advisor-plugin-actions').boundingBox();
            const permissionBox = await page.getByTestId('relationship-advisor-plugin-permissions').boundingBox();
            expect(actionBox).not.toBeNull();
            expect(permissionBox).not.toBeNull();
            expect(actionBox!.y).toBeLessThan(permissionBox!.y);
            await pauseForRecordedReview(page);
            await page.screenshot({ path: evidencePath(testInfo, 'draft'), fullPage: true });

            await page.getByTestId('plugin-marketplace-back').click();
            await page.getByTestId('plugin-marketplace-plugin-relationship-advisor').click();
            await expect(page.getByTestId('relationship-advisor-plugin-base-url'))
                .toHaveValue('https://api.deepseek.com');
            await expect(page.getByTestId('relationship-advisor-plugin-model'))
                .toHaveValue('deepseek-v4-flash-vision-exp');
            const reopenedApiKeyInput = page.getByTestId('relationship-advisor-plugin-api-key');
            await expect(reopenedApiKeyInput).toHaveValue('');
            await reopenedApiKeyInput.fill('e2e-deepseek-secret');

            await expect(testConnectionButton).toBeVisible();
            await expect(testConnectionButton).toBeEnabled();
            const testResponsePromise = page.waitForResponse((response) => (
                response.request().method() === 'POST'
                && new URL(response.url()).pathname === '/v1/plugins/relationship-advisor/test-connection'
            ));
            const saveResponsePromise = page.waitForResponse((response) => (
                response.request().method() === 'PUT'
                && new URL(response.url()).pathname === '/v1/plugins/relationship-advisor'
            ));
            await testConnectionButton.click();
            expect((await testResponsePromise).status()).toBe(200);
            expect((await saveResponsePromise).status()).toBe(200);
            expect(testedConfiguration).toEqual({
                apiKey: 'e2e-deepseek-secret',
                baseUrl: 'https://api.deepseek.com',
                model: 'deepseek-v4-flash-vision-exp',
            });
            expect(savedConfiguration).toEqual(testedConfiguration);
            const result = page.getByTestId('relationship-advisor-plugin-test-connection-result');
            await expect(result).toBeVisible();
            await expect(result).toContainText(/连接成功|Connection successful/);
            await expect(unsavedChanges).toHaveCount(0);
            await pauseForRecordedReview(page);
            await page.screenshot({ path: evidencePath(testInfo, 'saved'), fullPage: true });

            await page.evaluate(() => {
                window.localStorage.setItem(
                    'mmkv.default\\local-settings',
                    JSON.stringify({ themePreference: 'dark', themePack: 'gingham' }),
                );
            });
            await page.emulateMedia({ colorScheme: 'dark' });
            await page.reload();
            await expect(pluginButton).toBeVisible({ timeout: 120_000 });
            await pluginButton.click();
            await page.getByTestId('plugin-marketplace-plugin-relationship-advisor').click();
            await expect(page.getByTestId('relationship-advisor-plugin-model'))
                .toHaveValue('deepseek-v4-flash-vision-exp');
            await expect.poll(() => page.locator('body').evaluate((element) => (
                window.getComputedStyle(element).backgroundColor
            ))).toBe('rgb(18, 24, 33)');
            await page.screenshot({ path: evidencePath(testInfo, 'dark'), fullPage: true });
        }
    } finally {
        // Playwright owns this fixture and closes it during worker teardown.
    }
});

test('[PLUGIN-CONNECTION-TEST] 测试失败时不保存并保留草稿', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installDevelopmentRefreshIndicatorSuppression(page);
    let updateRequests = 0;
    await page.route('**/v1/plugins', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            status: 200,
            body: JSON.stringify(catalogFixture),
        });
    });
    await page.route('**/v1/plugins/relationship-advisor/test-connection', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            status: 200,
            body: JSON.stringify({ success: false, code: 'authentication_failed' }),
        });
    });
    await page.route('**/v1/plugins/relationship-advisor', async (route) => {
        if (route.request().method() === 'PUT') updateRequests += 1;
        await route.fulfill({
            contentType: 'application/json',
            status: 500,
            body: JSON.stringify({ error: 'Unexpected save request' }),
        });
    });

    await page.goto(authenticatedRoute('/'));
    await expect(page.getByTestId('sidebar-plugins-button')).toBeVisible({ timeout: 120_000 });
    await page.getByTestId('sidebar-plugins-button').click();
    await page.getByTestId('plugin-marketplace-plugin-relationship-advisor').click();
    await page.getByTestId('relationship-advisor-plugin-api-key').fill('invalid-deepseek-secret');
    await page.getByTestId('relationship-advisor-plugin-base-url').fill('https://api.deepseek.com');
    await page.getByTestId('relationship-advisor-plugin-model').fill('deepseek-v4-flash-vision-exp');
    await page.getByTestId('relationship-advisor-plugin-test-connection').click();

    const result = page.getByTestId('relationship-advisor-plugin-test-connection-result');
    await expect(result).toContainText(/身份验证失败|Authentication failed/i);
    expect(updateRequests).toBe(0);
    await expect(page.getByTestId('relationship-advisor-plugin-unsaved-changes')).toBeVisible();

    await page.getByTestId('plugin-marketplace-back').click();
    await page.getByTestId('plugin-marketplace-plugin-relationship-advisor').click();
    await expect(page.getByTestId('relationship-advisor-plugin-base-url'))
        .toHaveValue('https://api.deepseek.com');
    await expect(page.getByTestId('relationship-advisor-plugin-model'))
        .toHaveValue('deepseek-v4-flash-vision-exp');
});
