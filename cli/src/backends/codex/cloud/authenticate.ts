/**
 * Codex authentication helper
 * 
 * Provides OAuth authentication flow for OpenAI/ChatGPT
 * Returns full token object without storing or refreshing
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { openBrowser } from '@/ui/openBrowser';
import { generatePkceCodes } from '@/cloud/pkce';

export interface CodexAuthTokens {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id: string;
}

// Configuration
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_BASE_URL = 'https://auth.openai.com';
const DEFAULT_PORT = 1455;

/**
 * Generate random state for OAuth security
 */
function generateState(): string {
    return randomBytes(16).toString('hex');
}

/**
 * Parse JWT token to extract payload
 */
function parseJWT(token: string): any {
    const parts = token.split('.');
    if (parts.length !== 3) {
        throw new Error('Invalid JWT format');
    }

    const payload = Buffer.from(parts[1], 'base64url').toString();
    return JSON.parse(payload);
}

/**
 * Find an available port for the callback server
 */
async function findAvailablePort(): Promise<number> {
    return new Promise((resolve) => {
        const server = createServer();
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as any).port;
            server.close(() => resolve(port));
        });
    });
}

/**
 * Check if a port is available
 */
async function isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const testServer = createServer();
        testServer.once('error', () => {
            testServer.close();
            resolve(false);
        });
        testServer.listen(port, '127.0.0.1', () => {
            testServer.close(() => resolve(true));
        });
    });
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCodeForTokens(
    code: string,
    verifier: string,
    port: number
): Promise<CodexAuthTokens> {
    const response = await fetch(`${AUTH_BASE_URL}/oauth/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            code: code,
            code_verifier: verifier,
            redirect_uri: `http://localhost:${port}/auth/callback`,
        }),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${error}`);
    }

    const data = (await response.json() as any);

    // Parse ID token to get account ID
    const idTokenPayload = parseJWT(data.id_token);

    // The account ID is stored at chatgpt_account_id in the payload
    let accountId = idTokenPayload.chatgpt_account_id;

    // Check nested location
    if (!accountId) {
        const authClaim = idTokenPayload['https://api.openai.com/auth'];
        if (authClaim && typeof authClaim === 'object') {
            accountId = authClaim.chatgpt_account_id || authClaim.account_id;
        }
    }

    return {
        id_token: data.id_token,
        access_token: data.access_token || data.id_token,
        refresh_token: data.refresh_token,
        account_id: accountId,
    };
}

/**
 * Start local server to handle OAuth callback
 */
async function startCallbackServer(
    state: string,
    verifier: string,
    port: number
): Promise<CodexAuthTokens> {
    return new Promise((resolve, reject) => {
        const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            const url = new URL(req.url!, `http://localhost:${port}`);

            if (url.pathname === '/auth/callback') {
                const code = url.searchParams.get('code');
                const receivedState = url.searchParams.get('state');

                if (receivedState !== state) {
                    res.writeHead(400);
                    res.end('Invalid state parameter');
                    server.close();
                    reject(new Error('Invalid state parameter'));
                    return;
                }

                if (!code) {
                    res.writeHead(400);
                    res.end('No authorization code received');
                    server.close();
                    reject(new Error('No authorization code received'));
                    return;
                }

                try {
                    // Exchange code for tokens
                    const tokens = await exchangeCodeForTokens(code, verifier, port);

                    // Send success response to browser
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(`
                        <html>
                        <body style="font-family: sans-serif; padding: 20px;">
                            <h2>✅ Authentication Successful!</h2>
                            <p>You can close this window and return to your terminal.</p>
                            <script>setTimeout(() => window.close(), 3000);</script>
                        </body>
                        </html>
                    `);

                    server.close();
                    resolve(tokens);
                } catch (error) {
                    res.writeHead(500);
                    res.end('Token exchange failed');
                    server.close();
                    reject(error);
                }
            }
        });

        server.listen(port, '127.0.0.1', () => {
            // console.log(`🔐 OAuth callback server listening on port ${port}`);
        });

        // Timeout after 5 minutes
        setTimeout(() => {
            server.close();
            reject(new Error('Authentication timeout'));
        }, 5 * 60 * 1000);
    });
}

/**
 * Authenticate with Codex/OpenAI and return tokens
 * 
 * This function handles the complete OAuth flow:
 * 1. Generates PKCE codes and state
 * 2. Starts local callback server
 * 3. Opens browser for authentication
 * 4. Handles callback and token exchange
 * 5. Returns complete token object
 * 
 * @returns Promise resolving to CodexAuthTokens with all token information
 */
export async function authenticateCodex(): Promise<CodexAuthTokens> {
    // console.log('🚀 Starting Codex authentication...');

    // Generate PKCE codes and state
    const { verifier, challenge } = generatePkceCodes();
    const state = generateState();

    // Try to use default port, or find an available one
    let port = DEFAULT_PORT;
    const portAvailable = await isPortAvailable(port);

    if (!portAvailable) {
        // console.log(`Port ${port} is in use, finding an available port...`);
        port = await findAvailablePort();
    }

    // console.log(`📡 Using callback port: ${port}`);

    // Start callback server FIRST (before opening browser)
    const serverPromise = startCallbackServer(state, verifier, port);

    // Wait a moment to ensure server is listening
    await new Promise(resolve => setTimeout(resolve, 100));

    // Build authorization URL
    const redirect_uri = `http://localhost:${port}/auth/callback`;

    // Build query parameters manually to ensure proper encoding
    const params = [
        ['response_type', 'code'],
        ['client_id', CLIENT_ID],
        ['redirect_uri', redirect_uri],
        ['scope', 'openid profile email offline_access'],
        ['code_challenge', challenge],
        ['code_challenge_method', 'S256'],
        ['id_token_add_organizations', 'true'],
        ['codex_cli_simplified_flow', 'true'],
        ['state', state],
    ];

    const queryString = params
        .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
        .join('&');

    // Use /oauth/authorize path
    const authUrl = `${AUTH_BASE_URL}/oauth/authorize?${queryString}`;

    console.log('📋 Opening browser for authentication...');
    console.log(`If browser doesn't open, visit:\n${authUrl}\n`);

    // Open browser AFTER server is running
    await openBrowser(authUrl);

    // Wait for authentication and return tokens
    const tokens = await serverPromise;

    console.log('🎉 Authentication successful!');
    // console.log(`Account ID: ${tokens.account_id || 'N/A'}`);

    return tokens;
}
