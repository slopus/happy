#!/usr/bin/env node
/**
 * E2E test script for the Happy webapp
 *
 * This script:
 * 1. Opens the webapp
 * 2. Logs in with a secret key
 * 3. Checks if sessions/machines are visible
 * 4. Takes screenshots at each step
 *
 * Usage:
 *   node test-webapp-e2e.mjs <secret-key>
 *
 * Example:
 *   node test-webapp-e2e.mjs "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF"
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const WEBAPP_URL = process.env.WEBAPP_URL || 'http://localhost:8081';
const TIMEOUT = 30000;
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp';

async function takeScreenshot(page, name) {
    const path = `${SCREENSHOT_DIR}/happy-e2e-${name}-${Date.now()}.png`;
    await page.screenshot({ path, fullPage: true });
    console.log(`  Screenshot: ${path}`);
    return path;
}

async function main() {
    const secretKey = process.argv[2];

    if (!secretKey) {
        console.log('Usage: node test-webapp-e2e.mjs <secret-key>');
        console.log('');
        console.log('Get the secret key from: node scripts/setup-test-credentials.mjs');
        process.exit(1);
    }

    console.log('=== Happy Webapp E2E Test ===\n');
    console.log(`Target URL: ${WEBAPP_URL}`);
    console.log(`Secret Key: ${secretKey.substring(0, 10)}...`);
    console.log('');

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 }
    });

    const page = await context.newPage();

    // Collect console errors
    const errors = [];
    page.on('console', msg => {
        if (msg.type() === 'error') {
            errors.push(msg.text());
        }
    });

    const results = {
        steps: [],
        success: false,
        errors: []
    };

    try {
        // Step 1: Load webapp
        console.log('Step 1: Loading webapp...');
        await page.goto(WEBAPP_URL, { timeout: TIMEOUT, waitUntil: 'networkidle' });
        await page.waitForTimeout(3000); // Wait for React to render
        await takeScreenshot(page, '01-initial');

        const title = await page.title();
        results.steps.push({ name: 'load', success: true, title });
        console.log(`  Title: ${title}`);
        console.log('  ✓ Webapp loaded\n');

        // Step 2: Look for "Create account" or restore option
        console.log('Step 2: Looking for login options...');

        // Check if there's a way to enter secret key
        const pageText = await page.evaluate(() => document.body.innerText);

        if (pageText.toLowerCase().includes('create account')) {
            console.log('  Found "Create account" option');

            // Click on "Create account" to see if it leads to secret key entry
            const createAccountLink = await page.$('text=Create account');
            if (createAccountLink) {
                await createAccountLink.click();
                await page.waitForTimeout(2000);
                await takeScreenshot(page, '02-after-create-click');
            }
        }

        // Step 3: Try to find and use secret key restore
        console.log('\nStep 3: Looking for secret key input...');

        // Look for text input that might accept secret key
        // The app might have a "restore" flow
        const restoreText = await page.$('text=/restore|secret key|enter.*key/i');
        if (restoreText) {
            console.log('  Found restore link, clicking...');
            await restoreText.click();
            await page.waitForTimeout(2000);
            await takeScreenshot(page, '03-restore-screen');
        }

        // Look for input field
        let input = await page.$('input, textarea');
        if (input) {
            console.log('  Found input field, entering secret key...');
            await input.fill(secretKey);
            await page.waitForTimeout(500);
            await takeScreenshot(page, '04-key-entered');

            // Look for submit button
            const submitBtn = await page.$('button:not(:disabled)');
            if (submitBtn) {
                const btnText = await submitBtn.innerText();
                console.log(`  Clicking button: "${btnText}"`);
                await submitBtn.click();
                await page.waitForTimeout(5000); // Wait for login to complete
                await takeScreenshot(page, '05-after-submit');
            }
        } else {
            console.log('  No input field found on current screen');
        }

        results.steps.push({ name: 'login_attempt', success: true });

        // Step 4: Check what we see after login attempt
        console.log('\nStep 4: Checking post-login state...');

        const postLoginText = await page.evaluate(() => document.body.innerText);
        await takeScreenshot(page, '06-final-state');

        // Check for various states
        const hasSession = /session/i.test(postLoginText);
        const hasMachine = /machine/i.test(postLoginText);
        const hasError = /error|failed|invalid/i.test(postLoginText);
        const hasNoSessions = /no session|no active/i.test(postLoginText);
        const stillOnLogin = /create account|login with mobile/i.test(postLoginText);

        console.log('  Post-login analysis:');
        console.log(`    - Has "session" text: ${hasSession}`);
        console.log(`    - Has "machine" text: ${hasMachine}`);
        console.log(`    - Has error text: ${hasError}`);
        console.log(`    - Shows "no sessions": ${hasNoSessions}`);
        console.log(`    - Still on login screen: ${stillOnLogin}`);

        results.steps.push({
            name: 'post_login_check',
            hasSession,
            hasMachine,
            hasError,
            hasNoSessions,
            stillOnLogin
        });

        // Determine success
        if (hasMachine || hasSession || hasNoSessions) {
            results.success = true;
            console.log('\n✓ SUCCESS: Login appears to have worked!');
        } else if (stillOnLogin) {
            console.log('\n✗ FAILED: Still on login screen - login did not work');
        } else if (hasError) {
            console.log('\n✗ FAILED: Error message detected');
        } else {
            console.log('\n? UNCLEAR: Could not determine login status');
        }

        // Output visible content
        console.log('\n=== Final Page Content ===');
        console.log(postLoginText.substring(0, 1500));
        console.log('=== End Content ===');

    } catch (error) {
        console.error('\nError:', error.message);
        results.errors.push(error.message);
        await takeScreenshot(page, 'error');
    } finally {
        // Report any console errors
        if (errors.length > 0) {
            console.log('\n=== Browser Console Errors ===');
            errors.forEach(e => console.log(`  ${e}`));
            results.errors.push(...errors);
        }

        await browser.close();
        console.log('\nBrowser closed.');

        // Write results JSON
        const resultsPath = `${SCREENSHOT_DIR}/happy-e2e-results-${Date.now()}.json`;
        writeFileSync(resultsPath, JSON.stringify(results, null, 2));
        console.log(`Results saved: ${resultsPath}`);

        process.exit(results.success ? 0 : 1);
    }
}

main().catch(console.error);
