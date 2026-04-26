import { atom, useAtomValue } from 'jotai'
import { useEffect, useState } from 'react'
import type {
    LLMInferenceCapability,
    ModelDescriptor,
    Plugin,
    PluginContext,
} from './types'

/* ─────────────────────────────────────────────────────────────────────────
 * Plugin host
 *
 * Singleton registry. Plugins register at app startup; the UI subscribes via
 * `pluginsAtom` (jotai) or the `usePlugins()` hook.
 *
 * Responsibilities the host owns:
 *  - keep the canonical list of registered plugins
 *  - notify subscribers when a plugin's auth or capabilities change
 *  - provide aggregate views (e.g. all models across plugins with the
 *    `llm-inference` capability) for the model picker
 *
 * Plugins own their own auth persistence (see plugins/anthropic, plugins/codex).
 * ──────────────────────────────────────────────────────────────────────── */

interface HostState {
    plugins: Plugin[]
    /** Bumped on every state change so jotai re-renders subscribers. */
    revision: number
}

let state: HostState = { plugins: [], revision: 0 }
const listeners = new Set<() => void>()

function emit() {
    state = { ...state, revision: state.revision + 1 }
    for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
}

/** Internal — only plugins/index.ts should call this on startup. */
export async function registerPlugin(plugin: Plugin): Promise<void> {
    if (state.plugins.some((p) => p.id === plugin.id)) {
        // eslint-disable-next-line no-console
        console.warn(`[plugins] duplicate id "${plugin.id}", skipping`)
        return
    }
    state = { plugins: [...state.plugins, plugin], revision: state.revision }
    const ctx: PluginContext = {
        onAuthChanged: emit,
        onCapabilitiesChanged: emit,
    }
    try {
        await plugin.activate(ctx)
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[plugins] activate failed for "${plugin.id}"`, err)
    }
    emit()
}

export const pluginHost = {
    /** All registered plugins. */
    all(): readonly Plugin[] {
        return state.plugins
    },
    /** Look up by id. */
    get(id: string): Plugin | undefined {
        return state.plugins.find((p) => p.id === id)
    },
    /** Subscribe to state changes (returns an unsubscribe fn). */
    subscribe,
    /** Connect to a plugin by passing its credential. */
    async connect(id: string, credential: string): Promise<void> {
        const plugin = pluginHost.get(id)
        if (!plugin) throw new Error(`unknown plugin: ${id}`)
        const ctx: PluginContext = { onAuthChanged: emit, onCapabilitiesChanged: emit }
        await plugin.connect(credential, ctx)
        emit()
    },
    /** Disconnect a plugin. */
    async disconnect(id: string): Promise<void> {
        const plugin = pluginHost.get(id)
        if (!plugin) return
        const ctx: PluginContext = { onAuthChanged: emit, onCapabilitiesChanged: emit }
        await plugin.disconnect(ctx)
        emit()
    },
    /** Aggregate every model exposed by every connected llm-inference plugin. */
    inferenceModels(): { plugin: Plugin; model: ModelDescriptor }[] {
        const out: { plugin: Plugin; model: ModelDescriptor }[] = []
        for (const plugin of state.plugins) {
            for (const cap of plugin.getCapabilities()) {
                if (cap.type !== 'llm-inference') continue
                for (const model of cap.models) out.push({ plugin, model })
            }
        }
        return out
    },
    /** Find the inference capability that owns a model id. */
    inferenceFor(modelId: string): { plugin: Plugin; cap: LLMInferenceCapability } | undefined {
        for (const plugin of state.plugins) {
            for (const cap of plugin.getCapabilities()) {
                if (cap.type !== 'llm-inference') continue
                if (cap.models.some((m) => m.id === modelId)) {
                    return { plugin, cap }
                }
            }
        }
        return undefined
    },
}

/* ─── jotai bridge ────────────────────────────────────────────────────── */

const subscribePluginHost = (cb: () => void) => subscribe(cb)

const baseAtom = atom(0)
baseAtom.onMount = (set) => {
    const off = subscribe(() => set((n) => n + 1))
    return off
}

export const pluginsAtom = atom((get) => {
    get(baseAtom) // re-evaluate on revision bump
    return state.plugins
})

/** React hook returning the current plugin list. Re-renders on host changes. */
export function usePlugins(): readonly Plugin[] {
    const [, force] = useState(0)
    useEffect(() => subscribe(() => force((n) => n + 1)), [])
    return state.plugins
}

/** Convenience hook returning a plugin by id. */
export function usePlugin(id: string): Plugin | undefined {
    const list = usePlugins()
    return list.find((p) => p.id === id)
}

/** Hook returning all `(plugin, model)` pairs across connected inference plugins. */
export function useInferenceModels() {
    useAtomValue(pluginsAtom) // subscribe
    return pluginHost.inferenceModels()
}

export { subscribePluginHost }
