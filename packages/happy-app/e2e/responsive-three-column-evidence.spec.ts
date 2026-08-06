import { expect, test, type APIRequestContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';
import { encodeBase64, encryptLegacy } from '../../happy-cli/src/api/encryption';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const e2eServerUrl = process.env.HAPPY_E2E_SERVER_URL!;
const evidenceDirectory = process.env.HAPPY_RESPONSIVE_LAYOUT_EVIDENCE_DIR;
const evidencePhase = process.env.HAPPY_RESPONSIVE_LAYOUT_EVIDENCE_PHASE ?? 'after';

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

function screenshotPath(testInfo: TestInfo, caseNumber: number): string {
    const filename = `case-${caseNumber}-${evidencePhase}.png`;
    return evidenceDirectory ? `${evidenceDirectory}/${filename}` : testInfo.outputPath(filename);
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

test('T08-01 narrow session keeps the T14 phone header and exposes an accessible edge drawer', async ({ page, request }, testInfo) => {
    const fixture = await createFixture(request);
    try {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(route(`/session/${fixture.sessionId}`));
        await expect(page.getByTestId('session-message-input')).toBeVisible();
        await expect(page.locator('[data-testid="permission-approve-button"]:visible')).toBeVisible();
        expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

        if (evidencePhase === 'before') {
            await page.screenshot({ path: screenshotPath(testInfo, 1), fullPage: true });
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
        await expect(handle).toHaveAttribute('aria-expanded', 'true');
        await expect(drawer.getByTestId('capability-block-outputs')).toBeVisible();
        await expect(drawer.getByTestId('capability-block-sources')).toBeVisible();
        await expect(drawer.getByTestId('capability-block-outputs')).toContainText('responsive-layout-report.md');
        await expect(drawer.getByTestId('capability-block-sources')).toContainText('docs.example.com');
        await expect.poll(() => drawer.evaluate(element => element.contains(document.activeElement))).toBe(true);
        await expectDrawerDoesNotCoverCriticalControls(page, drawer);
        await expect(page.getByTestId('right-swipe-panel-main')).toHaveAttribute('aria-hidden', 'true');
        await expect(page.getByTestId('right-swipe-panel-main')).toHaveAttribute('inert', '');
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: screenshotPath(testInfo, 1), fullPage: true });

        await drawer.getByTestId('capability-block-outputs').click();
        await expect(drawer.getByTestId('task-context-output-file')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(drawer.getByTestId('capability-block-sources')).toBeVisible();
        await expect(drawer).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(drawer).toHaveCount(0);
        await expect(handle).toBeFocused();

        // Gesture access remains available in addition to the visible handle.
        await page.mouse.move(388, 320);
        await page.mouse.down();
        await page.mouse.move(120, 320, { steps: 8 });
        await page.mouse.up();
        await expect(page.getByRole('dialog', { name: 'Capability Hub' })).toBeVisible();
        await page.getByTestId('right-swipe-panel-close-button').click();
        await expect(page.getByRole('dialog', { name: 'Capability Hub' })).toHaveCount(0);
    } finally {
        fixture.close();
    }
});

test('T08-02 compact desktop toggle opens one measured drawer and restores focus', async ({ page, request }, testInfo) => {
    const fixture = await createFixture(request);
    try {
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.goto(route(`/session/${fixture.sessionId}`));
        await expect(page.getByTestId('session-message-input')).toBeVisible();
        await expect(page.locator('[data-testid="permission-approve-button"]:visible')).toBeVisible();

        if (evidencePhase === 'before') {
            await page.screenshot({ path: screenshotPath(testInfo, 2), fullPage: true });
            return;
        }

        const toggle = page.locator('[data-testid="desktop-right-panel-toggle-button"]:visible');
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('[data-testid="desktop-right-panel"]:visible')).toHaveCount(0);
        await expect(page.getByTestId('right-swipe-panel-edge-handle')).toHaveCount(0);

        // Opening another top-level surface never leaves two overlays stacked.
        await page.getByTestId('session-header-more-button').click();
        await expect(page.getByTestId('session-agent-panel')).toBeVisible();
        await toggle.click();
        await expect(page.getByTestId('session-agent-panel')).toHaveCount(0);

        const drawer = page.getByRole('dialog', { name: 'Capability Hub' });
        await expect(drawer).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(drawer.getByTestId('capability-block-outputs')).toBeVisible();
        await expect(drawer.getByTestId('capability-block-sources')).toBeVisible();
        await expectDrawerDoesNotCoverCriticalControls(page, drawer);
        await expect.poll(() => drawer.evaluate(element => element.contains(document.activeElement))).toBe(true);
        await page.keyboard.press('Tab');
        expect(await drawer.evaluate(element => element.contains(document.activeElement))).toBe(true);
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: screenshotPath(testInfo, 2), fullPage: true });

        await page.keyboard.press('Escape');
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
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.goto(route(`/session/${fixture.sessionId}`));
        await expect(page.getByTestId('session-message-input')).toBeVisible();

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
        await expect(page.locator('[data-testid="desktop-right-panel"]:visible')).toHaveCount(1);
        await page.setViewportSize({ width: 1024, height: 768 });
        await expect(page.locator('[data-testid="desktop-right-panel-toggle-button"]:visible')).toHaveAttribute('aria-expanded', 'false');
    } finally {
        fixture.close();
    }
});
