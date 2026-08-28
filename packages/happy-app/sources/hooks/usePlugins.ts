import type { PluginCatalogItem } from '@slopus/happy-wire';
import * as React from 'react';

import { sync } from '@/sync/sync';

const EMPTY_PLUGIN_CATALOG: readonly PluginCatalogItem[] = [];
const getEmptyPluginCatalog = () => EMPTY_PLUGIN_CATALOG;
const subscribeToNothing = () => () => undefined;

/** Subscribes active plugin surfaces to the account-specific catalog in the central sync layer. */
export function usePlugins(enabled = true) {
    const catalogSnapshot = React.useSyncExternalStore(
        enabled ? sync.subscribePluginCatalog : subscribeToNothing,
        enabled ? sync.getPluginCatalogSnapshot : getEmptyPluginCatalog,
        getEmptyPluginCatalog,
    );
    const plugins: readonly PluginCatalogItem[] = catalogSnapshot;
    const [loading, setLoading] = React.useState(enabled);
    const mountedRef = React.useRef(true);
    const requestGenerationRef = React.useRef(0);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const refresh = React.useCallback(async () => {
        if (!enabled) return null;
        const requestGeneration = ++requestGenerationRef.current;
        setLoading(true);
        try {
            return await sync.refreshPluginCatalog();
        } finally {
            if (mountedRef.current && requestGeneration === requestGenerationRef.current) {
                setLoading(false);
            }
        }
    }, [enabled]);

    React.useEffect(() => {
        if (!enabled) {
            requestGenerationRef.current++;
            setLoading(false);
            return;
        }
        void refresh().catch(() => undefined);
    }, [enabled, refresh]);

    const getPlugin = React.useCallback(
        (pluginId: string) => plugins.find((plugin) => plugin.manifest.id === pluginId) ?? null,
        [plugins],
    );

    return { getPlugin, loading, plugins, refresh };
}
