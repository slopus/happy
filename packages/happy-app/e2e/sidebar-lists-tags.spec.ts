import { expect, test, type APIRequestContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { encodeBase64, encryptLegacy } from '../../happy-cli/src/api/encryption';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const e2eServerUrl = process.env.HAPPY_E2E_SERVER_URL!;
const recordEvidence = process.env.HAPPY_E2E_RECORD === '1';
const tagComboboxEvidenceDirectory = process.env.HAPPY_TAG_COMBOBOX_EVIDENCE_DIR;

test.use({ video: 'off', trace: 'off' });
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
    if (!token || !secret || !e2eServerUrl) {
        throw new Error('Missing isolated E2E authentication context.');
    }
    return {
        headers: { Authorization: `Bearer ${token}`, 'X-Happy-Client': 'playwright-e2e' },
        encryptionKey: new Uint8Array(Buffer.from(secret, 'base64url')),
    };
}

async function createSession(
    request: APIRequestContext,
    options: { name: string; summary: string; path: string },
): Promise<string> {
    const { headers, encryptionKey } = authContext();
    const metadata = encodeBase64(encryptLegacy({
        path: options.path,
        host: 'sidebar-e2e-mac',
        name: options.name,
        summary: { text: options.summary, updatedAt: Date.now() },
        flavor: 'codex',
        machineId: 'sidebar-e2e-machine',
        homeDir: '/workspace',
        lifecycleState: 'running',
        startedBy: 'terminal',
    }, encryptionKey));
    const response = await request.post(new URL('/v1/sessions', e2eServerUrl).toString(), {
        data: {
            tag: `sidebar-lists-tags-${Date.now()}-${Math.random()}`,
            metadata,
            agentState: null,
            dataEncryptionKey: null,
        },
        headers,
    });
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { session: { id: string } }).session.id;
}

async function deleteSession(request: APIRequestContext, sessionId: string): Promise<void> {
    const { headers } = authContext();
    await request.post(new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/archive`, e2eServerUrl).toString(), { headers });
    const response = await request.delete(
        new URL(`/v1/sessions/${encodeURIComponent(sessionId)}`, e2eServerUrl).toString(),
        { headers },
    );
    expect(response.ok()).toBe(true);
}

async function createMachine(request: APIRequestContext): Promise<string> {
    const { headers, encryptionKey } = authContext();
    const machineId = 'sidebar-e2e-machine';
    const metadata = encodeBase64(encryptLegacy({
        host: 'sidebar-e2e-mac',
        displayName: 'Sidebar E2E Mac',
        platform: 'darwin',
        happyCliVersion: '0.0.0-e2e',
        happyHomeDir: '/workspace/.happy',
        homeDir: '/workspace',
        cliAvailability: {
            ask: true,
            claude: true,
            codex: true,
            gemini: true,
            opencode: true,
            openclaw: true,
            detectedAt: Date.now(),
        },
    }, encryptionKey));
    const response = await request.post(new URL('/v1/machines', e2eServerUrl).toString(), {
        data: { id: machineId, metadata, dataEncryptionKey: null },
        headers,
    });
    expect(response.ok()).toBe(true);
    return machineId;
}

async function deleteMachine(request: APIRequestContext, machineId: string): Promise<void> {
    const { headers } = authContext();
    const response = await request.delete(
        new URL(`/v1/machines/${encodeURIComponent(machineId)}`, e2eServerUrl).toString(),
        { headers },
    );
    expect(response.ok() || response.status() === 404).toBe(true);
}

async function pauseForReview(page: Page, duration = 850): Promise<void> {
    if (!recordEvidence) return;
    await page.waitForTimeout(duration);
    await waitForDevelopmentOverlayToClear(page);
}

async function waitForDevelopmentOverlayToClear(page: Page): Promise<void> {
    if (!recordEvidence) return;
    await expect(page.locator('.__expo_fast_refresh_show')).toHaveCount(0, { timeout: 120_000 });
}

async function configureAskApi(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const storageKey = 'mmkv.default\\local-settings';
        const existing = JSON.parse(window.localStorage.getItem(storageKey) ?? '{}') as Record<string, unknown>;
        window.localStorage.setItem(storageKey, JSON.stringify({
            ...existing,
            askApi: {
                apiKey: 'sidebar-e2e-ask-key',
                baseUrl: '',
                tavilyApiKey: '',
            },
        }));
    });
}

async function captureEvidenceFrame(page: Page, testInfo: TestInfo, name: string): Promise<void> {
    if (!recordEvidence) return;
    await waitForDevelopmentOverlayToClear(page);
    await page.screenshot({ path: testInfo.outputPath(`evidence-${name}.png`), fullPage: true });
}

function tagComboboxEvidencePath(testInfo: TestInfo, filename: string): string {
    if (!tagComboboxEvidenceDirectory) return testInfo.outputPath(filename);
    fs.mkdirSync(tagComboboxEvidenceDirectory, { recursive: true });
    return path.join(tagComboboxEvidenceDirectory, filename);
}

async function expectMobileTouchTarget(locator: Locator): Promise<void> {
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
}

async function clickVisibleCenter(page: Page, locator: Locator): Promise<void> {
    await expect(locator).toBeVisible();
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

async function dragSessionToList(
    page: Page,
    source: Locator,
    target: Locator,
    onTargetHover?: () => Promise<void>,
): Promise<void> {
    await source.scrollIntoViewIfNeeded();
    await target.scrollIntoViewIfNeeded();
    await expect(source).toHaveAttribute('draggable', 'true');
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    const restingBackground = await target.evaluate((element) => window.getComputedStyle(element).backgroundColor);
    const targetY = targetBox!.y + targetBox!.height / 2;

    await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(sourceBox!.x + sourceBox!.width / 2 + 8, sourceBox!.y + sourceBox!.height / 2, { steps: 4 });
    await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 12 });
    await page.mouse.move(targetBox!.x + targetBox!.width / 2 + 1, targetBox!.y + targetBox!.height / 2, { steps: 2 });
    await expect.poll(() => target.evaluate((element) => window.getComputedStyle(element).backgroundColor)).not.toBe(restingBackground);
    await expect(target.locator('[data-testid^="sidebar-list-drop-indicator-"]')).toHaveCount(0);
    if (onTargetHover) await onTargetHover();
    await page.mouse.move(targetBox!.x + targetBox!.width + 80, targetY, { steps: 6 });
    await expect.poll(() => target.evaluate((element) => window.getComputedStyle(element).backgroundColor)).toBe(restingBackground);
    await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetY, { steps: 6 });
    await page.mouse.move(targetBox!.x + targetBox!.width / 2 + 1, targetY, { steps: 2 });
    await expect.poll(() => target.evaluate((element) => window.getComputedStyle(element).backgroundColor)).not.toBe(restingBackground);
    await pauseForReview(page, 900);
    await page.mouse.up();
}

async function dragListToList(
    page: Page,
    source: Locator,
    target: Locator,
    position: 'before' | 'after',
    onTargetHover?: () => Promise<void>,
): Promise<void> {
    await source.scrollIntoViewIfNeeded();
    await target.scrollIntoViewIfNeeded();
    await expect(source).toHaveAttribute('draggable', 'true');
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    const restingBackground = await target.evaluate((element) => window.getComputedStyle(element).backgroundColor);
    const targetY = targetBox!.y + targetBox!.height * (position === 'before' ? 0.25 : 0.75);
    const indicator = target.getByTestId(`sidebar-list-drop-indicator-${position}`);

    await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(sourceBox!.x + sourceBox!.width / 2 + 8, sourceBox!.y + sourceBox!.height / 2, { steps: 4 });
    await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetY, { steps: 12 });
    await page.mouse.move(targetBox!.x + targetBox!.width / 2 + 1, targetY, { steps: 2 });
    await expect(indicator).toBeVisible();
    await expect.poll(() => target.evaluate((element) => window.getComputedStyle(element).backgroundColor)).toBe(restingBackground);
    const indicatorBox = await indicator.boundingBox();
    expect(indicatorBox).not.toBeNull();
    expect(indicatorBox!.width).toBeGreaterThan(targetBox!.width * 0.75);
    const expectedIndicatorY = position === 'before' ? targetBox!.y : targetBox!.y + targetBox!.height;
    expect(Math.abs(indicatorBox!.y + indicatorBox!.height / 2 - expectedIndicatorY)).toBeLessThanOrEqual(3);
    if (onTargetHover) await onTargetHover();
    await page.mouse.move(targetBox!.x + targetBox!.width + 80, targetY, { steps: 6 });
    await expect(indicator).toHaveCount(0);
    await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetY, { steps: 6 });
    await page.mouse.move(targetBox!.x + targetBox!.width / 2 + 1, targetY, { steps: 2 });
    await expect(indicator).toBeVisible();
    await pauseForReview(page, 900);
    await page.mouse.up();
}

async function expectListBefore(first: Locator, second: Locator): Promise<void> {
    await expect.poll(async () => {
        const [firstBox, secondBox] = await Promise.all([first.boundingBox(), second.boundingBox()]);
        return !!firstBox && !!secondBox && firstBox.y < secondBox.y;
    }).toBe(true);
}

async function expectPersistedListBefore(page: Page, firstId: string, secondId: string): Promise<void> {
    await expect.poll(() => page.evaluate(({ firstId: expectedFirstId, secondId: expectedSecondId }) => {
        const stored = window.localStorage.getItem('mmkv.default\\local-settings');
        if (!stored) return false;
        const parsed = JSON.parse(stored) as { sidebarOrganization?: { lists?: Array<{ id: string }> } };
        const ids = parsed.sidebarOrganization?.lists?.map((list) => list.id) ?? [];
        return ids.indexOf(expectedFirstId) >= 0 && ids.indexOf(expectedFirstId) < ids.indexOf(expectedSecondId);
    }, { firstId, secondId })).toBe(true);
}

async function createList(
    page: Page,
    options: { name: string; kind: 'workspace' | 'agent'; machineName?: string; directoryName?: string },
): Promise<void> {
    await page.getByTestId('sidebar-create-list-button').click();
    await expect(page.getByText('New list', { exact: true })).toBeVisible();
    await page.getByTestId('sidebar-list-name-input').fill(options.name);
    await page.getByTestId(`sidebar-list-kind-${options.kind}`).click();
    await expect(page.getByTestId(`sidebar-list-kind-${options.kind}`)).toHaveAttribute('aria-checked', 'true');
    if (options.kind === 'agent') {
        await expect(page.getByText('Default machine', { exact: true })).toHaveCount(0);
        await expect(page.getByText('Default directory', { exact: true })).toHaveCount(0);
        await expect(page.getByTestId('sidebar-list-agent-prompt-input')).toHaveCount(0);
        const askMode = page.getByRole('radio', { name: 'Ask', exact: true });
        await expect(askMode).toHaveAttribute('aria-checked', 'true');
        await expect(askMode).toBeDisabled();
    } else {
        await expect(page.getByTestId('sidebar-list-machine-picker')).toBeVisible();
        const directoryPicker = page.getByTestId('sidebar-list-directory-picker');
        await expect(directoryPicker).toBeVisible();
        await expect(page.getByTestId('sidebar-list-directory-none')).toHaveAttribute('aria-checked', 'true');
        await expect(directoryPicker.locator('input')).not.toBeEditable();
        if (options.machineName) {
            const machine = page.getByRole('radio', { name: new RegExp(options.machineName) });
            await machine.click({ timeout: 120_000 });
            await expect(machine).toHaveAttribute('aria-checked', 'true');
        }
        if (options.directoryName) {
            await directoryPicker.getByText(options.directoryName, { exact: true }).click();
            await expect(directoryPicker.locator('input')).toHaveValue('/workspace/remote-happy');
        }
    }
    await page.getByTestId('sidebar-create-list-submit').click();
    await expect(page.getByText('New list', { exact: true })).toHaveCount(0);
    await expect(page.getByText(options.name, { exact: true })).toBeVisible();
}

async function organizeSession(
    page: Page,
    options: { sessionId: string; listName: string; tagName: string },
): Promise<void> {
    await page.getByTestId(`organize-session-${options.sessionId}`).click();
    await expect(page.getByText('Organize session', { exact: true })).toBeVisible();
    const list = page.getByRole('radio', { name: options.listName, exact: true });
    await list.click();
    await expect(list).toHaveAttribute('aria-checked', 'true');
    const tag = page.getByRole('checkbox', { name: options.tagName, exact: true });
    await tag.click();
    await expect(tag).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('organize-session-save').click();
    await expect(page.getByText('Organize session', { exact: true })).toHaveCount(0);
}

test('[SIDEBAR-LISTS-TAGS] desktop Lists and Tags organize sessions without replacing the conversation', async ({ page, request }, testInfo: TestInfo) => {
    page.setDefaultTimeout(120_000);
    page.setDefaultNavigationTimeout(180_000);
    let machineId: string | null = null;
    const createdSessionIds: string[] = [];

    try {
        await configureAskApi(page);
        machineId = await createMachine(request);
        const alphaId = await createSession(request, {
            name: 'Sidebar Alpha runtime',
            summary: 'E2E Alpha conversation',
            path: '/workspace/remote-happy',
        });
        createdSessionIds.push(alphaId);
        const betaId = await createSession(request, {
            name: 'Sidebar Beta runtime',
            summary: 'E2E Beta conversation',
            path: '/workspace/local-happy',
        });
        createdSessionIds.push(betaId);

        await page.emulateMedia({ colorScheme: 'dark' });
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Gingham', { exact: true }).click();
        await expect.poll(() => page.locator('body').evaluate((element) => (
            window.getComputedStyle(element).backgroundColor
        ))).toBe('rgb(18, 24, 33)');
        await page.goto(authenticatedRoute(`/session/${alphaId}`));
        page.setDefaultTimeout(15_000);
        expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
        const alphaUrl = page.url();
        const visibleTitle = page.locator('[data-testid="session-header-title"]:visible');
        await expect(visibleTitle).toHaveText('E2E Alpha conversation', { timeout: 120_000 });
        await expect(page.getByTestId('desktop-sidebar-tab-projects')).toHaveAttribute('aria-selected', 'true');
        await captureEvidenceFrame(page, testInfo, '01-projects-default');

        await page.getByTestId('desktop-sidebar-tab-lists').click();
        await expect(page.getByTestId('desktop-sidebar-tab-lists')).toHaveAttribute('aria-selected', 'true');
        await expect(page).toHaveURL(alphaUrl);
        await expect(visibleTitle).toHaveText('E2E Alpha conversation');
        await captureEvidenceFrame(page, testInfo, '02-lists-empty');

        await createList(page, {
            name: 'Remote Happy',
            kind: 'workspace',
            machineName: 'Sidebar E2E Mac',
            directoryName: '~/remote-happy',
        });
        await captureEvidenceFrame(page, testInfo, '03-workspace-list');
        const remoteListRow = page.getByText('Remote Happy', { exact: true });
        await expect(remoteListRow).toBeVisible();
        const remoteListId = await remoteListRow.locator('xpath=ancestor::*[@data-testid][1]').getAttribute('data-testid');
        expect(remoteListId).toMatch(/^sidebar-list-/);
        const remoteId = remoteListId!.replace('sidebar-list-', '');
        await page.getByTestId(`sidebar-edit-list-${remoteId}`).click();
        await expect(page.getByText('Edit list', { exact: true })).toBeVisible();
        await expect(page.getByRole('radio', { name: /Sidebar E2E Mac/ })).toHaveAttribute('aria-checked', 'true');
        await expect(page.getByTestId('sidebar-list-directory-picker').locator('input')).toHaveValue('/workspace/remote-happy');
        await captureEvidenceFrame(page, testInfo, '04-workspace-picker-saved');
        await page.getByTestId('sidebar-list-name-input').fill('Remote Happy renamed');
        await page.getByTestId('sidebar-edit-list-submit').click();
        await expect(page.getByText('Remote Happy renamed', { exact: true })).toBeVisible();

        await createList(page, { name: 'Advisor', kind: 'agent' });
        const advisorListRow = page.getByText('Advisor', { exact: true });
        const advisorListTestId = await advisorListRow.locator('xpath=ancestor::*[@data-testid][1]').getAttribute('data-testid');
        expect(advisorListTestId).toMatch(/^sidebar-list-/);
        const advisorId = advisorListTestId!.replace('sidebar-list-', '');
        await page.getByTestId(`sidebar-list-${advisorId}`).click();
        await page.getByTestId(`sidebar-new-session-${advisorId}`).click();
        await expect(page).toHaveURL((url) => url.pathname === '/new' && url.searchParams.get('sidebarListId') === advisorId);
        const askInput = page.locator('[data-testid="new-session-message-input"]:visible');
        await expect(askInput).toBeVisible();
        await expect(askInput).toHaveAttribute('placeholder', 'Ask anything');
        await expect(askInput).toHaveValue('');
        await captureEvidenceFrame(page, testInfo, '05-agent-ask-new-session');

        await page.goto(alphaUrl, { timeout: 120_000 });
        await expect(page.locator('[data-testid="session-header-title"]:visible')).toHaveText('E2E Alpha conversation', { timeout: 120_000 });
        await expect(page.getByTestId('desktop-sidebar-tab-lists')).toHaveAttribute('aria-selected', 'true');

        await page.getByTestId('sidebar-create-tag-button').click();
        await page.getByPlaceholder('Tag name').fill('product');
        await page.getByRole('button', { name: 'Create', exact: true }).click();
        await expect(page.getByRole('button', { name: /^product 0$/ })).toBeVisible();
        await expect(page).toHaveURL(alphaUrl);
        await captureEvidenceFrame(page, testInfo, '06-tag-created');

        await organizeSession(page, { sessionId: alphaId, listName: 'Remote Happy renamed', tagName: 'product' });
        await expect(page.getByTestId(`organized-session-${alphaId}`)).toBeVisible();
        await expect(page).toHaveURL(alphaUrl);
        await expect(visibleTitle).toHaveText('E2E Alpha conversation');
        await pauseForReview(page);
        await page.screenshot({ path: testInfo.outputPath('01-lists-organized.png'), fullPage: true });
        await captureEvidenceFrame(page, testInfo, '07-alpha-organized');

        const remoteDropTarget = page.getByTestId(`sidebar-drop-list-${remoteId}`);
        const advisorDropTarget = page.getByTestId(`sidebar-drop-list-${advisorId}`);
        const unassignedDropTarget = page.getByTestId('sidebar-drop-list-unassigned');
        await expect(remoteDropTarget.getByText('1', { exact: true })).toBeVisible();
        await expect(advisorDropTarget.getByText('0', { exact: true })).toBeVisible();
        await expect(unassignedDropTarget.getByText('1', { exact: true })).toBeVisible();

        await dragListToList(page, remoteDropTarget, advisorDropTarget, 'after', async () => {
            await page.screenshot({ path: testInfo.outputPath('04-list-drag-target-highlight.png'), fullPage: true });
        });
        await expectListBefore(advisorDropTarget, remoteDropTarget);
        await expectPersistedListBefore(page, advisorId, remoteId);
        await captureEvidenceFrame(page, testInfo, '08-lists-reordered');

        await page.reload({ timeout: 180_000 });
        await expect(page.getByTestId('desktop-sidebar-tab-lists')).toHaveAttribute('aria-selected', 'true', { timeout: 120_000 });
        await expectListBefore(advisorDropTarget, remoteDropTarget);
        await expect(page).toHaveURL(alphaUrl);
        await expect(page.getByTestId(`organized-session-tags-${alphaId}`)).toContainText('#product');
        await captureEvidenceFrame(page, testInfo, '09-list-order-reloaded');

        await dragListToList(page, remoteDropTarget, advisorDropTarget, 'before');
        await expectListBefore(remoteDropTarget, advisorDropTarget);
        await dragListToList(page, remoteDropTarget, advisorDropTarget, 'after');
        await expectListBefore(advisorDropTarget, remoteDropTarget);

        await dragSessionToList(
            page,
            page.getByTestId(`sidebar-drag-session-${alphaId}`),
            advisorDropTarget,
            async () => {
                await page.screenshot({ path: testInfo.outputPath('05-session-drag-target-highlight.png'), fullPage: true });
            },
        );
        await expect(remoteDropTarget.getByText('0', { exact: true })).toBeVisible();
        await expect(advisorDropTarget.getByText('1', { exact: true })).toBeVisible();
        await expect(page.getByTestId(`organized-session-tags-${alphaId}`)).toContainText('#product');
        await expect(page).toHaveURL(alphaUrl);
        await captureEvidenceFrame(page, testInfo, '08-alpha-dragged-to-advisor');

        await dragSessionToList(page, page.getByTestId(`sidebar-drag-session-${alphaId}`), unassignedDropTarget);
        await expect(advisorDropTarget.getByText('0', { exact: true })).toBeVisible();
        await expect(unassignedDropTarget.getByText('2', { exact: true })).toBeVisible();
        await expect(page.getByTestId(`organized-session-tags-${alphaId}`)).toContainText('#product');
        await expect(page).toHaveURL(alphaUrl);
        await page.screenshot({ path: testInfo.outputPath('06-dragged-to-unassigned.png'), fullPage: true });
        await captureEvidenceFrame(page, testInfo, '09-alpha-dragged-to-unassigned');

        await page.getByTestId(`organized-session-${betaId}`).click();
        await expect(page).toHaveURL((url) => url.pathname === `/session/${betaId}`);
        await expect(page.locator('[data-testid="session-header-title"]:visible')).toHaveText('E2E Beta conversation');
        const betaUrl = page.url();
        await captureEvidenceFrame(page, testInfo, '08-beta-selected');

        await organizeSession(page, { sessionId: betaId, listName: 'Advisor', tagName: 'product' });
        await expect(page.getByRole('button', { name: /^product 2$/ })).toBeVisible();
        await page.getByRole('button', { name: /^product 2$/ }).click();
        await expect(page.getByTestId(`organized-session-${alphaId}`)).toBeVisible();
        await expect(page.getByTestId(`organized-session-${betaId}`)).toBeVisible();
        await expect(page).toHaveURL(betaUrl);
        await expect(page.locator('[data-testid="session-header-title"]:visible')).toHaveText('E2E Beta conversation');
        await pauseForReview(page, 1_100);
        await page.screenshot({ path: testInfo.outputPath('02-tag-cross-list-filter.png'), fullPage: true });
        await captureEvidenceFrame(page, testInfo, '09-tag-cross-list-filter');

        await page.getByTestId(`organized-session-${alphaId}`).click();
        await expect(page).toHaveURL((url) => url.pathname === `/session/${alphaId}`);
        await expect(page.locator('[data-testid="session-header-title"]:visible')).toHaveText('E2E Alpha conversation');

        await page.getByTestId('sidebar-close-tag-filter').click();
        await page.getByTestId(`sidebar-edit-list-${advisorId}`).click();
        await page.getByTestId('sidebar-delete-list').click();
        await expect(page.getByText('Delete list', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Delete', exact: true }).click();
        await expect(page.getByText('Advisor', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: /^product 2$/ })).toBeVisible();
        await expect(page.getByTestId(`organized-session-${betaId}`)).toBeVisible();

        await page.reload({ timeout: 180_000 });
        await expect(page.getByTestId('desktop-sidebar-tab-lists')).toHaveAttribute('aria-selected', 'true', { timeout: 120_000 });
        await expect(page.getByText('Remote Happy renamed', { exact: true })).toBeVisible();
        await expect(page.getByText('Advisor', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: /^product 2$/ })).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('sidebar-drop-list-unassigned').getByText('2', { exact: true })).toBeVisible();
        await expect(page.getByTestId(`organized-session-tags-${alphaId}`)).toContainText('#product');
        await page.getByTestId(`sidebar-edit-list-${remoteId}`).click();
        await expect(page.getByText('Edit list', { exact: true })).toBeVisible();
        await expect(page.getByRole('radio', { name: /Sidebar E2E Mac/ })).toHaveAttribute('aria-checked', 'true');
        await expect(page.getByTestId('sidebar-list-directory-picker').locator('input')).toHaveValue('/workspace/remote-happy');
        await captureEvidenceFrame(page, testInfo, '10-workspace-picker-reloaded');
        await page.getByTestId('sidebar-create-list-cancel').click();
        await page.getByRole('button', { name: /^product 2$/ }).click();
        await expect(page.getByTestId(`organized-session-${alphaId}`)).toBeVisible();
        await expect(page.getByTestId(`organized-session-${betaId}`)).toBeVisible();
        await expect(page).toHaveURL((url) => url.pathname === `/session/${alphaId}`);
        await expect(page.locator('[data-testid="session-header-title"]:visible')).toHaveText('E2E Alpha conversation');
        await pauseForReview(page);
        await page.screenshot({ path: testInfo.outputPath('03-reload-persisted.png'), fullPage: true });
        await captureEvidenceFrame(page, testInfo, '11-reload-persisted');
    } finally {
        await page.close();
        await Promise.allSettled(createdSessionIds.map((sessionId) => deleteSession(request, sessionId)));
        if (machineId) await deleteMachine(request, machineId);
    }
});

test('[SESSION-TAG-COMBOBOX] title hash creates, searches, and syncs tags outside the title', async ({ page, request }, testInfo: TestInfo) => {
    page.setDefaultTimeout(120_000);
    page.setDefaultNavigationTimeout(180_000);
    const sessionId = await createSession(request, {
        name: 'Session tag combobox',
        summary: 'Tag from the title',
        path: '/workspace/session-tag-combobox',
    });

    try {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(authenticatedRoute('/settings/appearance'));
        await page.getByText('Gingham', { exact: true }).click();
        await expect.poll(() => page.locator('body').evaluate((element) => (
            window.getComputedStyle(element).backgroundColor
        ))).toBe('rgb(18, 24, 33)');

        await page.goto(authenticatedRoute(`/session/${sessionId}`));
        const title = page.locator('[data-testid="session-header-title"]:visible');
        await expect(title).toHaveText('Tag from the title', { timeout: 120_000 });
        await expect(page.getByTestId('session-canvas-tags')).toBeVisible();
        const emptyCanvasAdd = page.getByTestId('session-canvas-add-tag');
        await expect(emptyCanvasAdd).toHaveAttribute('role', 'button');
        await page.screenshot({ path: tagComboboxEvidencePath(testInfo, '00-empty-bottom-add.png'), fullPage: true });
        await captureEvidenceFrame(page, testInfo, 'tag-combobox-00-empty-bottom-add');
        await emptyCanvasAdd.click();
        await expect(page.getByText('Organize session', { exact: true })).toBeVisible();
        await clickVisibleCenter(page, page.getByTestId('organize-session-cancel'));
        const headerTags = page.locator('[data-testid="session-header-tags-button"]:visible');
        await expect(headerTags).toBeVisible();
        await expect(headerTags).toHaveText('#');
        await headerTags.click();

        const input = page.getByTestId('session-header-title-input');
        await expect(input).toBeFocused();
        await expect(input).toHaveAttribute('role', 'combobox');
        await expect(input).toHaveValue('Tag from the title #');
        await expect(input).toHaveAttribute('aria-expanded', 'true');
        await expect(page.getByRole('listbox')).toBeVisible();
        await input.fill('Tag from the title #product');
        const createProduct = page.getByTestId('session-title-create-tag');
        await expect(createProduct).toContainText('Create #product');
        await expect(createProduct).toHaveCSS('background-color', 'rgb(40, 53, 68)');
        await page.screenshot({ path: tagComboboxEvidencePath(testInfo, '01-desktop-create-option.png'), fullPage: true });
        await captureEvidenceFrame(page, testInfo, 'tag-combobox-01-create-option');

        await input.press('Enter');
        await expect(input).toHaveValue('Tag from the title');
        await expect(page.getByTestId('session-canvas-tags')).toContainText('#product');
        await expect(page.locator('[data-testid^="session-row-tag-"]:visible').filter({ hasText: '#product' }).first()).toBeVisible();

        await page.getByTestId('desktop-sidebar-tab-lists').click();
        await page.getByRole('button', { name: /^product 1$/ }).click();
        await expect(page.getByTestId(`organized-session-tags-${sessionId}`)).toContainText('#product');
        await page.screenshot({ path: tagComboboxEvidencePath(testInfo, '04-lists-sidebar-tags.png'), fullPage: true });
        await captureEvidenceFrame(page, testInfo, 'tag-combobox-04-lists-sidebar-tags');
        await page.goto(authenticatedRoute(`/session/${sessionId}`));
        await expect(page.locator('[data-testid="session-header-title"]:visible')).toHaveText('Tag from the title', { timeout: 120_000 });
        await page.locator('[data-testid="session-header-tags-button"]:visible').click();
        const restoredInput = page.getByTestId('session-header-title-input');
        await expect(restoredInput).toBeFocused();
        await restoredInput.fill('Tag from the title #research');
        await restoredInput.press('Enter');
        await expect(restoredInput).toHaveValue('Tag from the title');
        await expect(page.getByTestId('session-canvas-tags')).toContainText('#research');

        await restoredInput.fill('Tag from the title #pro');
        const productResult = page.getByRole('option').filter({ hasText: '#product' });
        await expect(productResult).toBeVisible();
        await expect(productResult).toHaveAttribute('aria-selected', 'true');
        await page.screenshot({ path: tagComboboxEvidencePath(testInfo, '02-desktop-search-selected.png'), fullPage: true });
        await captureEvidenceFrame(page, testInfo, 'tag-combobox-02-search-selected');
        await productResult.click();
        await expect(restoredInput).toHaveValue('Tag from the title');
        await expect(restoredInput).toBeFocused();
        await restoredInput.press('Enter');

        await expect(title).toHaveText('Tag from the title');
        await expect(headerTags).toHaveText('#');
        await expect(page.getByTestId('session-canvas-tags')).toContainText('#product');
        await expect(page.getByTestId('session-canvas-tags')).toContainText('#research');

        const productCanvasTag = page.getByRole('button', { name: 'Organize session: #product', exact: true });
        const removeProduct = page.getByRole('button', { name: 'Delete #product', exact: true });
        await expect(removeProduct).toHaveCSS('opacity', '0');
        await page.screenshot({ path: tagComboboxEvidencePath(testInfo, '06-rest-tag.png'), fullPage: true });
        await productCanvasTag.hover();
        await expect(removeProduct).toHaveCSS('opacity', '1');
        await page.screenshot({ path: tagComboboxEvidencePath(testInfo, '07-hover-remove-tag.png'), fullPage: true });
        await captureEvidenceFrame(page, testInfo, 'tag-combobox-06-hover-remove-tag');
        await removeProduct.click();
        await expect(page.getByTestId('session-canvas-tags')).not.toContainText('#product');
        await expect(page.getByTestId('session-canvas-tags')).toContainText('#research');
        await page.screenshot({ path: tagComboboxEvidencePath(testInfo, '08-tag-removed.png'), fullPage: true });

        await headerTags.click();
        const reassignInput = page.getByTestId('session-header-title-input');
        await reassignInput.fill('Tag from the title #pro');
        const existingProduct = page.getByRole('option').filter({ hasText: '#product' });
        await expect(existingProduct).toBeVisible();
        await existingProduct.click();
        await reassignInput.press('Enter');
        await expect(page.getByTestId('session-canvas-tags')).toContainText('#product');

        await page.reload({ timeout: 180_000 });
        await expect(page.locator('[data-testid="session-header-title"]:visible')).toHaveText('Tag from the title', { timeout: 120_000 });
        await expect(page.locator('[data-testid="session-header-tags-button"]:visible')).toHaveText('#');
        await expect(page.getByTestId('session-canvas-tags')).toContainText('#product');
        await page.getByTestId('desktop-sidebar-tab-projects').click();
        await expect(page.locator('[data-testid^="session-row-tag-"]:visible').filter({ hasText: '#product' }).first()).toBeVisible();

        await page.setViewportSize({ width: 800, height: 900 });
        const compactHeaderTags = page.locator('[data-testid="session-header-tags-button"]:visible');
        await expect(compactHeaderTags).toBeVisible();
        await expect(page.getByTestId('session-canvas-tags')).toContainText('#product');
        await expect(page.getByTestId('session-canvas-tags')).toContainText('#research');
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: tagComboboxEvidencePath(testInfo, '03-narrow-selected-tags.png'), fullPage: true });
        await captureEvidenceFrame(page, testInfo, 'tag-combobox-03-narrow-selected-tags');

        await page.getByTestId('session-canvas-add-tag').click();
        const organizerInput = page.getByTestId('organize-tag-input');
        const selectedTag = (name: string) => page.locator('[data-testid^="organize-selected-tag-"]').filter({ hasText: name });
        await expect(selectedTag('#product')).toBeVisible();
        await organizerInput.fill('#discarded');
        await page.getByTestId('organize-create-tag').click();
        await expect(selectedTag('#discarded')).toBeVisible();
        await clickVisibleCenter(page, page.getByTestId('organize-session-cancel'));
        await page.getByTestId('session-canvas-add-tag').click();
        await expect(selectedTag('#discarded')).toHaveCount(0);
        await expect(selectedTag('#product')).toBeVisible();
        await clickVisibleCenter(page, page.getByTestId('organize-session-cancel'));

        await page.setViewportSize({ width: 1440, height: 900 });
        await compactHeaderTags.click();
        const manyTagsInput = page.getByTestId('session-header-title-input');
        for (const tagName of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta']) {
            await manyTagsInput.fill(`Tag from the title #${tagName}`);
            await manyTagsInput.press('Enter');
            await expect(manyTagsInput).toHaveValue('Tag from the title');
        }
        await manyTagsInput.fill('Tag from the title #');
        const allTagOptions = page.getByTestId('session-title-tag-results').getByRole('option');
        await expect(allTagOptions).toHaveCount(8);
        const tagResults = page.getByTestId('session-title-tag-results');
        await expect.poll(() => tagResults.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
        for (let index = 1; index < 8; index += 1) await manyTagsInput.press('ArrowDown');
        await expect(manyTagsInput).toHaveAttribute('aria-activedescendant', 'session-title-tag-option-7');
        await expect.poll(async () => {
            const containerBounds = await tagResults.boundingBox();
            const activeBounds = await page.locator('#session-title-tag-option-7').boundingBox();
            return !!containerBounds && !!activeBounds
                && activeBounds.y >= containerBounds.y
                && activeBounds.y + activeBounds.height <= containerBounds.y + containerBounds.height;
        }).toBe(true);
        await page.screenshot({ path: tagComboboxEvidencePath(testInfo, '05-scrollable-all-tags.png'), fullPage: true });
        await captureEvidenceFrame(page, testInfo, 'tag-combobox-05-scrollable-all-tags');
        await manyTagsInput.press('Enter');
        await expect(manyTagsInput).toHaveValue('Tag from the title');
    } finally {
        await page.close();
        await deleteSession(request, sessionId);
    }
});

test('[SIDEBAR-LISTS-TAGS-MOBILE] mobile drawer exposes Projects and Lists tabs', async ({ page, request }, testInfo: TestInfo) => {
    page.setDefaultTimeout(120_000);
    page.setDefaultNavigationTimeout(180_000);
    const sessionId = await createSession(request, {
        name: 'Mobile sidebar tabs',
        summary: 'Mobile sidebar tabs',
        path: '/workspace/mobile-sidebar-tabs',
    });
    const evidencePhase = process.env.HAPPY_SIDEBAR_LISTS_TAGS_MOBILE_EVIDENCE_PHASE ?? 'after';

    try {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(authenticatedRoute('/'));
        page.setDefaultTimeout(15_000);
        const composer = page.getByRole('textbox');
        try {
            await expect(composer).toBeVisible({ timeout: 120_000 });
        } catch {
            await page.reload({ timeout: 180_000 });
            await expect(composer).toBeVisible({ timeout: 120_000 });
        }

        await page.getByTestId('compose-home-drawer-button').click();
        const accountFooter = page.getByTestId('sidebar-account-footer');
        await expect.poll(async () => (await accountFooter.boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0);
        await expect(page.getByTestId(`session-row-${sessionId}`)).toBeVisible();

        const projectsTab = page.getByTestId('desktop-sidebar-tab-projects');
        const listsTab = page.getByTestId('desktop-sidebar-tab-lists');
        if (evidencePhase === 'before') {
            await expect(projectsTab).toHaveCount(0);
            await expect(listsTab).toHaveCount(0);
            await page.screenshot({ path: testInfo.outputPath('mobile-before-no-tabs.png'), fullPage: true });
            return;
        }

        await expect(projectsTab).toBeVisible();
        await expect(listsTab).toBeVisible();
        await expect(projectsTab).toHaveAttribute('aria-selected', 'true');
        await expectMobileTouchTarget(projectsTab);
        await expectMobileTouchTarget(listsTab);
        const projectsVisual = await page.getByTestId('desktop-sidebar-tab-projects-visual').boundingBox();
        const listsVisual = await page.getByTestId('desktop-sidebar-tab-lists-visual').boundingBox();
        expect(projectsVisual?.height).toBeLessThanOrEqual(32);
        expect(listsVisual?.height).toBeLessThanOrEqual(32);
        await captureEvidenceFrame(page, testInfo, 'mobile-01-projects');
        const homeUrl = page.url();
        await listsTab.click();
        await expect(listsTab).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByTestId('sidebar-lists-view')).toBeVisible();
        await expect(page).toHaveURL(homeUrl);
        await expectMobileTouchTarget(page.getByTestId('sidebar-create-list-button'));
        await expectMobileTouchTarget(page.getByTestId('sidebar-create-tag-button'));
        await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

        await page.getByTestId('sidebar-create-list-button').click();
        await expect(page.getByText('New list', { exact: true })).toBeVisible();
        await expectMobileTouchTarget(page.getByTestId('sidebar-list-kind-workspace'));
        await expectMobileTouchTarget(page.getByTestId('sidebar-list-color-blue'));
        await expectMobileTouchTarget(page.getByTestId('sidebar-create-list-submit'));
        await page.getByTestId('sidebar-list-name-input').fill('Mobile removable');
        await page.getByTestId('sidebar-list-kind-agent').click();
        await page.getByTestId('sidebar-create-list-submit').click();
        await expect(page.getByText('New list', { exact: true })).toHaveCount(0);
        const removableList = page.getByText('Mobile removable', { exact: true });
        await expect(removableList).toBeVisible();
        const deleteButton = page.getByRole('button', { name: 'Delete list Mobile removable', exact: true });
        await expectMobileTouchTarget(deleteButton);
        await expect(page.getByText(/cannot contain a nested/i)).toHaveCount(0);
        await pauseForReview(page);
        await captureEvidenceFrame(page, testInfo, 'mobile-02-delete-action');
        await deleteButton.click();
        await expect(page.getByText('Delete list', { exact: true })).toBeVisible();
        await pauseForReview(page);
        await captureEvidenceFrame(page, testInfo, 'mobile-03-delete-confirm');
        await page.getByRole('button', { name: 'Delete', exact: true }).click();
        await expect(removableList).toHaveCount(0);

        await page.reload({ timeout: 180_000 });
        await expect(page.getByRole('textbox')).toBeVisible({ timeout: 120_000 });
        await page.getByTestId('compose-home-drawer-button').click();
        await expect.poll(async () => (await accountFooter.boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0);
        await expect(listsTab).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByText('Mobile removable', { exact: true })).toHaveCount(0);

        await expect.poll(async () => {
            const box = await accountFooter.boundingBox();
            return box !== null
                && box.x >= 0
                && box.y >= 0
                && box.x + box.width <= 390
                && box.y + box.height <= 844;
        }).toBe(true);
        await pauseForReview(page);
        await page.screenshot({ path: testInfo.outputPath('mobile-after-lists-tab.png'), fullPage: true });
        await captureEvidenceFrame(page, testInfo, 'mobile-04-lists');
    } finally {
        await page.close();
        await deleteSession(request, sessionId);
    }
});

test('[SIDEBAR-LISTS-TAGS-PERF] 100 unassigned sessions remain responsive when expanded', async ({ page, request }, testInfo: TestInfo) => {
    const sessionIds = await Promise.all(Array.from({ length: 100 }, (_, index) => createSession(request, {
        name: `Sidebar performance ${index + 1}`,
        summary: `Performance conversation ${index + 1}`,
        path: `/workspace/sidebar-performance-${index + 1}`,
    })));

    try {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(authenticatedRoute(`/session/${sessionIds[0]}`));
        page.setDefaultTimeout(15_000);
        await expect(page.locator('[data-testid="session-header-title"]:visible')).toHaveText('Performance conversation 1', { timeout: 120_000 });
        const listsTab = page.getByTestId('desktop-sidebar-tab-lists');
        await expect(listsTab).toBeVisible();
        const listsTabBox = await listsTab.boundingBox();
        expect(listsTabBox).not.toBeNull();
        await page.mouse.click(
            listsTabBox!.x + listsTabBox!.width / 2,
            listsTabBox!.y + listsTabBox!.height / 2,
        );
        await expect(listsTab).toHaveAttribute('aria-selected', 'true', { timeout: 120_000 });
        const unassigned = page.getByTestId('sidebar-list-unassigned');
        await expect(unassigned).toContainText('100', { timeout: 120_000 });

        const mountedSessions = page.locator('[data-testid^="organized-session-"]');
        await expect(mountedSessions.first()).toBeVisible({ timeout: 120_000 });
        expect(await mountedSessions.count()).toBeLessThan(100);

        const unassignedBox = await unassigned.boundingBox();
        expect(unassignedBox).not.toBeNull();
        const clickUnassigned = () => page.mouse.click(
            unassignedBox!.x + unassignedBox!.width / 2,
            unassignedBox!.y + unassignedBox!.height / 2,
        );

        await clickUnassigned();
        await expect(mountedSessions).toHaveCount(0);

        const startedAt = Date.now();
        await clickUnassigned();
        await expect(mountedSessions.first()).toBeVisible();
        expect(Date.now() - startedAt).toBeLessThan(5_000);
        expect(await mountedSessions.count()).toBeLessThan(100);
        await captureEvidenceFrame(page, testInfo, 'desktop-100-sessions-responsive');

        await clickUnassigned();
        await expect(mountedSessions).toHaveCount(0);
        await page.getByTestId('sidebar-create-tag-button').click();
        await expect(page.getByPlaceholder('Tag name')).toBeVisible();
    } finally {
        await page.close();
        await Promise.allSettled(sessionIds.map((sessionId) => deleteSession(request, sessionId)));
    }
});
