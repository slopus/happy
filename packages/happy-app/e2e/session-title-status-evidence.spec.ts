import { expect, test, type APIRequestContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';
import { encodeBase64, encryptLegacy } from '../../happy-cli/src/api/encryption';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const e2eServerUrl = process.env.HAPPY_E2E_SERVER_URL!;
const evidenceDirectory = process.env.HAPPY_TITLE_STATUS_EVIDENCE_DIR;
const evidencePhase = process.env.HAPPY_TITLE_STATUS_EVIDENCE_PHASE ?? 'after';

type Auth = { encryptionKey: Uint8Array; secret: string; token: string };

function auth(): Auth {
    const url = new URL(authenticatedWebUrl);
    const token = url.searchParams.get('dev_token');
    const secret = url.searchParams.get('dev_secret');
    if (!token || !secret) throw new Error('Missing local E2E authentication.');
    return { token, secret, encryptionKey: new Uint8Array(Buffer.from(secret, 'base64url')) };
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

async function createSession(request: APIRequestContext, options: {
    agentState?: Record<string, unknown> | null;
    path: string;
    summary?: string;
    tag: string;
}): Promise<string> {
    const credentials = auth();
    const metadata = {
        path: options.path,
        host: 'paws-title-status.local',
        name: 'Title status fixture',
        flavor: 'codex',
        lifecycleState: 'running',
        startedBy: 'terminal',
        models: [{ code: 'gpt-5.6-sol', value: 'gpt-5.6-sol' }],
        currentModelCode: 'gpt-5.6-sol',
        thoughtLevels: [{ code: 'xhigh', value: 'xhigh' }],
        currentThoughtLevelCode: 'xhigh',
        ...(options.summary ? { summary: { text: options.summary, updatedAt: Date.now() } } : {}),
    };
    const response = await request.post(new URL('/v1/sessions', e2eServerUrl).toString(), {
        data: {
            tag: `${options.tag}-${Date.now()}-${Math.random()}`,
            metadata: encodeBase64(encryptLegacy(metadata, credentials.encryptionKey)),
            agentState: options.agentState
                ? encodeBase64(encryptLegacy(options.agentState, credentials.encryptionKey))
                : null,
            dataEncryptionKey: null,
        },
        headers: {
            Authorization: `Bearer ${credentials.token}`,
            'X-Happy-Client': 'playwright-title-status',
        },
    });
    expect(response.ok()).toBe(true);
    const sessionId = (await response.json() as { session: { id: string } }).session.id;
    if (options.agentState) {
        // The create-session route intentionally does not persist agentState.
        // Seed it through the same versioned socket event used by a real CLI.
        const client = await connectSession(sessionId, false);
        try {
            await client.updateAgentState(options.agentState);
        } finally {
            client.close();
        }
    }
    return sessionId;
}

async function createPendingToolCall(
    request: APIRequestContext,
    sessionId: string,
    permissionId: string,
): Promise<void> {
    const credentials = auth();
    const content = encodeBase64(encryptLegacy({
        role: 'agent',
        content: {
            type: 'acp',
            provider: 'codex',
            data: {
                type: 'tool-call',
                callId: permissionId,
                id: permissionId,
                input: { command: 'pnpm test' },
                name: 'Bash',
            },
        },
        meta: { sentFrom: 'cli' },
    }, credentials.encryptionKey));
    const response = await request.post(
        new URL(`/v3/sessions/${encodeURIComponent(sessionId)}/messages`, e2eServerUrl).toString(),
        {
            data: { messages: [{ content, localId: `${permissionId}-${Date.now()}` }] },
            headers: {
                Authorization: `Bearer ${credentials.token}`,
                'X-Happy-Client': 'playwright-title-status',
            },
        },
    );
    expect(response.ok()).toBe(true);
}

async function markSessionOffline(request: APIRequestContext, sessionId: string): Promise<void> {
    const response = await request.post(
        new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/archive`, e2eServerUrl).toString(),
        {
            headers: {
                Authorization: `Bearer ${auth().token}`,
                'X-Happy-Client': 'playwright-title-status',
            },
        },
    );
    expect(response.ok()).toBe(true);
}

async function connectSession(sessionId: string, thinking: boolean): Promise<{
    close: () => void;
    pulse: () => void;
    updateAgentState: (agentState: Record<string, unknown>) => Promise<void>;
}> {
    const credentials = auth();
    const socket: Socket = io(e2eServerUrl, {
        auth: {
            token: credentials.token,
            clientType: 'session-scoped',
            sessionId,
            happyClient: 'playwright-title-status',
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
    const pulse = () => socket.emit('session-alive', { sid: sessionId, time: Date.now(), thinking });
    pulse();
    const interval = setInterval(pulse, 1_000);
    return {
        pulse,
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

async function expectCenterHitTestable(locator: Locator): Promise<void> {
    expect(await locator.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return rect.width > 0 && rect.height > 0 && (hit === element || element.contains(hit));
    })).toBe(true);
}

test('T09-01 first message creates a protected editable title and permanent header state', async ({ page, request }, testInfo) => {
    const sessionId = await createSession(request, {
        path: '/workspace/paws-title-status-title',
        tag: 'title-status-title',
    });
    const client = await connectSession(sessionId, true);
    const prompt = 'Implement persistent session status after reconnect';

    try {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(route(`/session/${sessionId}`));
        client.pulse();
        const input = page.getByTestId('session-message-input');
        await expect(input).toBeVisible();
        await input.fill(prompt);
        await page.locator('[data-testid="message-composer-send-button"]:not([aria-disabled="true"])').click();

        const title = page.locator('[data-testid="session-header-title"]:visible');
        if (evidencePhase === 'after') {
            await expect(title).toHaveAccessibleName(new RegExp(prompt));
            await expect(page.getByTestId('session-header-title-edit-icon')).toHaveCount(0);
            await expect(page.getByTestId('session-header-run-status')).toContainText(/running/i);
        } else {
            await expect(title).toHaveAccessibleName(/New chat/i);
        }

        await page.screenshot({ path: screenshotPath(testInfo, 1), fullPage: true });

        if (evidencePhase === 'after') {
            await title.click();
            const manualTitle = 'Manual title wins permanently';
            const followUpPrompt = 'This second message must not replace the manual title';
            const inlineTitleInput = page.getByTestId('session-header-title-input');
            await expect(inlineTitleInput).toBeVisible();
            await inlineTitleInput.fill(manualTitle);
            await inlineTitleInput.press('Enter');
            await expect(title).toHaveAccessibleName(new RegExp(manualTitle));

            // Exercise the real message queue again after the manual rename. The
            // fallback title updater runs for every sent message, so observing the
            // second user bubble proves it had a chance to run without overwriting.
            await input.fill(followUpPrompt);
            await page.locator('[data-testid="message-composer-send-button"]:not([aria-disabled="true"])').click();
            await expect(page.getByText(followUpPrompt, { exact: true })).toBeVisible();
            await expect(title).toHaveAccessibleName(new RegExp(manualTitle));
        } else {
            await title.click();
            await expect(page.getByText('Rename Session', { exact: true })).toHaveCount(0);
        }
    } finally {
        client.close();
    }
});

test('T09-02 sidebar distinguishes persisted running and pending sessions, then jumps to confirmation', async ({ page, request }, testInfo) => {
    const workspace = '/workspace/paws-title-status-multi';
    const permissionId = `permission-${Date.now()}`;
    const runningId = await createSession(request, {
        path: workspace,
        summary: 'Persisted running after reconnect',
        tag: 'title-status-running',
        agentState: { turnStatus: { status: 'running', updatedAt: Date.now(), turnId: 'turn-running' } },
    });
    const permissionIdSession = await createSession(request, {
        path: workspace,
        summary: 'Waiting for confirmation',
        tag: 'title-status-permission',
        agentState: {
            requests: {
                [permissionId]: { tool: 'Bash', arguments: { command: 'pnpm test' }, createdAt: Date.now() },
            },
            turnStatus: { status: 'running', updatedAt: Date.now(), turnId: 'turn-permission' },
        },
    });
    await createPendingToolCall(request, permissionIdSession, permissionId);
    const runningClient = await connectSession(runningId, false);
    let permissionClient = await connectSession(permissionIdSession, false);

    try {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(route(`/session/${runningId}`));
        runningClient.pulse();
        permissionClient.pulse();
        await expect(page.getByTestId('session-message-input')).toBeVisible();

        // Reload while the CLI reports no ephemeral thinking. Only encrypted
        // turnStatus can restore "running" after this App reconnection.
        await page.reload();
        runningClient.pulse();
        permissionClient.pulse();
        await expect(page.getByTestId('session-message-input')).toBeVisible();

        const runningRow = page.getByTestId(`session-row-${runningId}`);
        const permissionRow = page.getByTestId(`session-row-${permissionIdSession}`);
        await expect(runningRow).toBeVisible();
        await expect(permissionRow).toBeVisible();

        if (evidencePhase === 'after') {
            await expect(page.getByTestId(`session-row-status-${runningId}`)).toContainText(/running/i);
            await expect(page.getByTestId(`session-row-status-${permissionIdSession}`)).toContainText(/permission required/i);
            await expect(runningRow).toHaveAccessibleName(/Persisted running after reconnect, running/i);
            await expect(permissionRow).toHaveAccessibleName(/Waiting for confirmation, permission required/i);
        } else {
            await expect(page.locator('[data-testid^="session-row-status-"]')).toHaveCount(0);
        }

        await page.screenshot({ path: screenshotPath(testInfo, 2), fullPage: true });
        await permissionRow.click();
        if (evidencePhase === 'after') {
            await expect(page).toHaveURL(new RegExp(`/session/${permissionIdSession}/message/`));
            const permissionActions = [
                page.getByTestId('permission-approve-button'),
                page.getByTestId('permission-approve-session-button'),
                page.getByTestId('permission-abort-button'),
            ];
            for (const action of permissionActions) await expect(action).toBeEnabled();

            permissionClient.close();
            // The server intentionally keeps an abruptly disconnected session
            // online for its heartbeat timeout. The CLI's graceful-shutdown
            // fallback marks it inactive through this same archive endpoint.
            await markSessionOffline(request, permissionIdSession);
            await expect(page.getByTestId('permission-offline-notice')).toBeVisible();
            for (const action of permissionActions) {
                await expect(action).toHaveAttribute('aria-disabled', 'true');
            }
            await expect(page.getByTestId(`session-row-status-${permissionIdSession}`)).toContainText(/permission required/i);
            await expect(page.getByTestId(`session-row-status-${runningId}`)).toContainText(/running/i);

            permissionClient = await connectSession(permissionIdSession, false);
            permissionClient.pulse();
            await expect(page.getByTestId('permission-offline-notice')).toHaveCount(0);
            for (const action of permissionActions) await expect(action).toBeEnabled();
            await expect(page.getByTestId(`session-row-status-${permissionIdSession}`)).toContainText(/permission required/i);
            await expect(page.getByTestId(`session-row-status-${runningId}`)).toContainText(/running/i);
        } else {
            await expect(page).toHaveURL(new RegExp(`/session/${permissionIdSession}/?$`));
        }
    } finally {
        runningClient.close();
        permissionClient.close();
    }
});

test('T09-03 compact header remains hit-testable at 800/1024 and phone keeps the T14 boundary', async ({ page, request }) => {
    test.skip(evidencePhase !== 'after', 'Layout regression only applies after T09.');
    const permissionId = `layout-permission-${Date.now()}`;
    const sessionId = await createSession(request, {
        path: '/workspace/paws-title-status-layout',
        summary: 'A deliberately very long editable session title that must yield space to status and Agent controls',
        tag: 'title-status-layout',
        agentState: {
            requests: {
                [permissionId]: { tool: 'Bash', arguments: {}, createdAt: Date.now() },
            },
        },
    });
    const client = await connectSession(sessionId, false);

    try {
        for (const width of [800, 1024, 1440]) {
            await page.setViewportSize({ width, height: 768 });
            await page.goto(route(`/session/${sessionId}`));
            client.pulse();
            await expect(page.getByTestId('session-message-input')).toBeVisible();
            const controls = [
                page.locator('[data-testid="session-header-title"]:visible'),
                page.locator('[data-testid="session-header-run-status"]:visible'),
                page.locator('[data-testid="session-header-more-button"]:visible'),
            ];
            if (width === 1440) {
                controls.push(page.locator('[data-testid="desktop-right-panel-toggle-button"]:visible'));
            }
            for (const control of controls) {
                await expect(control).toBeVisible();
                await expectCenterHitTestable(control);
            }
            const boxes = await Promise.all(controls.map(control => control.boundingBox()));
            expect(boxes[0]!.width).toBeGreaterThanOrEqual(32);
            if (width === 1440) {
                expect(boxes[0]!.width).toBeGreaterThanOrEqual(120);
                expect(boxes[1]!.width).toBeGreaterThanOrEqual(44);
            }
            for (let index = 1; index < boxes.length; index++) {
                expect(boxes[index - 1]!.x + boxes[index - 1]!.width).toBeLessThanOrEqual(boxes[index]!.x + 1);
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        }

        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(route(`/session/${sessionId}`));
        client.pulse();
        await expect(page.getByTestId('session-message-input')).toBeVisible();
        await expect(page.getByTestId('session-header-title')).toHaveCount(0);
        await expect(page.getByTestId('session-header-run-status')).toHaveCount(0);
        await expect(page.getByTestId('session-header-more-button')).toHaveCount(0);
        await expect(page.locator('[data-testid="session-header-chip"]:visible')).toBeVisible();
        await expect(page.locator('[data-testid="session-header-new-session-button"]:visible')).toBeVisible();
    } finally {
        client.close();
    }
});
