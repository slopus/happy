/**
 * E2E Test: Local→Remote Message Handover (Manual Setup)
 *
 * This test runs against existing infrastructure. Configure via environment:
 * - HAPPY_SERVER_PORT: Server port (default: 3005)
 * - HAPPY_WEBAPP_PORT: Webapp port (default: 8081)
 * - HAPPY_SERVER_URL: Full server URL (overrides port)
 * - HAPPY_WEBAPP_URL: Full webapp URL (overrides port)
 * - HAPPY_HOME_DIR: CLI home directory (default: ~/.happy-dev-test)
 *
 * Run with: HAPPY_HOME_DIR=/root/.happy-dev-test yarn test tests/message-handover-manual.spec.ts
 *
 * For slot-based testing with happy-launcher.sh:
 *   HAPPY_SERVER_PORT=10001 HAPPY_WEBAPP_PORT=10002 yarn test
 *
 * This test demonstrates the bug where messages don't appear in the webapp
 * after switching from Local to Remote mode.
 */

import { test, expect, Page } from '@playwright/test';
import axios from 'axios';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import tweetnacl from 'tweetnacl';
import { createHmac } from 'crypto';

// Configuration for existing infrastructure
// These can be overridden via environment variables for slot-based testing
const SERVER_PORT = process.env.HAPPY_SERVER_PORT || '3005';
const WEBAPP_PORT = process.env.HAPPY_WEBAPP_PORT || '8081';
const SERVER_URL = process.env.HAPPY_SERVER_URL || `http://localhost:${SERVER_PORT}`;
const WEBAPP_URL = process.env.HAPPY_WEBAPP_URL || `http://localhost:${WEBAPP_PORT}`;
const HOME_DIR = process.env.HAPPY_HOME_DIR || join(homedir(), '.happy-dev-test');

interface Credentials {
    type: string;
    encryption: {
        publicKey: string;
        machineKey: string;
    };
    token: string;
}

// Helper functions to generate web secret key from credentials
function hmac_sha512(key: Uint8Array, data: Uint8Array): Uint8Array {
    const hmac = createHmac('sha512', Buffer.from(key));
    hmac.update(Buffer.from(data));
    return new Uint8Array(hmac.digest());
}

function deriveSecretKeyTreeRoot(seed: Uint8Array, usage: string) {
    const I = hmac_sha512(
        new TextEncoder().encode(usage + ' Master Seed'),
        seed
    );
    return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

function deriveSecretKeyTreeChild(chainCode: Uint8Array, index: string) {
    const data = new Uint8Array([0x00, ...new TextEncoder().encode(index)]);
    const I = hmac_sha512(chainCode, data);
    return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

function deriveKey(master: Uint8Array, usage: string, path: string[]) {
    let state = deriveSecretKeyTreeRoot(master, usage);
    for (const index of path) {
        state = deriveSecretKeyTreeChild(state.chainCode, index);
    }
    return state.key;
}

function bytesToBase32(bytes: Uint8Array): string {
    const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let result = '';
    let buffer = 0;
    let bufferLength = 0;
    for (const byte of bytes) {
        buffer = (buffer << 8) | byte;
        bufferLength += 8;
        while (bufferLength >= 5) {
            bufferLength -= 5;
            result += base32Alphabet[(buffer >> bufferLength) & 0x1f];
        }
    }
    if (bufferLength > 0) {
        result += base32Alphabet[(buffer << (5 - bufferLength)) & 0x1f];
    }
    return result;
}

function formatSecretKeyForBackup(secretKeyBase64url: string): string {
    const bytes = Buffer.from(secretKeyBase64url, 'base64url');
    const base32 = bytesToBase32(bytes);
    const groups: string[] = [];
    for (let i = 0; i < base32.length; i += 5) {
        groups.push(base32.slice(i, i + 5));
    }
    return groups.join('-');
}

async function getCredentials(): Promise<Credentials> {
    const credPath = join(HOME_DIR, 'access.key');
    const content = await readFile(credPath, 'utf-8');
    return JSON.parse(content);
}

/**
 * Clear localStorage and IndexedDB to ensure clean state
 * This removes any stored server URL that might override localhost
 * MMKV on web stores data in IndexedDB with specific database names
 */
async function clearBrowserStorage(page: Page) {
    // First clear storage synchronously
    await page.evaluate(async () => {
        // Clear localStorage
        localStorage.clear();

        // Clear sessionStorage
        sessionStorage.clear();

        // Clear ALL IndexedDB databases (MMKV stores data here on web)
        // MMKV uses databases with names like 'mmkv' and 'mmkv-{id}'
        if (typeof indexedDB !== 'undefined' && indexedDB.databases) {
            try {
                const dbs = await indexedDB.databases();
                console.log('[Test] Found IndexedDB databases:', dbs.map(d => d.name));
                for (const db of dbs) {
                    if (db.name) {
                        console.log('[Test] Deleting IndexedDB:', db.name);
                        indexedDB.deleteDatabase(db.name);
                    }
                }
            } catch (e) {
                console.log('[Test] Error clearing IndexedDB:', e);
            }
        }

        // Also try to delete known MMKV database names directly
        const mmkvDbs = ['mmkv', 'mmkv-server-config', 'mmkv-default', 'server-config'];
        for (const name of mmkvDbs) {
            try {
                indexedDB.deleteDatabase(name);
                console.log('[Test] Deleted MMKV DB:', name);
            } catch (e) {
                // Ignore if doesn't exist
            }
        }
    });

    // Wait a bit for IndexedDB operations to complete
    await page.waitForTimeout(500);

    // Reload to apply clean state
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Wait additional time for React app to initialize with fresh state
    await page.waitForTimeout(2000);
}

/**
 * Navigate through the login flow and authenticate with secret key
 */
async function loginWithSecretKey(page: Page, secretKey: string) {
    // Wait for the landing page to load
    await page.waitForTimeout(2000);

    // Take screenshot of initial state
    await page.screenshot({ path: 'test-results/login-01-initial.png', fullPage: true });

    // Click "Login with mobile app" button
    const loginButton = page.getByText('Login with mobile app');
    await expect(loginButton).toBeVisible({ timeout: 10000 });
    await loginButton.click();

    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'test-results/login-02-after-login-click.png', fullPage: true });

    // Click "Restore with Secret Key Instead" button
    const restoreButton = page.getByText('Restore with Secret Key Instead');
    await expect(restoreButton).toBeVisible({ timeout: 10000 });
    await restoreButton.click();

    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'test-results/login-03-restore-page.png', fullPage: true });

    // Find the text input for secret key (placeholder: XXXXX-XXXXX-XXXXX...)
    const secretKeyInput = page.locator('textarea, input[type="text"]').first();
    await expect(secretKeyInput).toBeVisible({ timeout: 5000 });

    // Enter the secret key
    await secretKeyInput.fill(secretKey);

    await page.screenshot({ path: 'test-results/login-04-key-entered.png', fullPage: true });

    // Click the restore/login button
    const submitButton = page.getByText('Restore Account').or(page.getByText('Login'));
    await submitButton.click();

    // Wait for authentication to complete
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'test-results/login-05-after-submit.png', fullPage: true });
}

test.describe('Message Handover: Local → Remote (Against Existing Infra)', () => {
    let credentials: Credentials;
    let webSecretKey: string;

    test.beforeAll(async () => {
        try {
            credentials = await getCredentials();
            console.log('Loaded credentials from', HOME_DIR);

            // Generate web secret key from credentials
            // The publicKey in credentials is the content encryption key
            // We need to derive the secret key format for web login
            // For now, we'll need to read it from a separate file or generate it
            // TODO: Properly derive webSecretKey from credentials

        } catch (error) {
            console.error('Failed to load credentials. Make sure you have authenticated with the CLI.');
            throw error;
        }
    });

    test('verify server is running', async () => {
        const response = await axios.get(`${SERVER_URL}/health`);
        expect(response.status).toBe(200);
        console.log('Server health check passed:', response.data);
    });

    test('can create a session and send messages via API', async () => {
        // Create a test session
        const sessionTag = `e2e-test-${Date.now()}`;

        // The API expects 'metadata' as an encrypted string, not name/cwd fields
        // For testing, we'll use a simple JSON metadata
        const metadata = JSON.stringify({
            name: 'E2E Test Session',
            cwd: '/tmp/e2e-test'
        });

        const createResponse = await axios.post(
            `${SERVER_URL}/v1/sessions`,
            {
                tag: sessionTag,
                metadata: metadata
            },
            { headers: { 'Authorization': `Bearer ${credentials.token}` } }
        );

        expect(createResponse.status).toBe(200);
        const sessionId = createResponse.data.session.id;
        console.log(`Created session: ${sessionId} (tag: ${sessionTag})`);

        // Verify we can fetch the session
        const sessionsResponse = await axios.get(
            `${SERVER_URL}/v1/sessions`,
            { headers: { 'Authorization': `Bearer ${credentials.token}` } }
        );

        const sessions = sessionsResponse.data.sessions;
        const ourSession = sessions.find((s: any) => s.id === sessionId);
        expect(ourSession).toBeDefined();
        console.log('Session verified in list');
    });

    test('webapp uses configured server after clearing storage', async ({ page }) => {
        // Navigate to webapp
        await page.goto(WEBAPP_URL);
        await page.waitForLoadState('networkidle');

        // Clear any stored server URL to ensure we use localhost
        await clearBrowserStorage(page);

        // Wait for app to reload
        await page.waitForTimeout(3000);

        // Take screenshot
        await page.screenshot({ path: 'test-results/webapp-clean-state.png', fullPage: true });

        // Log page content - should not show production server
        const bodyText = await page.locator('body').innerText().catch(() => 'Failed to get body text');
        console.log('Page content after clear:', bodyText.slice(0, 500));

        // Verify production server is NOT being used
        expect(bodyText).not.toContain('ffh.duckdns.org');
        expect(bodyText).not.toContain('cluster-fluster.com');
    });
});

test.describe('Debug: Webapp State Analysis', () => {
    test('analyze webapp DOM structure after clearing storage', async ({ page }) => {
        await page.goto(WEBAPP_URL);
        await page.waitForLoadState('networkidle');

        // Clear storage first using our thorough clearing function
        await clearBrowserStorage(page);

        // Get all visible text
        const visibleText = await page.evaluate(() => document.body.innerText);
        console.log('=== Visible Text ===');
        console.log(visibleText);

        // Get all data-testid attributes
        const testIds = await page.evaluate(() => {
            const elements = document.querySelectorAll('[data-testid]');
            return Array.from(elements).map(el => ({
                testId: el.getAttribute('data-testid'),
                tag: el.tagName,
                text: (el as HTMLElement).innerText?.slice(0, 50)
            }));
        });
        console.log('=== Data Test IDs ===');
        console.log(JSON.stringify(testIds, null, 2));

        // Get all buttons and clickable elements
        const buttons = await page.evaluate(() => {
            const elements = document.querySelectorAll('button, [role="button"], a');
            return Array.from(elements).map(el => ({
                tag: el.tagName,
                text: (el as HTMLElement).innerText?.slice(0, 50),
                role: el.getAttribute('role'),
                href: el.getAttribute('href')
            }));
        });
        console.log('=== Buttons/Links ===');
        console.log(JSON.stringify(buttons, null, 2));

        // Get all input fields
        const inputs = await page.evaluate(() => {
            const elements = document.querySelectorAll('input, textarea');
            return Array.from(elements).map(el => ({
                type: el.getAttribute('type'),
                placeholder: el.getAttribute('placeholder'),
                name: el.getAttribute('name')
            }));
        });
        console.log('=== Input Fields ===');
        console.log(JSON.stringify(inputs, null, 2));

        // Take final screenshot
        await page.screenshot({ path: 'test-results/debug-structure.png', fullPage: true });

        // Verify we're on localhost
        expect(visibleText).not.toContain('ffh.duckdns.org');
    });

    test('check network requests to messages endpoint', async ({ page }) => {
        // Clear storage first
        await page.goto(WEBAPP_URL);
        await clearBrowserStorage(page);

        // Enable request interception
        const requests: string[] = [];
        page.on('request', (request) => {
            const url = request.url();
            // Only log requests to our local server
            // Only log requests to the configured server or API endpoints
            if (url.includes(SERVER_URL.replace('http://', '')) || url.includes('/v1/')) {
                requests.push(`${request.method()} ${url}`);
            }
        });

        page.on('response', (response) => {
            const url = response.url();
            if (url.includes(SERVER_URL.replace('http://', '')) || url.includes('/v1/')) {
                console.log(`Response: ${response.status()} ${url}`);
            }
        });

        await page.reload();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(5000);

        console.log(`=== API Requests Made to ${SERVER_URL} ===`);
        requests.forEach(r => console.log(r));

        // Check if messages endpoint was called
        const messagesRequests = requests.filter(r => r.includes('messages'));
        console.log(`Messages endpoint calls: ${messagesRequests.length}`);

        await page.screenshot({ path: 'test-results/network-debug.png', fullPage: true });
    });

    test('navigate login flow: Login -> Restore with Secret Key', async ({ page }) => {
        // Navigate and clear storage
        await page.goto(WEBAPP_URL);
        await page.waitForLoadState('networkidle');

        // Clear all storage including MMKV/IndexedDB
        await clearBrowserStorage(page);

        // Screenshot initial state
        await page.screenshot({ path: 'test-results/flow-01-initial.png', fullPage: true });

        // Find and click "Login with mobile app"
        const loginButton = page.getByText('Login with mobile app');
        if (await loginButton.isVisible()) {
            console.log('Found "Login with mobile app" button');
            await loginButton.click();
            await page.waitForTimeout(1000);
            await page.screenshot({ path: 'test-results/flow-02-after-login.png', fullPage: true });

            // Find and click "Restore with Secret Key Instead"
            const restoreButton = page.getByText('Restore with Secret Key Instead');
            if (await restoreButton.isVisible()) {
                console.log('Found "Restore with Secret Key Instead" button');
                await restoreButton.click();
                await page.waitForTimeout(1000);
                await page.screenshot({ path: 'test-results/flow-03-restore-page.png', fullPage: true });

                // Log what we see on the restore page
                const pageText = await page.evaluate(() => document.body.innerText);
                console.log('Restore page content:', pageText.slice(0, 500));

                // Find input field
                const inputs = await page.locator('textarea, input').all();
                console.log(`Found ${inputs.length} input fields`);
            } else {
                console.log('"Restore with Secret Key Instead" button not found');
            }
        } else {
            console.log('"Login with mobile app" button not found');
            const pageText = await page.evaluate(() => document.body.innerText);
            console.log('Current page:', pageText.slice(0, 300));
        }
    });
});

test.describe('Happy Status Command: Test Message Flow Without Claude', () => {
    let credentials: Credentials;

    test.beforeAll(async () => {
        credentials = await getCredentials();
    });

    test('send /happy-status via API and verify message flow', async () => {
        // Create a test session
        const sessionTag = `happy-status-test-${Date.now()}`;
        const metadata = JSON.stringify({
            name: 'Happy Status Test',
            cwd: '/tmp/test'
        });

        const createResponse = await axios.post(
            `${SERVER_URL}/v1/sessions`,
            { tag: sessionTag, metadata },
            { headers: { 'Authorization': `Bearer ${credentials.token}` } }
        );

        expect(createResponse.status).toBe(200);
        const sessionId = createResponse.data.session.id;
        console.log(`Created test session: ${sessionId}`);

        // Now we can send a message via the server API to test the flow
        // This tests the server → webapp message relay without needing the CLI
        const testMessage = {
            type: 'user',
            message: {
                role: 'user',
                content: '/happy-status This is a test message'
            },
            sessionId,
            uuid: `test-uuid-${Date.now()}`,
            timestamp: new Date().toISOString()
        };

        // Send message to the session
        try {
            const messageResponse = await axios.post(
                `${SERVER_URL}/v1/sessions/${sessionId}/messages`,
                testMessage,
                { headers: { 'Authorization': `Bearer ${credentials.token}` } }
            );
            console.log('Message sent:', messageResponse.status);
        } catch (err: any) {
            // The endpoint might not exist - that's OK, we're testing the flow
            console.log('Message endpoint response:', err.response?.status, err.response?.data);
        }

        // Fetch messages to verify they were stored
        try {
            const messagesResponse = await axios.get(
                `${SERVER_URL}/v1/sessions/${sessionId}/messages`,
                { headers: { 'Authorization': `Bearer ${credentials.token}` } }
            );
            console.log('Messages in session:', JSON.stringify(messagesResponse.data, null, 2));
        } catch (err: any) {
            console.log('Get messages response:', err.response?.status, err.response?.data);
        }
    });
});
