import { expect, test } from '@playwright/test';
import {
    centerMcpAppFrame,
    findMcpAppFrames,
    findMcpAppFramesForView,
    injectUnexpectedSourceMessage,
    requireMcpAppE2eEnvironment,
    saveMcpAppEvidence,
    sessionUrl,
} from './helpers/mcpAppHarness';

const environment = requireMcpAppE2eEnvironment();
// Playwright traces retain request headers/storage. This authenticated evidence
// spec records screenshots and video only; action traces are intentionally off.
test.use({ storageState: environment.storageState, trace: 'off' });

test.describe.serial('MCP App real-origin Web Host', () => {
    test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto(sessionUrl(environment), { waitUntil: 'domcontentloaded' });
        await expect.poll(() => page.getByTestId('mcp-app-content').count(), { timeout: 30_000 })
            .toBeGreaterThanOrEqual(4);
    });

    test('[MCP-WEB-001] renders a read-only App on the sandbox origin', async ({ page }, testInfo) => {
        const { proxy, view } = await findMcpAppFrames(page, environment.sandboxOrigin, environment.webOrigin);
        expect(new URL(proxy.url()).origin).toBe(environment.sandboxOrigin);
        expect(new URL(proxy.url()).origin).not.toBe(new URL(page.url()).origin);
        await expect(view.locator('[data-testid="mcp-example-root"]')).toHaveCount(1);
        await expect(view.getByTestId('readiness-title')).toHaveText('Paws MCP Apps Host E2E');
        await expect(view.getByTestId('readiness-score')).toContainText('4 / 4');
        await saveMcpAppEvidence(page, testInfo, 'mcp-web-001-success.png');
    });

    test('[MCP-WEB-002] blocks parent DOM and cookie access', async ({ page }, testInfo) => {
        const { view } = await findMcpAppFrames(page, environment.sandboxOrigin, environment.webOrigin);
        const access = await view.evaluate(() => {
            try {
                void window.top!.document.cookie;
                return 'accessible';
            } catch (error) {
                return error instanceof DOMException ? error.name : 'unexpected-error';
            }
        });
        expect(access).toBe('SecurityError');
        await saveMcpAppEvidence(page, testInfo, 'mcp-web-002-isolation.png');
    });

    test('[MCP-WEB-003] rejects a forged Proxy message', async ({ page }, testInfo) => {
        const { proxy, view } = await findMcpAppFrames(page, environment.sandboxOrigin, environment.webOrigin);
        const proxyUrl = proxy.url();
        const viewUrl = view.url();
        await injectUnexpectedSourceMessage(page, environment.sandboxOrigin);
        expect(page.frames()).toContain(proxy);
        expect(page.frames()).toContain(view);
        expect(proxy.url()).toBe(proxyUrl);
        expect(view.url()).toBe(viewUrl);
        expect(view.parentFrame()).toBe(proxy);
        await expect(view.locator('[data-testid="mcp-example-root"]')).toHaveCount(1);
        await expect(page.getByTestId('mcp-app-content').first()).toBeVisible();
        await expect(page.getByTestId('mcp-app-error')).toHaveCount(0);
        await saveMcpAppEvidence(page, testInfo, 'mcp-web-003-forged-source-stable.png');
    });

    test('[MCP-WEB-004] mediates an App tool call and teardown', async ({ page }, testInfo) => {
        const { view } = await findMcpAppFrames(page, environment.sandboxOrigin, environment.webOrigin);
        await view.getByTestId('mcp-example-tool-call').click();
        await expect(view.getByTestId('mcp-example-tool-result')).toHaveText('approved');
        await saveMcpAppEvidence(page, testInfo, 'mcp-web-004-interaction.png');
        const home = new URL('/', environment.authenticatedWebUrl).toString();
        await page.goto(home, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('[data-testid="mcp-app-sandbox-frame"]')).toHaveCount(0);
    });

    test('[MCP-WEB-005] keeps the tool card when the sandbox is unavailable', async ({ page }, testInfo) => {
        test.setTimeout(120_000);
        await page.route(`${environment.sandboxOrigin}/mcp-app-sandbox/host?*`, (route) => route.fulfill({
            status: 503,
            contentType: 'text/plain',
            body: 'sandbox unavailable',
        }));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect.poll(async () => {
            const hosts = page.getByTestId('mcp-app-content');
            const count = await hosts.count();
            if (count < 4) return false;
            const latest = [0, 1, 2, 3];
            const states = await Promise.all(latest.map(async (index) => ({
                errors: await hosts.nth(index).getByTestId('mcp-app-error').count(),
                frames: await hosts.nth(index).locator('[data-testid="mcp-app-sandbox-frame"]').count(),
            })));
            return states.every((state) => state.errors === 1 && state.frames === 0);
        }, { timeout: 90_000 }).toBe(true);
        await saveMcpAppEvidence(page, testInfo, 'mcp-web-005-fallback.png');
    });

    test('[MCP-WEB-006] filters and inspects a horizontal service catalog', async ({ page }, testInfo) => {
        const { view } = await findMcpAppFramesForView(
            page, environment.sandboxOrigin, environment.webOrigin, 'mcp-catalog-root',
        );
        const rail = view.getByTestId('service-catalog-rail');
        const dimensions = await rail.evaluate((node) => ({
            clientWidth: node.clientWidth,
            scrollWidth: node.scrollWidth,
        }));
        expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
        await saveMcpAppEvidence(page, testInfo, 'mcp-web-006-service-catalog-before.png');
        const before = await rail.evaluate((node) => node.scrollLeft);
        await view.getByTestId('service-catalog-next').click();
        await expect.poll(() => rail.evaluate((node) => node.scrollLeft)).toBeGreaterThan(before);

        await view.getByTestId('service-filter-attention').click();
        await expect(view.locator('[data-testid-group="service-card"]')).toHaveCount(2);
        await view.getByTestId('service-card-sync').click();
        await expect(view.getByTestId('service-detail-name')).toHaveText('Sync Engine');
        await view.getByTestId('service-health-action').click();
        await expect(view.getByTestId('service-health-result')).toHaveText('passed');
        await saveMcpAppEvidence(page, testInfo, 'mcp-web-006-service-catalog.png');
    });

    test('[MCP-WEB-007] filters, expands and confirms an incident runbook', async ({ page }, testInfo) => {
        const { proxy, view } = await findMcpAppFramesForView(
            page, environment.sandboxOrigin, environment.webOrigin, 'mcp-incident-root',
        );
        await saveMcpAppEvidence(page, testInfo, 'mcp-web-007-incident-board-before.png');
        await view.getByTestId('incident-filter-critical').click();
        await expect(view.locator('[data-testid="incident-row"]')).toHaveCount(1);
        await centerMcpAppFrame(page, proxy);
        await view.getByTestId('incident-toggle-inc-1042').click();
        await expect(view.getByTestId('incident-runbook-inc-1042')).toBeVisible();
        await expect(view.getByTestId('incident-runbook-inc-1042').getByRole('listitem')).toHaveCount(2);
        await centerMcpAppFrame(page, proxy);
        await view.getByTestId('incident-confirm-action').click();
        await expect(view.getByTestId('incident-confirm-result')).toHaveText('confirmed');
        await saveMcpAppEvidence(page, testInfo, 'mcp-web-007-incident-board.png');
    });

    test('[MCP-WEB-008] configures and previews a multi-step deployment plan', async ({ page }, testInfo) => {
        const { view } = await findMcpAppFramesForView(
            page, environment.sandboxOrigin, environment.webOrigin, 'mcp-deployment-root',
        );
        await saveMcpAppEvidence(page, testInfo, 'mcp-web-008-deployment-planner-before.png');
        await view.getByTestId('deployment-environment-production').click();
        await view.getByTestId('deployment-step-notify').click();
        await expect(view.getByTestId('deployment-summary')).toHaveText('Production · 3 steps · Elevated risk');
        await view.getByTestId('deployment-preview-action').click();
        await expect(view.getByTestId('deployment-environment-production')).toBeDisabled();
        await expect(view.getByTestId('deployment-step-notify')).toBeDisabled();
        await expect(view.getByTestId('deployment-preview-result')).toHaveText('plan-production-3 · ready');
        await expect(view.getByTestId('deployment-environment-production')).toBeEnabled();
        await expect(view.getByTestId('deployment-step-notify')).toBeEnabled();
        await saveMcpAppEvidence(page, testInfo, 'mcp-web-008-deployment-planner.png');
    });

    test('[MCP-WEB-009] keeps every complex App usable at a narrow mobile viewport', async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 430, height: 932 });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect.poll(() => page.getByTestId('mcp-app-content').count(), { timeout: 30_000 })
            .toBeGreaterThanOrEqual(4);

        for (const rootTestId of ['mcp-catalog-root', 'mcp-incident-root', 'mcp-deployment-root']) {
            const { view } = await findMcpAppFramesForView(
                page, environment.sandboxOrigin, environment.webOrigin, rootTestId, 'mounted',
            );
            const overflow = await view.locator(`[data-testid="${rootTestId}"]`).evaluate((node) => ({
                clientWidth: node.clientWidth,
                scrollWidth: node.scrollWidth,
            }));
            expect(overflow.scrollWidth).toBe(overflow.clientWidth);
        }

        const { view: catalog } = await findMcpAppFramesForView(
            page, environment.sandboxOrigin, environment.webOrigin, 'mcp-catalog-root', 'mounted',
        );
        await saveMcpAppEvidence(page, testInfo, 'mcp-web-009-mobile-responsive-before.png');
        await catalog.getByTestId('service-filter-attention').click();
        await expect(catalog.getByTestId('service-filter-attention')).toHaveAttribute('aria-pressed', 'true');
        await expect(catalog.locator('[data-testid-group="service-card"]')).toHaveCount(2);
        await expect(catalog.locator('[data-testid-group="service-card"]').first()).toContainText('Sync Engine');
        await catalog.evaluate(() => new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        await saveMcpAppEvidence(page, testInfo, 'mcp-web-009-mobile-responsive.png');
    });
});
