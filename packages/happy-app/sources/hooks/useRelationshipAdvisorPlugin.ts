import { resolveInstalledPluginEntrypoint } from '@/components/plugins/pluginClientAdapters';
import { usePlugins } from './usePlugins';

type RelationshipAdvisorPluginStatus =
    | { installed: false }
    | { installed: true; baseUrl: string; model: string; keyHint: string };

/** Loads the server-owned plugin state only while its UI surface is active. */
export function useRelationshipAdvisorPlugin(enabled = true) {
    const { getPlugin, loading, refresh } = usePlugins(enabled);
    const item = getPlugin('relationship-advisor');
    const entrypoint = item ? resolveInstalledPluginEntrypoint(item) : null;
    const status: RelationshipAdvisorPluginStatus | null = item
        ? item.status.installed && entrypoint
            ? {
                installed: true,
                baseUrl: item.status.configuration.baseUrl,
                model: item.status.configuration.model,
                keyHint: item.status.secretHints.apiKey,
            }
            : { installed: false }
        : null;
    return { loading, status, refresh };
}
