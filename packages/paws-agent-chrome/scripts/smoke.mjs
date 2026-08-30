import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const extensionDir = resolve('dist');
const executablePath = await resolveBrowserExecutable();
const manifest = JSON.parse(await readFile(join(extensionDir, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3 || !manifest.content_scripts?.[0]?.js?.includes('content.js')) {
    throw new Error('Built extension manifest is incomplete');
}
if (manifest.host_permissions?.some(permission => /localhost|127\.0\.0\.1/.test(permission))) {
    throw new Error('Production extension manifest must not expose localhost host permissions');
}

const server = createServer(async (request, response) => {
    const path = request.url === '/' ? null : request.url?.replace(/^\//, '').split('?')[0];
    if (!path) {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end('<!doctype html><title>Extension fixture</title><main><h1>Broken checkout</h1><p id="issue">Payment failed with code 42</p></main><script src="/content.js"></script>');
        return;
    }
    try {
        const content = await readFile(join(extensionDir, path));
        const type = extname(path) === '.js' ? 'text/javascript' : extname(path) === '.css' ? 'text/css' : 'text/html';
        response.setHeader('content-type', `${type}; charset=utf-8`);
        response.end(content);
    } catch {
        response.statusCode = 404;
        response.end('not found');
    }
});
let browser;
try {
    await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server did not bind');
    const origin = `http://127.0.0.1:${address.port}`;

    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript(testOrigin => {
        const values = new Map();
        const chromeApi = window.chrome ?? {};
        chromeApi.runtime = { id: 'paws-agent-test', getURL: path => `${testOrigin}/${path}` };
        chromeApi.storage = {
            local: {
                async get(key) { return { [key]: values.get(key) }; },
                async set(items) { for (const [key, value] of Object.entries(items)) values.set(key, value); },
                async remove(key) { values.delete(key); },
            },
        };
        if (!window.chrome) {
            Object.defineProperty(window, 'chrome', {
                configurable: true,
                value: chromeApi,
            });
        }
    }, origin);
    const response = await page.goto(origin);
    const frameHost = page.locator('iframe[data-paws-agent-bubble="true"]');
    try {
        await frameHost.waitFor({ state: 'visible', timeout: 15_000 });
    } catch (cause) {
        const diagnostics = await page.evaluate(() => ({
            chromeType: typeof window.chrome,
            scriptSources: [...document.scripts].map(script => script.src),
            frameCount: document.querySelectorAll('iframe').length,
        }));
        throw new Error(`Content bundle did not inject: ${JSON.stringify({ status: response?.status(), pageErrors, diagnostics })}`, { cause });
    }
    const bubble = page.frameLocator('#paws-agent-bubble-frame');
    await bubble.getByRole('button', { name: '打开 Paws Agent' }).click();
    await bubble.getByText('把这个浏览器连接到 Paws').waitFor();
    await page.waitForFunction(() => {
        const frame = document.querySelector('iframe[data-paws-agent-bubble="true"]');
        if (!frame) return false;
        const style = getComputedStyle(frame);
        return Number.parseFloat(style.width) >= 389 && Number.parseFloat(style.height) >= 639;
    });
    const dimensions = await frameHost.evaluate(frame => ({
        inlineWidth: frame.style.width,
        inlineHeight: frame.style.height,
        computedWidth: getComputedStyle(frame).width,
        computedHeight: getComputedStyle(frame).height,
    }));
    if (dimensions.inlineWidth !== '390px' || dimensions.inlineHeight !== '640px') {
        throw new Error(`Bubble did not expand: ${JSON.stringify(dimensions)}`);
    }
    if (process.env.PAWS_EXTENSION_SCREENSHOT) {
        await page.screenshot({ path: process.env.PAWS_EXTENSION_SCREENSHOT, fullPage: true });
    }
    process.stdout.write(JSON.stringify({
        host: executablePath ?? 'Playwright Chromium',
        mode: 'browser-harness',
        manifestV3: true,
        injected: true,
        expanded: true,
        setupVisible: true,
        size: dimensions,
    }) + '\n');
} finally {
    if (browser) await browser.close().catch(() => {});
    if (server.listening) {
        await new Promise(resolveClose => server.close(resolveClose));
    }
}

async function resolveBrowserExecutable() {
    const candidates = [
        process.env.PAWS_EXTENSION_BROWSER,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            await access(candidate, constants.X_OK);
            return candidate;
        } catch {
            // Try the next installed Chromium host.
        }
    }
    return undefined;
}
