import type { InferenceContext, InferenceParameters, StreamGenerator } from './llm'

/* ─────────────────────────────────────────────────────────────────────────
 * Plugin host types
 *
 * A plugin is a self-contained module bundled with the app. At startup it
 * registers itself with the plugin host and declares which capabilities it
 * provides. The only capability for now is `llm-inference`, which exposes
 * one or more named models and a `stream()` function.
 *
 * Plugins manage their own auth state (API key, session token, OAuth, etc.)
 * and persist it to localStorage under a plugin-scoped key.
 * ──────────────────────────────────────────────────────────────────────── */

/** Display category shown on the plugins catalog page. */
export type PluginCategory = 'inference' | 'tools' | 'integrations'

export type AuthState =
    | { status: 'unconfigured' }
    | { status: 'connecting' }
    | { status: 'connected';   account?: string }
    | { status: 'error';       message: string }

/** What a plugin can do. */
export type Capability = LLMInferenceCapability

export interface LLMInferenceCapability {
    type: 'llm-inference'
    /** Models this plugin exposes (shown in pickers). */
    models: ModelDescriptor[]
    /** Stream a single inference call. */
    stream(modelId: string, ctx: InferenceContext, params?: InferenceParameters): StreamGenerator
}

export interface ModelDescriptor {
    /** Stable id used by the picker / atom. */
    id: string
    /** Human label e.g. "Sonnet 4.6". */
    label: string
    /** Vendor group e.g. "Anthropic". */
    group: string
    /** Optional one-line description. */
    description?: string
}

/** A plugin module registered with the host. */
export interface Plugin {
    /** Stable identifier — also the URL slug in /plugins/<id> and the
     *  localStorage key namespace (`codium.plugin.<id>.*`). */
    id: string
    /** Human-readable name. */
    name: string
    /** One-paragraph description shown on the catalog page. */
    description: string
    /** Vendor / provider name (e.g. "Anthropic", "OpenAI"). */
    vendor: string
    /** Catalog category. */
    category: PluginCategory
    /** Optional URL or imported asset for the plugin's logo. */
    icon?: string
    /** Optional brand color (used as the avatar background fallback). */
    accent?: string

    /** Lifecycle. Called once at startup. The plugin should read its persisted
     *  auth state and register capabilities if connected. */
    activate(ctx: PluginContext): Promise<void> | void

    /** Validate the user-supplied credential. Resolves with the new auth state. */
    connect(credential: string, ctx: PluginContext): Promise<AuthState>

    /** Drop credentials and capabilities. */
    disconnect(ctx: PluginContext): Promise<void> | void

    /** Snapshot of the current auth state (for the UI). */
    getAuthState(): AuthState

    /** Active capabilities the plugin currently exposes. Empty when
     *  disconnected. */
    getCapabilities(): readonly Capability[]
}

/**
 * Surface the plugin host exposes to plugins. Lets a plugin emit events when
 * its auth state changes so the UI can re-render without polling.
 */
export interface PluginContext {
    onAuthChanged(): void
    onCapabilitiesChanged(): void
}
