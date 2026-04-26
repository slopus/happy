/* ─────────────────────────────────────────────────────────────────────────
 * OpenAI Codex (ChatGPT) OAuth + PKCE
 *
 * Direct port of @mariozechner/pi-ai/dist/utils/oauth/openai-codex.js — runs
 * entirely in this Electron main process. No dependency on the Codex CLI.
 *
 *   1. Generate PKCE code_verifier + code_challenge (SHA-256, base64url).
 *   2. Build the authorize URL with the same client_id / scope / extra
 *      params the Codex CLI uses (so OpenAI accepts the request).
 *   3. Start a local HTTP listener on 127.0.0.1:1455 — when the browser
 *      redirects to /auth/callback?code=…&state=…, capture the code.
 *   4. Open the user's default browser at the authorize URL.
 *   5. Exchange the authorization code at /oauth/token, store the access /
 *      refresh tokens.
 *   6. Refresh transparently when the access_token is near expiry.
 *
 * Tokens are persisted to the app's userData directory at
 * `<userData>/codex-auth.json`, NOT `~/.codex/auth.json` — that file is
 * owned by the CLI and we don't want to step on it.
 * ──────────────────────────────────────────────────────────────────────── */
import { app, shell } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { URL } from 'node:url'

const CLIENT_ID     = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const TOKEN_URL     = 'https://auth.openai.com/oauth/token'
const REDIRECT_URI  = 'http://localhost:1455/auth/callback'
const SCOPE         = 'openid profile email offline_access'
const ORIGINATOR    = 'codium'
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

const SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authentication successful</title>
<style>
body { font-family: -apple-system, system-ui, sans-serif; padding: 48px; max-width: 480px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 12px; }
p  { color: #555; line-height: 1.5; margin: 0; }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #10a37f; margin-right: 8px; vertical-align: middle; }
</style>
</head>
<body>
<h1><span class="dot"></span>Authentication successful</h1>
<p>You can close this tab and return to Codium.</p>
</body>
</html>`

const ERROR_HTML = (msg: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Authentication failed</title></head>
<body style="font-family:-apple-system,system-ui,sans-serif;padding:48px;max-width:480px;margin:0 auto">
<h1>Authentication failed</h1><p>${escapeHtml(msg)}</p></body></html>`

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c),
    )
}

/* ─────────── PKCE helpers ─────────── */

function base64UrlEncode(buf: Buffer): string {
    return buf
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
}

function generatePKCE(): { verifier: string; challenge: string } {
    const verifier = base64UrlEncode(randomBytes(32))
    const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest())
    return { verifier, challenge }
}

function generateState(): string {
    return randomBytes(16).toString('hex')
}

/* ─────────── Local callback server ─────────── */

interface CallbackResult {
    code: string
}

interface CallbackServer {
    waitForCode(timeoutMs: number): Promise<CallbackResult>
    cancel(): void
    close(): void
}

function startCallbackServer(expectedState: string): Promise<CallbackServer> {
    return new Promise((resolve, reject) => {
        let captured: CallbackResult | null = null
        let cancelError: Error | null = null
        let resolveNow: ((v: CallbackResult | null) => void) | null = null

        const server: Server = createServer((req, res) => {
            try {
                const url = new URL(req.url ?? '', 'http://localhost')
                if (url.pathname !== '/auth/callback') {
                    res.statusCode = 404
                    res.end('Not found')
                    return
                }
                const error = url.searchParams.get('error')
                if (error) {
                    const description = url.searchParams.get('error_description') ?? error
                    res.statusCode = 400
                    res.setHeader('Content-Type', 'text/html; charset=utf-8')
                    res.end(ERROR_HTML(description))
                    cancelError = new Error(description)
                    resolveNow?.(null)
                    return
                }
                if (url.searchParams.get('state') !== expectedState) {
                    res.statusCode = 400
                    res.setHeader('Content-Type', 'text/html; charset=utf-8')
                    res.end(ERROR_HTML('State mismatch — try signing in again.'))
                    cancelError = new Error('State mismatch')
                    resolveNow?.(null)
                    return
                }
                const code = url.searchParams.get('code')
                if (!code) {
                    res.statusCode = 400
                    res.setHeader('Content-Type', 'text/html; charset=utf-8')
                    res.end(ERROR_HTML('Missing authorization code.'))
                    cancelError = new Error('Missing authorization code')
                    resolveNow?.(null)
                    return
                }
                res.statusCode = 200
                res.setHeader('Content-Type', 'text/html; charset=utf-8')
                res.end(SUCCESS_HTML)
                captured = { code }
                resolveNow?.(captured)
            } catch (err) {
                res.statusCode = 500
                res.end('Internal error')
                cancelError = err instanceof Error ? err : new Error(String(err))
                resolveNow?.(null)
            }
        })

        server.on('error', reject)
        server.listen(1455, '127.0.0.1', () => {
            resolve({
                waitForCode(timeoutMs) {
                    if (captured) return Promise.resolve(captured)
                    return new Promise<CallbackResult>((res, rej) => {
                        const timer = setTimeout(() => {
                            resolveNow = null
                            rej(new Error('OAuth timed out — no callback received'))
                        }, timeoutMs)
                        resolveNow = (v) => {
                            clearTimeout(timer)
                            resolveNow = null
                            if (cancelError) rej(cancelError)
                            else if (v) res(v)
                            else rej(new Error('OAuth cancelled'))
                        }
                    })
                },
                cancel() {
                    cancelError = new Error('OAuth cancelled')
                    resolveNow?.(null)
                },
                close() {
                    try { server.close() } catch {}
                },
            })
        })
    })
}

/* ─────────── Token exchange + refresh ─────────── */

interface TokenResponse {
    access_token: string
    refresh_token: string
    id_token?: string
    expires_in: number
    token_type?: string
}

async function exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type:    'authorization_code',
            client_id:     CLIENT_ID,
            code,
            code_verifier: verifier,
            redirect_uri:  REDIRECT_URI,
        }),
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Token exchange failed (${res.status}): ${text || res.statusText}`)
    }
    const json = (await res.json()) as TokenResponse
    if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
        throw new Error('Token response missing fields')
    }
    return json
}

async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type:    'refresh_token',
            refresh_token: refreshToken,
            client_id:     CLIENT_ID,
        }),
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Token refresh failed (${res.status}): ${text || res.statusText}`)
    }
    const json = (await res.json()) as TokenResponse
    if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
        throw new Error('Refresh response missing fields')
    }
    return json
}

/* ─────────── Token storage ─────────── */

interface StoredTokens {
    access:    string
    refresh:   string
    idToken?:  string
    expiresAt: number
    accountId: string
    email?:    string
}

function authPath(): string {
    return join(app.getPath('userData'), 'codex-auth.json')
}

async function readStored(): Promise<StoredTokens | null> {
    const path = authPath()
    if (!existsSync(path)) return null
    try {
        return JSON.parse(await readFile(path, 'utf8')) as StoredTokens
    } catch {
        return null
    }
}

async function writeStored(tokens: StoredTokens): Promise<void> {
    const path = authPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(tokens, null, 2), { mode: 0o600 })
}

async function clearStored(): Promise<void> {
    const path = authPath()
    if (existsSync(path)) await unlink(path).catch(() => undefined)
}

/* ─────────── JWT helpers ─────────── */

function decodeJwtPayload<T>(jwt: string): T | null {
    const parts = jwt.split('.')
    if (parts.length !== 3) return null
    try {
        let s = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
        while (s.length % 4) s += '='
        return JSON.parse(Buffer.from(s, 'base64').toString('utf8')) as T
    } catch {
        return null
    }
}

function extractAccountId(accessToken: string): string {
    const claims = decodeJwtPayload<{ [k: string]: { chatgpt_account_id?: string } }>(accessToken)
    const id = claims?.[JWT_CLAIM_PATH]?.chatgpt_account_id
    if (!id) throw new Error('Account ID not found in access token')
    return id
}

function extractEmail(idToken: string | undefined): string | undefined {
    if (!idToken) return undefined
    const claims = decodeJwtPayload<{ email?: string }>(idToken)
    return claims?.email
}

/* ─────────── Public API ─────────── */

export interface CodexAuthSnapshot {
    status: 'unconfigured' | 'connected'
    email?: string
    accountId?: string
    accessToken?: string
    expiresAt?: number
}

let activeServer: CallbackServer | null = null

/** Read the current persisted snapshot, refreshing the access token if it's
 *  near expiry. Never throws on network errors — falls back to the stored
 *  token (callers will see a 401 on the first request and re-trigger login). */
export async function getStatus(): Promise<CodexAuthSnapshot> {
    const stored = await readStored()
    if (!stored) return { status: 'unconfigured' }
    const now = Date.now()
    // Refresh if within 60s of expiry
    if (stored.expiresAt - now < 60_000) {
        try {
            const next = await refreshTokens(stored.refresh)
            const accountId = extractAccountId(next.access_token)
            const email = extractEmail(next.id_token) ?? stored.email
            const updated: StoredTokens = {
                access:    next.access_token,
                refresh:   next.refresh_token,
                idToken:   next.id_token,
                expiresAt: now + next.expires_in * 1000,
                accountId,
                email,
            }
            await writeStored(updated)
            return {
                status: 'connected',
                email,
                accountId,
                accessToken: updated.access,
                expiresAt: updated.expiresAt,
            }
        } catch {
            // Fall through and return the stored value — better than nothing.
        }
    }
    return {
        status: 'connected',
        email:       stored.email,
        accountId:   stored.accountId,
        accessToken: stored.access,
        expiresAt:   stored.expiresAt,
    }
}

/** Run the full OAuth flow. Throws on cancel / timeout / token failure. */
export async function login(): Promise<CodexAuthSnapshot> {
    if (activeServer) {
        throw new Error('Codex login already in progress')
    }
    const { verifier, challenge } = generatePKCE()
    const state = generateState()
    const url = new URL(AUTHORIZE_URL)
    url.searchParams.set('response_type',          'code')
    url.searchParams.set('client_id',              CLIENT_ID)
    url.searchParams.set('redirect_uri',           REDIRECT_URI)
    url.searchParams.set('scope',                  SCOPE)
    url.searchParams.set('code_challenge',         challenge)
    url.searchParams.set('code_challenge_method',  'S256')
    url.searchParams.set('state',                  state)
    url.searchParams.set('id_token_add_organizations', 'true')
    url.searchParams.set('codex_cli_simplified_flow',  'true')
    url.searchParams.set('originator',             ORIGINATOR)

    const server = await startCallbackServer(state)
    activeServer = server
    try {
        await shell.openExternal(url.toString())
        const { code } = await server.waitForCode(5 * 60 * 1000)
        const tokens = await exchangeCode(code, verifier)
        const accountId = extractAccountId(tokens.access_token)
        const email = extractEmail(tokens.id_token)
        const stored: StoredTokens = {
            access:    tokens.access_token,
            refresh:   tokens.refresh_token,
            idToken:   tokens.id_token,
            expiresAt: Date.now() + tokens.expires_in * 1000,
            accountId,
            email,
        }
        await writeStored(stored)
        return {
            status: 'connected',
            email,
            accountId,
            accessToken: stored.access,
            expiresAt:   stored.expiresAt,
        }
    } finally {
        try { server.close() } catch {}
        activeServer = null
    }
}

export function cancelLogin(): void {
    if (activeServer) {
        activeServer.cancel()
        try { activeServer.close() } catch {}
        activeServer = null
    }
}

export async function logout(): Promise<void> {
    cancelLogin()
    await clearStored()
}
