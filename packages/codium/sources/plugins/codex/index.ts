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
import { runStream, validateToken, type CodexEffort, type CodexParameters } from './provider'

const STORAGE_KEY = 'codium.plugin.codex.token'

const MODELS: ModelDescriptor[] = [
    { id: 'gpt-5.5', label: '5.5', group: 'OpenAI', description: 'Frontier reasoning model.' },
    { id: 'gpt-5.4', label: '5.4', group: 'OpenAI', description: 'Faster, lighter reasoning.' },
]

function mapEffort(eff: InferenceParameters['effort']): CodexEffort | undefined {
    if (!eff) return undefined
    return eff
}

class CodexPlugin implements Plugin {
    id = 'codex'
    name = 'Codex'
    description = 'Use ChatGPT models (GPT 5.5 / 5.4) via the Codex Responses API. Sign in with your ChatGPT account.'
    vendor = 'OpenAI'
    category = 'inference' as const
    accent = '#10a37f'

    private auth: AuthState = { status: 'unconfigured' }
    private token: string | null = null
    private capabilities: Capability[] = []

    async activate(_ctx: PluginContext) {
        const stored = readStored(STORAGE_KEY)
        if (stored) {
            this.token = stored
            this.auth = { status: 'connected' }
            this.capabilities = [this.makeCapability()]
        }
    }

    async connect(credential: string, ctx: PluginContext): Promise<AuthState> {
        const trimmed = credential.trim()
        if (trimmed.length === 0) {
            this.auth = { status: 'error', message: 'Token is empty' }
            ctx.onAuthChanged()
            return this.auth
        }
        this.auth = { status: 'connecting' }
        ctx.onAuthChanged()
        const errMsg = await validateToken(trimmed)
        if (errMsg !== null) {
            this.auth = { status: 'error', message: errMsg }
            this.token = null
            this.capabilities = []
            ctx.onAuthChanged()
            ctx.onCapabilitiesChanged()
            return this.auth
        }
        this.token = trimmed
        writeStored(STORAGE_KEY, trimmed)
        this.auth = { status: 'connected' }
        this.capabilities = [this.makeCapability()]
        ctx.onAuthChanged()
        ctx.onCapabilitiesChanged()
        return this.auth
    }

    async disconnect(ctx: PluginContext) {
        clearStored(STORAGE_KEY)
        this.token = null
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
        if (!this.token) {
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
        yield* runStream(this.token, modelId, context, codexParams)
    }
}

export const codexPlugin: Plugin = new CodexPlugin()

function readStored(key: string): string | null {
    try { return localStorage.getItem(key) } catch { return null }
}
function writeStored(key: string, value: string): void {
    try { localStorage.setItem(key, value) } catch {}
}
function clearStored(key: string): void {
    try { localStorage.removeItem(key) } catch {}
}
