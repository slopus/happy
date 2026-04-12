/**
 * GitHub Copilot authentication helper
 *
 * Provides OAuth device flow authentication for GitHub Copilot.
 * Uses GitHub's device authorization grant (RFC 8628) — no local
 * callback server needed. The user visits a short URL and enters a
 * one-time code shown in the terminal.
 */

import { CopilotAuthTokens } from './types';

// The GitHub CLI's well-known OAuth client ID (public, device-flow only)
const CLIENT_ID = '178c6fc778ccc68e1d6a';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const SCOPES = 'read:user copilot';
const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 5 * 60_000;

interface DeviceCodeResponse {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
}

interface TokenPollResponse {
    access_token?: string;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
}

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
    const response = await fetch(DEVICE_CODE_URL, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            client_id: CLIENT_ID,
            scope: SCOPES,
        }),
    });

    if (!response.ok) {
        throw new Error(`Device code request failed: ${response.statusText}`);
    }

    return response.json() as Promise<DeviceCodeResponse>;
}

async function pollForToken(deviceCode: string, intervalMs: number): Promise<CopilotAuthTokens> {
    const deadline = Date.now() + TIMEOUT_MS;

    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));

        const response = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                device_code: deviceCode,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            }),
        });

        if (!response.ok) {
            throw new Error(`Token poll request failed: ${response.statusText}`);
        }

        const data = await response.json() as TokenPollResponse;

        if (data.access_token) {
            return {
                access_token: data.access_token,
                token_type: data.token_type ?? 'bearer',
                scope: data.scope ?? SCOPES,
            };
        }

        if (data.error === 'authorization_pending' || data.error === 'slow_down') {
            // Keep polling — slow_down adds 5 seconds per spec
            if (data.error === 'slow_down') {
                intervalMs += 5_000;
            }
            continue;
        }

        throw new Error(data.error_description ?? data.error ?? 'Unknown error during token poll');
    }

    throw new Error('Authentication timeout — no response within 5 minutes');
}

/**
 * Authenticate with GitHub for Copilot access using the device flow.
 *
 * Flow:
 * 1. Request a device code from GitHub
 * 2. Print the one-time code and URL for the user
 * 3. Poll until the user completes authorization
 * 4. Return the resulting access token
 */
export async function authenticateCopilot(): Promise<CopilotAuthTokens> {
    console.log('🚀 Starting GitHub Copilot authentication...');

    const { device_code, user_code, verification_uri, interval } = await requestDeviceCode();

    console.log('\n📋 Open the following URL in your browser:');
    console.log(`\n  ${verification_uri}\n`);
    console.log('Then enter this code when prompted:');
    console.log(`\n  ${user_code}\n`);
    console.log('Waiting for authorization...');

    const tokens = await pollForToken(device_code, Math.max(interval * 1000, POLL_INTERVAL_MS));

    console.log('🎉 Authentication successful!');
    return tokens;
}
