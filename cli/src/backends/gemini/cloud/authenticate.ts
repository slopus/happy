/**
 * Gemini/Google authentication helper
 * 
 * Provides OAuth authentication flow for Google Gemini
 * Uses local callback server to handle OAuth redirect
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { generatePkceCodes } from '@/cloud/pkce';

const execAsync = promisify(exec);

export interface GeminiAuthTokens {
    access_token: string;
    refresh_token?: string;
    token_type: string;
    expires_in: number;
    scope: string;
    id_token?: string;
}

// Google OAuth Configuration for Gemini
const CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_PORT = 54545;
const SCOPES = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

/**
 * Generate random state for OAuth security
 */
function generateState(): string {
    return randomBytes(32).toString('hex');
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
): Promise<GeminiAuthTokens> {
    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code: code,
            code_verifier: verifier,
            redirect_uri: `http://localhost:${port}/oauth2callback`,
        }),
    });
    
    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${error}`);
    }
    
    const data = await response.json() as GeminiAuthTokens;
    return data;
}

/**
 * Start local server to handle OAuth callback
 */
async function startCallbackServer(
    state: string,
    verifier: string,
    port: number
): Promise<GeminiAuthTokens> {
    return new Promise((resolve, reject) => {
        const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            const url = new URL(req.url!, `http://localhost:${port}`);
            
            if (url.pathname === '/oauth2callback') {
                const code = url.searchParams.get('code');
                const receivedState = url.searchParams.get('state');
                const error = url.searchParams.get('error');
                
                if (error) {
                    res.writeHead(302, { 
                        'Location': 'https://developers.google.com/gemini-code-assist/auth_failure_gemini' 
                    });
                    res.end();
                    server.close();
                    reject(new Error(`Authentication error: ${error}`));
                    return;
                }
                
                if (receivedState !== state) {
                    res.writeHead(400);
                    res.end('State mismatch. Possible CSRF attack');
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
                    
                    // Redirect to success page
                    res.writeHead(302, { 
                        'Location': 'https://developers.google.com/gemini-code-assist/auth_success_gemini' 
                    });
                    res.end();
                    
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
 * Authenticate with Google Gemini and return tokens
 * 
 * This function handles the complete OAuth flow:
 * 1. Generates PKCE codes and state
 * 2. Starts local callback server
 * 3. Opens browser for authentication
 * 4. Handles callback and token exchange
 * 5. Returns complete token object
 * 
 * @returns Promise resolving to GeminiAuthTokens with all token information
 */
export async function authenticateGemini(): Promise<GeminiAuthTokens> {
    console.log('🚀 Starting Google Gemini authentication...');
    
    // Generate PKCE codes and state
    const { verifier, challenge } = generatePkceCodes();
    const state = generateState();
    
    // Try to use default port, or find an available one
    let port = DEFAULT_PORT;
    const portAvailable = await isPortAvailable(port);
    
    if (!portAvailable) {
        console.log(`Port ${port} is in use, finding an available port...`);
        port = await findAvailablePort();
    }
    
    console.log(`📡 Using callback port: ${port}`);
    
    // Start callback server FIRST (before opening browser)
    const serverPromise = startCallbackServer(state, verifier, port);
    
    // Wait a moment to ensure server is listening
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Build authorization URL
    const redirect_uri = `http://localhost:${port}/oauth2callback`;
    
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: redirect_uri,
        scope: SCOPES,
        access_type: 'offline',  // To get refresh token
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: state,
        prompt: 'consent',  // Force consent to get refresh token
    });
    
    const authUrl = `${AUTHORIZE_URL}?${params}`;
    
    console.log('\n📋 Opening browser for authentication...');
    console.log('If browser doesn\'t open, visit this URL:');
    console.log(`\n${authUrl}\n`);
    
    // Open browser AFTER server is running
    const platform = process.platform;
    const openCommand = 
        platform === 'darwin' ? 'open' :
        platform === 'win32' ? 'start' :
        'xdg-open';
    
    try {
        await execAsync(`${openCommand} "${authUrl}"`);
    } catch {
        console.log('⚠️  Could not open browser automatically');
    }
    
    // Wait for authentication and return tokens
    try {
        const tokens = await serverPromise;
        
        console.log('\n🎉 Authentication successful!');
        console.log('✅ OAuth tokens received');
        
        return tokens;
    } catch (error) {
        console.error('\n❌ Failed to authenticate with Google');
        throw error;
    }
}
