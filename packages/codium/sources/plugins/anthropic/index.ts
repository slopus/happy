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
    validateApiKey,
    type AnthropicEffort,
    type AnthropicParameters,
} from './provider'

const STORAGE_KEY = 'codium.plugin.anthropic.apiKey'

const MODELS: ModelDescriptor[] = [
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', group: 'Anthropic', description: 'Balanced reasoning + speed.' },
    { id: 'claude-opus-4-6',   label: 'Opus 4.6',   group: 'Anthropic', description: 'Deepest reasoning, slowest.' },
    { id: 'claude-opus-4-7',   label: 'Opus 4.7',   group: 'Anthropic', description: 'Latest Opus generation.' },
]

function mapEffort(eff: InferenceParameters['effort']): AnthropicEffort | undefined {
    if (!eff) return undefined
    if (eff === 'xhigh') return 'xhigh'
    return eff
}

class AnthropicPlugin implements Plugin {
    id = 'anthropic'
    name = 'Anthropic'
    description = 'Direct API access to Claude — Sonnet & Opus models. Bring your own API key.'
    vendor = 'Anthropic'
    category = 'inference' as const
    accent = '#d97757'

    private auth: AuthState = { status: 'unconfigured' }
    private apiKey: string | null = null
    private capabilities: Capability[] = []

    async activate(_ctx: PluginContext) {
        const stored = readStored(STORAGE_KEY)
        if (stored) {
            this.apiKey = stored
            this.auth = { status: 'connected' }
            this.capabilities = [this.makeCapability()]
        }
    }

    async connect(credential: string, ctx: PluginContext): Promise<AuthState> {
        const trimmed = credential.trim()
        if (trimmed.length === 0) {
            this.auth = { status: 'error', message: 'API key is empty' }
            ctx.onAuthChanged()
            return this.auth
        }
        this.auth = { status: 'connecting' }
        ctx.onAuthChanged()
        const errMsg = await validateApiKey(trimmed)
        if (errMsg !== null) {
            this.auth = { status: 'error', message: friendlyError(errMsg) }
            this.apiKey = null
            this.capabilities = []
            ctx.onAuthChanged()
            ctx.onCapabilitiesChanged()
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
            stream: (modelId, ctx, params) => this.streamImpl(modelId, ctx, params),
        }
    }

    private async *streamImpl(
        modelId: string,
        context: InferenceContext,
        params?: InferenceParameters,
    ): AsyncIterable<StreamEvent> {
        if (!this.apiKey) {
            yield {
                type: 'error', reason: 'error',
                message: { role: 'assistant', content: [] },
                error: 'Anthropic plugin not connected',
            }
            return
        }
        const anthropicParams: AnthropicParameters = {
            effort: mapEffort(params?.effort),
            maxTokens: params?.maxTokens,
            signal: params?.signal,
        }
        yield* runStream({ apiKey: this.apiKey }, modelId, context, anthropicParams)
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

function friendlyError(raw: string): string {
    const lower = raw.toLowerCase()
    if (lower.includes('401') || lower.includes('invalid_api_key') || lower.includes('authentication')) {
        return 'Invalid API key. Check it on console.anthropic.com.'
    }
    if (lower.includes('network') || lower.includes('fetch')) {
        return 'Network error. Check your connection.'
    }
    return raw
}
