import { test, expect } from '@playwright/test';
import * as tweetnacl from 'tweetnacl';

const SERVER_URL = 'http://localhost:3005';
const APP_URL = 'http://localhost:8081';

// ─── Auth helpers ──────────────────────────────────────────────────────────

// Server uses privacy-kit's decodeBase64 which expects standard base64 (not base64url)
function toBase64(buf: Uint8Array): string {
    return Buffer.from(buf).toString('base64');
}

async function createTestAccount(): Promise<{ token: string; secret: string }> {
    const seed = tweetnacl.randomBytes(32);
    const keypair = tweetnacl.sign.keyPair.fromSeed(seed);
    const challenge = tweetnacl.randomBytes(32);
    const signature = tweetnacl.sign.detached(challenge, keypair.secretKey);

    const response = await fetch(`${SERVER_URL}/v1/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            publicKey: toBase64(keypair.publicKey),
            challenge: toBase64(challenge),
            signature: toBase64(signature),
        }),
    });

    if (!response.ok) {
        throw new Error(`Auth failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as { token: string };
    // App's authGetToken uses base64url for the secret
    return { token: data.token, secret: Buffer.from(seed).toString('base64url') };
}

// Navigate to the app pre-authenticated using dev credential query params.
// _layout.tsx reads these via getDevWebQueryCredentials() and auto-logins.
// Note: _layout.tsx strips the params from URL after reading them, so each
// test must pass them fresh.
function authenticatedUrl(token: string, secret: string): string {
    return `${APP_URL}/?dev_token=${encodeURIComponent(token)}&dev_secret=${encodeURIComponent(secret)}`;
}

// ─── Shared credentials (provisioned once per suite) ──────────────────────

let testToken: string;
let testSecret: string;

// ─── Tests ────────────────────────────────────────────────────────────────

test.describe('Smoke Tests', () => {

    test.beforeAll(async () => {
        const creds = await createTestAccount();
        testToken = creds.token;
        testSecret = creds.secret;
    });

    // ── Server ──────────────────────────────────────────────────────────────

    test('standalone server responds', async ({ request }) => {
        const response = await request.get(SERVER_URL);
        expect(response.ok()).toBeTruthy();
    });

    test('auth API creates a valid token', async ({ request }) => {
        const seed = tweetnacl.randomBytes(32);
        const keypair = tweetnacl.sign.keyPair.fromSeed(seed);
        const challenge = tweetnacl.randomBytes(32);
        const signature = tweetnacl.sign.detached(challenge, keypair.secretKey);

        const response = await request.post(`${SERVER_URL}/v1/auth`, {
            data: {
                publicKey: toBase64(keypair.publicKey),
                challenge: toBase64(challenge),
                signature: toBase64(signature),
            },
        });

        expect(response.ok()).toBeTruthy();
        const body = await response.json();
        expect(typeof body.token).toBe('string');
        expect(body.token.length).toBeGreaterThan(0);
    });

    // ── App: unauthenticated ────────────────────────────────────────────────

    test('app loads without crash', async ({ page }) => {
        await page.goto(APP_URL);
        // Page must not be blank — some content rendered
        await expect(page.locator('body')).not.toBeEmpty();
    });

    test('unauthenticated: create account button visible', async ({ page }) => {
        await page.goto(APP_URL);
        // libsodium WASM must load before splash hides — allow generous timeout
        const btn = page.getByTestId('create-account-button');
        await expect(btn).toBeVisible({ timeout: 20_000 });
    });

    // ── App: authenticated ──────────────────────────────────────────────────

    test('authenticated: empty state visible', async ({ page }) => {
        await page.goto(authenticatedUrl(testToken, testSecret));
        // Fresh account has no sessions → EmptyMainScreen renders
        const emptyScreen = page.getByTestId('empty-main-screen');
        await expect(emptyScreen).toBeVisible({ timeout: 20_000 });
    });

});
