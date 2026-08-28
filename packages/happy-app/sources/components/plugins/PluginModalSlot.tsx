import type { PluginCatalogItem } from '@slopus/happy-wire';
import * as React from 'react';

import { DynamicPluginConfiguration } from './DynamicPluginConfiguration';
import { resolveInstalledPluginView } from './pluginClientAdapters';

interface Props {
    plugin: PluginCatalogItem;
    onInstalled?: () => void;
    onOpen?: () => void;
    onStatusChanged?: () => void | Promise<void>;
}

export const PluginModalSlot = React.memo(function PluginModalSlot({
    plugin,
    onInstalled,
    onOpen,
    onStatusChanged,
}: Props) {
    const viewId = plugin.manifest.entrypoint.type === 'configuration'
        ? plugin.manifest.entrypoint.viewId
        : plugin.manifest.contributes.views.find((view) => view.surface === 'modal')?.id;
    if (!viewId) return null;

    const view = resolveInstalledPluginView(plugin, viewId, 'modal');
    if (view?.componentId !== 'plugin-configuration') return null;

    return (
        <DynamicPluginConfiguration
            onInstalled={onInstalled}
            onOpen={onOpen}
            onStatusChanged={onStatusChanged}
            plugin={plugin}
        />
    );
});
