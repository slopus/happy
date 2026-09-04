import { expect, test, type APIRequestContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';
import { encodeBase64, encryptLegacy } from '../../happy-cli/src/api/encryption';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const e2eServerUrl = process.env.HAPPY_E2E_SERVER_URL!;
const evidenceDirectory = process.env.HAPPY_RESPONSIVE_LAYOUT_EVIDENCE_DIR;
const evidencePhase = process.env.HAPPY_RESPONSIVE_LAYOUT_EVIDENCE_PHASE ?? 'after';
const finalRegressionEvidenceDirectory = process.env.HAPPY_FINAL_REGRESSION_EVIDENCE_DIR;
const cleanEvidenceRuntime = process.env.HAPPY_E2E_WEB_NO_DEV === '1';
const sessionReadyTimeout = cleanEvidenceRuntime ? 30_000 : 10_000;

type Fixture = {
    close: () => void;
    permissionId: string;
    sessionId: string;
};

function auth() {
    const url = new URL(authenticatedWebUrl);
    const token = url.searchParams.get('dev_token');
    const secret = url.searchParams.get('dev_secret');
    if (!token || !secret) throw new Error('Missing local E2E authentication.');
    return {
        encryptionKey: new Uint8Array(Buffer.from(secret, 'base64url')),
        token,
    };
}

function route(pathname: string): string {
    const url = new URL(authenticatedWebUrl);
    url.pathname = pathname;
    return url.toString();
}

async function installStoredCredentials(page: Page): Promise<void> {
    const url = new URL(authenticatedWebUrl);
    const token = url.searchParams.get('dev_token');
    const secret = url.searchParams.get('dev_secret');
    if (!token || !secret) throw new Error('Missing local E2E authentication.');
    await page.addInitScript(({ token, secret }) => {
        if (window.location.origin === 'null') return;
        window.localStorage.setItem('auth_credentials', JSON.stringify({ token, secret }));
    }, { token, secret });
}

function screenshotPath(testInfo: TestInfo, caseNumber: number): string {
    const filename = `case-${caseNumber}-${evidencePhase}.png`;
    return evidenceDirectory ? `${evidenceDirectory}/${filename}` : testInfo.outputPath(filename);
}

function finalRegressionScreenshotPath(testInfo: TestInfo, viewport: string): string {
    const filename = `r10-05-${viewport}.png`;
    return finalRegressionEvidenceDirectory ? `${finalRegressionEvidenceDirectory}/${filename}` : testInfo.outputPath(filename);
}

function captureBrowserDiagnostics(page: Page): string[] {
    const diagnostics: string[] = [];
    page.on('console', (message) => {
        if (message.type() === 'warning' || message.type() === 'error') {
            diagnostics.push(`${message.type()}: ${message.text()}`);
        }
    });
    page.on('pageerror', error => diagnostics.push(`pageerror: ${error.message}`));
    return diagnostics;
}

async function expectNoDevelopmentWarningSurface(page: Page, diagnostics: string[]): Promise<void> {
    const baselineNativeDriverWarning = 'warning: Animated: `useNativeDriver` is not supported because the native animated module is missing. Falling back to JS-based animation. To resolve this, add `RCTAnimation` module to this app, or remove `useNativeDriver`. Make sure to run `bundle exec pod install` first. Read more about autolinking: https://github.com/react-native-community/cli/blob/master/docs/autolinking.md';
    const actionableDiagnostics = diagnostics.filter(message => (
        !message.includes('Failed to load resource: net::ERR_CONNECTION_REFUSED')
        // The exact baseline warning is a known pre-existing console defect.
        && !(evidencePhase === 'before' && message === baselineNativeDriverWarning)
    ));
    expect(actionableDiagnostics).toEqual([]);
    await expect(page.locator('#logbox_notification')).toHaveCount(0);
    const bottomLeftWarningCandidates = await page.locator('*').evaluateAll(elements => (
        elements.flatMap((element) => {
            const rect = element.getBoundingClientRect();
            const isBottomLeftBadge = rect.left <= 12
                && rect.left >= 0
                && window.innerHeight - rect.bottom <= 12
                && window.innerHeight - rect.bottom >= 0
                && rect.width >= 32
                && rect.width <= 56
                && rect.height >= 32
                && rect.height <= 56;
            return isBottomLeftBadge ? [{
                ariaLabel: element.getAttribute('aria-label'),
                backgroundColor: getComputedStyle(element).backgroundColor,
                bottom: rect.bottom,
                height: rect.height,
                id: element.id,
                left: rect.left,
                outerHTML: element.outerHTML.slice(0, 600),
                role: element.getAttribute('role'),
                tagName: element.tagName,
                title: element.getAttribute('title'),
                width: rect.width,
            }] : [];
        })
    ));
    expect(bottomLeftWarningCandidates).toEqual([]);
}

async function waitForFastRefreshIndicatorToSettle(page: Page): Promise<void> {
    const deadline = Date.now() + 30_000;
    let hiddenSince: number | null = null;
    let lastCount = Number.POSITIVE_INFINITY;

    while (Date.now() < deadline) {
        lastCount = await page.locator('.__expo_fast_refresh_show').count();
        if (lastCount === 0) {
            hiddenSince ??= Date.now();
            if (Date.now() - hiddenSince >= 1_000) return;
        } else {
            hiddenSince = null;
        }
        await page.waitForTimeout(125);
    }

    throw new Error(`Expo fast-refresh indicator did not stay hidden for 1000ms (last count: ${lastCount}).`);
}

async function appendAcpMessages(
    request: APIRequestContext,
    sessionId: string,
    messages: Array<Record<string, unknown>>,
): Promise<void> {
    const credentials = auth();
    const response = await request.post(
        new URL(`/v3/sessions/${encodeURIComponent(sessionId)}/messages`, e2eServerUrl).toString(),
        {
            data: {
                messages: messages.map((data, index) => ({
                    content: encodeBase64(encryptLegacy({
                        role: 'agent',
                        content: { type: 'acp', provider: 'codex', data },
                        meta: { sentFrom: 'cli' },
                    }, credentials.encryptionKey)),
                    localId: `responsive-layout-${index}-${Date.now()}-${Math.random()}`,
                })),
            },
            headers: {
                Authorization: `Bearer ${credentials.token}`,
                'X-Happy-Client': 'playwright-responsive-layout',
            },
        },
    );
    expect(response.ok()).toBe(true);
}

async function connectSession(sessionId: string): Promise<{
    close: () => void;
    updateAgentState: (agentState: Record<string, unknown>) => Promise<void>;
}> {
    const credentials = auth();
    const socket: Socket = io(e2eServerUrl, {
        auth: {
            token: credentials.token,
            clientType: 'session-scoped',
            sessionId,
            happyClient: 'playwright-responsive-layout',
        },
        autoConnect: false,
        path: '/v1/updates',
        reconnection: false,
        transports: ['websocket'],
    });
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Session socket connection timed out.')), 10_000);
        socket.once('connect_error', error => {
            clearTimeout(timeout);
            reject(error);
        });
        socket.once('connect', () => {
            clearTimeout(timeout);
            resolve();
        });
        socket.connect();
    });
    const pulse = () => socket.emit('session-alive', {
        sid: sessionId,
        time: Date.now(),
        thinking: false,
        mode: 'remote',
    });
    pulse();
    const interval = setInterval(pulse, 1_000);
    return {
        updateAgentState: async (agentState) => {
            const encrypted = encodeBase64(encryptLegacy(agentState, credentials.encryptionKey));
            const response = await new Promise<{ result: string }>((resolve) => {
                socket.emit('update-state', {
                    sid: sessionId,
                    expectedVersion: 0,
                    agentState: encrypted,
                }, resolve);
            });
            expect(response.result).toBe('success');
        },
        close: () => {
            clearInterval(interval);
            socket.close();
        },
    };
}

async function createFixture(request: APIRequestContext): Promise<Fixture> {
    const credentials = auth();
    const permissionId = `responsive-permission-${Date.now()}-${Math.random()}`;
    const metadata = encodeBase64(encryptLegacy({
        path: '/workspace/responsive-three-column',
        host: 'responsive-layout.local',
        name: 'Responsive layout fixture',
        summary: {
            text: 'Keep the composer, permission request, outputs, and sources reachable at every width',
            updatedAt: Date.now(),
        },
        flavor: 'codex',
        lifecycleState: 'running',
        startedBy: 'terminal',
        models: [{ code: 'gpt-5.6-sol', value: 'gpt-5.6-sol' }],
        currentModelCode: 'gpt-5.6-sol',
        thoughtLevels: [{ code: 'xhigh', value: 'xhigh' }],
        currentThoughtLevelCode: 'xhigh',
        currentOperatingModeCode: 'acceptEdits',
    }, credentials.encryptionKey));
    const response = await request.post(new URL('/v1/sessions', e2eServerUrl).toString(), {
        data: {
            tag: `responsive-layout-${Date.now()}-${Math.random()}`,
            metadata,
            agentState: null,
            dataEncryptionKey: null,
        },
        headers: {
            Authorization: `Bearer ${credentials.token}`,
            'X-Happy-Client': 'playwright-responsive-layout',
        },
    });
    expect(response.ok()).toBe(true);
    const sessionId = (await response.json() as { session: { id: string } }).session.id;

    await appendAcpMessages(request, sessionId, [
        {
            type: 'tool-call',
            callId: 'responsive-write',
            id: 'responsive-write',
            input: { file_path: '/tmp/responsive-layout-report.md', content: 'responsive output' },
            name: 'Write',
        },
        {
            type: 'tool-result',
            callId: 'responsive-write',
            id: 'responsive-write-result',
            output: { success: true },
        },
        {
            type: 'tool-call',
            callId: 'responsive-source',
            id: 'responsive-source',
            input: { url: 'https://docs.example.com/responsive-layout' },
            name: 'WebFetch',
        },
        {
            type: 'tool-result',
            callId: 'responsive-source',
            id: 'responsive-source-result',
            output: { success: true },
        },
        {
            type: 'tool-call',
            callId: permissionId,
            id: permissionId,
            input: { command: 'pnpm test' },
            name: 'Bash',
        },
    ]);

    const client = await connectSession(sessionId);
    await client.updateAgentState({
        requests: {
            [permissionId]: {
                arguments: { command: 'pnpm test' },
                createdAt: Date.now(),
                tool: 'Bash',
            },
        },
        turnStatus: { status: 'running', updatedAt: Date.now(), turnId: 'responsive-turn' },
    });
    return { close: client.close, permissionId, sessionId };
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
    expect(await page.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
    }))).toEqual(expect.objectContaining({
        documentWidth: expect.any(Number),
        viewportWidth: expect.any(Number),
    }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

async function expectCenterHitTestable(locator: Locator): Promise<void> {
    expect(await locator.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
        const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
        const hit = document.elementFromPoint(x, y);
        return rect.width > 0 && rect.height > 0 && (hit === element || element.contains(hit));
    })).toBe(true);
}

async function expectCenterNotHitTestable(locator: Locator): Promise<void> {
    expect(await locator.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
        const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
        const hit = document.elementFromPoint(x, y);
        return rect.width > 0
            && rect.height > 0
            && hit !== element
            && !element.contains(hit);
    })).toBe(true);
}

type ElementBox = NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>;

function boxesOverlap(left: ElementBox, right: ElementBox): boolean {
    return left.x < right.x + right.width - 1
        && left.x + left.width > right.x + 1
        && left.y < right.y + right.height - 1
        && left.y + left.height > right.y + 1;
}

async function expectCriticalLayoutInsideCompactWorkspace(page: Page, drawer: Locator): Promise<void> {
    const host = page.getByTestId('right-swipe-panel-host');
    const leftSidebar = page.getByTestId('desktop-left-sidebar');
    const desktopAgentChip = page.locator('[data-testid="session-header-chip"]:visible');
    const targets: Array<{ label: string; locator: Locator }> = [
        { label: 'main area', locator: page.getByTestId('right-swipe-panel-main') },
        { label: 'session title', locator: page.locator('[data-testid="session-header-title"]:visible') },
        { label: 'run status', locator: page.locator('[data-testid="session-header-run-status"]:visible') },
        { label: 'header More action', locator: page.locator('[data-testid="session-header-more-button"]:visible') },
        { label: 'header right-panel toggle', locator: page.locator('[data-testid="desktop-right-panel-toggle-button"]:visible') },
        { label: 'composer', locator: page.locator('[data-testid="message-composer-content"]:visible') },
        { label: 'permission action', locator: page.locator('[data-testid="permission-approve-button"]:visible') },
    ];
    // Desktop Web intentionally uses the inline title/status identity from
    // #289; the Agent chip remains a native/phone affordance only.
    await expect(desktopAgentChip).toHaveCount(0);
    const hostBox = await host.boundingBox();
    const leftBox = await leftSidebar.boundingBox();
    const drawerBox = await drawer.boundingBox();
    expect(hostBox, 'compact workspace host must have geometry').not.toBeNull();
    expect(leftBox, 'open desktop left sidebar must have geometry').not.toBeNull();
    expect(drawerBox, 'open right drawer must have geometry').not.toBeNull();

    const workspaceLeft = Math.max(hostBox!.x, leftBox!.x + leftBox!.width);
    const workspaceRight = drawerBox!.x;
    expect(workspaceRight).toBeGreaterThan(workspaceLeft);

    for (const { label, locator } of targets) {
        await expect(locator, `${label} must remain rendered while the drawer is open`).toBeVisible();
        const box = await locator.boundingBox();
        expect(box, `${label} must have geometry`).not.toBeNull();
        expect(box!.x, `${label} must stay right of the left sidebar`).toBeGreaterThanOrEqual(workspaceLeft - 1);
        expect(box!.x + box!.width, `${label} must stay left of the right drawer`).toBeLessThanOrEqual(workspaceRight + 1);
        expect(box!.y, `${label} must stay inside the workspace top`).toBeGreaterThanOrEqual(hostBox!.y - 1);
        expect(box!.y + box!.height, `${label} must stay inside the workspace bottom`).toBeLessThanOrEqual(
            hostBox!.y + hostBox!.height + 1,
        );
        expect(boxesOverlap(box!, leftBox!), `${label} must not overlap the desktop left sidebar`).toBe(false);
        expect(boxesOverlap(box!, drawerBox!), `${label} must not overlap the right drawer`).toBe(false);
    }
}

async function expectDrawerDoesNotCoverCriticalControls(page: Page, drawer: Locator): Promise<void> {
    const drawerBox = await drawer.boundingBox();
    const composerBox = await page.locator('[data-testid="message-composer-content"]:visible').boundingBox();
    const permissionBox = await page.locator('[data-testid="permission-approve-button"]:visible').boundingBox();
    expect(drawerBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(permissionBox).not.toBeNull();
    expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(drawerBox!.x + 1);
    expect(permissionBox!.x + permissionBox!.width).toBeLessThanOrEqual(drawerBox!.x + 1);
}

async function expectDrawerSettled(page: Page, drawer: Locator): Promise<void> {
    await expect.poll(() => page.getByTestId('right-swipe-panel-host').evaluate(element => element.scrollLeft)).toBe(0);
    await expect.poll(async () => {
        const box = await drawer.boundingBox();
        return box ? Math.abs(box.x + box.width - await page.evaluate(() => window.innerWidth)) : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(1);
    for (const testID of ['capability-block-outputs', 'capability-block-sources']) {
        const block = drawer.getByTestId(testID);
        await expect(block).toBeVisible();
        expect(await block.evaluate(element => {
            const rect = element.getBoundingClientRect();
            return rect.left >= -1 && rect.right <= window.innerWidth + 1;
        })).toBe(true);
    }
}

test('T08-01 narrow session keeps the T14 phone header and exposes an accessible edge drawer', async ({ page, request }, testInfo) => {
    const fixture = await createFixture(request);
    const browserDiagnostics = captureBrowserDiagnostics(page);
    try {
        await installStoredCredentials(page);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(route(`/session/${fixture.sessionId}`));
        await expect(page.getByTestId('session-message-input')).toBeVisible({ timeout: sessionReadyTimeout });
        await expect(page.locator('[data-testid="permission-approve-button"]:visible')).toBeVisible({ timeout: sessionReadyTimeout });
        expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

        if (evidencePhase === 'before') {
            await waitForFastRefreshIndicatorToSettle(page);
            await expectNoDevelopmentWarningSurface(page, browserDiagnostics);
            await page.screenshot({ path: screenshotPath(testInfo, 1), fullPage: true });
            await expect(page.locator('.__expo_fast_refresh_show')).toHaveCount(0);
            await expectNoDevelopmentWarningSurface(page, browserDiagnostics);
            return;
        }

        await expect(page.getByTestId('desktop-right-panel-toggle-button')).toHaveCount(0);
        await expect(page.getByTestId('session-header-title')).toHaveCount(0);
        await expect(page.getByTestId('session-header-run-status')).toHaveCount(0);
        const handle = page.getByTestId('right-swipe-panel-edge-handle');
        await expect(handle).toBeVisible();
        await expect(handle).toHaveAttribute('aria-expanded', 'false');
        const handleBox = await handle.boundingBox();
        const sendBox = await page.locator('[data-testid="message-composer-send-button"]:visible').boundingBox();
        expect(handleBox).not.toBeNull();
        expect(sendBox).not.toBeNull();
        expect(handleBox!.width).toBeGreaterThanOrEqual(40);
        expect(handleBox!.height).toBeGreaterThanOrEqual(40);
        expect(handleBox!.y + handleBox!.height <= sendBox!.y || sendBox!.y + sendBox!.height <= handleBox!.y).toBe(true);

        await handle.focus();
        await handle.click();
        const drawer = page.getByRole('dialog', { name: 'Capability Hub' });
        await expect(drawer).toBeVisible();
        await expectDrawerSettled(page, drawer);
        await expect(handle).toHaveAttribute('aria-expanded', 'true');
        await expect(handle).toHaveAccessibleName('Hide Capability Hub');
        await expect(drawer.getByTestId('capability-block-outputs')).toBeVisible();
        await expect(drawer.getByTestId('capability-block-sources')).toBeVisible();
        await expect(drawer.getByTestId('capability-block-outputs')).toContainText('responsive-layout-report.md');
        await expect(drawer.getByTestId('capability-block-sources')).toContainText('docs.example.com');
        const openHandleBox = await handle.boundingBox();
        const openDrawerBox = await drawer.boundingBox();
        expect(openHandleBox).not.toBeNull();
        expect(openDrawerBox).not.toBeNull();
        expect(Math.abs(openHandleBox!.x + openHandleBox!.width - openDrawerBox!.x)).toBeLessThanOrEqual(1);
        await expectCenterHitTestable(handle);
        for (const testID of ['capability-block-outputs', 'capability-block-sources']) {
            const blockBox = await drawer.getByTestId(testID).boundingBox();
            expect(blockBox).not.toBeNull();
            expect(openHandleBox!.x + openHandleBox!.width <= blockBox!.x
                || blockBox!.x + blockBox!.width <= openHandleBox!.x
                || openHandleBox!.y + openHandleBox!.height <= blockBox!.y
                || blockBox!.y + blockBox!.height <= openHandleBox!.y).toBe(true);
        }
        await expect.poll(() => drawer.evaluate(element => element.contains(document.activeElement))).toBe(true);
        await expectDrawerDoesNotCoverCriticalControls(page, drawer);
        await expect(page.getByTestId('right-swipe-panel-main')).toHaveAttribute('aria-hidden', 'true');
        await expect(page.getByTestId('right-swipe-panel-main')).toHaveAttribute('inert', '');
        await expectNoHorizontalOverflow(page);

        // Visit both lazy detail surfaces before the screenshot stability gate.
        await drawer.getByTestId('capability-block-outputs').click();
        await expect(drawer.getByTestId('task-context-output-file')).toBeVisible();
        await page.keyboard.press('Escape');
        await drawer.getByTestId('capability-block-sources').click();
        await expect(drawer.getByTestId('task-context-source-web')).toBeVisible();
        await page.keyboard.press('Escape');

        await waitForFastRefreshIndicatorToSettle(page);
        await expectNoDevelopmentWarningSurface(page, browserDiagnostics);
        await page.screenshot({ path: screenshotPath(testInfo, 1), fullPage: true });
        await expect(page.locator('.__expo_fast_refresh_show')).toHaveCount(0);
        await expectNoDevelopmentWarningSurface(page, browserDiagnostics);

        // The edge affordance is an explicit Hide action, not a Back action:
        // even from a nested detail, one activation closes the whole drawer.
        await drawer.getByTestId('capability-block-outputs').click();
        await expect(drawer.getByTestId('task-context-output-file')).toBeVisible();
        await expect(handle).toHaveAccessibleName('Hide Capability Hub');
        await handle.click();
        await expect(drawer).toHaveCount(0);
        await expect(handle).toBeFocused();

        // Gesture access remains available in addition to the visible handle.
        await page.mouse.move(388, 320);
        await page.mouse.down();
        await page.mouse.move(120, 320, { steps: 8 });
        await page.mouse.up();
        await expect(page.getByRole('dialog', { name: 'Capability Hub' })).toBeVisible();
        await expectDrawerSettled(page, page.getByRole('dialog', { name: 'Capability Hub' }));
        await page.getByTestId('right-swipe-panel-close-button').click();
        await expect(page.getByRole('dialog', { name: 'Capability Hub' })).toHaveCount(0);
    } finally {
        fixture.close();
    }
});

test('T08-02 compact desktop toggle opens one measured drawer and restores focus', async ({ page, request }, testInfo) => {
    const fixture = await createFixture(request);
    const browserDiagnostics = captureBrowserDiagnostics(page);
    try {
        await installStoredCredentials(page);
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.goto(route(`/session/${fixture.sessionId}`));
        await expect(page.getByTestId('session-message-input')).toBeVisible({ timeout: sessionReadyTimeout });
        await expect(page.locator('[data-testid="permission-approve-button"]:visible')).toBeVisible({ timeout: sessionReadyTimeout });

        if (evidencePhase === 'before') {
            await waitForFastRefreshIndicatorToSettle(page);
            await expectNoDevelopmentWarningSurface(page, browserDiagnostics);
            await page.screenshot({ path: screenshotPath(testInfo, 2), fullPage: true });
            await expect(page.locator('.__expo_fast_refresh_show')).toHaveCount(0);
            await expectNoDevelopmentWarningSurface(page, browserDiagnostics);
            return;
        }

        const toggle = page.locator('[data-testid="desktop-right-panel-toggle-button"]:visible');
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('[data-testid="desktop-right-panel"]:visible')).toHaveCount(0);
        await expect(page.getByTestId('right-swipe-panel-edge-handle')).toHaveCount(0);

        const leftSidebar = page.getByTestId('desktop-left-sidebar');
        const main = page.getByTestId('right-swipe-panel-main');
        await expect(leftSidebar).toBeVisible();
        await expectCenterHitTestable(leftSidebar);

        // A real composer permission picker owns Alt+Meta+B while open. The
        // workspace shortcut must not stack the Capability Hub over it.
        const permissionTrigger = page.getByTestId('session-composer-permission-trigger');
        await expect(permissionTrigger).toBeVisible();
        await permissionTrigger.click();
        const permissionPicker = page.getByTestId('session-composer-permission-picker');
        await expect(permissionPicker).toBeVisible();
        await expect.poll(() => permissionPicker.evaluate(element => element.contains(document.activeElement))).toBe(true);
        await page.keyboard.press('Alt+Meta+KeyB');
        await expect(permissionPicker).toBeVisible();
        await expect(page.getByRole('dialog', { name: 'Capability Hub' })).toHaveCount(0);
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');

        await page.keyboard.press('Escape');
        await expect(permissionPicker).toHaveCount(0);
        await expect(permissionTrigger).toBeFocused();

        // Once the picker is gone, the same shortcut opens the compact drawer.
        await page.keyboard.press('Alt+Meta+KeyB');

        const drawer = page.getByRole('dialog', { name: 'Capability Hub' });
        await expect(drawer).toBeVisible();
        await expectDrawerSettled(page, drawer);
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(drawer.getByTestId('capability-block-outputs')).toBeVisible();
        await expect(drawer.getByTestId('capability-block-sources')).toBeVisible();
        await expectDrawerDoesNotCoverCriticalControls(page, drawer);
        await expectCriticalLayoutInsideCompactWorkspace(page, drawer);

        // The modal drawer covers the complete workspace, including the
        // permanent left sidebar. No background region stays in the a11y or
        // pointer hit-test tree while the Hub is open.
        await expect(main).toHaveAttribute('aria-hidden', 'true');
        await expect(main).toHaveAttribute('inert', '');
        await expect.poll(() => leftSidebar.evaluate(element => (
            element.closest('[inert][aria-hidden="true"]') !== null
        ))).toBe(true);
        await expectCenterNotHitTestable(leftSidebar);
        await expect.poll(() => drawer.evaluate(element => element.contains(document.activeElement))).toBe(true);
        await page.keyboard.press('Tab');
        expect(await drawer.evaluate(element => element.contains(document.activeElement))).toBe(true);
        await expectNoHorizontalOverflow(page);

        // Settle every lazy Capability Hub surface before collecting visual proof.
        await drawer.getByTestId('capability-block-outputs').click();
        await expect(drawer.getByTestId('task-context-output-file')).toBeVisible();
        await page.keyboard.press('Escape');
        await drawer.getByTestId('capability-block-sources').click();
        await expect(drawer.getByTestId('task-context-source-web')).toBeVisible();
        await page.keyboard.press('Escape');

        await waitForFastRefreshIndicatorToSettle(page);
        await expectNoDevelopmentWarningSurface(page, browserDiagnostics);
        await page.screenshot({ path: screenshotPath(testInfo, 2), fullPage: true });
        await expect(page.locator('.__expo_fast_refresh_show')).toHaveCount(0);
        await expectNoDevelopmentWarningSurface(page, browserDiagnostics);

        // Escape is hierarchical: the first press leaves detail for the Hub
        // summary without dropping dialog focus, the second closes the drawer
        // and restores the element that owned focus before the shortcut.
        await drawer.getByTestId('capability-block-outputs').click();
        await expect(drawer.getByTestId('task-context-output-file')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(drawer).toBeVisible();
        await expect(drawer.getByTestId('capability-block-outputs')).toBeVisible();
        await expect.poll(() => drawer.evaluate(element => element.contains(document.activeElement))).toBe(true);
        await page.keyboard.press('Escape');
        await expect(drawer).toHaveCount(0);
        await expect(permissionTrigger).toBeFocused();
        await expect(main).not.toHaveAttribute('aria-hidden', 'true');
        await expect(main).not.toHaveAttribute('inert', '');
        await expect.poll(() => leftSidebar.evaluate(element => (
            element.closest('[inert][aria-hidden="true"]') !== null
        ))).toBe(false);
        await expectCenterHitTestable(leftSidebar);

        // The explicit Hide button is not a detail-level Back control. One
        // click from a nested Outputs detail closes the complete dialog and
        // returns focus to the header opener.
        await toggle.focus();
        await toggle.click();
        await expect(drawer).toBeVisible();
        await drawer.getByTestId('capability-block-outputs').click();
        await expect(drawer.getByTestId('task-context-output-file')).toBeVisible();
        const closeButton = drawer.getByTestId('right-swipe-panel-close-button');
        await expect(closeButton).toHaveAccessibleName('Hide Capability Hub');
        await closeButton.click();
        await expect(drawer).toHaveCount(0);
        await expect(toggle).toBeFocused();
    } finally {
        fixture.close();
    }
});

test('T08-03 all locked widths keep exactly one reachable right-panel presentation', async ({ page, request }) => {
    test.skip(evidencePhase === 'before', 'Responsive behavior only applies after T08.');
    const fixture = await createFixture(request);
    try {
        await installStoredCredentials(page);
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.goto(route(`/session/${fixture.sessionId}`));
        await expect(page.getByTestId('session-message-input')).toBeVisible({ timeout: sessionReadyTimeout });

        for (const width of [390, 500, 799]) {
            await page.setViewportSize({ width, height: 768 });
            await expect(page.getByTestId('right-swipe-panel-edge-handle')).toBeVisible();
            await expect(page.getByTestId('desktop-right-panel-toggle-button')).toHaveCount(0);
            await expect(page.locator('[data-testid="desktop-right-panel"]:visible')).toHaveCount(0);
            await expectNoHorizontalOverflow(page);
        }

        for (const width of [800, 1024, 1099]) {
            await page.setViewportSize({ width, height: 768 });
            const toggle = page.locator('[data-testid="desktop-right-panel-toggle-button"]:visible');
            await expect(toggle).toBeVisible();
            await expect(toggle).toHaveAttribute('aria-expanded', 'false');
            await expect(page.getByTestId('right-swipe-panel-edge-handle')).toHaveCount(0);
            await expect(page.locator('[data-testid="desktop-right-panel"]:visible')).toHaveCount(0);
            await expectCenterHitTestable(toggle);
            await expectNoHorizontalOverflow(page);
        }

        for (const width of [1100, 1179, 1180, 1280, 1440, 1920]) {
            await page.setViewportSize({ width, height: 768 });
            const left = page.getByTestId('desktop-left-sidebar');
            const main = page.locator('[data-testid="desktop-workspace-main"]:visible');
            const right = page.locator('[data-testid="desktop-right-panel"]:visible');
            await expect(left).toBeVisible();
            await expect(main).toBeVisible();
            await expect(right).toBeVisible();
            await expect(page.getByTestId('right-swipe-panel-edge-handle')).toHaveCount(0);
            await expect(page.getByRole('dialog', { name: 'Capability Hub' })).toHaveCount(0);
            const leftBox = await left.boundingBox();
            const mainBox = await main.boundingBox();
            const rightBox = await right.boundingBox();
            expect(leftBox).not.toBeNull();
            expect(mainBox).not.toBeNull();
            expect(rightBox).not.toBeNull();
            expect(leftBox!.x + leftBox!.width).toBeLessThanOrEqual(mainBox!.x + 1);
            expect(mainBox!.x + mainBox!.width).toBeLessThanOrEqual(rightBox!.x + 1);
            expect(mainBox!.width).toBeGreaterThanOrEqual(480);
            expect(rightBox!.width).toBeGreaterThanOrEqual(280);
            await expect(right.getByTestId('capability-block-outputs')).toBeVisible();
            await expect(right.getByTestId('capability-block-sources')).toBeVisible();
            await expectNoHorizontalOverflow(page);
        }

        // A collapsed persistent preference never removes compact drawer access.
        await page.setViewportSize({ width: 1280, height: 768 });
        const persistentToggle = page.locator('[data-testid="desktop-right-panel-toggle-button"]:visible');
        await persistentToggle.click();
        await expect(persistentToggle).toHaveAttribute('aria-expanded', 'false');
        await page.setViewportSize({ width: 1024, height: 768 });
        const compactToggle = page.locator('[data-testid="desktop-right-panel-toggle-button"]:visible');
        await expect(compactToggle).toBeVisible();
        await compactToggle.click();
        await expect(page.getByRole('dialog', { name: 'Capability Hub' })).toBeVisible();
        await page.getByTestId('right-swipe-panel-close-button').click();
        await expect(page.getByRole('dialog', { name: 'Capability Hub' })).toHaveCount(0);

        await page.setViewportSize({ width: 1280, height: 768 });
        await expect(page.getByRole('dialog', { name: 'Capability Hub' })).toHaveCount(0);
        const restoredPersistentToggle = page.locator('[data-testid="desktop-right-panel-toggle-button"]:visible');
        await expect(restoredPersistentToggle).toBeVisible();
        await expect(restoredPersistentToggle).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('[data-testid="desktop-right-panel"]:visible')).toHaveCount(0);
        await restoredPersistentToggle.click();
        await expect(restoredPersistentToggle).toHaveAttribute('aria-expanded', 'true');
        await expect(page.locator('[data-testid="desktop-right-panel"]:visible')).toHaveCount(1);
        await page.setViewportSize({ width: 1024, height: 768 });
        await expect(page.locator('[data-testid="desktop-right-panel-toggle-button"]:visible')).toHaveAttribute('aria-expanded', 'false');
    } finally {
        fixture.close();
    }
});

test('[R10-05] final responsive acceptance keeps one hit-testable right-panel path', async ({ page, request }, testInfo) => {
    const fixture = await createFixture(request);
    const browserDiagnostics = captureBrowserDiagnostics(page);
    try {
        await installStoredCredentials(page);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(route(`/session/${fixture.sessionId}`));
        await expect(page.getByTestId('session-message-input')).toBeVisible({ timeout: sessionReadyTimeout });
        expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

        for (const viewport of [
            { width: 390, height: 844 },
            { width: 799, height: 768 },
        ]) {
            await page.setViewportSize(viewport);
            const handle = page.getByTestId('right-swipe-panel-edge-handle');
            await expect(handle).toBeVisible();
            await expect(handle).toHaveAttribute('aria-expanded', 'false');
            await expect(page.getByTestId('desktop-right-panel-toggle-button')).toHaveCount(0);
            await expect(page.locator('[data-testid="desktop-right-panel"]:visible')).toHaveCount(0);
            await expectCenterHitTestable(handle);
            await handle.focus();
            await handle.click();

            const drawer = page.getByRole('dialog', { name: 'Capability Hub' });
            await expect(drawer).toBeVisible();
            await expectDrawerSettled(page, drawer);
            await expectDrawerDoesNotCoverCriticalControls(page, drawer);
            await expectNoHorizontalOverflow(page);

            if (viewport.width === 390) {
                await waitForFastRefreshIndicatorToSettle(page);
                await expectNoDevelopmentWarningSurface(page, browserDiagnostics);
                await page.screenshot({
                    path: finalRegressionScreenshotPath(testInfo, '390x844'),
                    fullPage: true,
                });
            }

            await page.getByTestId('right-swipe-panel-close-button').click();
            await expect(drawer).toHaveCount(0);
            await expect(handle).toBeFocused();
        }

        for (const viewport of [
            { width: 800, height: 768 },
            { width: 1024, height: 768 },
        ]) {
            await page.setViewportSize(viewport);
            const toggle = page.locator('[data-testid="desktop-right-panel-toggle-button"]:visible');
            await expect(toggle).toBeVisible();
            await expect(toggle).toHaveAttribute('aria-expanded', 'false');
            await expect(page.getByTestId('right-swipe-panel-edge-handle')).toHaveCount(0);
            await expect(page.locator('[data-testid="desktop-right-panel"]:visible')).toHaveCount(0);
            await expectCenterHitTestable(toggle);
            await toggle.focus();
            await toggle.click();

            const drawer = page.getByRole('dialog', { name: 'Capability Hub' });
            await expect(drawer).toBeVisible();
            await expectDrawerSettled(page, drawer);
            await expectDrawerDoesNotCoverCriticalControls(page, drawer);
            await expectNoHorizontalOverflow(page);

            if (viewport.width === 1024) {
                await expectCriticalLayoutInsideCompactWorkspace(page, drawer);
                await waitForFastRefreshIndicatorToSettle(page);
                await expectNoDevelopmentWarningSurface(page, browserDiagnostics);
                await page.screenshot({
                    path: finalRegressionScreenshotPath(testInfo, '1024x768'),
                    fullPage: true,
                });
            }

            await page.getByTestId('right-swipe-panel-close-button').click();
            await expect(drawer).toHaveCount(0);
            await expect(toggle).toBeFocused();
        }

        await page.setViewportSize({ width: 1440, height: 900 });
        await page.waitForTimeout(350); // Let breakpoint ownership settle before toggling the persistent panel.
        const persistentToggle = page.locator('[data-testid="desktop-right-panel-toggle-button"]:visible');
        const left = page.getByTestId('desktop-left-sidebar');
        const main = page.locator('[data-testid="desktop-workspace-main"]:visible');
        const right = page.locator('[data-testid="desktop-right-panel"]:visible');
        await expect(persistentToggle).toBeVisible();
        await expectCenterHitTestable(persistentToggle);
        if (!await right.isVisible()) await persistentToggle.click();
        await expect(right).toBeVisible();
        await expect(page.getByTestId('right-swipe-panel-edge-handle')).toHaveCount(0);
        await expect(page.getByRole('dialog', { name: 'Capability Hub' })).toHaveCount(0);

        const leftBox = await left.boundingBox();
        const mainBox = await main.boundingBox();
        const rightBox = await right.boundingBox();
        expect(leftBox).not.toBeNull();
        expect(mainBox).not.toBeNull();
        expect(rightBox).not.toBeNull();
        expect(leftBox!.x + leftBox!.width).toBeLessThanOrEqual(mainBox!.x + 1);
        expect(mainBox!.x + mainBox!.width).toBeLessThanOrEqual(rightBox!.x + 1);
        expect(mainBox!.width).toBeGreaterThanOrEqual(480);
        expect(rightBox!.width).toBeGreaterThanOrEqual(280);
        await expect(right.getByTestId('capability-block-outputs')).toBeVisible();
        await expect(right.getByTestId('capability-block-sources')).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await page.getByTestId('session-message-input').hover();
        await page.getByTestId('session-message-input').focus();
        await expect(page.getByTestId('session-header-title-tooltip')).toHaveCount(0);
        await expect(page.getByTestId('desktop-right-panel-toggle-tooltip')).toHaveCount(0);
        await waitForFastRefreshIndicatorToSettle(page);
        await expectNoDevelopmentWarningSurface(page, browserDiagnostics);
        await page.screenshot({
            path: finalRegressionScreenshotPath(testInfo, '1440x900'),
            fullPage: true,
        });
    } finally {
        fixture.close();
    }
});
