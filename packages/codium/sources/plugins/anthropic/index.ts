import type {
    AuthState,
    Capability,
    LLMInferenceCapability,
    ModelDescriptor,
    Plugin,
    PluginContext,
} from '../types'

const STORAGE_KEY = 'codium.plugin.anthropic.apiKey'

const MODELS: ModelDescriptor[] = [
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', group: 'Anthropic', description: 'Balanced reasoning + speed.' },
    { id: 'claude-opus-4-6',   label: 'Opus 4.6',   group: 'Anthropic', description: 'Deepest reasoning, slowest.' },
    { id: 'claude-opus-4-7',   label: 'Opus 4.7',   group: 'Anthropic', description: 'Latest Opus generation.' },
]

/**
 * Anthropic plugin — auth via API key from localStorage. Inference is
 * driven by the chat runner against the worker-hosted Claude Agent SDK
 * (see boot/main/agent-worker). The plugin itself just exposes models
 * and lends out the API key to the runner.
 */
class AnthropicPlugin implements Plugin {
    id = 'anthropic'
    name = 'Anthropic'
    description = 'Direct API access to Claude — Sonnet & Opus models. Bring your own API key.'
    vendor = 'Anthropic'
    category = 'inference' as const
    accent = '#d97757'

    private auth: AuthState = { status: 'unconfigured' }
    private apiKey: string | null = null
    /** Anthropic models are always exposed in the picker — even before
     *  the user saves a key — because the worker can also pick up
     *  ANTHROPIC_API_KEY from its own environment. */
    private capabilities: Capability[] = [this.makeCapability()]

    async activate(_ctx: PluginContext) {
        const stored = readStored(STORAGE_KEY)
        if (stored) {
            this.apiKey = stored
            this.auth = { status: 'connected' }
        }
    }

    async connect(credential: string, ctx: PluginContext): Promise<AuthState> {
        const trimmed = credential.trim()
        if (trimmed.length === 0) {
            this.auth = { status: 'error', message: 'API key is empty' }
            ctx.onAuthChanged()
            return this.auth
        }
        // Light-weight format check — the Agent SDK will surface real auth
        // failures on the first turn.
        if (!/^sk-[A-Za-z0-9_-]+$/.test(trimmed)) {
            this.auth = { status: 'error', message: 'API key looks malformed (expected sk-…)' }
            ctx.onAuthChanged()
            return this.auth
        }
        this.apiKey = trimmed
        writeStored(STORAGE_KEY, trimmed)
        this.auth = { status: 'connected' }
        this.capabilities = [this.makeCapability()]
        ctx.onAuthChanged()
        ctx.onCapabilitiesChanged()
        return this.auth
    }

    async disconnect(ctx: PluginContext) {
        clearStored(STORAGE_KEY)
        this.apiKey = null
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
            getApiKey: () => this.apiKey,
        }
    }
}

export const anthropicPlugin: Plugin = new AnthropicPlugin()

/* — small storage helpers (renderer-only; localStorage may throw in SSR/test) — */
function readStored(key: string): string | null {
    try { return localStorage.getItem(key) } catch { return null }
}
function writeStored(key: string, value: string): void {
    try { localStorage.setItem(key, value) } catch {}
}
function clearStored(key: string): void {
    try { localStorage.removeItem(key) } catch {}
}
