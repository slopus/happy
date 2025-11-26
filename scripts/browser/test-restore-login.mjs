#!/usr/bin/env node
/**
 * Test script to verify webapp can see CLI-created sessions after restore login
 *
 * Usage:
 *   node test-restore-login.mjs <secret-key>
 */

import { chromium } from 'playwright';

const WEBAPP_URL = process.env.WEBAPP_URL || 'http://localhost:8081';
const TIMEOUT = 60000;
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp';

async function takeScreenshot(page, name) {
    const path = `${SCREENSHOT_DIR}/restore-test-${name}-${Date.now()}.png`;
    await page.screenshot({ path, fullPage: true });
    console.log(`  Screenshot: ${path}`);
    return path;
}

async function main() {
    const secretKey = process.argv[2];

    if (!secretKey) {
        console.log('Usage: node test-restore-login.mjs <secret-key>');
        process.exit(1);
    }

    console.log('=== Webapp Restore Login Test ===\n');
    console.log(`Target URL: ${WEBAPP_URL}`);
    console.log(`Secret Key: ${secretKey.substring(0, 15)}...`);
    console.log('');

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 }
    });

    const page = await context.newPage();

    // Collect console logs
    const logs = [];
    page.on('console', msg => {
        logs.push(`[${msg.type()}] ${msg.text()}`);
    });

    try {
        // Step 1: Navigate directly to restore/manual page
        console.log('Step 1: Navigating to restore/manual...');
        await page.goto(`${WEBAPP_URL}/restore/manual`, { timeout: TIMEOUT, waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);
        await takeScreenshot(page, '01-restore-page');

        // Step 2: Find the text input for secret key
        console.log('\nStep 2: Looking for secret key input...');
        const textInput = await page.$('textarea, input[type="text"]');

        if (!textInput) {
            console.log('  ERROR: No input field found!');
            await takeScreenshot(page, '02-no-input');
            throw new Error('No input field found on restore page');
        }

        // Step 3: Enter the secret key
        console.log('\nStep 3: Entering secret key...');
        await textInput.fill(secretKey);
        await page.waitForTimeout(500);
        await takeScreenshot(page, '03-key-entered');

        // Step 4: Click the restore button
        console.log('\nStep 4: Clicking restore button...');
        // Look for button with "Restore" text
        const restoreButton = await page.$('text=Restore Account');
        if (restoreButton) {
            console.log('  Found "Restore Account" button');
            await restoreButton.click();
        } else {
            console.log('  Looking for any button with restore text...');
            await page.click('text=/restore/i');
        }

        // Wait for authentication to complete
        console.log('\nStep 5: Waiting for authentication...');
        await page.waitForTimeout(5000);
        await takeScreenshot(page, '05-after-auth');

        // Step 6: Check if we're logged in by looking at the page content
        console.log('\nStep 6: Checking login status...');
        const pageText = await page.evaluate(() => document.body.innerText);

        const isConnected = pageText.includes('connected') && !pageText.includes('disconnected');
        const hasNoSessions = pageText.toLowerCase().includes('no active sessions');
        const hasSession = pageText.toLowerCase().includes('session') && !hasNoSessions;
        const stillOnRestore = pageText.toLowerCase().includes('enter your secret key');

        console.log(`  Connected: ${isConnected}`);
        console.log(`  Has sessions: ${hasSession}`);
        console.log(`  No active sessions message: ${hasNoSessions}`);
        console.log(`  Still on restore page: ${stillOnRestore}`);

        // Step 7: Navigate to home to see sessions
        if (!stillOnRestore && isConnected) {
            console.log('\nStep 7: Navigating to home to check sessions...');
            await page.goto(`${WEBAPP_URL}/`, { timeout: TIMEOUT, waitUntil: 'networkidle' });
            await page.waitForTimeout(3000);
            await takeScreenshot(page, '07-home-page');

            const homeText = await page.evaluate(() => document.body.innerText);
            console.log('\n=== Home Page Content ===');
            console.log(homeText.substring(0, 1500));
            console.log('=== End Content ===');

            // Check for sessions
            const sessionsVisible = !homeText.toLowerCase().includes('no active sessions');
            console.log(`\nSessions visible on home: ${sessionsVisible}`);
        }

        // Print relevant console logs
        console.log('\n=== Relevant Console Logs ===');
        const relevantLogs = logs.filter(l =>
            l.includes('Restore') ||
            l.includes('auth') ||
            l.includes('token') ||
            l.includes('session') ||
            l.includes('error') ||
            l.includes('Error')
        );
        relevantLogs.slice(-30).forEach(l => console.log(l));
        console.log('=== End Logs ===');

    } catch (error) {
        console.error('\nError:', error.message);
        await takeScreenshot(page, 'error');
    } finally {
        await browser.close();
        console.log('\nBrowser closed.');
    }
}

main().catch(console.error);
