import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { pluginPackages } from '@paws/plugins/catalog';
import fs from 'node:fs';
import path from 'node:path';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const evidenceDirectory = process.env.HAPPY_PLUGIN_VISIBILITY_EVIDENCE_DIR;
const evidencePhase = process.env.HAPPY_PLUGIN_VISIBILITY_EVIDENCE_PHASE === 'before'
    ? 'before'
    : 'after';
const permissionEvidenceDirectory = process.env.HAPPY_PLUGIN_PERMISSION_EVIDENCE_DIR;
const permissionEvidencePhase = process.env.HAPPY_PLUGIN_PERMISSION_EVIDENCE_PHASE === 'before'
    ? 'before'
    : 'after';
const reviewEvidenceDirectory = process.env.HAPPY_PLUGIN_REVIEW_EVIDENCE_DIR;
const reviewEvidencePhase = process.env.HAPPY_PLUGIN_REVIEW_EVIDENCE_PHASE === 'before'
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

function permissionEvidencePath(testInfo: TestInfo): string {
    const filename = `case-1-${permissionEvidencePhase}.png`;
    if (!permissionEvidenceDirectory) return testInfo.outputPath(filename);
    fs.mkdirSync(permissionEvidenceDirectory, { recursive: true });
    return path.join(permissionEvidenceDirectory, filename);
}

function reviewEvidencePath(testInfo: TestInfo): string {
    const filename = `case-2-${reviewEvidencePhase}.png`;
    if (!reviewEvidenceDirectory) return testInfo.outputPath(filename);
    fs.mkdirSync(reviewEvidenceDirectory, { recursive: true });
    return path.join(reviewEvidenceDirectory, filename);
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

async function activateGinghamDarkTheme(page: Page): Promise<void> {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(authenticatedRoute('/settings/appearance'));
    const gingham = page.getByText('Gingham', { exact: true });
    await expect(gingham).toBeVisible({ timeout: 120_000 });
    await gingham.click();
    await expectGinghamDarkTheme(page);
}

async function expectGinghamDarkTheme(page: Page): Promise<void> {
    await expect.poll(() => page.locator('body').evaluate((element) => (
        window.getComputedStyle(element).backgroundColor
    ))).toBe('rgb(18, 24, 33)');
}

const evidenceMode = Boolean(
    evidenceDirectory
    || permissionEvidenceDirectory
    || reviewEvidenceDirectory,
);
test.setTimeout(evidenceMode ? 600_000 : 120_000);

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

        const catalogResponsePromise = page.waitForResponse((response) => (
            response.request().method() === 'GET'
            && new URL(response.url()).pathname === '/v1/plugins'
        ));
        await page.goto(authenticatedRoute('/'));
        const pluginButton = page.getByTestId('sidebar-plugins-button');
        await expect(pluginButton).toBeVisible({ timeout: 120_000 });

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

test('[PLUGIN-PERMISSION-GRANTS] 安装前展示内置代码边界与完整权限', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 1200 });
    await installDevelopmentRefreshIndicatorSuppression(page);
    await page.route('**/v1/plugins', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            status: 200,
            body: JSON.stringify({
                plugins: catalogFixture.plugins.map(({ manifest }) => ({
                    manifest,
                    status: { installed: false },
                })),
            }),
        });
    });

    try {
        await activateGinghamDarkTheme(page);
        await page.getByTestId('sidebar-plugins-button').click();
        await expect(page.getByTestId('plugin-marketplace-desktop-dialog')).toBeVisible({ timeout: 120_000 });
        await page.getByTestId('plugin-marketplace-plugin-relationship-advisor').click();
        await expect(page.getByTestId('relationship-advisor-plugin-api-key')).toBeVisible();

        const permissions = page.getByTestId('relationship-advisor-plugin-permissions');
        if (permissionEvidencePhase === 'before') {
            await expect(permissions).toHaveCount(0);
        } else {
            await expect(permissions).toBeVisible();
            await expect(page.getByTestId('relationship-advisor-built-in-code')).toBeVisible();
            await expect(page.locator('[data-testid^="relationship-advisor-permission-"]')).toHaveCount(4);
            for (const permission of [
                'paws.ai.provider.invoke',
                'paws.secrets.use',
                'paws.conversations.images.read',
                'paws.storage.images.write',
            ]) {
                await expect(page.getByTestId(`relationship-advisor-permission-${permission}`)).toBeVisible();
            }
            const imageWritePermission = page.getByTestId(
                'relationship-advisor-permission-paws.storage.images.write',
            );
            await imageWritePermission.scrollIntoViewIfNeeded();
            await expect(imageWritePermission).toBeInViewport();
        }

        await pauseForRecordedReview(page);
        await page.screenshot({ path: permissionEvidencePath(testInfo), fullPage: true });

        if (permissionEvidenceDirectory) return;
        if (permissionEvidencePhase === 'after') {
            await page.setViewportSize({ width: 390, height: 844 });
            await expect(page.getByTestId('plugin-marketplace-mobile-drawer')).toBeVisible();
            await expect(page.getByTestId('relationship-advisor-plugin-permissions')).toBeVisible();
        }
    } finally {
        await page.close();
    }
});

test('[PLUGIN-PERMISSION-REVIEW] 授权快照失效时要求复审并可安全卸载', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installDevelopmentRefreshIndicatorSuppression(page);
    let installed = true;
    const partialGrantCatalog = () => ({
        plugins: catalogFixture.plugins.map(({ manifest }) => ({
            manifest,
            status: manifest.id === 'relationship-advisor' && installed
                ? {
                    installed: true,
                    version: manifest.version,
                    grantedPermissions: ['paws.storage.images.write'],
                    configuration: {
                        baseUrl: 'https://api.example.com/v1',
                        model: 'example/model-mini',
                    },
                    secretHints: { apiKey: 'LLPq' },
                }
                : { installed: false },
        })),
    });
    await page.route('**/v1/plugins', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            status: 200,
            body: JSON.stringify(partialGrantCatalog()),
        });
    });
    await page.route('**/v1/plugins/relationship-advisor', async (route) => {
        if (route.request().method() !== 'DELETE') {
            await route.fallback();
            return;
        }
        installed = false;
        await route.fulfill({
            contentType: 'application/json',
            status: 200,
            body: JSON.stringify({ installed: false }),
        });
    });

    try {
        await activateGinghamDarkTheme(page);
        await page.getByTestId('sidebar-plugins-button').click();
        await expect(page.getByTestId('plugin-marketplace-desktop-dialog')).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('plugin-marketplace-installed-relationship-advisor')).toHaveCount(0);
        await page.getByTestId('plugin-marketplace-plugin-relationship-advisor').click();

        const status = page.getByTestId('relationship-advisor-plugin-status');
        await expect(status).toContainText(/Review required|需要重新确认/);
        await expect(page.getByTestId('relationship-advisor-plugin-open')).toHaveCount(0);
        const reviewAction = page.getByTestId('relationship-advisor-plugin-install');
        await reviewAction.scrollIntoViewIfNeeded();
        await expect(reviewAction).toBeVisible();
        await page.screenshot({ path: reviewEvidencePath(testInfo), fullPage: true });

        if (reviewEvidenceDirectory) return;
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.getByTestId('plugin-marketplace-mobile-drawer')).toBeVisible();
        await expect(status).toContainText(/Review required|需要重新确认/);

        await page.getByTestId('relationship-advisor-plugin-uninstall').click();
        await expect(status).toContainText(/Not installed|未安装/);
        await expect(page.getByTestId('relationship-advisor-plugin-uninstall')).toHaveCount(0);
    } finally {
        await page.close();
    }
});

test('[PLUGIN-INSTALL-LIFECYCLE] 画廊插件通过真实 API 完成安装与卸载闭环', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installDevelopmentRefreshIndicatorSuppression(page);

    const isPluginResponse = (response: import('@playwright/test').Response, method: string, pathname: string) => (
        response.request().method() === method
        && new URL(response.url()).pathname === pathname
    );

    try {
        await page.goto(authenticatedRoute('/'));
        await expect(page.getByTestId('compose-home-creation-rail')).toHaveCount(0);
        const pluginButton = page.getByTestId('sidebar-plugins-button');
        await expect(pluginButton).toBeVisible({ timeout: 120_000 });
        await pluginButton.click();
        await expect(page.getByTestId('plugin-marketplace-desktop-dialog')).toBeVisible();
        await page.getByTestId('plugin-marketplace-plugin-generated-images-gallery').click();

        const installButton = page.getByTestId('generated-images-gallery-plugin-install');
        await expect(installButton).toBeVisible();
        const installResponsePromise = page.waitForResponse((response) => isPluginResponse(
            response,
            'PUT',
            '/v1/plugins/generated-images-gallery',
        ));
        const installedCatalogPromise = page.waitForResponse((response) => isPluginResponse(
            response,
            'GET',
            '/v1/plugins',
        ));
        await installButton.click();

        const installResponse = await installResponsePromise;
        expect(installResponse.status()).toBe(200);
        const installedCatalogResponse = await installedCatalogPromise;
        expect(installedCatalogResponse.status()).toBe(200);
        const installedCatalog = await installedCatalogResponse.json() as typeof catalogFixture;
        expect(installedCatalog.plugins.find(({ manifest }) => (
            manifest.id === 'generated-images-gallery'
        ))?.status).toMatchObject({
            installed: true,
            grantedPermissions: ['paws.conversations.images.read'],
        });
        await expect(page).toHaveURL(/\/generated-images$/);

        await page.goto(authenticatedRoute('/'));
        await expect(page.getByTestId('compose-home-creation-rail')).toBeVisible();

        await pluginButton.click();
        await expect(page.getByTestId('plugin-marketplace-desktop-dialog')).toBeVisible();
        await expect(page.getByTestId('plugin-marketplace-installed-generated-images-gallery')).toBeVisible();
        await page.getByTestId('plugin-marketplace-plugin-generated-images-gallery').click();

        const uninstallButton = page.getByTestId('generated-images-gallery-plugin-uninstall');
        await expect(uninstallButton).toBeVisible();
        const uninstallResponsePromise = page.waitForResponse((response) => isPluginResponse(
            response,
            'DELETE',
            '/v1/plugins/generated-images-gallery',
        ));
        const uninstalledCatalogPromise = page.waitForResponse((response) => isPluginResponse(
            response,
            'GET',
            '/v1/plugins',
        ));
        await uninstallButton.click();

        const uninstallResponse = await uninstallResponsePromise;
        expect(uninstallResponse.status()).toBe(200);
        const uninstalledCatalogResponse = await uninstalledCatalogPromise;
        expect(uninstalledCatalogResponse.status()).toBe(200);
        const uninstalledCatalog = await uninstalledCatalogResponse.json() as typeof catalogFixture;
        expect(uninstalledCatalog.plugins.find(({ manifest }) => (
            manifest.id === 'generated-images-gallery'
        ))?.status).toEqual({ installed: false });
        await expect(page.getByTestId('generated-images-gallery-plugin-uninstall')).toHaveCount(0);
        await expect(page.getByTestId('generated-images-gallery-plugin-status'))
            .toContainText(/Not installed|未安装/);
        await page.getByTestId('plugin-marketplace-close').click();
        await expect(page.getByTestId('compose-home-creation-rail')).toHaveCount(0);

        const imageModeUrl = new URL(authenticatedRoute('/new'));
        imageModeUrl.searchParams.set('mode', 'image-styles');
        await page.goto(imageModeUrl.toString());
        await expect(page.getByTestId('compose-home-image-agent-panel')).toHaveCount(0);
    } finally {
        await page.close();
    }
});
