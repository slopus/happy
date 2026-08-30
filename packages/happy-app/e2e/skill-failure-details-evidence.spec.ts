import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const authenticatedWebUrl = process.env.HAPPY_E2E_WEB_URL!;
const evidenceDirectory = process.env.HAPPY_SKILL_FAILURE_EVIDENCE_DIR;

function evidencePath(testInfo: TestInfo, state: 'collapsed' | 'expanded'): string {
    const filename = `after-${state}.png`;
    if (!evidenceDirectory) {
        return testInfo.outputPath(filename);
    }
    mkdirSync(evidenceDirectory, { recursive: true });
    return path.join(evidenceDirectory, filename);
}

async function paceRecordedReview(page: Page, duration = 900): Promise<void> {
    if (process.env.HAPPY_E2E_RECORD === '1') {
        await page.waitForTimeout(duration);
    }
}

test.use({ locale: 'zh-CN' });

test('[SKILL-FAILURE-DETAILS] failure summary is visible and diagnostic detail expands on demand', async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on('console', (message) => {
        if (message.type() === 'error') {
            consoleErrors.push(message.text());
        }
    });
    page.on('response', (response) => {
        if (!response.ok() && ['fetch', 'xhr'].includes(response.request().resourceType())) {
            failedRequests.push(`${response.request().resourceType()}:${response.status()}`);
        }
    });

    const url = new URL(authenticatedWebUrl);
    url.pathname = '/dev/messages-demo';
    url.searchParams.set('demo', 'activity-status');
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(url.toString());

    const collapsedSkill = page.getByRole('button', { name: '查看技能失败详情：gpt-image-2' });
    await expect(collapsedSkill).toBeVisible({ timeout: 45_000 });
    await expect(collapsedSkill).toHaveAttribute('aria-expanded', 'false');
    await expect(collapsedSkill).toContainText('失败');
    await expect(collapsedSkill).toContainText('Skill file was not found.');
    await expect(collapsedSkill).not.toContainText('No such file or directory');
    const implementationAgent = page.getByText('Implementation agent', { exact: true });
    await expect(implementationAgent).toBeVisible();
    expect(await implementationAgent.evaluate((element) => getComputedStyle(element.parentElement!).flexDirection)).toBe('row');
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
    await page.screenshot({ path: evidencePath(testInfo, 'collapsed') });
    await paceRecordedReview(page);

    await collapsedSkill.click();
    const expandedSkill = page.getByRole('button', { name: '收起技能失败详情：gpt-image-2' });
    await expect(expandedSkill).toHaveAttribute('aria-expanded', 'true');
    await expect(expandedSkill).toContainText('sed: /plugins/gpt-image-2/SKILL.md: No such file or directory');
    await page.screenshot({ path: evidencePath(testInfo, 'expanded') });
    await paceRecordedReview(page, 1_200);

    expect(consoleErrors.filter((error) => error !== 'Failed to load resource: net::ERR_CONNECTION_REFUSED')).toEqual([]);
    expect(failedRequests).toEqual([]);
});
