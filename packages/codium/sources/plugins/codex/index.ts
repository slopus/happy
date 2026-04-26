import type {
    InferenceContext,
    InferenceParameters,
    StreamEvent,
} from '../llm'
import type {
    AuthState,
    Capability,
    LLMInferenceCapability,
    ModelDescriptor,
    Plugin,
    PluginContext,
} from '../types'
import {
    runStream,
    validateCredential,
    type CodexCredential,
    type CodexEffort,
    type CodexParameters,
} from './provider'

const MODELS: ModelDescriptor[] = [
    { id: 'gpt-5.5', label: '5.5', group: 'OpenAI', description: 'Frontier reasoning model.' },
    { id: 'gpt-5.4', label: '5.4', group: 'OpenAI', description: 'Faster, lighter reasoning.' },
]

function mapEffort(eff: InferenceParameters['effort']): CodexEffort | undefined {
    if (!eff) return undefined
    return eff
}

/**
 * Codex plugin — auth flows through the official Codex CLI's OAuth.
 *
 *   1. User clicks "Sign in with Codex" in the plugin detail page.
 *   2. The renderer calls `window.codexAuth.login()`.
 *   3. The main process spawns `codex login` (the CLI), which runs the
 *      Authorization Code + PKCE flow against `auth.openai.com`, opens the
 *      user's default browser, runs a local listener on port 1455 for the
 *      callback, exchanges the code for tokens, and writes
 *      `~/.codex/auth.json`.
 *   4. The main process reads `auth.json`, decodes the access_token JWT for
 *      its expiry + the id_token JWT for the email, and returns a snapshot.
 *   5. We persist nothing in localStorage — the OAuth tokens live in the
 *      Codex CLI's auth.json and we re-read them on every activate. The
 *      access token is used as the Authorization Bearer to the Responses
 *      API; the account_id from the JWT goes into the `chatgpt-account-id`
 *      header.
 */
class CodexPlugin implements Plugin {
    id = 'codex'
    name = 'Codex'
    description = 'Use ChatGPT models (GPT 5.5 / 5.4) via Codex. Sign in with your ChatGPT account.'
    vendor = 'OpenAI'
    category = 'inference' as const
    accent = '#10a37f'

    private auth: AuthState = { status: 'unconfigured' }
    private credential: CodexCredential | null = null
    private capabilities: Capability[] = []

    async activate(_ctx: PluginContext) {
        try {
            const snap = await window.codexAuth.status()
            if (snap.status === 'connected' && snap.accessToken && snap.accountId) {
                this.credential = { accessToken: snap.accessToken, accountId: snap.accountId }
                this.auth = { status: 'connected', account: snap.email }
                this.capabilities = [this.makeCapability()]
            }
        } catch (err) {
            // codexAuth IPC isn't available (browser preview or missing preload) — leave unconfigured.
            console.warn('codex plugin: cannot read CLI auth.json', err)
        }
    }

    /**
     * `connect()` ignores its credential argument — Codex auth is OAuth via
     * the CLI, not a paste box. Calling this triggers the login flow.
     */
    async connect(_credential: string, ctx: PluginContext): Promise<AuthState> {
        try {
            this.auth = { status: 'connecting' }
            ctx.onAuthChanged()
            const snap = await window.codexAuth.login()
            if (snap.status !== 'connected' || !snap.accessToken || !snap.accountId) {
                this.auth = { status: 'error', message: 'Login finished but no tokens were written.' }
                ctx.onAuthChanged()
                return this.auth
            }
            const cred: CodexCredential = { accessToken: snap.accessToken, accountId: snap.accountId }
            const errMsg = await validateCredential(cred)
            if (errMsg !== null) {
                this.auth = { status: 'error', message: errMsg }
                this.credential = null
                this.capabilities = []
                ctx.onAuthChanged()
                ctx.onCapabilitiesChanged()
                return this.auth
            }
            this.credential = cred
            this.auth = { status: 'connected', account: snap.email }
            this.capabilities = [this.makeCapability()]
            ctx.onAuthChanged()
            ctx.onCapabilitiesChanged()
            return this.auth
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            this.auth = { status: 'error', message: msg }
            ctx.onAuthChanged()
            return this.auth
        }
    }

    async disconnect(ctx: PluginContext) {
        try { await window.codexAuth.logout() } catch {}
        this.credential = null
        this.auth = { status: 'unconfigured' }
        this.capabilities = []
        ctx.onAuthChanged()
        ctx.onCapabilitiesChanged()
    }

    getAuthState(): AuthState { return this.auth }
    getCapabilities(): readonly Capability[] { return this.capabilities }

    private makeCapability(): LLMInferenceCapability {
        return {
            type: 'llm-inference',
            models: MODELS,
            stream: (modelId, ctx, params) => this.streamImpl(modelId, ctx, params),
        }
    }

    private async *streamImpl(
        modelId: string,
        context: InferenceContext,
        params?: InferenceParameters,
    ): AsyncIterable<StreamEvent> {
        if (!this.credential) {
            yield {
                type: 'error', reason: 'error',
                message: { role: 'assistant', content: [] },
                error: 'Codex plugin not connected',
            }
            return
        }
        const codexParams: CodexParameters = {
            effort: mapEffort(params?.effort),
            signal: params?.signal,
        }
        yield* runStream(this.credential, modelId, context, codexParams)
    }
}

export const codexPlugin: Plugin = new CodexPlugin()
