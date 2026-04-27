import { anthropicPlugin } from './anthropic'
import { codexPlugin } from './codex'
import { registerPlugin } from './host'

export type {
    AuthState,
    Capability,
    LLMInferenceCapability,
    ModelDescriptor,
    Plugin,
    PluginCategory,
} from './types'
export {
    pluginHost,
    pluginsAtom,
    useInferenceModels,
    usePlugin,
    usePlugins,
} from './host'

let booted = false

/**
 * Boot the plugin host once. Call this from the renderer entry point before
 * the React app mounts so plugins are ready by the time UI subscribes.
 */
export async function bootPlugins(): Promise<void> {
    if (booted) return
    booted = true
    await Promise.all([
        registerPlugin(anthropicPlugin),
        registerPlugin(codexPlugin),
    ])
}
