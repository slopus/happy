#!/usr/bin/env node
/**
 * Test script to verify webapp can create a new account
 *
 * Usage:
 *   node test-create-account.mjs
 */

import { chromium } from 'playwright';

const WEBAPP_URL = process.env.WEBAPP_URL || 'http://localhost:8081';
const TIMEOUT = 60000;
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp';

async function takeScreenshot(page, name) {
    const path = `${SCREENSHOT_DIR}/create-account-${name}-${Date.now()}.png`;
    await page.screenshot({ path, fullPage: true });
    console.log(`  Screenshot: ${path}`);
    return path;
}

async function main() {
    console.log('=== Webapp Create Account Test ===\n');
    console.log(`Target URL: ${WEBAPP_URL}`);
    console.log('');

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 }
    });

    const page = await context.newPage();

    // Collect ALL console logs
    const logs = [];
    page.on('console', msg => {
        const text = `[${msg.type()}] ${msg.text()}`;
        logs.push(text);
        // Print errors immediately
        if (msg.type() === 'error') {
            console.log(`  CONSOLE ERROR: ${msg.text()}`);
        }
    });

    // Collect page errors (uncaught exceptions)
    const pageErrors = [];
    page.on('pageerror', error => {
        pageErrors.push(error.message);
        console.log(`  PAGE ERROR: ${error.message}`);
    });

    // Collect network request failures
    const networkErrors = [];
    page.on('requestfailed', request => {
        const failure = `${request.method()} ${request.url()} - ${request.failure()?.errorText}`;
        networkErrors.push(failure);
        console.log(`  NETWORK FAILED: ${failure}`);
    });

    // Track API responses
    const apiResponses = [];
    page.on('response', async response => {
        const url = response.url();
        if (url.includes('/v1/') || url.includes('/api/')) {
            const status = response.status();
            let body = '';
            try {
                body = await response.text();
                if (body.length > 200) body = body.substring(0, 200) + '...';
            } catch (e) { }
            apiResponses.push({ url, status, body });
            console.log(`  API ${status}: ${url.split('/').slice(-2).join('/')}`);
        }
    });

    try {
        // Step 1: Navigate to the webapp root
        console.log('Step 1: Navigating to webapp...');
        await page.goto(WEBAPP_URL, { timeout: TIMEOUT, waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);
        await takeScreenshot(page, '01-initial-load');

        // Check what page we're on
        const currentUrl = page.url();
        console.log(`  Current URL: ${currentUrl}`);

        const pageText = await page.evaluate(() => document.body.innerText);
        console.log('\n  === Page Content (first 800 chars) ===');
        console.log(pageText.substring(0, 800));
        console.log('  === End Content ===\n');

        // Step 2: Look for "Create Account" button
        console.log('Step 2: Looking for Create Account button...');

        // Try various selectors
        const createAccountSelectors = [
            'text=Create Account',
            'text=Create account',
            'text=create account',
            'button:has-text("Create")',
            '[data-testid="create-account"]',
            'a:has-text("Create")'
        ];

        let createButton = null;
        for (const selector of createAccountSelectors) {
            try {
                createButton = await page.$(selector);
                if (createButton) {
                    console.log(`  Found button with selector: ${selector}`);
                    break;
                }
            } catch (e) { }
        }

        if (!createButton) {
            console.log('  WARNING: No "Create Account" button found');
            console.log('  Looking for all buttons on page...');

            const buttons = await page.$$eval('button, a[role="button"], [role="button"]', els =>
                els.map(el => ({
                    tag: el.tagName,
                    text: el.innerText?.trim().substring(0, 50),
                    className: el.className?.substring(0, 50)
                }))
            );
            console.log('  Buttons found:', JSON.stringify(buttons, null, 2));

            await takeScreenshot(page, '02-no-create-button');
        } else {
            // Step 3: Click Create Account
            console.log('\nStep 3: Clicking Create Account...');
            await takeScreenshot(page, '03-before-click');

            await createButton.click();
            console.log('  Clicked!');

            // Wait for any network activity and state changes
            await page.waitForTimeout(3000);
            await takeScreenshot(page, '04-after-click');

            // Check what happened
            const newUrl = page.url();
            console.log(`  New URL: ${newUrl}`);

            const newPageText = await page.evaluate(() => document.body.innerText);
            console.log('\n  === Page Content After Click (first 800 chars) ===');
            console.log(newPageText.substring(0, 800));
            console.log('  === End Content ===\n');

            // Check if we got logged in or if there's an error
            const hasError = newPageText.toLowerCase().includes('error');
            const hasSecret = newPageText.toLowerCase().includes('secret key');
            const isLoggedIn = newPageText.includes('connected') || newPageText.includes('Sessions');

            console.log(`  Has error message: ${hasError}`);
            console.log(`  Shows secret key: ${hasSecret}`);
            console.log(`  Appears logged in: ${isLoggedIn}`);
        }

        // Step 4: Summary
        console.log('\n=== Summary ===');
        console.log(`Console errors: ${logs.filter(l => l.startsWith('[error]')).length}`);
        console.log(`Page errors: ${pageErrors.length}`);
        console.log(`Network failures: ${networkErrors.length}`);
        console.log(`API calls: ${apiResponses.length}`);

        if (pageErrors.length > 0) {
            console.log('\n=== Page Errors ===');
            pageErrors.forEach(e => console.log(`  - ${e}`));
        }

        if (networkErrors.length > 0) {
            console.log('\n=== Network Errors ===');
            networkErrors.forEach(e => console.log(`  - ${e}`));
        }

        // Print console errors
        const consoleErrors = logs.filter(l => l.startsWith('[error]'));
        if (consoleErrors.length > 0) {
            console.log('\n=== Console Errors ===');
            consoleErrors.forEach(e => console.log(`  ${e}`));
        }

        // Print API responses with errors
        const failedApi = apiResponses.filter(r => r.status >= 400);
        if (failedApi.length > 0) {
            console.log('\n=== Failed API Calls ===');
            failedApi.forEach(r => {
                console.log(`  ${r.status} ${r.url}`);
                if (r.body) console.log(`    Response: ${r.body}`);
            });
        }

        // Print all console logs if verbose
        if (process.argv.includes('--verbose') || process.argv.includes('-v')) {
            console.log('\n=== All Console Logs ===');
            logs.forEach(l => console.log(l));
        }

    } catch (error) {
        console.error('\nError:', error.message);
        console.error(error.stack);
        await takeScreenshot(page, 'error');
    } finally {
        await browser.close();
        console.log('\nBrowser closed.');
    }
}

main().catch(console.error);
