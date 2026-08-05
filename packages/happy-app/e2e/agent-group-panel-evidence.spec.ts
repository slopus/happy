import { expect, test, type APIRequestContext, type TestInfo } from '@playwright/test';
import { encodeBase64, encryptLegacy } from '../../happy-cli/src/api/encryption';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const e2eServerUrl = process.env.HAPPY_E2E_SERVER_URL!;
const evidenceDirectory = process.env.HAPPY_AGENT_PANEL_EVIDENCE_DIR;
const evidencePhase = process.env.HAPPY_AGENT_PANEL_EVIDENCE_PHASE ?? 'after';

function screenshotPath(testInfo: TestInfo, caseId: number): string {
    const filename = `case-${caseId}-${evidencePhase}.png`;
    return evidenceDirectory ? `${evidenceDirectory}/${filename}` : testInfo.outputPath(filename);
}

function authenticatedRoute(pathname: string): string {
    const url = new URL(authenticatedWebUrl);
    url.pathname = pathname;
    return url.toString();
}

async function createSession(request: APIRequestContext, suffix: string): Promise<string> {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    const secret = authUrl.searchParams.get('dev_secret');
    if (!token || !secret) {
        throw new Error('Missing local E2E authentication.');
    }

    const encryptionKey = new Uint8Array(Buffer.from(secret, 'base64url'));
    const metadata = encodeBase64(encryptLegacy({
        path: '/workspace/atlas-dashboard',
        host: 'atlas-mac-mini.local',
        name: `Agent panel ${suffix}`,
        summary: { text: `Agent panel ${suffix}`, updatedAt: Date.now() },
        flavor: 'codex',
        currentOperatingModeCode: 'acceptEdits',
        models: [
            { code: 'gpt-5.5', value: 'gpt-5.5', description: 'Stable coding model' },
            { code: 'gpt-5.6-sol', value: 'gpt-5.6-sol', description: 'Current coding model' },
        ],
        currentModelCode: 'gpt-5.6-sol',
        thoughtLevels: [
            { code: 'high', value: 'high', description: 'Deep reasoning' },
            { code: 'xhigh', value: 'xhigh', description: 'Maximum reasoning' },
        ],
        currentThoughtLevelCode: 'xhigh',
        lifecycleState: 'running',
        startedBy: 'terminal',
    }, encryptionKey));
    const response = await request.post(new URL('/v1/sessions', e2eServerUrl).toString(), {
        data: {
            tag: `agent-panel-${suffix}-${Date.now()}-${Math.random()}`,
            metadata,
            agentState: null,
            dataEncryptionKey: null,
        },
        headers: {
            Authorization: `Bearer ${token}`,
            'X-Happy-Client': 'playwright-e2e',
        },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json() as { session: { id: string } };
    return body.session.id;
}

async function deactivateSession(request: APIRequestContext, sessionId: string): Promise<void> {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    if (!token) {
        throw new Error('Missing local E2E authentication.');
    }
    const response = await request.post(new URL(`/v1/sessions/${sessionId}/archive`, e2eServerUrl).toString(), {
        headers: {
            Authorization: `Bearer ${token}`,
            'X-Happy-Client': 'playwright-e2e',
        },
    });
    expect(response.ok()).toBe(true);
}

test('AGP-01 online panel evidence', async ({ page, request }, testInfo) => {
    const sessionId = await createSession(request, 'online');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(authenticatedRoute(`/session/${sessionId}`));
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
    await page.getByTestId('session-header-chip').click();
    const panel = page.getByTestId('session-agent-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Runtime location', { exact: true })).toBeVisible();
    await expect(panel.getByText('This execution', { exact: true })).toBeVisible();
    await expect(panel.getByText('Session management', { exact: true })).toBeVisible();
    await expect(panel.getByTestId('session-agent-panel-machine-status')).toContainText('Agent panel online · online');
    await expect(panel.getByTestId('session-agent-panel-address')).toContainText('atlas-mac-mini.local');
    await expect(panel.getByTestId('session-agent-panel-working-directory')).toContainText('/workspace/atlas-dashboard');
    await expect(panel.getByTestId('session-agent-panel-agent')).toContainText('Codex');
    await expect(panel.getByTestId('session-agent-panel-address')).not.toHaveAttribute('role', 'button');

    const panelModel = panel.getByTestId('session-agent-panel-model');
    const panelEffort = panel.getByTestId('session-agent-panel-effort');
    const panelPermission = panel.getByTestId('session-agent-panel-permission');
    await expect(panelModel).toHaveAttribute('role', 'button');
    await expect(panelEffort).toHaveAttribute('role', 'button');
    await expect(panelPermission).toHaveAttribute('role', 'button');
    await expect(panelModel).toContainText('gpt-5.6-sol');
    await expect(panelEffort).toContainText('xhigh');
    await expect(panelPermission).toContainText('Needs confirmation');

    // Panel → composer: both surfaces read and update the same next-turn override.
    await panelModel.click();
    await panel.getByTestId('session-agent-panel-model-option-gpt-5.5').click();
    await expect(panelModel).toContainText('gpt-5.5');
    await page.getByTestId('session-header-chip').click();
    const composerModel = page.locator('[data-testid="session-composer-mode-selector"]:visible')
        .getByTestId('session-composer-model-trigger');
    await expect(composerModel).toContainText('gpt-5.5');

    // Composer → panel: switching back is immediately reflected when the panel reopens.
    await composerModel.click();
    await page.getByTestId('session-composer-model-picker')
        .getByRole('radio', { name: /^gpt-5\.6-sol,/ })
        .click();
    await expect(composerModel).toContainText('gpt-5.6-sol');
    await page.getByTestId('session-header-chip').click();
    await expect(panel.getByTestId('session-agent-panel-model')).toContainText('gpt-5.6-sol');
    await page.screenshot({
        path: screenshotPath(testInfo, 1),
        fullPage: true,
    });
});

test('AGP-02 offline panel evidence', async ({ page, request }, testInfo) => {
    const sessionId = await createSession(request, 'offline');
    await deactivateSession(request, sessionId);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(authenticatedRoute(`/session/${sessionId}`));
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
    await expect(page.getByTestId('session-header-chip')).toHaveAccessibleName(/offline/);
    await page.getByTestId('session-header-chip').click();
    const panel = page.getByTestId('session-agent-panel');
    await expect(panel.getByTestId('session-agent-panel-offline-notice')).toContainText(
        'This machine is offline. Settings are kept, but execution is unavailable.',
    );
    await expect(panel.getByTestId('session-agent-panel-model')).toContainText('gpt-5.6-sol');
    await expect(panel.getByTestId('session-agent-panel-effort')).toContainText('xhigh');
    await expect(panel.getByTestId('session-agent-panel-permission')).toContainText('Needs confirmation');
    for (const testID of [
        'session-agent-panel-model',
        'session-agent-panel-effort',
        'session-agent-panel-permission',
    ]) {
        await expect(panel.getByTestId(testID)).not.toHaveAttribute('role', 'button');
        await expect(panel.getByTestId(testID)).toContainText('Read-only');
    }
    await page.screenshot({
        path: screenshotPath(testInfo, 2),
        fullPage: true,
    });
});
