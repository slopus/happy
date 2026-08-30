import type { PluginCatalogItem } from '@slopus/happy-wire';
import * as React from 'react';

import { sync } from '@/sync/sync';
import type { PluginCatalogSnapshot } from '@/sync/pluginCatalogStore';

const EMPTY_PLUGIN_CATALOG: readonly PluginCatalogItem[] = [];
const EMPTY_PLUGIN_CATALOG_SNAPSHOT: PluginCatalogSnapshot = {
    status: 'idle',
    plugins: EMPTY_PLUGIN_CATALOG,
    revision: 0,
};
const getEmptyPluginCatalog = () => EMPTY_PLUGIN_CATALOG_SNAPSHOT;
const subscribeToNothing = () => () => undefined;

/** Subscribes active plugin surfaces to the account-specific catalog in the central sync layer. */
export function usePlugins(enabled = true) {
    const catalogSnapshot = React.useSyncExternalStore(
        enabled ? sync.subscribePluginCatalog : subscribeToNothing,
        enabled ? sync.getPluginCatalogSnapshot : getEmptyPluginCatalog,
        getEmptyPluginCatalog,
    );
    const plugins = catalogSnapshot.plugins;
    const loading = enabled && (catalogSnapshot.status === 'idle' || catalogSnapshot.status === 'loading');

    const refresh = React.useCallback(async () => {
        if (!enabled) return null;
        return sync.refreshPluginCatalog();
    }, [enabled]);

    const getPlugin = React.useCallback(
        (pluginId: string) => plugins.find((plugin) => plugin.manifest.id === pluginId) ?? null,
        [plugins],
    );

    return { getPlugin, loading, plugins, refresh, status: catalogSnapshot.status };
}
