import puppeteer, { type Browser } from 'puppeteer-core';
import { logger } from '@/ui/logger';

const CHROME_PATHS = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const SCREENSHOT_TIMEOUT_MS = 15_000;

let browserInstance: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;

function findChromePath(): string {
    const fs = require('fs');

    for (const p of CHROME_PATHS) {
        if (fs.existsSync(p)) return p;
    }

    // Check Playwright cache
    const home = process.env.HOME || '/root';
    const playwrightDir = `${home}/.cache/ms-playwright`;
    try {
        const entries = fs.readdirSync(playwrightDir) as string[];
        for (const entry of entries) {
            if (entry.startsWith('chromium-')) {
                const candidate = `${playwrightDir}/${entry}/chrome-linux/chrome`;
                if (fs.existsSync(candidate)) return candidate;
            }
        }
    } catch {
        // Playwright not installed
    }

    throw new Error('Chrome binary not found. Install Chrome or Chromium.');
}

async function getBrowser(): Promise<Browser> {
    if (browserInstance?.connected) return browserInstance;

    // Avoid double-launching
    if (browserLaunchPromise) return browserLaunchPromise;

    browserLaunchPromise = (async () => {
        const executablePath = await findChromePath();
        logger.debug('[screenshot] Launching Chrome from:', executablePath);

        const browser = await puppeteer.launch({
            executablePath,
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
            ],
        });

        browserInstance = browser;
        browser.on('disconnected', () => {
            browserInstance = null;
            browserLaunchPromise = null;
        });

        return browser;
    })();

    try {
        return await browserLaunchPromise;
    } catch (err) {
        browserLaunchPromise = null;
        throw err;
    }
}

export interface ScreenshotResult {
    base64: string;
    width: number;
    height: number;
}

export async function takeScreenshot(
    url: string,
    viewport?: { width?: number; height?: number },
): Promise<ScreenshotResult> {
    const browser = await getBrowser();
    const page = await browser.newPage();

    const vp = {
        width: viewport?.width || DEFAULT_VIEWPORT.width,
        height: viewport?.height || DEFAULT_VIEWPORT.height,
    };

    try {
        await page.setViewport(vp);
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: SCREENSHOT_TIMEOUT_MS,
        });

        const buffer = await page.screenshot({
            type: 'jpeg',
            quality: 75,
            fullPage: false,
        });

        const base64 = Buffer.from(buffer).toString('base64');
        logger.debug('[screenshot] Screenshot taken, base64 length:', base64.length);
        return { base64, width: vp.width, height: vp.height };
    } finally {
        await page.close().catch(() => {});
    }
}

export async function cleanupScreenshotService(): Promise<void> {
    if (browserInstance) {
        await browserInstance.close().catch(() => {});
        browserInstance = null;
        browserLaunchPromise = null;
    }
}
