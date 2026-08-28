import type { PluginViewSurface } from '@slopus/happy-wire';
import * as React from 'react';

import { usePlugins } from '@/hooks/usePlugins';
import { resolveInstalledPluginSurfaceViews } from './pluginClientAdapters';

export function usePluginSurfaceViews(surface: PluginViewSurface) {
    const { plugins } = usePlugins();
    return React.useMemo(
        () => resolveInstalledPluginSurfaceViews(plugins, surface),
        [plugins, surface],
    );
}
