import { decodeBase64, encodeBase64, encodeBase64Url } from "@/api/encryption";
import { configuration } from "@/configuration";
import { randomBytes } from "node:crypto";
import tweetnacl from 'tweetnacl';
import axios from 'axios';
import { displayQRCode } from "./qrcode";
import { delay } from "@/utils/time";
import { writeCredentials, readCredentials, updateSettings, readSettings } from "@/persistence/persistence";
import { generateWebAuthUrl } from "@/api/webAuth";
import { openBrowser } from "@/utils/browser";
import { AuthSelector, AuthMethod } from "./ink/AuthSelector";
import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import os from 'os';
import { logger } from './logger';
import packageJson from '../../package.json';
import { ApiClient } from '@/api/api';
import { MachineMetadata } from '@/api/types';

export async function doAuth(): Promise<{ secret: Uint8Array, token: string } | null> {
    console.clear();

    // Show authentication method selector
    const authMethod = await selectAuthenticationMethod();
    if (!authMethod) {
        console.log('\nAuthentication cancelled.\n');
        return null;
    }

    // Generating ephemeral key
    const secret = new Uint8Array(randomBytes(32));
    const keypair = tweetnacl.box.keyPair.fromSecretKey(secret);

    // Create a new authentication request
    try {
        console.log(`[AUTH DEBUG] Sending auth request to: ${configuration.serverUrl}/v1/auth/request`);
        console.log(`[AUTH DEBUG] Public key: ${encodeBase64(keypair.publicKey).substring(0, 20)}...`);
        await axios.post(`${configuration.serverUrl}/v1/auth/request`, {
            publicKey: encodeBase64(keypair.publicKey),
        });
        console.log(`[AUTH DEBUG] Auth request sent successfully`);
    } catch (error) {
        console.log(`[AUTH DEBUG] Failed to send auth request:`, error);
        console.log('Failed to create authentication request, please try again later.');
        return null;
    }

    // Handle authentication based on selected method
    if (authMethod === 'mobile') {
        return await doMobileAuth(keypair);
    } else {
        return await doWebAuth(keypair);
    }
}

/**
 * Display authentication method selector and return user choice
 */
function selectAuthenticationMethod(): Promise<AuthMethod | null> {
    return new Promise((resolve) => {
        let hasResolved = false;

        const onSelect = (method: AuthMethod) => {
            if (!hasResolved) {
                hasResolved = true;
                app.unmount();
                resolve(method);
            }
        };

        const onCancel = () => {
            if (!hasResolved) {
                hasResolved = true;
                app.unmount();
                resolve(null);
            }
        };

        const app = render(React.createElement(AuthSelector, { onSelect, onCancel }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    });
}

/**
 * Handle mobile authentication flow
 */
async function doMobileAuth(keypair: tweetnacl.BoxKeyPair): Promise<{ secret: Uint8Array, token: string } | null> {
    console.clear();
    console.log('\nMobile Authentication\n');
    console.log('Scan this QR code with your Happy mobile app:\n');

    const authUrl = 'happy://terminal?' + encodeBase64Url(keypair.publicKey);
    displayQRCode(authUrl);

    console.log('\nOr manually enter this URL:');
    console.log(authUrl);
    console.log('');

    return await waitForAuthentication(keypair);
}

/**
 * Handle web authentication flow
 */
async function doWebAuth(keypair: tweetnacl.BoxKeyPair): Promise<{ secret: Uint8Array, token: string } | null> {
    console.clear();
    console.log('\nWeb Authentication\n');

    const webUrl = generateWebAuthUrl(keypair.publicKey);
    console.log('Opening your browser...');

    const browserOpened = await openBrowser(webUrl);

    if (browserOpened) {
        console.log('✓ Browser opened\n');
        console.log('Complete authentication in your browser window.');
    } else {
        console.log('Could not open browser automatically.\n');
        console.log('Please open this URL manually:');
        console.log(webUrl);
    }
    console.log('');

    return await waitForAuthentication(keypair);
}

/**
 * Wait for authentication to complete and return credentials
 */
async function waitForAuthentication(keypair: tweetnacl.BoxKeyPair): Promise<{ secret: Uint8Array, token: string } | null> {
    process.stdout.write('Waiting for authentication');
    let dots = 0;
    let cancelled = false;

    // Handle Ctrl-C during waiting
    const handleInterrupt = () => {
        cancelled = true;
        console.log('\n\nAuthentication cancelled.');
        process.exit(0);
    };

    process.on('SIGINT', handleInterrupt);

    try {
        while (!cancelled) {
            try {
                const response = await axios.post(`${configuration.serverUrl}/v1/auth/request`, {
                    publicKey: encodeBase64(keypair.publicKey),
                });
                if (response.data.state === 'authorized') {
                    let token = response.data.token as string;
                    let r = decodeBase64(response.data.response);
                    let decrypted = decryptWithEphemeralKey(r, keypair.secretKey);
                    if (decrypted) {
                        const credentials = {
                            secret: decrypted,
                            token: token
                        }
                        await writeCredentials(credentials);
                        console.log('\n\n✓ Authentication successful\n');
                        return credentials;
                    } else {
                        console.log('\n\nFailed to decrypt response. Please try again.');
                        return null;
                    }
                }
            } catch (error) {
                console.log('\n\nFailed to check authentication status. Please try again.');
                return null;
            }

            // Animate waiting dots
            process.stdout.write('\rWaiting for authentication' + '.'.repeat((dots % 3) + 1) + '   ');
            dots++;

            await delay(1000);
        }
    } finally {
        process.off('SIGINT', handleInterrupt);
    }

    return null;
}

export function decryptWithEphemeralKey(encryptedBundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
    // Extract components from bundle: ephemeral public key (32 bytes) + nonce (24 bytes) + encrypted data
    const ephemeralPublicKey = encryptedBundle.slice(0, 32);
    const nonce = encryptedBundle.slice(32, 32 + tweetnacl.box.nonceLength);
    const encrypted = encryptedBundle.slice(32 + tweetnacl.box.nonceLength);

    const decrypted = tweetnacl.box.open(encrypted, nonce, ephemeralPublicKey, recipientSecretKey);
    if (!decrypted) {
        return null;
    }

    return decrypted;
}


/**
 * Ensure authentication and machine setup
 * This replaces the onboarding flow and ensures everything is ready
 */
export async function authAndSetupMachineIfNeeded(): Promise<{
    credentials: { token: string; secret: Uint8Array };
    machineId: string;
}> {
    logger.debug('[AUTH] Starting auth and machine setup...');

    // Step 1: Handle authentication
    let credentials = await readCredentials();

    if (!credentials) {
        logger.debug('[AUTH] No credentials found, starting authentication flow...');
        const authResult = await doAuth();
        if (!authResult) {
            throw new Error('Authentication failed or was cancelled');
        }
        credentials = authResult;
    } else {
        logger.debug('[AUTH] Using existing credentials');
    }

    const settings = await updateSettings(async s => {
        // Machine not created or failed to be created - lets create it
        if (!s.machineId || !s.machineIdConfirmedByServer) {
            const machineId = s.machineId || randomUUID();

            const metadata: MachineMetadata = {
                host: hostname(),
                platform: process.platform,
                happyCliVersion: packageJson.version,
                homeDir: os.homedir(),
                happyHomeDir: configuration.happyHomeDir
            };

            // Choosig to do this synchronously for less variance in control flow
            try {
                const apiClient = new ApiClient(credentials.token, credentials.secret);
                await apiClient.createOrReturnExistingAsIs({
                    machineId,
                    metadata,
                    daemonState: { status: 'offline' }
                });
                await updateSettings(s => {
                    return {
                        ...s,
                        machineIdConfirmedByServer: true
                    }
                });
            } catch (error) {
                logger.debug('[AUTH] Failed to register machine with server, will try again on next cli run:', error);
            }

            // This ID is used as the actual database ID on the server
            // All machine operations use this ID
            return {
                ...s,
                machineId
            };
        }
        return s;
    });

    logger.debug(`[AUTH] Machine ID: ${settings.machineId}`);

    return { credentials, machineId: settings.machineId! };
}