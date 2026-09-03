import { resolveInstalledPluginEntrypoint } from '@/components/plugins/pluginClientAdapters';
import { usePlugins } from './usePlugins';

type GeneratedImagesPluginStatus = { installed: boolean };

/** Reads the server-owned installation state used to gate generated-image UI surfaces. */
export function useGeneratedImagesPlugin(enabled = true) {
    const { getPlugin, loading, refresh } = usePlugins(enabled);
    const item = getPlugin('generated-images-gallery');
    const entrypoint = item ? resolveInstalledPluginEntrypoint(item) : null;
    const status: GeneratedImagesPluginStatus | null = item
        ? {
            installed: Boolean(entrypoint),
        }
        : null;
    return { loading, status, refresh };
}
