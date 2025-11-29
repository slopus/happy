/**
 * E2E Test: Local→Remote Message Handover
 *
 * This test verifies that when switching from Local mode to Remote mode,
 * messages sent in Local mode appear in the webapp.
 *
 * Current expected behavior: This test should FAIL, demonstrating the bug
 * where the webapp shows a blank screen after handover.
 */

import { test, expect, Page } from '@playwright/test';
import { spawn, ChildProcess } from 'child_process';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { allocateTestPorts } from '../utils/ports.mjs';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { createHmac, randomUUID } from 'crypto';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface TestPorts {
    serverPort: number;
    webappPort: number;
    minioPort: number;
    minioConsolePort: number;
    postgresPort: number;
    redisPort: number;
}

interface TestCredentials {
    type: string;
    encryption: {
        publicKey: string;
        machineKey: string;
    };
    token: string;
}

interface TestContext {
    ports: TestPorts;
    homeDir: string;
    serverUrl: string;
    webappUrl: string;
    credentials: TestCredentials;
    webSecretKey: string;
    processes: ChildProcess[];
}

// Helper functions for auth
function encodeBase64(data: Uint8Array): string {
    return Buffer.from(data).toString('base64');
}

function decodeBase64(str: string): Uint8Array {
    return new Uint8Array(Buffer.from(str, 'base64'));
}

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

function deriveContentEncryptionPublicKey(accountSecretKey: Uint8Array) {
    const seed = accountSecretKey.slice(0, 32);
    return deriveKey(seed, 'Happy EnCoder', ['content']);
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

async function waitForUrl(url: string, maxAttempts = 60, delayMs = 1000): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
        try {
            await axios.get(url, { timeout: 1000 });
            return true;
        } catch {
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    return false;
}

async function setupTestEnvironment(): Promise<TestContext> {
    console.log('🔧 Setting up test environment...');

    const ports = await allocateTestPorts();
    console.log(`  Server port: ${ports.serverPort}`);
    console.log(`  Webapp port: ${ports.webappPort}`);
    console.log(`  MinIO port: ${ports.minioPort}`);

    const homeDir = `/tmp/happy-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(homeDir, { recursive: true });
    console.log(`  Home dir: ${homeDir}`);

    const processes: ChildProcess[] = [];

    // Start MinIO
    console.log('  Starting MinIO...');
    const minioDataDir = join(homeDir, 'minio-data');
    await mkdir(minioDataDir, { recursive: true });

    const minioProc = spawn('minio', [
        'server',
        minioDataDir,
        '--address', `:${ports.minioPort}`,
        '--console-address', `:${ports.minioConsolePort}`
    ], {
        env: {
            ...process.env,
            MINIO_ROOT_USER: 'minioadmin',
            MINIO_ROOT_PASSWORD: 'minioadmin'
        },
        stdio: 'pipe'
    });
    processes.push(minioProc);

    const minioReady = await waitForUrl(`http://localhost:${ports.minioPort}/minio/health/live`, 30, 500);
    if (!minioReady) {
        throw new Error('MinIO failed to start');
    }
    console.log('  ✓ MinIO ready');

    // Start server
    console.log('  Starting happy-server...');
    const serverDir = join(ROOT_DIR, 'happy-server');

    const serverProc = spawn('yarn', ['start'], {
        cwd: serverDir,
        env: {
            ...process.env,
            PORT: String(ports.serverPort),
            DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/handy',
            REDIS_URL: 'redis://localhost:6379',
            S3_ENDPOINT: `http://localhost:${ports.minioPort}`,
            S3_BUCKET: `happy-test-${Date.now()}`,
            S3_ACCESS_KEY: 'minioadmin',
            S3_SECRET_KEY: 'minioadmin',
            S3_REGION: 'us-east-1',
            NODE_ENV: 'test'
        },
        stdio: 'pipe'
    });
    processes.push(serverProc);

    const serverReady = await waitForUrl(`http://localhost:${ports.serverPort}/health`, 60, 1000);
    if (!serverReady) {
        throw new Error('Server failed to start');
    }
    console.log('  ✓ Server ready');

    // Setup credentials
    console.log('  Setting up test credentials...');
    const serverUrl = `http://localhost:${ports.serverPort}`;

    // Create test account
    const accountKeypair = tweetnacl.sign.keyPair();
    const challenge = tweetnacl.randomBytes(32);
    const signature = tweetnacl.sign.detached(challenge, accountKeypair.secretKey);

    const authResponse = await axios.post(`${serverUrl}/v1/auth`, {
        publicKey: encodeBase64(accountKeypair.publicKey),
        challenge: encodeBase64(challenge),
        signature: encodeBase64(signature)
    });

    const accountToken = authResponse.data.token;

    // Create CLI auth request
    const cliSecret = tweetnacl.randomBytes(32);
    const cliKeypair = tweetnacl.box.keyPair.fromSecretKey(cliSecret);

    await axios.post(`${serverUrl}/v1/auth/request`, {
        publicKey: encodeBase64(cliKeypair.publicKey),
        supportsV2: true
    });

    // Approve the auth request
    const ephemeralKeypair = tweetnacl.box.keyPair();
    const contentEncryptionPublicKey = deriveContentEncryptionPublicKey(accountKeypair.secretKey);

    const responseData = new Uint8Array(33);
    responseData[0] = 0x00;
    responseData.set(contentEncryptionPublicKey, 1);

    const nonce = tweetnacl.randomBytes(24);
    const encrypted = tweetnacl.box(
        responseData,
        nonce,
        cliKeypair.publicKey,
        ephemeralKeypair.secretKey
    );

    const bundle = new Uint8Array(32 + 24 + encrypted.length);
    bundle.set(ephemeralKeypair.publicKey, 0);
    bundle.set(nonce, 32);
    bundle.set(encrypted, 32 + 24);

    await axios.post(
        `${serverUrl}/v1/auth/response`,
        {
            publicKey: encodeBase64(cliKeypair.publicKey),
            response: encodeBase64(bundle)
        },
        { headers: { 'Authorization': `Bearer ${accountToken}` } }
    );

    // Fetch approved credentials
    const credsResponse = await axios.post(`${serverUrl}/v1/auth/request`, {
        publicKey: encodeBase64(cliKeypair.publicKey),
        supportsV2: true
    });

    const encryptedBundle = decodeBase64(credsResponse.data.response);
    const ephemeralPubKey = encryptedBundle.slice(0, 32);
    const credsNonce = encryptedBundle.slice(32, 56);
    const credsEncrypted = encryptedBundle.slice(56);

    const decrypted = tweetnacl.box.open(
        credsEncrypted,
        credsNonce,
        ephemeralPubKey,
        cliKeypair.secretKey
    );

    if (!decrypted) {
        throw new Error('Failed to decrypt credentials');
    }

    const publicKey = decrypted.slice(1, 33);
    const machineKey = tweetnacl.randomBytes(32);

    const credentials: TestCredentials = {
        type: 'dataKey',
        encryption: {
            publicKey: encodeBase64(publicKey),
            machineKey: encodeBase64(machineKey)
        },
        token: credsResponse.data.token
    };

    // Write credentials to home dir
    await writeFile(join(homeDir, 'access.key'), JSON.stringify(credentials, null, 2));
    await writeFile(join(homeDir, 'settings.json'), JSON.stringify({
        onboardingCompleted: true,
        machineId: randomUUID()
    }, null, 2));

    // Generate web secret key for browser auth
    const secretSeed = accountKeypair.secretKey.slice(0, 32);
    const secretKeyBase64url = Buffer.from(secretSeed).toString('base64url');
    const webSecretKey = formatSecretKeyForBackup(secretKeyBase64url);

    console.log('  ✓ Credentials ready');
    console.log('✅ Test environment ready');

    return {
        ports,
        homeDir,
        serverUrl: `http://localhost:${ports.serverPort}`,
        webappUrl: `http://localhost:${ports.webappPort}`,
        credentials,
        webSecretKey,
        processes
    };
}

async function teardownTestEnvironment(ctx: TestContext) {
    console.log('🧹 Cleaning up test environment...');

    // Kill all processes
    for (const proc of ctx.processes) {
        try {
            proc.kill('SIGTERM');
        } catch {}
    }

    await new Promise(r => setTimeout(r, 1000));

    for (const proc of ctx.processes) {
        try {
            proc.kill('SIGKILL');
        } catch {}
    }

    // Clean up home dir
    if (ctx.homeDir && existsSync(ctx.homeDir)) {
        try {
            await rm(ctx.homeDir, { recursive: true, force: true });
        } catch {}
    }

    console.log('✅ Cleanup complete');
}

test.describe('Message Handover: Local → Remote', () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestEnvironment();
    });

    test.afterAll(async () => {
        if (ctx) {
            await teardownTestEnvironment(ctx);
        }
    });

    test('messages sent in local mode should appear in webapp after handover', async ({ page }) => {
        // Step 1: Create a session with messages via the API (simulating CLI local mode)
        const sessionTag = `test-session-${Date.now()}`;
        const testMessages = [
            { role: 'user', content: { type: 'text', text: 'Hello, this is a test message from local mode' } },
            { role: 'agent', content: { type: 'output', data: { message: { content: [{ type: 'text', text: 'I received your test message!' }] } } } }
        ];

        // Create session via API
        const createSessionResponse = await axios.post(
            `${ctx.serverUrl}/v1/sessions`,
            {
                tag: sessionTag,
                name: 'Test Session',
                cwd: '/tmp/test'
            },
            { headers: { 'Authorization': `Bearer ${ctx.credentials.token}` } }
        );

        const sessionId = createSessionResponse.data.id;
        console.log(`Created test session: ${sessionId}`);

        // Send messages to session via WebSocket or API
        // For now, we'll use the messages API endpoint if available
        // Or we might need to use the socket connection

        // Step 2: Navigate to webapp and authenticate
        await page.goto(ctx.webappUrl);

        // Wait for the app to load
        await page.waitForLoadState('networkidle');

        // The webapp should prompt for authentication
        // We need to enter the secret key
        const secretKeyInput = page.locator('input[placeholder*="secret"]').or(
            page.locator('input[type="password"]')
        ).or(
            page.locator('[data-testid="secret-key-input"]')
        );

        // If auth is needed, enter the secret key
        if (await secretKeyInput.isVisible({ timeout: 5000 }).catch(() => false)) {
            await secretKeyInput.fill(ctx.webSecretKey);
            await page.keyboard.press('Enter');
        }

        // Step 3: Wait for session list to appear and click on our test session
        await page.waitForSelector(`text=${sessionTag}`, { timeout: 30000 });
        await page.click(`text=${sessionTag}`);

        // Step 4: Verify messages are visible
        // This is where the test should FAIL currently (demonstrating the bug)
        const messageContainer = page.locator('[data-testid="message-list"]').or(
            page.locator('.message-container')
        ).or(
            page.locator('[class*="message"]')
        );

        // Wait for messages to load
        await page.waitForTimeout(2000);

        // Check for the user message text
        const userMessageVisible = await page.locator('text=Hello, this is a test message from local mode')
            .isVisible({ timeout: 10000 })
            .catch(() => false);

        // Check for the agent response text
        const agentMessageVisible = await page.locator('text=I received your test message!')
            .isVisible({ timeout: 5000 })
            .catch(() => false);

        // Take a screenshot for debugging
        await page.screenshot({ path: 'test-results/message-handover.png', fullPage: true });

        // This assertion should FAIL, demonstrating the bug
        expect(userMessageVisible).toBe(true);
        expect(agentMessageVisible).toBe(true);
    });

    test('webapp should fetch messages when opening existing session', async ({ page }) => {
        // This test focuses on the message fetching behavior

        // First, create a session with messages directly in the database/API
        const sessionTag = `fetch-test-${Date.now()}`;

        const createResponse = await axios.post(
            `${ctx.serverUrl}/v1/sessions`,
            {
                tag: sessionTag,
                name: 'Fetch Test Session',
                cwd: '/tmp/test'
            },
            { headers: { 'Authorization': `Bearer ${ctx.credentials.token}` } }
        );

        const sessionId = createResponse.data.id;

        // TODO: Add messages to the session via the API
        // This would require understanding the exact message creation endpoint

        // Navigate to webapp
        await page.goto(ctx.webappUrl);
        await page.waitForLoadState('networkidle');

        // Check if we need to authenticate
        const needsAuth = await page.locator('text=Enter your secret key').isVisible({ timeout: 3000 }).catch(() => false);
        if (needsAuth) {
            const input = page.locator('input').first();
            await input.fill(ctx.webSecretKey);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(2000);
        }

        // Look for the session
        const sessionVisible = await page.locator(`text=${sessionTag}`).isVisible({ timeout: 10000 }).catch(() => false);

        // Take screenshot
        await page.screenshot({ path: 'test-results/fetch-test.png', fullPage: true });

        expect(sessionVisible).toBe(true);
    });
});
