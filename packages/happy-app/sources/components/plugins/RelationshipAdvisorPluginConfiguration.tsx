import type { PluginInstallationStatus } from '@slopus/happy-wire';
import * as React from 'react';

import { usePlugins } from '@/hooks/usePlugins';
import { DynamicPluginConfiguration } from './DynamicPluginConfiguration';

type Props = {
    onInstalled?: (status: PluginInstallationStatus) => void | Promise<void>;
    onStatusChanged?: () => void | Promise<void>;
};

/** Host-owned configuration surface; fields still come from the server manifest. */
export const RelationshipAdvisorPluginConfiguration = React.memo(function RelationshipAdvisorPluginConfiguration({
    onInstalled,
    onStatusChanged,
}: Props) {
    const { getPlugin, refresh } = usePlugins();
    const plugin = getPlugin('relationship-advisor');
    if (!plugin) return null;

    return (
        <DynamicPluginConfiguration
            onInstalled={onInstalled}
            onStatusChanged={async () => {
                await refresh();
                await onStatusChanged?.();
            }}
            plugin={plugin}
        />
    );
});
