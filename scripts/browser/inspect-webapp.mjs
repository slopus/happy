#!/usr/bin/env node
/**
 * Browser automation script to inspect and interact with the Happy webapp
 *
 * Usage:
 *   node inspect-webapp.mjs                    # Basic inspection
 *   node inspect-webapp.mjs --screenshot       # Take screenshot
 *   node inspect-webapp.mjs --console          # Show console logs
 *   node inspect-webapp.mjs --login SECRET     # Login with secret key
 *   node inspect-webapp.mjs --check-sessions   # Check if sessions are visible
 */

import { chromium } from 'playwright';

const WEBAPP_URL = process.env.WEBAPP_URL || 'http://localhost:8081';
const TIMEOUT = 30000;

async function main() {
    const args = process.argv.slice(2);
    const doScreenshot = args.includes('--screenshot');
    const showConsole = args.includes('--console');
    const secretKeyIndex = args.indexOf('--login');
    const secretKey = secretKeyIndex >= 0 ? args[secretKeyIndex + 1] : null;
    const checkSessions = args.includes('--check-sessions');

    console.log('=== Happy Webapp Browser Inspection ===\n');
    console.log(`Target URL: ${WEBAPP_URL}`);
    console.log(`Options: screenshot=${doScreenshot}, console=${showConsole}, login=${!!secretKey}, checkSessions=${checkSessions}\n`);

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 }
    });

    const page = await context.newPage();

    // Collect console logs if requested
    const consoleLogs = [];
    if (showConsole) {
        page.on('console', msg => {
            const text = msg.text();
            consoleLogs.push({ type: msg.type(), text });
            // Print important logs immediately
            if (text.includes('error') || text.includes('Error') || text.includes('Failed')) {
                console.log(`[CONSOLE ${msg.type()}] ${text}`);
            }
        });
    }

    try {
        // Navigate to webapp
        console.log('Navigating to webapp...');
        await page.goto(WEBAPP_URL, { timeout: TIMEOUT, waitUntil: 'networkidle' });
        console.log('Page loaded successfully\n');

        // Wait for React to render (Expo web apps need time)
        await page.waitForTimeout(3000);

        // Get page title
        const title = await page.title();
        console.log(`Page title: ${title}`);

        // Get visible text content
        const bodyText = await page.evaluate(() => {
            return document.body.innerText.substring(0, 2000);
        });
        console.log('\n=== Visible Page Content (first 2000 chars) ===');
        console.log(bodyText || '(No visible text - might still be loading)');
        console.log('=== End Content ===\n');

        // Look for common UI elements
        console.log('=== UI Element Detection ===');

        const elements = await page.evaluate(() => {
            const results = {};
            const bodyText = document.body.innerText.toLowerCase();

            // Check for login-related elements
            results.hasSecretKeyInput = !!document.querySelector('input[placeholder*="secret" i], input[type="password"]');
            results.hasLoginButton = Array.from(document.querySelectorAll('button')).some(b =>
                /login|sign|enter|submit/i.test(b.innerText)
            );
            results.hasRestoreLink = bodyText.includes('restore') || bodyText.includes('secret key');

            // Check for session-related elements
            results.hasSessionList = bodyText.includes('session');
            results.hasMachineList = bodyText.includes('machine');

            // Get all buttons
            results.buttons = Array.from(document.querySelectorAll('button, [role="button"]')).map(b => b.innerText.trim()).filter(t => t).slice(0, 10);

            // Get all clickable text elements
            results.clickableText = Array.from(document.querySelectorAll('a, [role="link"], [tabindex="0"]')).map(el => el.innerText.trim()).filter(t => t).slice(0, 10);

            // Check for error messages
            results.errors = [];
            document.querySelectorAll('*').forEach(el => {
                const text = el.innerText?.toLowerCase() || '';
                if ((text.includes('error') || text.includes('failed')) && el.children.length === 0) {
                    results.errors.push(el.innerText.trim());
                }
            });
            results.errors = results.errors.slice(0, 5);

            return results;
        });

        console.log('Has secret key input:', elements.hasSecretKeyInput);
        console.log('Has login button:', elements.hasLoginButton);
        console.log('Has restore link:', elements.hasRestoreLink);
        console.log('Has session list:', elements.hasSessionList);
        console.log('Has machine list:', elements.hasMachineList);
        console.log('Buttons found:', elements.buttons);
        console.log('Links found:', elements.links);
        if (elements.errors.length > 0) {
            console.log('Errors found:', elements.errors);
        }
        console.log('');

        // Login if secret key provided
        if (secretKey) {
            console.log('=== Attempting Login ===');

            // Look for "restore" or "secret key" link/button
            const restoreSelector = 'text=/restore|secret key/i';
            try {
                await page.click(restoreSelector, { timeout: 5000 });
                console.log('Clicked restore/secret key link');
                await page.waitForTimeout(1000);
            } catch (e) {
                console.log('No restore link found, looking for input directly');
            }

            // Find and fill secret key input
            const input = await page.$('input[placeholder*="secret" i], input[type="password"], textarea');
            if (input) {
                await input.fill(secretKey);
                console.log('Filled secret key');

                // Look for submit button
                const submitBtn = await page.$('button:has-text("Restore"), button:has-text("Submit"), button:has-text("Enter"), button[type="submit"]');
                if (submitBtn) {
                    await submitBtn.click();
                    console.log('Clicked submit button');
                    await page.waitForTimeout(3000);
                }
            } else {
                console.log('Could not find secret key input');
            }

            // Re-check page content after login
            const afterLoginText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
            console.log('\n=== Content After Login ===');
            console.log(afterLoginText);
            console.log('=== End ===\n');
        }

        // Check for sessions
        if (checkSessions) {
            console.log('=== Checking for Sessions ===');

            // Look for session IDs or "No sessions" message
            const sessionInfo = await page.evaluate(() => {
                const text = document.body.innerText;
                const sessionMatches = text.match(/cm[a-z0-9]{20,}/gi) || [];
                const noSessions = text.toLowerCase().includes('no session') || text.toLowerCase().includes('no active');
                return { sessionMatches, noSessions, fullText: text.substring(0, 3000) };
            });

            if (sessionInfo.sessionMatches.length > 0) {
                console.log('Found session IDs:', sessionInfo.sessionMatches);
            } else if (sessionInfo.noSessions) {
                console.log('Page indicates no sessions');
            } else {
                console.log('Could not determine session status');
                console.log('Page text:', sessionInfo.fullText);
            }
        }

        // Take screenshot if requested
        if (doScreenshot) {
            const screenshotPath = `/tmp/webapp-screenshot-${Date.now()}.png`;
            await page.screenshot({ path: screenshotPath, fullPage: true });
            console.log(`\nScreenshot saved: ${screenshotPath}`);
        }

        // Show console logs if collected
        if (showConsole && consoleLogs.length > 0) {
            console.log('\n=== Browser Console Logs ===');
            consoleLogs.forEach(log => {
                console.log(`[${log.type}] ${log.text}`);
            });
            console.log('=== End Console Logs ===');
        }

    } catch (error) {
        console.error('Error:', error.message);

        // Take error screenshot
        const errorScreenshot = `/tmp/webapp-error-${Date.now()}.png`;
        await page.screenshot({ path: errorScreenshot });
        console.log(`Error screenshot saved: ${errorScreenshot}`);
    } finally {
        await browser.close();
        console.log('\nBrowser closed.');
    }
}

main().catch(console.error);
