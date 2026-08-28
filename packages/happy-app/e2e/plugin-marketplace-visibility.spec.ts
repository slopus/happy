import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { pluginPackages } from '@paws/plugins/catalog';
import fs from 'node:fs';
import path from 'node:path';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const evidenceDirectory = process.env.HAPPY_PLUGIN_VISIBILITY_EVIDENCE_DIR;
const evidencePhase = process.env.HAPPY_PLUGIN_VISIBILITY_EVIDENCE_PHASE === 'before'
    ? 'before'
    : 'after';

function authenticatedRoute(pathname: string): string {
    const url = new URL(authenticatedWebUrl);
    url.pathname = pathname;
    return url.toString();
}

function evidencePath(testInfo: TestInfo, caseId: 1 | 2 | 3): string {
    const filename = `case-${caseId}-${evidencePhase}.png`;
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

async function pauseForRecordedReview(page: Page): Promise<void> {
    if (process.env.HAPPY_E2E_RECORD === '1') {
        await page.waitForTimeout(1_000);
    }
}

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

test('[PLUGIN-MARKETPLACE-VISIBILITY] 插件目录有内容且未安装军师不进入我的 Agent', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installDevelopmentRefreshIndicatorSuppression(page);
    let baselineCatalogMode: 'missing' | 'uninstalled' | 'installed' = 'missing';

    try {
        if (evidencePhase === 'before') {
            // Reproduce the production failure that motivated PR #376: the old
            // standalone image did not expose the newly added plugin route.
            await page.route('**/v1/plugins', async (route) => {
                if (baselineCatalogMode !== 'missing') {
                    await route.fulfill({
                        contentType: 'application/json',
                        status: 200,
                        body: JSON.stringify(baselineCatalogMode === 'uninstalled'
                            ? {
                                plugins: catalogFixture.plugins.map(({ manifest }) => ({
                                    manifest,
                                    status: { installed: false },
                                })),
                            }
                            : catalogFixture),
                    });
                    return;
                }
                await route.fulfill({
                    contentType: 'application/json',
                    status: 404,
                    body: JSON.stringify({ error: 'not_found' }),
                });
            });
        }

        await page.goto(authenticatedRoute('/'));
        const pluginButton = page.getByTestId('sidebar-plugins-button');
        await expect(pluginButton).toBeVisible({ timeout: 120_000 });

        const catalogResponsePromise = page.waitForResponse((response) => (
            response.request().method() === 'GET'
            && new URL(response.url()).pathname === '/v1/plugins'
        ));
        await pluginButton.click();

        const catalogResponse = await catalogResponsePromise;
        const marketplace = page.getByTestId('plugin-marketplace-desktop-dialog');
        await expect(marketplace).toBeVisible();
        if (evidencePhase === 'before') {
            expect(catalogResponse.status()).toBe(404);
            await expect(page.getByTestId('plugin-marketplace-empty')).toBeVisible();
            await expect(page.locator('[data-testid^="plugin-marketplace-plugin-"]')).toHaveCount(0);
        } else {
            expect(catalogResponse.status()).toBe(200);
            const catalog = await catalogResponse.json() as {
                plugins: Array<{ manifest: { id: string }; status: { installed: boolean } }>;
            };
            expect(catalog.plugins.map((plugin) => plugin.manifest.id).sort()).toEqual([
                'generated-images-gallery',
                'relationship-advisor',
            ]);
            expect(catalog.plugins.every((plugin) => plugin.status.installed === false)).toBe(true);
            await expect(page.getByTestId('plugin-marketplace-empty')).toHaveCount(0);
            await expect(page.getByTestId('plugin-marketplace-plugin-relationship-advisor')).toBeVisible();
            await expect(page.getByTestId('plugin-marketplace-plugin-generated-images-gallery')).toBeVisible();
        }
        await pauseForRecordedReview(page);
        await page.screenshot({ path: evidencePath(testInfo, 1), fullPage: true });
        if (evidencePhase === 'before') baselineCatalogMode = 'uninstalled';

        await page.getByTestId('plugin-marketplace-close').click();
        await expect(marketplace).toHaveCount(0);

        await page.getByTestId('sidebar-my-agents-button').click();
        const agentDialog = page.getByTestId('agent-sheet-desktop-dialog');
        await expect(agentDialog).toBeVisible();
        const relationshipAdvisor = page.getByTestId('agent-sheet-relationship-advisor');
        if (evidencePhase === 'before') {
            await expect(relationshipAdvisor).toBeVisible();
        } else {
            await expect(relationshipAdvisor).toHaveCount(0);
        }
        await pauseForRecordedReview(page);
        await page.screenshot({ path: evidencePath(testInfo, 2), fullPage: true });
        if (evidencePhase === 'before') baselineCatalogMode = 'installed';

        await page.keyboard.press('Escape');
        await expect(agentDialog).toHaveCount(0);

        if (evidencePhase === 'after') {
            await page.route('**/v1/plugins', async (route) => {
                await route.fulfill({
                    contentType: 'application/json',
                    status: 200,
                    body: JSON.stringify(catalogFixture),
                });
            });
        }

        await pluginButton.click();
        await expect(marketplace).toBeVisible();
        await page.getByTestId('plugin-marketplace-plugin-relationship-advisor').click();
        const secretInput = page.getByTestId('relationship-advisor-plugin-api-key');
        const visibilityToggle = page.getByTestId('relationship-advisor-plugin-api-key-visibility-toggle');
        await expect(secretInput).toBeVisible();
        await expect(secretInput).toHaveAttribute('type', 'password');
        if (evidencePhase === 'before') {
            await expect(visibilityToggle).toHaveCount(0);
        } else {
            await expect(visibilityToggle).toBeVisible();
            await expect(visibilityToggle).toBeDisabled();
        }
        await pauseForRecordedReview(page);
        await page.screenshot({ path: evidencePath(testInfo, 3), fullPage: true });

        if (evidencePhase === 'after') {
            await secretInput.fill('e2e-replacement-secret');
            await expect(visibilityToggle).toBeEnabled();
            await visibilityToggle.click();
            await expect.poll(() => secretInput.evaluate((element) => (
                (element as HTMLInputElement).type
            ))).toBe('text');
            await expect(secretInput).toHaveValue('e2e-replacement-secret');
            await pauseForRecordedReview(page);

            await secretInput.fill('');
            await expect(secretInput).toHaveAttribute('type', 'password');
            await expect(visibilityToggle).toBeDisabled();
            await pauseForRecordedReview(page);

            await secretInput.fill('e2e-replacement-secret');
            await expect(visibilityToggle).toBeEnabled();
            await visibilityToggle.click();
            await expect.poll(() => secretInput.evaluate((element) => (
                (element as HTMLInputElement).type
            ))).toBe('text');
            await pauseForRecordedReview(page);
            await visibilityToggle.click();
            await expect(secretInput).toHaveAttribute('type', 'password');
            await pauseForRecordedReview(page);
        }
    } finally {
        await page.close();
    }
});
