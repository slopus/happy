import { expect, type Frame, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export type McpAppE2eEnvironment = {
    authenticatedWebUrl: string;
    webOrigin: string;
    sandboxOrigin: string;
    sessionId: string;
    storageState: string;
};

export type McpAppFrames = { proxy: Frame; view: Frame };

export async function centerMcpAppFrame(page: Page, proxy: Frame): Promise<void> {
    const outer = await proxy.frameElement();
    await outer.evaluate((element) => (element as HTMLElement).scrollIntoView({ block: 'center', inline: 'nearest' }));
    let previous = '';
    let stableSamples = 0;
    await expect.poll(async () => {
        const box = await outer.boundingBox();
        const signature = box
            ? `${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(box.width)}:${Math.round(box.height)}`
            : 'detached';
        stableSamples = signature === previous ? stableSamples + 1 : 0;
        previous = signature;
        return stableSamples;
    }, {
        timeout: 5_000,
        intervals: [100, 150, 250],
        message: 'expected the MCP App frame geometry to settle before pointer interaction',
    }).toBeGreaterThanOrEqual(2);
}

function requiredEnvironment(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required ${name} for MCP App real-origin E2E`);
    return value;
}

function exactOrigin(raw: string, label: string): string {
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error(`${label} must be an absolute URL`); }
    const loopbackHttp = url.protocol === 'http:'
        && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !loopbackHttp) || url.username || url.password || !url.hostname) {
        throw new Error(`${label} must be an HTTP(S) URL without credentials`);
    }
    return url.origin;
}

export function requireMcpAppE2eEnvironment(): McpAppE2eEnvironment {
    const authenticatedWebUrl = requiredEnvironment('HAPPY_E2E_WEB_URL');
    const sandboxRaw = requiredEnvironment('HAPPY_MCP_APP_SANDBOX_ORIGIN');
    const sessionId = requiredEnvironment('HAPPY_MCP_APP_E2E_SESSION_ID');
    const storageState = path.resolve(requiredEnvironment('HAPPY_E2E_STORAGE_STATE'));
    const webOrigin = exactOrigin(authenticatedWebUrl, 'HAPPY_E2E_WEB_URL');
    const sandboxOrigin = exactOrigin(sandboxRaw, 'HAPPY_MCP_APP_SANDBOX_ORIGIN');
    const webUrl = new URL(authenticatedWebUrl);
    if (webUrl.search || webUrl.hash) throw new Error('HAPPY_E2E_WEB_URL must not contain query authentication or a fragment');
    if (sandboxRaw !== sandboxOrigin && sandboxRaw !== `${sandboxOrigin}/`) {
        throw new Error('HAPPY_MCP_APP_SANDBOX_ORIGIN must be an exact origin');
    }
    if (sandboxOrigin === webOrigin) throw new Error('MCP App sandbox origin must differ from the Paws Web origin');
    if (!/^[A-Za-z0-9_-]{1,256}$/u.test(sessionId)) throw new Error('HAPPY_MCP_APP_E2E_SESSION_ID is invalid');
    const state = fs.statSync(storageState, { throwIfNoEntry: false });
    if (!state?.isFile() || (state.mode & 0o077) !== 0) throw new Error('HAPPY_E2E_STORAGE_STATE must be a protected 0600 file');
    return { authenticatedWebUrl, webOrigin, sandboxOrigin, sessionId, storageState };
}

export function sessionUrl(environment: McpAppE2eEnvironment): string {
    const url = new URL(environment.authenticatedWebUrl);
    url.pathname = `/session/${encodeURIComponent(environment.sessionId)}`;
    return url.toString();
}

export async function findMcpAppFramesForView(
    page: Page,
    sandboxOrigin: string,
    webOrigin: string,
    rootTestId: string,
    scope: 'latest-fixture' | 'mounted' = 'latest-fixture',
): Promise<McpAppFrames> {
    expect(new URL(page.url()).origin).toBe(webOrigin);
    // The session timeline is an inverted virtual list: the newest messages
    // occupy the first DOM positions, and this fixture's tool calls therefore
    // appear in reverse invocation order.
    const fixturePosition = {
        'mcp-deployment-root': 0,
        'mcp-incident-root': 1,
        'mcp-catalog-root': 2,
        'mcp-example-root': 3,
    }[rootTestId];
    if (fixturePosition === undefined) throw new Error(`Unknown fixture root: ${rootTestId}`);
    let result: McpAppFrames | undefined;
    let mountedScanStep = 0;
    const mountedScanRatios = [0.2, 0.4, 0.6, 0.8, 1, 0] as const;
    await expect.poll(async () => {
        if (scope === 'mounted') {
            for (const proxy of page.frames()) {
                try {
                    if (new URL(proxy.url()).origin !== sandboxOrigin
                        || proxy.parentFrame() !== page.mainFrame()) continue;
                } catch {
                    continue;
                }
                const children = proxy.childFrames();
                if (children.length !== 1) continue;
                if (await children[0].locator(`[data-testid="${rootTestId}"]`).count() === 1) {
                    result = { proxy, view: children[0] };
                    return true;
                }
            }
            // At a narrow viewport the inverted virtual list can create the
            // outer Proxy iframe before mounting its owned srcdoc child. Move
            // through deterministic transcript positions so each virtualized
            // tool card gets a chance to finish mounting before the next poll.
            const ratio = mountedScanRatios[mountedScanStep % mountedScanRatios.length];
            mountedScanStep += 1;
            const transcript = page.getByTestId('conversation-transcript-list');
            if (await transcript.count() === 1) {
                await transcript.evaluate((element, nextRatio) => {
                    const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
                    element.scrollTop = Math.round(maximum * nextRatio);
                }, ratio);
            }
            return false;
        }
        const hosts = page.getByTestId('mcp-app-content');
        const hostCount = await hosts.count();
        if (hostCount < 4) return false;
        const host = hosts.nth(fixturePosition);
        // React Native Web's inverted virtual list uses transforms, which can
        // fool Playwright's visibility-based scrollIntoViewIfNeeded(). Force a
        // DOM scroll so the requested newest card mounts at narrow widths.
        await host.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
        const outer = await host
            .locator('iframe[data-testid="mcp-app-sandbox-frame"]')
            .elementHandle();
        const proxy = await outer?.contentFrame();
        if (!proxy) return false;
        try {
            if (new URL(proxy.url()).origin !== sandboxOrigin
                || proxy.parentFrame() !== page.mainFrame()) return false;
        } catch {
            return false;
        }
        const children = proxy.childFrames();
        // Chromium may expose a sandboxed srcdoc frame as either about:srcdoc
        // or an empty URL. Its opaque origin is verified below in-frame.
        if (children.length !== 1) return false;
        if (await children[0].locator(`[data-testid="${rootTestId}"]`).count() === 1) {
            result = { proxy, view: children[0] };
            return true;
        }
        return false;
    }, { timeout: 30_000, message: `expected an exact-origin Proxy containing ${rootTestId}` }).toBe(true);

    const outer = await result!.proxy.frameElement();
    const src = await outer.getAttribute('src');
    expect(src && new URL(src).origin).toBe(sandboxOrigin);
    expect(await outer.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    expect(await outer.getAttribute('referrerpolicy')).toBe('origin');

    const proxyState = await result!.proxy.evaluate(() => ({
        origin: window.location.origin,
        referrer: document.referrer,
        innerCount: document.querySelectorAll('iframe').length,
    }));
    expect(proxyState.origin).toBe(sandboxOrigin);
    expect(new URL(proxyState.referrer).origin).toBe(webOrigin);
    expect(proxyState.innerCount).toBe(1);
    const inner = result!.proxy.locator('iframe');
    await expect(inner).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(inner).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(await inner.getAttribute('srcdoc')).toBeTruthy();
    expect(await result!.view.evaluate(() => window.origin)).toBe('null');
    // The session timeline opens anchored to its newest message. Center the
    // owned outer frame before pointer interaction so a card above the fold
    // cannot be clicked through stale cross-frame coordinates while it resizes.
    await centerMcpAppFrame(page, result!.proxy);
    return result!;
}

export async function findMcpAppFrames(page: Page, sandboxOrigin: string, webOrigin: string): Promise<McpAppFrames> {
    return findMcpAppFramesForView(page, sandboxOrigin, webOrigin, 'mcp-example-root');
}

export async function injectUnexpectedSourceMessage(page: Page, sandboxOrigin: string): Promise<void> {
    const attackerName = 'mcp-app-unexpected-source';
    await page.evaluate(({ attackerName }) => {
        document.querySelector(`iframe[name="${attackerName}"]`)?.remove();
        const attacker = document.createElement('iframe');
        attacker.name = attackerName;
        attacker.hidden = true;
        attacker.srcdoc = '<!doctype html><title>unexpected source</title>';
        document.body.append(attacker);
    }, { attackerName });
    try {
        let attacker: Frame | undefined;
        await expect.poll(() => {
            attacker = page.frames().find((frame) => frame.name() === attackerName);
            return Boolean(attacker);
        }, { message: 'unexpected-source attacker frame did not load' }).toBe(true);
        await attacker!.evaluate(({ sandboxOrigin }) => {
            const target = parent.document.querySelector<HTMLIFrameElement>('iframe[data-testid="mcp-app-sandbox-frame"]')?.contentWindow;
            if (!target) throw new Error('MCP App Proxy WindowProxy is unavailable');
            target.postMessage(JSON.stringify({
                type: 'sandbox-proxy-ready',
                parentOrigin: parent.location.origin,
            }), sandboxOrigin);
            return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        }, { sandboxOrigin });
        await page.waitForTimeout(100);
    } finally {
        await page.evaluate(({ attackerName }) => {
            document.querySelector(`iframe[name="${attackerName}"]`)?.remove();
        }, { attackerName });
    }
}

export async function saveMcpAppEvidence(page: Page, testInfo: TestInfo, filename: string): Promise<void> {
    const configured = process.env.HAPPY_MCP_APP_EVIDENCE_DIR;
    const target = configured
        ? path.join(path.resolve(configured), filename)
        : testInfo.outputPath(filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await page.screenshot({ path: target, fullPage: true });
}
