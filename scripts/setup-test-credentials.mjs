#!/usr/bin/env node

/**
 * Setup test credentials for headless e2e testing
 *
 * This script:
 * 1. Creates a test account on the server
 * 2. Simulates the CLI auth flow
 * 3. Auto-approves the auth request
 * 4. Writes credentials to the CLI's config directory
 *
 * Usage:
 *   HAPPY_HOME_DIR=~/.happy-dev-test node scripts/setup-test-credentials.mjs
 */

import tweetnacl from 'tweetnacl';
import axios from 'axios';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

const SERVER_URL = process.env.HAPPY_SERVER_URL || 'http://localhost:3005';
const HAPPY_HOME_DIR = process.env.HAPPY_HOME_DIR || join(homedir(), '.happy-dev-test');

console.log('=== Happy Test Credentials Setup ===\n');
console.log(`Server: ${SERVER_URL}`);
console.log(`Home Dir: ${HAPPY_HOME_DIR}\n`);

// Helper functions
function encodeBase64(data) {
    return Buffer.from(data).toString('base64');
}

function decodeBase64(str) {
    return new Uint8Array(Buffer.from(str, 'base64'));
}

/**
 * Step 1: Create a test account (simulates mobile/web client)
 */
async function createTestAccount() {
    console.log('[1/5] Creating test account...');

    const accountKeypair = tweetnacl.sign.keyPair();
    const challenge = tweetnacl.randomBytes(32);
    const signature = tweetnacl.sign.detached(challenge, accountKeypair.secretKey);

    try {
        const response = await axios.post(`${SERVER_URL}/v1/auth`, {
            publicKey: encodeBase64(accountKeypair.publicKey),
            challenge: encodeBase64(challenge),
            signature: encodeBase64(signature)
        });

        console.log('✓ Test account created');
        return {
            keypair: accountKeypair,
            token: response.data.token
        };
    } catch (error) {
        console.error('✗ Failed to create account:', error.response?.data || error.message);
        throw error;
    }
}

/**
 * Step 2: Create CLI auth request (simulates CLI)
 */
async function createCliAuthRequest() {
    console.log('[2/5] Creating CLI auth request...');

    const secret = tweetnacl.randomBytes(32);
    const keypair = tweetnacl.box.keyPair.fromSecretKey(secret);

    try {
        await axios.post(`${SERVER_URL}/v1/auth/request`, {
            publicKey: encodeBase64(keypair.publicKey),
            supportsV2: true
        });

        console.log('✓ CLI auth request created');
        return { secret, keypair };
    } catch (error) {
        console.error('✗ Failed to create auth request:', error.response?.data || error.message);
        throw error;
    }
}

/**
 * Step 3: Approve the auth request (simulates mobile/web client approving)
 */
async function approveAuthRequest(cliKeypair, accountKeypair, accountToken) {
    console.log('[3/5] Approving auth request...');

    // Generate ephemeral keypair for encrypting the response
    const ephemeralKeypair = tweetnacl.box.keyPair();

    // For legacy auth (v1), send the account's secret key (first 32 bytes)
    // For v2, send [0x00, publicKey(32 bytes)]
    // Let's use v2 format
    const responseData = new Uint8Array(33);
    responseData[0] = 0x00; // v2 marker
    responseData.set(accountKeypair.publicKey, 1);

    // Encrypt the response for the CLI
    const nonce = tweetnacl.randomBytes(24);
    const encrypted = tweetnacl.box(
        responseData,
        nonce,
        cliKeypair.publicKey,
        ephemeralKeypair.secretKey
    );

    // Bundle: ephemeral public key (32) + nonce (24) + encrypted data
    const bundle = new Uint8Array(32 + 24 + encrypted.length);
    bundle.set(ephemeralKeypair.publicKey, 0);
    bundle.set(nonce, 32);
    bundle.set(encrypted, 32 + 24);

    try {
        await axios.post(
            `${SERVER_URL}/v1/auth/response`,
            {
                publicKey: encodeBase64(cliKeypair.publicKey),
                response: encodeBase64(bundle)
            },
            {
                headers: {
                    'Authorization': `Bearer ${accountToken}`
                }
            }
        );

        console.log('✓ Auth request approved');
    } catch (error) {
        console.error('✗ Failed to approve auth:', error.response?.data || error.message);
        throw error;
    }
}

/**
 * Step 4: Fetch the approved credentials (simulates CLI polling)
 */
async function fetchApprovedCredentials(cliKeypair) {
    console.log('[4/5] Fetching approved credentials...');

    try {
        const response = await axios.post(`${SERVER_URL}/v1/auth/request`, {
            publicKey: encodeBase64(cliKeypair.publicKey),
            supportsV2: true
        });

        if (response.data.state !== 'authorized') {
            throw new Error('Auth request not yet authorized');
        }

        // Decrypt the response
        const encryptedBundle = decodeBase64(response.data.response);
        const ephemeralPublicKey = encryptedBundle.slice(0, 32);
        const nonce = encryptedBundle.slice(32, 56);
        const encrypted = encryptedBundle.slice(56);

        const decrypted = tweetnacl.box.open(
            encrypted,
            nonce,
            ephemeralPublicKey,
            cliKeypair.secretKey
        );

        if (!decrypted) {
            throw new Error('Failed to decrypt response');
        }

        // Check if it's v2 format (starts with 0x00)
        let credentials;
        if (decrypted[0] === 0x00) {
            const publicKey = decrypted.slice(1, 33);
            const machineKey = tweetnacl.randomBytes(32);

            credentials = {
                type: 'dataKey',
                encryption: {
                    publicKey: encodeBase64(publicKey),
                    machineKey: encodeBase64(machineKey)
                },
                token: response.data.token
            };
        } else {
            // Legacy format
            credentials = {
                type: 'legacy',
                secret: encodeBase64(decrypted),
                token: response.data.token
            };
        }

        console.log('✓ Credentials received');
        return credentials;
    } catch (error) {
        console.error('✗ Failed to fetch credentials:', error.response?.data || error.message);
        throw error;
    }
}

/**
 * Step 5: Write credentials to disk
 */
async function writeCredentials(credentials) {
    console.log('[5/5] Writing credentials to disk...');

    // Ensure directory exists
    if (!existsSync(HAPPY_HOME_DIR)) {
        await mkdir(HAPPY_HOME_DIR, { recursive: true });
    }

    // Write credentials file
    const credsFile = join(HAPPY_HOME_DIR, 'access.key');
    await writeFile(credsFile, JSON.stringify(credentials, null, 2));

    // Write settings file with machine ID
    const settingsFile = join(HAPPY_HOME_DIR, 'settings.json');
    const settings = {
        onboardingCompleted: true,
        machineId: randomUUID()
    };
    await writeFile(settingsFile, JSON.stringify(settings, null, 2));

    console.log('✓ Credentials written');
    console.log(`\nCredentials saved to: ${credsFile}`);
    console.log(`Settings saved to: ${settingsFile}`);
}

/**
 * Main execution
 */
async function main() {
    try {
        // Step 1: Create test account (mobile/web)
        const account = await createTestAccount();

        // Step 2: Create CLI auth request
        const cliAuth = await createCliAuthRequest();

        // Step 3: Approve the request (mobile/web approves CLI)
        await approveAuthRequest(cliAuth.keypair, account.keypair, account.token);

        // Step 4: Fetch approved credentials (CLI polls and gets token)
        const credentials = await fetchApprovedCredentials(cliAuth.keypair);

        // Step 5: Write to disk
        await writeCredentials(credentials);

        console.log('\n✓ Success! Test credentials are ready.');
        console.log(`\nYou can now run the CLI with:`);
        console.log(`  HAPPY_HOME_DIR=${HAPPY_HOME_DIR} HAPPY_SERVER_URL=${SERVER_URL} ./happy-cli/bin/happy.mjs\n`);
        console.log(`Or run the integration tests with:`);
        console.log(`  cd happy-cli && yarn test:integration-test-env\n`);
    } catch (error) {
        console.error('\n✗ Setup failed:', error.message);
        process.exit(1);
    }
}

main();
