import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { encodeBase64, encryptLegacy } from '../../happy-cli/src/api/encryption';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const e2eServerUrl = process.env.HAPPY_E2E_SERVER_URL!;
const recordEvidence = process.env.HAPPY_E2E_RECORD === '1';

test.setTimeout(360_000);

function authenticatedRoute(pathname: string): string {
    const url = new URL(authenticatedWebUrl);
    url.pathname = pathname;
    return url.toString();
}

function authContext(): { headers: Record<string, string>; encryptionKey: Uint8Array } {
    const url = new URL(authenticatedWebUrl);
    const token = url.searchParams.get('dev_token');
    const secret = url.searchParams.get('dev_secret');
    if (!token || !secret || !e2eServerUrl) throw new Error('Missing isolated E2E authentication context.');
    return {
        headers: { Authorization: `Bearer ${token}`, 'X-Happy-Client': 'playwright-e2e' },
        encryptionKey: new Uint8Array(Buffer.from(secret, 'base64url')),
    };
}

async function createSession(request: APIRequestContext, options: { name: string; summary: string; path: string }): Promise<string> {
    const { headers, encryptionKey } = authContext();
    const metadata = encodeBase64(encryptLegacy({
        path: options.path,
        host: 'three-level-e2e-mac',
        name: options.name,
        summary: { text: options.summary, updatedAt: Date.now() },
        flavor: 'codex',
        machineId: 'three-level-e2e-machine',
        homeDir: '/workspace',
        lifecycleState: 'running',
        startedBy: 'terminal',
    }, encryptionKey));
    const response = await request.post(new URL('/v1/sessions', e2eServerUrl).toString(), {
        data: { tag: `three-level-navigation-${Date.now()}-${Math.random()}`, metadata, agentState: null, dataEncryptionKey: null },
        headers,
    });
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { session: { id: string } }).session.id;
}

async function deleteSession(request: APIRequestContext, sessionId: string): Promise<void> {
    const { headers } = authContext();
    await request.post(new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/archive`, e2eServerUrl).toString(), { headers });
    const response = await request.delete(new URL(`/v1/sessions/${encodeURIComponent(sessionId)}`, e2eServerUrl).toString(), { headers });
    expect(response.ok()).toBe(true);
}

async function evidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
    if (!recordEvidence) return;
    await expect(page.locator('.__expo_fast_refresh_show')).toHaveCount(0, { timeout: 120_000 });
    await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
    await page.waitForTimeout(700);
}

async function createFolder(page: Page, name: string): Promise<void> {
    await page.getByTestId('sidebar-create-folder-button').click();
    await page.getByPlaceholder('Folder name').fill(name);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText(name, { exact: true })).toBeVisible();
}

async function createAgentList(page: Page, options: { name: string; folder: string }): Promise<string> {
    await page.getByTestId('sidebar-create-list-button').click();
    await expect(page.getByText('New list', { exact: true })).toBeVisible();
    await page.getByTestId('sidebar-list-name-input').fill(options.name);
    await page.getByTestId('sidebar-list-kind-agent').click();
    await page.getByRole('radio', { name: options.folder, exact: true }).click();
    await page.getByTestId('sidebar-create-list-submit').click();
    await expect(page.getByTestId('sidebar-create-list-submit')).toHaveCount(0);
    const row = page.getByText(options.name, { exact: true });
    await expect(row).toBeVisible();
    const testID = await row.locator('xpath=ancestor::*[@data-testid][1]').getAttribute('data-testid');
    expect(testID).toMatch(/^sidebar-list-/);
    return testID!.replace('sidebar-list-', '');
}

async function createTag(page: Page, name: string): Promise<void> {
    await page.getByTestId('sidebar-create-tag-button').click();
    await page.getByPlaceholder('Tag name').fill(name);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText(name, { exact: true })).toBeVisible();
}

test('[THREE-LEVEL-NAV-PC] icon rail, organization, sessions, chat, and Capability Hub coexist', async ({ page, request }, testInfo) => {
    page.setDefaultTimeout(120_000);
    page.setDefaultNavigationTimeout(180_000);
    const sessionId = await createSession(request, {
        name: 'Three level desktop runtime',
        summary: 'Three level desktop conversation',
        path: '/workspace/three-level-desktop',
    });

    try {
        await page.addInitScript(() => {
            const key = 'mmkv.default\\local-settings';
            const current = JSON.parse(window.localStorage.getItem(key) ?? '{}');
            window.localStorage.setItem(key, JSON.stringify({ ...current, themePreference: 'dark', themePack: 'gingham' }));
        });
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(authenticatedRoute(`/session/${sessionId}`));
        await expect(page.locator('[data-testid="session-header-title"]:visible')).toHaveText('Three level desktop conversation', { timeout: 120_000 });

        await expect(page.getByTestId('desktop-sidebar-icon-rail')).toBeVisible();
        await expect(page.getByTestId('sidebar-organization-pane')).toBeVisible();
        await expect(page.getByTestId('sidebar-session-pane')).toBeVisible();
        await expect(page.locator('[data-testid="desktop-right-panel"]:visible')).toBeVisible();
        await expect(page.locator('[data-testid^="desktop-sidebar-tab-"]')).toHaveCount(0);

        const organizationToggle = page.getByTestId('sidebar-organization-collapse-button');
        const sessionPaneTitle = page.getByTestId('sidebar-session-pane-title');
        await expect(organizationToggle).toHaveAttribute('aria-expanded', 'true');
        const toggleBox = await organizationToggle.boundingBox();
        const titleBox = await sessionPaneTitle.boundingBox();
        expect(toggleBox).not.toBeNull();
        expect(titleBox).not.toBeNull();
        expect(toggleBox!.x + toggleBox!.width).toBeLessThanOrEqual(titleBox!.x + 1);

        const organizationResize = page.getByTestId('sidebar-organization-resize-handle');
        const organizationBeforeResize = await page.getByTestId('sidebar-organization-pane').boundingBox();
        const organizationHandleBox = await organizationResize.boundingBox();
        expect(organizationBeforeResize).not.toBeNull();
        expect(organizationHandleBox).not.toBeNull();
        await page.mouse.move(organizationHandleBox!.x + organizationHandleBox!.width / 2, organizationHandleBox!.y + 80);
        await page.mouse.down();
        await page.mouse.move(organizationHandleBox!.x + organizationHandleBox!.width / 2 + 36, organizationHandleBox!.y + 80, { steps: 5 });
        await page.mouse.up();
        await expect.poll(async () => (await page.getByTestId('sidebar-organization-pane').boundingBox())?.width ?? 0)
            .toBeGreaterThan(organizationBeforeResize!.width + 28);
        const resizedOrganizationWidth = Number(await organizationResize.getAttribute('aria-valuenow'));
        await expect.poll(() => page.evaluate(() => {
            const stored = window.localStorage.getItem('mmkv.default\\local-settings');
            if (!stored) return null;
            return JSON.parse(stored).desktopSidebarOrganizationWidth ?? null;
        })).toBe(resizedOrganizationWidth);

        await page.reload();
        await expect(page.locator('[data-testid="session-header-title"]:visible')).toHaveText('Three level desktop conversation', { timeout: 120_000 });
        await expect(page.getByTestId('sidebar-organization-resize-handle')).toHaveAttribute('aria-valuenow', String(resizedOrganizationWidth));
        await page.getByTestId('sidebar-organization-collapse-button').click();
        await expect(page.getByTestId('sidebar-organization-collapse-button')).toHaveAttribute('aria-expanded', 'false');
        await expect(page.getByTestId('sidebar-organization-pane')).toHaveCount(0);
        await expect(page.getByTestId('sidebar-session-pane')).toBeVisible();
        await expect(page.getByTestId('sidebar-organization-resize-handle')).toHaveCount(0);
        await page.reload();
        await expect(page.locator('[data-testid="session-header-title"]:visible')).toHaveText('Three level desktop conversation', { timeout: 120_000 });
        await expect(page.getByTestId('sidebar-organization-pane')).toHaveCount(0);
        await page.getByTestId('sidebar-organization-collapse-button').click();
        await expect(page.getByTestId('sidebar-organization-pane')).toBeVisible();

        const rightPanelToggle = page.locator('[data-testid="desktop-right-panel-toggle-button"]:visible');
        await rightPanelToggle.click();
        await expect(page.locator('[data-testid="desktop-right-panel"]:visible')).toHaveCount(0);
        const wholeSidebar = page.getByTestId('desktop-left-sidebar');
        const wholeSidebarResize = page.getByTestId('desktop-left-panel-resize-handle');
        const wholeSidebarBeforeResize = await wholeSidebar.boundingBox();
        const wholeSidebarHandleBox = await wholeSidebarResize.boundingBox();
        expect(wholeSidebarBeforeResize).not.toBeNull();
        expect(wholeSidebarHandleBox).not.toBeNull();
        await page.mouse.move(wholeSidebarHandleBox!.x + wholeSidebarHandleBox!.width / 2, wholeSidebarHandleBox!.y + 120);
        await page.mouse.down();
        await page.mouse.move(wholeSidebarHandleBox!.x + wholeSidebarHandleBox!.width / 2 + 28, wholeSidebarHandleBox!.y + 120, { steps: 5 });
        await page.mouse.up();
        await expect.poll(async () => (await wholeSidebar.boundingBox())?.width ?? 0)
            .toBeGreaterThan(wholeSidebarBeforeResize!.width + 20);
        await rightPanelToggle.click();
        await expect(page.locator('[data-testid="desktop-right-panel"]:visible')).toBeVisible();

        for (const testID of [
            'sidebar-new-session-button',
            'sidebar-inbox-button',
            'sidebar-command-palette-button',
            'sidebar-plugins-button',
            'sidebar-my-agents-button',
            'sidebar-notifications-button',
        ]) await expect(page.getByTestId(testID)).toBeVisible();

        await page.getByTestId('sidebar-command-palette-button').hover();
        await expect(page.getByTestId('sidebar-command-palette-button-tooltip')).toBeVisible();
        await page.getByTestId('sidebar-account-trigger').click();
        await expect(page.getByTestId('sidebar-account-settings-action')).toBeVisible();
        await page.keyboard.press('Escape');
        await page.getByTestId('sidebar-help-trigger').click();
        await expect(page.getByTestId('sidebar-help-shortcuts-action')).toBeVisible();
        await page.keyboard.press('Escape');
        const projectRow = page.getByTestId('sidebar-project-toggle-three-level-e2e-machine--%2Fworkspace%2Fthree-level-desktop');
        await projectRow.hover();
        await expect(page.getByTestId('sidebar-project-toggle-three-level-e2e-machine--%2Fworkspace%2Fthree-level-desktop-new-session-action')).toHaveAccessibleName('New session');
        await projectRow.click({ button: 'right' });
        await expect(page.getByText('Pin Session', { exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await page.locator('[data-testid="session-header-title"]:visible').click();
        await expect(page.getByText('Pin Session', { exact: true })).toHaveCount(0);
        await page.getByTestId(`session-row-${sessionId}`).hover();
        const sessionActions = page.getByTestId(`session-row-actions-${sessionId}`);
        await expect(page.getByTestId(`organize-session-${sessionId}`)).toBeVisible();
        await sessionActions.getByTestId('session-row-more-action').click();
        await expect(page.getByText('Pin Session', { exact: true })).toBeVisible();
        await expect(page.getByText('Archive Session', { exact: true })).toBeVisible();
        await expect(page.getByText('Delete Session', { exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await page.locator('[data-testid="session-header-title"]:visible').click();
        await expect(page.getByText('Pin Session', { exact: true })).toHaveCount(0);
        await evidence(page, testInfo, 'pc-01-five-columns-and-history');

        await createFolder(page, 'Desktop Work');
        const listId = await createAgentList(page, { name: 'Desktop Happy', folder: 'Desktop Work' });
        await createTag(page, 'desktop-review');

        await page.getByTestId('sidebar-list-unassigned').click();
        await expect(page.getByTestId(`session-row-${sessionId}`)).toBeVisible();
        await page.getByTestId(`organize-session-${sessionId}`).click();
        await page.getByRole('radio', { name: 'Desktop Happy', exact: true }).click();
        await page.getByRole('checkbox', { name: 'desktop-review', exact: true }).click();
        await page.getByTestId('organize-session-save').click();

        await page.getByTestId(`sidebar-list-${listId}`).click();
        await expect(page.getByTestId(`session-row-${sessionId}`)).toBeVisible();
        await expect(page.getByTestId(`session-row-tags-${sessionId}`)).toContainText('#desktop-review');
        await expect(page).toHaveURL((url) => url.pathname === `/session/${sessionId}`);

        await page.getByTestId('sidebar-tags-visibility-button').click();
        await expect(page.getByTestId('sidebar-tags-visibility-menu')).toBeVisible();
        await expect(page.getByTestId('sidebar-tags-visibility-when-populated')).toHaveAttribute('aria-checked', 'true');
        await page.getByTestId('sidebar-tags-visibility-hidden').click();
        await expect(page.locator('[data-testid^="sidebar-tag-"]').filter({ hasText: 'desktop-review' })).toHaveCount(0);
        await evidence(page, testInfo, 'pc-02-folder-list-session-and-tag-controls');
    } finally {
        await page.close();
        await deleteSession(request, sessionId);
    }
});

test('[THREE-LEVEL-NAV-COMPACT-WEB] 800-979px preserves usable organization and session columns', async ({ page }) => {
    page.setDefaultTimeout(120_000);
    page.setDefaultNavigationTimeout(180_000);
    await page.addInitScript(() => {
        const key = 'mmkv.default\\local-settings';
        const current = JSON.parse(window.localStorage.getItem(key) ?? '{}');
        window.localStorage.setItem(key, JSON.stringify({
            ...current,
            desktopSidebarOrganizationCollapsed: false,
            desktopSidebarOrganizationWidth: 320,
        }));
    });
    await page.setViewportSize({ width: 800, height: 720 });
    await page.goto(authenticatedRoute('/'));
    await expect(page.getByRole('textbox')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('desktop-sidebar-icon-rail')).toBeVisible();
    await expect(page.getByTestId('sidebar-organization-pane')).toBeVisible();
    await expect(page.getByTestId('sidebar-session-pane')).toBeVisible();
    const organizationBox = await page.getByTestId('sidebar-organization-pane').boundingBox();
    const sessionBox = await page.getByTestId('sidebar-session-pane').boundingBox();
    expect(organizationBox?.width).toBeGreaterThanOrEqual(176);
    expect(sessionBox?.width).toBeGreaterThanOrEqual(200);

    const resizeHandle = page.getByTestId('sidebar-organization-resize-handle');
    await expect(resizeHandle).toHaveAttribute('aria-valuemax', '242');
    await resizeHandle.press('End');
    await expect(resizeHandle).toHaveAttribute('aria-valuenow', '242');
    const resizedSessionBox = await page.getByTestId('sidebar-session-pane').boundingBox();
    expect(resizedSessionBox?.width).toBeGreaterThanOrEqual(200);
});

test('[THREE-LEVEL-NAV-MOBILE] full-text drawer steps through organization, sessions, and chat', async ({ page, request }, testInfo) => {
    page.setDefaultTimeout(120_000);
    page.setDefaultNavigationTimeout(180_000);
    const sessionId = await createSession(request, {
        name: 'Three level mobile runtime',
        summary: 'Three level mobile conversation',
        path: '/workspace/three-level-mobile',
    });

    try {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(authenticatedRoute('/'));
        await expect(page.getByRole('textbox')).toBeVisible({ timeout: 120_000 });
        await page.getByTestId('compose-home-drawer-button').click();
        await expect(page.getByTestId('sidebar-organization-pane')).toBeVisible();
        await expect(page.getByTestId('desktop-sidebar-icon-rail')).toHaveCount(0);
        for (const testID of ['sidebar-new-session-button', 'sidebar-inbox-button', 'sidebar-command-palette-button', 'sidebar-plugins-button', 'sidebar-my-agents-button']) {
            await expect(page.getByTestId(testID)).toBeVisible();
        }
        await evidence(page, testInfo, 'mobile-01-full-text-organization');

        await createFolder(page, 'Mobile Work');
        const listId = await createAgentList(page, { name: 'Mobile Happy', folder: 'Mobile Work' });
        await page.getByTestId('sidebar-list-unassigned').click();
        await expect(page.getByTestId('sidebar-session-pane')).toBeVisible();
        await expect(page.getByTestId('sidebar-organization-pane')).toHaveCount(0);
        await expect(page.getByTestId(`session-row-${sessionId}`)).toBeVisible();
        await evidence(page, testInfo, 'mobile-02-session-step');

        await page.getByTestId(`session-row-${sessionId}`).click();
        await expect(page).toHaveURL((url) => url.pathname === `/session/${sessionId}`);
        await expect(page.getByRole('textbox', { name: 'Type a message ...' })).toBeVisible();
        await expect(page.getByText(/CLOSE_DRAWER/)).toHaveCount(0);
        await evidence(page, testInfo, 'mobile-03-chat-step');

        await page.getByTestId('chat-header-list-button').click();
        await expect(page.getByTestId('sidebar-session-pane')).toBeVisible();
        await expect(page.getByTestId(`session-row-${sessionId}`)).toBeVisible();
        await page.getByTestId('sidebar-session-pane-back').click();
        await expect(page.getByTestId('sidebar-organization-pane')).toBeVisible();
        await expect(page.getByText('Mobile Work', { exact: true })).toBeVisible();
        await page.getByTestId('sidebar-tags-visibility-button').click();
        await expect(page.getByTestId('sidebar-tags-visibility-sheet')).toBeVisible();
        await expect(page.getByTestId('sidebar-tags-visibility-hidden')).toBeVisible();
        await evidence(page, testInfo, 'mobile-04-tag-visibility-sheet');
        await page.getByTestId('sidebar-tags-visibility-always').click();
        await expect(page.getByTestId('sidebar-tags-visibility-sheet')).toHaveCount(0);
        await expect(page.getByTestId(`sidebar-list-${listId}`)).toBeVisible();
        await evidence(page, testInfo, 'mobile-05-folder-and-list-persisted');
    } finally {
        await page.close();
        await deleteSession(request, sessionId);
    }
});
