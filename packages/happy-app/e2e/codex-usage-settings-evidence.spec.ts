import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { encodeBase64, encryptLegacy } from '../../happy-cli/src/api/encryption';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const e2eServerUrl = process.env.HAPPY_E2E_SERVER_URL!;
const evidenceDirectory = process.env.HAPPY_CODEX_USAGE_EVIDENCE_DIR;
const evidencePhase = process.env.HAPPY_CODEX_USAGE_EVIDENCE_PHASE === 'before' ? 'before' : 'after';

async function holdForEvidence(page: Page): Promise<void> {
    if (process.env.HAPPY_E2E_RECORD === '1') {
        await page.waitForTimeout(900);
    }
}

function evidencePath(testInfo: TestInfo, caseId: 1 | 2 | 3): string {
    const filename = `case-${caseId}-${evidencePhase}.png`;
    if (!evidenceDirectory) return testInfo.outputPath(filename);
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    return path.join(evidenceDirectory, filename);
}

function authContext(): { headers: Record<string, string>; encryptionKey: Uint8Array } {
    const url = new URL(authenticatedWebUrl);
    const token = url.searchParams.get('dev_token');
    const secret = url.searchParams.get('dev_secret');
    if (!token || !secret || !e2eServerUrl) {
        throw new Error('Missing local E2E authentication configuration.');
    }
    return {
        encryptionKey: new Uint8Array(Buffer.from(secret, 'base64url')),
        headers: {
            Authorization: `Bearer ${token}`,
            'X-Happy-Client': 'playwright-codex-usage-evidence',
        },
    };
}

function usageDay(date: string, totalTokens: number, sessions: number) {
    return {
        date,
        inputTokens: Math.round(totalTokens * 0.58),
        cachedInputTokens: Math.round(totalTokens * 0.21),
        outputTokens: Math.round(totalTokens * 0.16),
        reasoningOutputTokens: Math.round(totalTokens * 0.05),
        totalTokens,
        tokenCountEvents: sessions * 3,
        sessions,
        totalOnlyTokens: 0,
    };
}

async function registerUsageMachine(request: APIRequestContext): Promise<() => Promise<void>> {
    const { encryptionKey, headers } = authContext();
    const machineId = `codex-usage-evidence-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const metadata = encodeBase64(encryptLegacy({
        host: 'studio-mac',
        platform: 'darwin',
        happyCliVersion: '0.0.0-e2e',
        happyHomeDir: '/tmp/.happy',
        homeDir: '/tmp',
    }, encryptionKey));
    const daemonState = encodeBase64(encryptLegacy({
        codexUsage: {
            source: 'codex-session-jsonl',
            scannedAt: Date.parse('2026-08-31T11:20:00.000Z'),
            timeZone: 'Asia/Shanghai',
            days: [
                usageDay('2025-09-01', 42_700, 1),
                usageDay('2025-10-14', 214_900, 4),
                usageDay('2025-12-03', 586_200, 8),
                usageDay('2026-02-17', 76_400, 2),
                usageDay('2026-04-09', 428_100, 6),
                usageDay('2026-06-21', 972_300, 13),
                usageDay('2026-08-18', 148_300, 3),
                usageDay('2026-08-20', 392_800, 7),
                usageDay('2026-08-22', 89_400, 2),
                usageDay('2026-08-24', 744_200, 11),
                usageDay('2026-08-25', 258_900, 5),
                usageDay('2026-08-27', 1_120_600, 14),
                usageDay('2026-08-29', 536_700, 8),
                usageDay('2026-08-30', 901_400, 12),
                usageDay('2026-08-31', 617_200, 9),
            ],
            latestEvent: {
                timestamp: '2026-08-31T11:18:00.000Z',
                rateLimitsTimestamp: '2026-08-31T11:18:00.000Z',
                rateLimits: {
                    planType: 'plus',
                    primary: { usedPercent: 37, windowMinutes: 300, resetsAt: 1788170400 },
                    secondary: { usedPercent: 62, windowMinutes: 10_080, resetsAt: 1788649200 },
                },
            },
        },
    }, encryptionKey));
    const response = await request.post(new URL('/v1/machines', e2eServerUrl).toString(), {
        data: { id: machineId, metadata, daemonState, dataEncryptionKey: null },
        headers,
    });
    expect(response.ok()).toBe(true);
    return async () => {
        const deletion = await request.delete(
            new URL(`/v1/machines/${encodeURIComponent(machineId)}`, e2eServerUrl).toString(),
            { headers },
        );
        expect(deletion.ok() || deletion.status() === 404).toBe(true);
    };
}

test('[CU-YEAR-01][CU-YEAR-03] annual desktop heatmap and day selection', async ({ page, request }, testInfo) => {
    test.setTimeout(240_000);
    const deleteMachine = await registerUsageMachine(request);
    try {
        await page.addInitScript(() => {
            window.localStorage.setItem(
                'mmkv.default\\local-settings',
                JSON.stringify({ themePreference: 'dark', themePack: 'gingham' }),
            );
        });
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.setViewportSize({ width: 1280, height: 900 });
        const usageUrl = new URL('/settings/usage', authenticatedWebUrl);
        usageUrl.search = new URL(authenticatedWebUrl).search;
        await page.goto(usageUrl.toString());
        await expect.poll(() => page.locator('body').evaluate((element) => (
            window.getComputedStyle(element).backgroundColor
        ))).toBe('rgb(18, 24, 33)');
        if (evidencePhase === 'after') {
            await expect(page.getByText('Codex Usage', { exact: true })).toBeVisible({ timeout: 120_000 });
            await expect(page.getByText('63%', { exact: true })).toBeVisible();
            await expect(page.getByText('Activity Over the Past Year', { exact: true })).toBeVisible();
            await expect(page.locator('[data-testid^="codex-usage-day-"]')).toHaveCount(365);
            await expect(page.locator('[data-testid^="codex-usage-week-"]')).toHaveCount(53);
            await expect(page.locator('[data-testid^="codex-usage-month-"]')).toHaveCount(12);
        } else {
            await expect(page.getByRole('tab', { name: 'Last 7 days' })).toBeVisible({ timeout: 30_000 });
            await expect(page.getByText('Codex Usage', { exact: true })).toHaveCount(0);
            await expect(page.getByText('No usage data available', { exact: true })).toBeVisible();
        }

        await holdForEvidence(page);
        await page.screenshot({ path: evidencePath(testInfo, 1), fullPage: true });

        if (evidencePhase === 'after') {
            const activeDay = page.getByTestId('codex-usage-day-2026-08-27');
            await activeDay.click();
            await expect(page.getByText('2026-08-27: 1.12M tokens · 14 sessions', { exact: true })).toBeVisible();
            await expect(activeDay).toHaveCSS('background-color', 'rgb(40, 53, 68)');
            await holdForEvidence(page);
            const pressedDay = page.getByTestId('codex-usage-day-2026-08-29');
            await pressedDay.hover();
            await page.mouse.down();
            await expect(pressedDay).toHaveCSS('background-color', 'rgb(31, 42, 56)');
            await holdForEvidence(page);
        }
        await page.screenshot({ path: evidencePath(testInfo, 2), fullPage: true });
        if (evidencePhase === 'after') {
            await page.mouse.up();
        }
    } finally {
        await deleteMachine();
    }
});

test('[CU-YEAR-02] narrow viewport starts at latest and can browse backward', async ({ page, request }, testInfo) => {
    test.setTimeout(120_000);
    const deleteMachine = await registerUsageMachine(request);
    try {
        await page.addInitScript(() => {
            window.localStorage.setItem(
                'mmkv.default\\local-settings',
                JSON.stringify({ themePreference: 'dark', themePack: 'gingham' }),
            );
        });
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.setViewportSize({ width: 390, height: 844 });
        const usageUrl = new URL('/settings/usage', authenticatedWebUrl);
        usageUrl.search = new URL(authenticatedWebUrl).search;
        await page.goto(usageUrl.toString());

        await expect(page.getByText('Activity Over the Past Year', { exact: true })).toBeVisible({ timeout: 30_000 });
        const heatmapScroll = page.getByTestId('codex-usage-heatmap-scroll');
        const latestDay = page.getByTestId('codex-usage-day-2026-08-31');
        await expect(heatmapScroll).toBeVisible();
        const scrollMetrics = await heatmapScroll.evaluate((element) => ({
            clientWidth: element.clientWidth,
            scrollLeft: element.scrollLeft,
            scrollWidth: element.scrollWidth,
        }));
        expect(scrollMetrics.scrollWidth).toBeGreaterThan(scrollMetrics.clientWidth);
        const latestPosition = await latestDay.boundingBox();
        const scrollPosition = await heatmapScroll.boundingBox();
        expect(latestPosition).not.toBeNull();
        expect(scrollPosition).not.toBeNull();
        expect(latestPosition!.x + latestPosition!.width).toBeLessThanOrEqual(scrollPosition!.x + scrollPosition!.width + 1);
        expect(await heatmapScroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

        await holdForEvidence(page);
        await page.screenshot({ path: evidencePath(testInfo, 3), fullPage: true });

        await heatmapScroll.evaluate((element) => element.scrollTo({ left: 0, behavior: 'instant' }));
        await expect.poll(() => heatmapScroll.evaluate((element) => element.scrollLeft)).toBe(0);
        await holdForEvidence(page);
        const firstDay = page.getByTestId('codex-usage-day-2025-09-01');
        await firstDay.click();
        await expect(page.getByText('2025-09-01: 42.7K tokens · 1 sessions', { exact: true })).toBeVisible();
        await expect(firstDay).toHaveCSS('background-color', 'rgb(40, 53, 68)');
        await holdForEvidence(page);
    } finally {
        await deleteMachine();
    }
});
