import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { pluginPackages } from '@paws/plugins/catalog';
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

function evidencePath(testInfo: TestInfo): string {
    const filename = `case-1-${evidencePhase}.png`;
    if (!evidenceDirectory) return testInfo.outputPath(filename);
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    return path.join(evidenceDirectory, filename);
}

const catalogFixture = {
    plugins: pluginPackages.map(({ manifest }) => ({
        manifest,
        status: manifest.id === 'relationship-advisor'
            ? {
                installed: true,
                version: manifest.version,
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

test('[PLUGIN-CONNECTION-TEST] 配置页可在保存前验证服务商连接', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installDevelopmentRefreshIndicatorSuppression(page);
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
            body: JSON.stringify({ success: true, latencyMs: 31 }),
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
            await expect(testConnectionButton).toHaveCount(0);
        } else {
            await expect(testConnectionButton).toBeVisible();
            await expect(testConnectionButton).toBeEnabled();
            const responsePromise = page.waitForResponse((response) => (
                response.request().method() === 'POST'
                && new URL(response.url()).pathname === '/v1/plugins/relationship-advisor/test-connection'
            ));
            await testConnectionButton.click();
            expect((await responsePromise).status()).toBe(200);
            const result = page.getByTestId('relationship-advisor-plugin-test-connection-result');
            await expect(result).toBeVisible();
            await expect(result).toContainText(/连接成功|Connection successful/);
        }

        await page.screenshot({ path: evidencePath(testInfo), fullPage: true });
    } finally {
        // Playwright owns this fixture and closes it during worker teardown.
    }
});
