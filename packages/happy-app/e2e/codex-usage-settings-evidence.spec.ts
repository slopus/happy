import { expect, test, type APIRequestContext, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { encodeBase64, encryptLegacy } from '../../happy-cli/src/api/encryption';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const e2eServerUrl = process.env.HAPPY_E2E_SERVER_URL!;
const evidenceDirectory = process.env.HAPPY_CODEX_USAGE_EVIDENCE_DIR;
const evidencePhase = process.env.HAPPY_CODEX_USAGE_EVIDENCE_PHASE === 'before' ? 'before' : 'after';

function evidencePath(testInfo: TestInfo, caseId: 1 | 2): string {
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

test('[CODEX-USAGE-EVIDENCE] quota and activity presentation', async ({ page, request }, testInfo) => {
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
        await page.setViewportSize({ width: 1280, height: 900 });
        const usageUrl = new URL('/settings/usage', authenticatedWebUrl);
        usageUrl.search = new URL(authenticatedWebUrl).search;
        await page.goto(usageUrl.toString());
        await expect.poll(() => page.locator('body').evaluate((element) => (
            window.getComputedStyle(element).backgroundColor
        ))).toBe('rgb(18, 24, 33)');
        if (evidencePhase === 'after') {
            await expect(page.getByText('Codex Usage', { exact: true })).toBeVisible({ timeout: 30_000 });
            await expect(page.getByText('63%', { exact: true })).toBeVisible();
            await expect(page.getByText('Activity (Last 14 Days)', { exact: true })).toBeVisible();
        } else {
            await expect(page.getByRole('tab', { name: 'Last 7 days' })).toBeVisible({ timeout: 30_000 });
            await expect(page.getByText('Codex Usage', { exact: true })).toHaveCount(0);
            await expect(page.getByText('No usage data available', { exact: true })).toBeVisible();
        }

        await page.screenshot({ path: evidencePath(testInfo, 1), fullPage: true });

        if (evidencePhase === 'after') {
            const activeDay = page.getByTestId('codex-usage-day-2026-08-27');
            await activeDay.click();
            await expect(page.getByText('2026-08-27: 1.12M tokens · 14 sessions', { exact: true })).toBeVisible();
            await expect(activeDay).toHaveCSS('background-color', 'rgb(40, 53, 68)');
            const pressedDay = page.getByTestId('codex-usage-day-2026-08-29');
            await pressedDay.hover();
            await page.mouse.down();
            await expect(pressedDay).toHaveCSS('background-color', 'rgb(31, 42, 56)');
        }
        await page.screenshot({ path: evidencePath(testInfo, 2), fullPage: true });
        if (evidencePhase === 'after') {
            await page.mouse.up();
        }
    } finally {
        await deleteMachine();
    }
});
