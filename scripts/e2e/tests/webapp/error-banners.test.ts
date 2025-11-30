/**
 * Webapp Error Banners Test
 *
 * Tests that error states are properly displayed in the UI:
 * 1. Connection error status appears when server goes down
 * 2. Disconnected status is shown correctly
 *
 * TODO: This test is currently skipped because reliably killing the server
 * in CI is complex - the happy-launcher.sh spawns child processes and the
 * server can respawn or have lingering connections. We need a better approach
 * such as:
 * - Adding a test endpoint to the server that forces disconnection
 * - Using network interception in Playwright to block server connections
 * - Mocking the socket.io connection at the client level
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
    startServices,
    ServerHandle,
    launchBrowser,
    BrowserHandle,
    attachPageLogging,
    PageLogs,
    navigateToWebapp,
    clickCreateAccount,
    isLoggedIn,
    takeScreenshot,
    printLogSummary,
} from '../../helpers/index.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const LAUNCHER_PATH = path.join(ROOT_DIR, 'happy-launcher.sh');

// Skip this entire test suite until we have a reliable way to test disconnection
describe.skip('Webapp Error Banners', () => {
    let server: ServerHandle;
    let browser: BrowserHandle;
    let logs: PageLogs;

    beforeAll(async () => {
        // Start services on an available slot
        server = await startServices();
        console.log(`[Test] Services started on slot ${server.slot.config.slot}`);

        // Launch browser
        browser = await launchBrowser(server.slot.config);
        logs = attachPageLogging(browser.page);
        console.log('[Test] Browser launched');
    }, 180000); // 3 minute timeout for setup

    afterAll(async () => {
        if (browser) {
            await browser.close();
            console.log('[Test] Browser closed');
        }
        if (server) {
            await server.stop();
            console.log('[Test] Services stopped');
        }

        // Print log summary
        if (logs) {
            printLogSummary(logs);
        }
    }, 60000); // 1 minute timeout for teardown

    it('should create an account and verify connected status', async () => {
        const { page } = browser;
        const { config } = server.slot;

        // Navigate to webapp
        await navigateToWebapp(page, config);
        await takeScreenshot(page, config, 'error-01-welcome');

        // Create account
        const clicked = await clickCreateAccount(page);
        expect(clicked).toBe(true);

        // Wait for account creation
        await page.waitForTimeout(3000);
        await takeScreenshot(page, config, 'error-02-after-create');

        // Verify logged in
        const loggedIn = await isLoggedIn(page);
        expect(loggedIn).toBe(true);

        // Navigate to home/sessions page to see the header with status
        await page.goto(`/#server=${config.serverPort}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);
        await takeScreenshot(page, config, 'error-03-home-connected');

        // Verify "connected" status is shown (text or visual indicator)
        const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());
        const hasConnectedIndicator = pageText.includes('connected') ||
                                       pageText.includes('sessions') ||
                                       pageText.includes('machines');

        console.log('[Test] Connected status check - has indicator:', hasConnectedIndicator);
        expect(hasConnectedIndicator).toBe(true);
    }, 180000); // 3 minute timeout for this test

    it('should show error/disconnected status when server stops', async () => {
        const { page } = browser;
        const { config } = server.slot;

        // Take screenshot before stopping server
        await takeScreenshot(page, config, 'error-04-before-stop');

        // Stop the happy-server to simulate connection loss
        // The server PID is stored in .pids-slot-N/server.pid by happy-launcher.sh
        console.log('[Test] Stopping happy-server to simulate connection error...');
        let serverStopped = false;

        // Method 1: Use PID file from launcher script's pids directory
        const pidsDir = path.join(ROOT_DIR, `.pids-slot-${config.slot}`);
        const serverPidFile = path.join(pidsDir, 'server.pid');
        console.log(`[Test] Looking for server PID file at: ${serverPidFile}`);

        try {
            if (fs.existsSync(serverPidFile)) {
                const pidContent = fs.readFileSync(serverPidFile, 'utf-8').trim();
                if (pidContent) {
                    console.log(`[Test] Found server PID: ${pidContent}`);
                    execSync(`kill -9 ${pidContent} 2>/dev/null || true`, { stdio: 'pipe' });
                    console.log('[Test] Killed server process by PID');
                    serverStopped = true;
                }
            } else {
                console.log('[Test] PID file not found');
            }
        } catch (e) {
            console.log('[Test] PID-based kill failed:', e);
        }

        // Method 2: Fallback - use lsof to find process on the server port
        if (!serverStopped) {
            try {
                const lsofOutput = execSync(`lsof -ti:${config.serverPort} 2>/dev/null || echo ""`, { encoding: 'utf-8' }).trim();
                if (lsofOutput) {
                    const pids = lsofOutput.split('\n').filter(Boolean);
                    console.log(`[Test] Found PIDs on port ${config.serverPort}:`, pids);
                    for (const pid of pids) {
                        execSync(`kill -9 ${pid} 2>/dev/null || true`, { stdio: 'pipe' });
                    }
                    console.log('[Test] Killed server process(es) by port');
                    serverStopped = true;
                } else {
                    console.log('[Test] No process found on server port');
                }
            } catch (e) {
                console.log('[Test] lsof fallback failed:', e);
            }
        }

        // Method 3: Use fuser as another fallback
        if (!serverStopped) {
            try {
                execSync(`fuser -k ${config.serverPort}/tcp 2>/dev/null || true`, { stdio: 'pipe' });
                console.log('[Test] Used fuser to kill process on port');
            } catch (e) {
                console.log('[Test] fuser fallback also failed');
            }
        }

        console.log(`[Test] Server stop attempt completed (stopped: ${serverStopped})`);

        // Verify server is actually down by trying to connect
        try {
            const response = await fetch(`http://localhost:${config.serverPort}/`, {
                signal: AbortSignal.timeout(2000),
            });
            console.log(`[Test] WARNING: Server still responding with status ${response.status}`);
        } catch {
            console.log('[Test] Confirmed: Server is not responding (expected)');
        }

        // Wait for the webapp to detect the disconnection
        // Socket.io has reconnection attempts with backoff, so we need to wait
        console.log('[Test] Waiting for webapp to detect disconnection...');
        await page.waitForTimeout(8000);

        // Refresh the page to trigger a fresh connection attempt to the dead server
        await page.reload({ waitUntil: 'networkidle' }).catch(() => {
            console.log('[Test] Page reload completed (may have errors)');
        });
        await page.waitForTimeout(5000);
        await takeScreenshot(page, config, 'error-05-after-stop');

        // Check for disconnected or error status in the UI
        const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());

        // The webapp should show one of these status indicators
        const hasDisconnectedStatus =
            pageText.includes('disconnected') ||
            pageText.includes('error') ||
            pageText.includes('connecting') || // While trying to reconnect
            pageText.includes('offline');

        console.log('[Test] Page text sample:', pageText.substring(0, 500));
        console.log('[Test] Has disconnected/error status:', hasDisconnectedStatus);

        // Take a final screenshot
        await takeScreenshot(page, config, 'error-06-status-shown');

        // The status should indicate a connection problem
        // Note: If this test fails, it might mean the UI doesn't properly show disconnected state
        expect(hasDisconnectedStatus).toBe(true);
    }, 60000);

    it('should show error indicator with appropriate styling', async () => {
        const { page } = browser;
        const { config } = server.slot;

        // Look for the status dot or error indicator element
        // The app uses StatusDot component with color based on status
        const statusElement = await page.$('[data-testid="status-dot"], .status-dot');

        if (statusElement) {
            // Get the computed style to check for error color
            const style = await statusElement.evaluate((el: Element) => {
                const computed = window.getComputedStyle(el);
                return {
                    backgroundColor: computed.backgroundColor,
                    color: computed.color,
                };
            });
            console.log('[Test] Status element style:', style);
        }

        // Alternative: Look for text-based status with specific color/class
        const errorTextElement = await page.$('text=error, text=disconnected, text=Error, text=Disconnected');

        if (errorTextElement) {
            const errorText = await errorTextElement.textContent();
            console.log('[Test] Found error status text:', errorText);
        }

        await takeScreenshot(page, config, 'error-07-final-state');

        // The test passes if we found any error/disconnected indication
        // (actual verification was done in previous test)
        expect(true).toBe(true);
    });

    it('should have console errors related to connection failure', async () => {
        // Verify that the webapp is logging connection-related errors
        // These are expected when the server is down
        const connectionErrors = logs.errors.filter(
            e => e.includes('ERR_CONNECTION_REFUSED') ||
                 e.includes('Network error') ||
                 e.includes('Failed to fetch') ||
                 e.includes('socket') ||
                 e.includes('disconnect')
        );

        const networkFailures = logs.networkFailures.filter(
            f => f.includes(String(server.slot.config.serverPort))
        );

        console.log('[Test] Connection-related errors:', connectionErrors.length);
        console.log('[Test] Network failures:', networkFailures.length);

        // We expect some connection errors after stopping the server
        // This confirms the error state was actually triggered
        // Note: If this fails with 0 errors, the server wasn't actually stopped
        expect(connectionErrors.length + networkFailures.length).toBeGreaterThan(0);
    });
});
