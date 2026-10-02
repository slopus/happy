import { decodeBase64, encodeBase64, encodeBase64Url } from "@/api/encryption";
import { configuration } from "@/configuration";
import { randomBytes } from "node:crypto";
import tweetnacl from 'tweetnacl';
import axios from 'axios';
import { displayQRCode } from "./qrcode";
import { delay } from "@/utils/time";
import { writeCredentialsLegacy, readCredentials, updateSettings, Credentials, writeCredentialsDataKey, provisionLegacyMachineKey, readPersistedSessions, readMachineIdentity, writeMachineIdentity, writePrivateFileSync } from "@/persistence";
import { buildMachineIdentity, reusableDataKeyMachineKey, reusableMachineId } from "@/machineIdentity";
import { planDataKeyOnboarding } from "@/datakey/onboarding";
import { existsSync } from "node:fs";
import { generateWebAuthUrl } from "@/api/webAuth";
import { openBrowser } from "@/utils/browser";
import { AuthSelector, AuthMethod } from "./ink/AuthSelector";
import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import { logger } from './logger';

export async function doAuth(): Promise<Credentials | null> {
    console.clear();

    // Show authentication method selector
    const authMethod = await selectAuthenticationMethod();
    if (!authMethod) {
        console.log('\nAuthentication cancelled.\n');
        process.exit(0);
    }

    // Generating ephemeral key
    const secret = new Uint8Array(randomBytes(32));
    const keypair = tweetnacl.box.keyPair.fromSecretKey(secret);

    // Create a new authentication request
    try {
        if (process.env.DEBUG) {
            console.log(`[AUTH DEBUG] Sending auth request to: ${configuration.serverUrl}/v1/auth/request`);
            console.log(`[AUTH DEBUG] Public key: ${encodeBase64(keypair.publicKey).substring(0, 20)}...`);
        }
        await axios.post(`${configuration.serverUrl}/v1/auth/request`, {
            publicKey: encodeBase64(keypair.publicKey),
            supportsV2: true
        }, {
            headers: {
                'X-Happy-Client': `cli/${configuration.currentCliVersion}`
            }
        });
        if (process.env.DEBUG) {
            console.log(`[AUTH DEBUG] Auth request sent successfully`);
        }
    } catch (error) {
        if (process.env.DEBUG) {
            console.log(`[AUTH DEBUG] Failed to send auth request:`, error);
        }
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
async function doMobileAuth(keypair: tweetnacl.BoxKeyPair): Promise<Credentials | null> {
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
async function doWebAuth(keypair: tweetnacl.BoxKeyPair): Promise<Credentials | null> {
    console.clear();
    console.log('\nWeb Authentication\n');

    const webUrl = generateWebAuthUrl(keypair.publicKey);
    console.log('Opening your browser...');

    const browserOpened = await openBrowser(webUrl);

    if (browserOpened) {
        console.log('✓ Browser opened\n');
        console.log('Complete authentication in your browser window.');
    } else {
        console.log('Could not open browser automatically.');
    }

    // I changed this to always show the URL because we got a report from
    // someone running happy inside a devcontainer that they saw the
    // "Complete authentication in your browser window." but nothing opened.
    // https://github.com/slopus/happy/issues/19
    console.log('\nIf the browser did not open, please copy and paste this URL:');
    console.log(webUrl);
    console.log('');

    return await waitForAuthentication(keypair);
}

/**
 * Wait for authentication to complete and return credentials
 */
async function waitForAuthentication(keypair: tweetnacl.BoxKeyPair): Promise<Credentials | null> {
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
                    supportsV2: true
                }, {
                    headers: {
                        'X-Happy-Client': `cli/${configuration.currentCliVersion}`
                    }
                });
                if (response.data.state === 'authorized') {
                    let token = response.data.token as string;
                    let r = decodeBase64(response.data.response);
                    let decrypted = decryptWithEphemeralKey(r, keypair.secretKey);
                    if (decrypted) {
                        if (decrypted.length === 32) {
                            const credentials = {
                                secret: decrypted,
                                token: token
                            }
                            await writeCredentialsLegacy(credentials);
                            console.log('\n\n✓ Authentication successful\n');
                            return {
                                encryption: {
                                    type: 'legacy',
                                    secret: decrypted
                                },
                                token: token
                            };
                        } else {
                            if (decrypted[0] === 0) {
                                const publicKey = decrypted.slice(1, 33);
                                const credentials = {
                                    publicKey,
                                    // The same account on this computer keeps the key its server machine is read with.
                                    machineKey: reusableDataKeyMachineKey(readMachineIdentity(), publicKey) ?? randomBytes(32),
                                    token: token
                                }
                                await writeCredentialsDataKey(credentials);
                                console.log('\n\n✓ Authentication successful\n');
                                return {
                                    encryption: {
                                        type: 'dataKey',
                                        publicKey: credentials.publicKey,
                                        machineKey: credentials.machineKey
                                    },
                                    token: token
                                };
                            } else {
                                console.log('\n\nFailed to decrypt response. Please try again.');
                                return null;
                            }
                        }
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
    credentials: Credentials;
    machineId: string;
    /** aplus §6-1 B1 — settings 에 기록된 서버 서비스 공개키(base64), 없으면 null. */
    serverPublicKey: string | null;
}> {
    logger.debug('[AUTH] Starting auth and machine setup...');

    // Step 1: Handle authentication
    let credentials = await readCredentials();
    let newAuth = false;

    if (!credentials) {
        logger.debug('[AUTH] No credentials found, starting authentication flow...');
        const authResult = await doAuth();
        if (!authResult) {
            throw new Error('Authentication failed or was cancelled');
        }
        credentials = authResult;
        newAuth = true;
    } else {
        logger.debug('[AUTH] Using existing credentials');
    }

    // Make sure we have a machine ID
    // Server machine entity will be created either by the daemon or by the CLI
    // specs/machine-identity-reuse — the same account comes back as the same machine.
    const identity = readMachineIdentity();
    const settings = await updateSettings(async s => {
        if (newAuth || !s.machineId) {
            const reused = reusableMachineId(identity, credentials!);
            if (reused) logger.debug(`[AUTH] Reusing machine ID from the previous login of this account`);
            return {
                ...s,
                machineId: reused ?? randomUUID()
            };
        }
        return s;
    });

    logger.debug(`[AUTH] Machine ID: ${settings.machineId}`);

    // aplus §6-1 Phase 3b — aplus claim setup 이 settings 에 남긴 계정
    // 공개키가 있으면 legacy 자격증명에 머신 키를 1회 병기 provisioning
    // 한다. RPC 는 여전히 legacy secret 로 동작하고(동작 무변경), wrap 된
    // 키는 다음 머신 등록에서 서버로 올라간다. best-effort — 어떤 실패도
    // 시작을 막지 않는다.
    if (credentials.encryption.type === 'legacy'
        && !credentials.encryption.provisioned
        && settings.accountPublicKey) {
        try {
            const previousKey = identity?.machineId === settings.machineId
                ? reusableDataKeyMachineKey(identity, decodeBase64(settings.accountPublicKey))
                : null;
            credentials = await provisionLegacyMachineKey(credentials, settings.accountPublicKey, previousKey ?? undefined);
            logger.debug('[AUTH] Provisioned machine data key for account public key');
        } catch (e) {
            logger.debug('[AUTH] Machine key provisioning failed — continuing in plain legacy mode', e);
        }
    }

    // aplus §6-1 온보딩 (specs/e2ee-datakey-onboarding) — 신규 머신(로컬
    // 세션 이력 0)의 dataKey 계정은 여기서 dataKey-활성으로 자동 승격한다.
    // 이후 세션이 계정 공개키 단독 수신자 DEK 로 등록돼 서버가 콘텐츠를
    // 못 본다. 기존 세션이 있는 머신은 승격하지 않는다(planDataKeyOnboarding
    // 의 has-local-sessions 게이트). best-effort — 실패는 legacy 로 계속.
    try {
        const plan = planDataKeyOnboarding({
            credentials,
            accountPublicKey: settings.accountPublicKey ?? null,
            hasLocalSessions: Object.keys(readPersistedSessions()).length > 0,
        });
        if (plan.ok) {
            const backupPath = `${configuration.privateKeyFile}.legacy-backup`;
            if (!existsSync(backupPath)) {
                writePrivateFileSync(backupPath, JSON.stringify(plan.backup, null, 2));
            }
            writePrivateFileSync(configuration.privateKeyFile, JSON.stringify(plan.serialized, null, 2));
            credentials = (await readCredentials())!;
            logger.debug('[AUTH] Onboarded fresh machine to dataKey-active');
        } else {
            logger.debug(`[AUTH] dataKey onboarding skipped: ${plan.reason}`);
        }
    } catch (e) {
        logger.debug('[AUTH] dataKey onboarding failed — continuing in current mode', e);
    }

    try {
        writeMachineIdentity(buildMachineIdentity(settings.machineId!, credentials, identity));
    } catch (e) {
        // Only the next re-login's reuse is lost; this login is complete.
        logger.debug('[AUTH] Could not record machine identity — the next re-login registers a new machine', e);
    }

    return { credentials, machineId: settings.machineId!, serverPublicKey: settings.serverPublicKey ?? null };
}