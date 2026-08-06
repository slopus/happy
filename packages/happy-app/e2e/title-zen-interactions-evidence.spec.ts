import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { encodeBase64, encryptLegacy } from '../../happy-cli/src/api/encryption';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const e2eServerUrl = process.env.HAPPY_E2E_SERVER_URL!;
const evidenceDirectory = process.env.HAPPY_TITLE_ZEN_EVIDENCE_DIR;
const evidencePhase = process.env.HAPPY_TITLE_ZEN_EVIDENCE_PHASE ?? 'after';

function authenticatedRoute(pathname: string): string {
    const url = new URL(authenticatedWebUrl);
    url.pathname = pathname;
    return url.toString();
}

function evidencePath(testInfo: TestInfo, caseNumber: number): string {
    const filename = `case-${String(caseNumber).padStart(2, '0')}-${evidencePhase}.png`;
    if (!evidenceDirectory) return testInfo.outputPath(filename);
    mkdirSync(evidenceDirectory, { recursive: true });
    return `${evidenceDirectory}/${filename}`;
}

async function captureCase(page: Page, testInfo: TestInfo, caseNumber: number): Promise<void> {
    await page.screenshot({ path: evidencePath(testInfo, caseNumber) });
}

async function pauseForRecordedReview(page: Page, duration = 900): Promise<void> {
    if (process.env.HAPPY_E2E_RECORD === '1') {
        await page.waitForTimeout(duration);
    }
}

async function createSession(request: APIRequestContext): Promise<string> {
    const authUrl = new URL(authenticatedWebUrl);
    const token = authUrl.searchParams.get('dev_token');
    const secret = authUrl.searchParams.get('dev_secret');
    if (!token || !secret || !e2eServerUrl) {
        throw new Error('缺少标题与禅模式 E2E 所需的本地认证配置。');
    }

    const encryptionKey = new Uint8Array(Buffer.from(secret, 'base64url'));
    const metadata = encodeBase64(encryptLegacy({
        path: '/workspace/paws-title-zen-evidence',
        host: 'playwright-title-zen.local',
        name: 'Title and zen interaction evidence',
        summary: {
            text: 'Refine title editing and zen mode',
            updatedAt: Date.now(),
        },
        flavor: 'codex',
        lifecycleState: 'running',
        startedBy: 'terminal',
        models: [{ code: 'gpt-5.6-sol', value: 'gpt-5.6-sol' }],
        currentModelCode: 'gpt-5.6-sol',
        thoughtLevels: [{ code: 'xhigh', value: 'xhigh' }],
        currentThoughtLevelCode: 'xhigh',
    }, encryptionKey));
    const response = await request.post(new URL('/v1/sessions', e2eServerUrl).toString(), {
        data: {
            tag: `title-zen-evidence-${Date.now()}-${Math.random()}`,
            metadata,
            agentState: null,
            dataEncryptionKey: null,
        },
        headers: {
            Authorization: `Bearer ${token}`,
            'X-Happy-Client': 'playwright-title-zen',
        },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json() as { session: { id: string } };
    return body.session.id;
}

test('[TITLE-ZEN-UX] PC title, header, new-session controls, and zen icon match the requested interaction', async ({ page, request }, testInfo) => {
    const sessionId = await createSession(request);

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(authenticatedRoute(`/session/${sessionId}`));
    await expect(page.getByTestId('session-message-input')).toBeVisible();

    const title = page.locator('[data-testid="session-header-title"]:visible');
    await expect(title).toHaveAccessibleName(/Refine title editing and zen mode/);

    if (evidencePhase === 'before') {
        await expect(page.getByTestId('session-header-title-edit-icon')).toBeVisible();
        await title.click();
        await expect(page.getByPlaceholder('Session title')).toBeVisible();
    } else {
        await expect(page.getByTestId('session-header-title-edit-icon')).toHaveCount(0);
        await title.click();
        const inlineTitleInput = page.getByTestId('session-header-title-input');
        await expect(inlineTitleInput).toBeVisible();
        await expect(inlineTitleInput).toBeFocused();
        await expect(inlineTitleInput).toHaveValue('Refine title editing and zen mode');
    }
    await pauseForRecordedReview(page);
    await captureCase(page, testInfo, 1);
    if (evidencePhase === 'before') {
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    } else {
        await page.keyboard.press('Escape');
    }

    if (evidencePhase === 'before') {
        const agentChip = page.locator('[data-testid="session-header-chip"]:visible');
        await expect(agentChip).toBeVisible();
        await agentChip.click();
    } else {
        await expect(page.getByTestId('session-header-chip')).toHaveCount(0);
        await page.locator('[data-testid="session-header-more-button"]:visible').click();
    }
    await expect(page.getByTestId('session-agent-panel')).toBeVisible();
    await pauseForRecordedReview(page);
    await captureCase(page, testInfo, 2);

    await page.goto(authenticatedRoute('/new'));
    await expect(page.getByRole('textbox')).toBeVisible();
    const modelChip = page.locator('[data-testid="compose-home-model-chip"]:visible');
    await expect(modelChip).toBeVisible();
    if (evidencePhase === 'before') {
        await expect(page.getByTestId('new-session-composer-controls')).toHaveCount(0);
    } else {
        await expect(page.locator('[data-testid="new-session-composer-controls"]:visible')).toBeVisible();
    }
    await pauseForRecordedReview(page);
    await captureCase(page, testInfo, 3);

    const zenButton = page.getByTestId('desktop-navigation-zen-button');
    if (await zenButton.getAttribute('aria-selected') === 'true') {
        await zenButton.click();
    }
    const initialZenGlyph = await zenButton.textContent();
    const initialZenIcon = page.getByTestId('desktop-navigation-zen-icon');
    const initialIconColor = evidencePhase === 'after'
        ? await initialZenIcon.evaluate(element => window.getComputedStyle(element).color)
        : null;

    await zenButton.click();
    await expect(zenButton).toHaveAttribute('aria-selected', 'true');
    if (evidencePhase === 'before') {
        expect(await zenButton.textContent()).not.toBe(initialZenGlyph);
    } else {
        const selectedZenIcon = page.getByTestId('desktop-navigation-zen-icon');
        await expect(selectedZenIcon).toHaveAttribute('data-icon-name', 'leaf-outline');
        expect(await selectedZenIcon.evaluate(element => window.getComputedStyle(element).color)).toBe(initialIconColor);
        expect(await zenButton.textContent()).toBe(initialZenGlyph);
        await expect(page.locator('[data-testid="new-session-composer-controls"]:visible')).toBeVisible();
    }
    await pauseForRecordedReview(page);
    await captureCase(page, testInfo, 4);

    if (evidencePhase === 'after') {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(authenticatedRoute('/new'));
        await expect(page.locator('[data-testid="new-session-composer-controls"]:visible')).toHaveCount(0);
        const mobileModelChip = page.locator('[data-testid="compose-home-model-chip"]:visible');
        await expect(mobileModelChip).toBeVisible();
        await mobileModelChip.click();
        await expect(page.getByTestId('compose-home-config-panel')).toBeVisible();

        await page.goto(authenticatedRoute(`/session/${sessionId}`));
        const mobileSessionChip = page.locator('[data-testid="session-header-chip"]:visible');
        await expect(mobileSessionChip).toBeVisible();
        await mobileSessionChip.click();
        await expect(page.getByTestId('session-agent-panel')).toBeVisible();
    }
});
