import type {
    AuthState,
    Capability,
    Plugin,
    PluginContext,
} from '../types'

/**
 * Codex plugin — auth-only for now. The agent worker is built on Claude
 * Agent SDK, which only speaks Anthropic. Once an OpenAI-compatible path
 * lands, this plugin can declare its own llm-inference capability.
 */
class CodexPlugin implements Plugin {
    id = 'codex'
    name = 'Codex'
    description = 'Sign in with your ChatGPT account. (Inference via Codex coming soon — currently auth-only.)'
    vendor = 'OpenAI'
    category = 'inference' as const
    accent = '#10a37f'

    private auth: AuthState = { status: 'unconfigured' }
    private capabilities: Capability[] = []

    async activate(_ctx: PluginContext) {
        try {
            const snap = await window.codexAuth.status()
            if (snap.status === 'connected') {
                this.auth = { status: 'connected', account: snap.email }
            }
        } catch {
            /* codexAuth IPC not available — leave unconfigured. */
        }
    }

    async connect(_credential: string, ctx: PluginContext): Promise<AuthState> {
        try {
            this.auth = { status: 'connecting' }
            ctx.onAuthChanged()
            const snap = await window.codexAuth.login()
            if (snap.status !== 'connected') {
                this.auth = { status: 'error', message: 'Login finished but no tokens were written.' }
                ctx.onAuthChanged()
                return this.auth
            }
            this.auth = { status: 'connected', account: snap.email }
            ctx.onAuthChanged()
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
        this.auth = { status: 'unconfigured' }
        ctx.onAuthChanged()
    }

    getAuthState(): AuthState { return this.auth }
    getCapabilities(): readonly Capability[] { return this.capabilities }
}

export const codexPlugin: Plugin = new CodexPlugin()
