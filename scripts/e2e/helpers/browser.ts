/**
 * Browser Helper - Playwright utilities for E2E tests
 *
 * Provides common browser operations for testing the webapp.
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SlotConfig } from './slots.js';

export interface BrowserHandle {
    browser: Browser;
    context: BrowserContext;
    page: Page;
    close: () => Promise<void>;
}

export interface PageLogs {
    console: string[];
    errors: string[];
    networkFailures: string[];
    apiResponses: Array<{ url: string; status: number; body: string }>;
}

const DEFAULT_TIMEOUT = 60000;

/**
 * Launch a browser and create a new page configured for testing
 */
export async function launchBrowser(config: SlotConfig): Promise<BrowserHandle> {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        baseURL: config.webappUrl,
    });

    const page = await context.newPage();

    // Set default timeout
    page.setDefaultTimeout(DEFAULT_TIMEOUT);

    return {
        browser,
        context,
        page,
        close: async () => {
            await context.close();
            await browser.close();
        },
    };
}

/**
 * Attach logging listeners to a page
 * Returns an object that will accumulate logs
 */
export function attachPageLogging(page: Page): PageLogs {
    const logs: PageLogs = {
        console: [],
        errors: [],
        networkFailures: [],
        apiResponses: [],
    };

    // Console logs
    page.on('console', msg => {
        const text = `[${msg.type()}] ${msg.text()}`;
        logs.console.push(text);
        if (msg.type() === 'error') {
            logs.errors.push(msg.text());
        }
    });

    // Page errors (uncaught exceptions)
    page.on('pageerror', error => {
        logs.errors.push(error.message);
    });

    // Network failures
    page.on('requestfailed', request => {
        const failure = `${request.method()} ${request.url()} - ${request.failure()?.errorText}`;
        logs.networkFailures.push(failure);
    });

    // API responses
    page.on('response', async response => {
        const url = response.url();
        if (url.includes('/v1/') || url.includes('/api/')) {
            const status = response.status();
            let body = '';
            try {
                body = await response.text();
                if (body.length > 500) {
                    body = body.substring(0, 500) + '...';
                }
            } catch {
                // Ignore body read errors
            }
            logs.apiResponses.push({ url, status, body });
        }
    });

    return logs;
}

/**
 * Take a screenshot and save to the slot's log directory
 */
export async function takeScreenshot(
    page: Page,
    config: SlotConfig,
    name: string
): Promise<string> {
    const screenshotDir = path.join(config.logDir, 'screenshots');
    fs.mkdirSync(screenshotDir, { recursive: true });

    const filename = `${name}-${Date.now()}.png`;
    const filepath = path.join(screenshotDir, filename);

    await page.screenshot({ path: filepath, fullPage: true });

    return filepath;
}

/**
 * Navigate to the webapp and wait for it to load
 * Appends #server=PORT to enable runtime server port configuration
 */
export async function navigateToWebapp(
    page: Page,
    config: SlotConfig,
    path: string = '/'
): Promise<void> {
    // Append server port as hash parameter for runtime configuration
    // The webapp's serverConfig.ts reads this to override the default port
    const urlWithServer = `${path}#server=${config.serverPort}`;
    await page.goto(urlWithServer, { waitUntil: 'networkidle' });
    // Give React time to hydrate
    await page.waitForTimeout(1000);
}

/**
 * Click the "Create Account" button on the welcome page
 */
export async function clickCreateAccount(page: Page): Promise<boolean> {
    const selectors = [
        'text=Create Account',
        'text=Create account',
        'text=create account',
        'button:has-text("Create")',
        '[data-testid="create-account"]',
        'a:has-text("Create")',
    ];

    for (const selector of selectors) {
        try {
            const button = await page.$(selector);
            if (button) {
                await button.click();
                await page.waitForTimeout(2000);
                return true;
            }
        } catch {
            // Try next selector
        }
    }

    return false;
}

/**
 * Check if the page shows a logged-in state
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
    const text = await page.evaluate(() => document.body.innerText);
    return (
        text.includes('connected') ||
        text.includes('Sessions') ||
        text.includes('Machines') ||
        text.includes('Settings')
    );
}

/**
 * Get the secret key displayed after account creation
 */
export async function getDisplayedSecretKey(page: Page): Promise<string | null> {
    // Look for the secret key in the page
    // This is typically shown after account creation
    try {
        const secretKeyElement = await page.$('[data-testid="secret-key"]');
        if (secretKeyElement) {
            return await secretKeyElement.textContent();
        }

        // Fallback: look for text that looks like a secret key
        const text = await page.evaluate(() => document.body.innerText);
        const match = text.match(/[A-Za-z0-9]{32,}/);
        return match ? match[0] : null;
    } catch {
        return null;
    }
}

/**
 * Navigate to restore login page and enter a secret key
 */
export async function restoreWithSecretKey(page: Page, secretKey: string): Promise<boolean> {
    try {
        // Navigate to restore page
        await page.goto('/restore/manual', { waitUntil: 'networkidle' });
        await page.waitForTimeout(1000);

        // Find and fill the secret key input
        const input = await page.$('input[type="text"], input[type="password"], textarea');
        if (!input) {
            console.error('Could not find secret key input');
            return false;
        }

        await input.fill(secretKey);
        await page.waitForTimeout(500);

        // Click submit/restore button
        const submitSelectors = [
            'button:has-text("Restore")',
            'button:has-text("Submit")',
            'button:has-text("Login")',
            'button[type="submit"]',
        ];

        for (const selector of submitSelectors) {
            const button = await page.$(selector);
            if (button) {
                await button.click();
                await page.waitForTimeout(2000);
                return true;
            }
        }

        return false;
    } catch (err) {
        console.error('Error in restoreWithSecretKey:', err);
        return false;
    }
}

/**
 * Print a summary of collected logs
 */
export function printLogSummary(logs: PageLogs): void {
    console.log('\n=== Page Log Summary ===');
    console.log(`Console messages: ${logs.console.length}`);
    console.log(`Errors: ${logs.errors.length}`);
    console.log(`Network failures: ${logs.networkFailures.length}`);
    console.log(`API calls: ${logs.apiResponses.length}`);

    if (logs.errors.length > 0) {
        console.log('\n--- Errors ---');
        logs.errors.forEach(e => console.log(`  ${e}`));
    }

    if (logs.networkFailures.length > 0) {
        console.log('\n--- Network Failures ---');
        logs.networkFailures.forEach(f => console.log(`  ${f}`));
    }

    const failedApi = logs.apiResponses.filter(r => r.status >= 400);
    if (failedApi.length > 0) {
        console.log('\n--- Failed API Calls ---');
        failedApi.forEach(r => console.log(`  ${r.status} ${r.url}`));
    }
}
