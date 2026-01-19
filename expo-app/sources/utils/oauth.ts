import { getRandomBytes } from 'expo-crypto';
import * as Crypto from 'expo-crypto';

// OAuth Configuration for Claude.ai
export const CLAUDE_OAUTH_CONFIG = {
    CLIENT_ID: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    AUTHORIZE_URL: 'https://claude.ai/oauth/authorize',
    TOKEN_URL: 'https://console.anthropic.com/v1/oauth/token',
    REDIRECT_URI: 'http://localhost:54545/callback',
    SCOPE: 'user:inference',
};

export interface PKCECodes {
    verifier: string;
    challenge: string;
}

export interface ClaudeAuthTokens {
    raw: any;
    token: string;
    expires: number;
}

/**
 * Convert Uint8Array to base64url string
 */
function base64urlEncode(buffer: Uint8Array): string {
    // Convert to base64
    const base64 = btoa(String.fromCharCode(...buffer));

    // Convert to base64url
    return base64
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

/**
 * Generate PKCE codes for OAuth flow
 */
export async function generatePKCE(): Promise<PKCECodes> {
    // Generate code verifier (43-128 characters, base64url)
    const verifierBytes = getRandomBytes(32);
    const verifier = base64urlEncode(verifierBytes);

    // Generate code challenge (SHA256 of verifier, base64url encoded)
    const challengeBytes = await Crypto.digest(
        Crypto.CryptoDigestAlgorithm.SHA256,
        new TextEncoder().encode(verifier)
    );
    const challenge = base64urlEncode(new Uint8Array(challengeBytes));

    return { verifier, challenge };
}

/**
 * Generate random state for OAuth security
 */
export function generateState(): string {
    const stateBytes = getRandomBytes(32);
    return base64urlEncode(stateBytes);
}

/**
 * Build OAuth authorization URL
 */
export function buildAuthorizationUrl(challenge: string, state: string): string {
    const params = new URLSearchParams({
        code: 'true',  // This tells Claude.ai to show the code AND redirect
        client_id: CLAUDE_OAUTH_CONFIG.CLIENT_ID,
        response_type: 'code',
        redirect_uri: CLAUDE_OAUTH_CONFIG.REDIRECT_URI,
        scope: CLAUDE_OAUTH_CONFIG.SCOPE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: state,
    });

    return `${CLAUDE_OAUTH_CONFIG.AUTHORIZE_URL}?${params}`;
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(
    code: string,
    verifier: string,
    state: string
): Promise<ClaudeAuthTokens> {
    const tokenResponse = await fetch(CLAUDE_OAUTH_CONFIG.TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: CLAUDE_OAUTH_CONFIG.REDIRECT_URI,
            client_id: CLAUDE_OAUTH_CONFIG.CLIENT_ID,
            code_verifier: verifier,
            state: state,
        }),
    });

    if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        throw new Error(`Token exchange failed: ${tokenResponse.statusText} - ${errorText}`);
    }

    const tokenData = await tokenResponse.json() as any;

    return {
        raw: tokenData,
        token: tokenData.access_token,
        expires: Date.now() + tokenData.expires_in * 1000,
    };
}

/**
 * Parse authorization code from callback URL
 */
export function parseCallbackUrl(url: string): { code?: string; state?: string; error?: string } {
    try {
        const urlObj = new URL(url);

        // Check if this is our callback URL
        if (!url.includes('localhost') || !urlObj.pathname.includes('/callback')) {
            return {};
        }

        const code = urlObj.searchParams.get('code');
        const state = urlObj.searchParams.get('state');
        const error = urlObj.searchParams.get('error');

        return {
            code: code || undefined,
            state: state || undefined,
            error: error || undefined,
        };
    } catch {
        return {};
    }
}