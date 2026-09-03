import * as React from 'react';

import { RelationshipAdvisorSidebarHistory } from '../relationship-advisor/RelationshipAdvisorSidebarHistory';
import { usePluginSurfaceViews } from './usePluginSurfaceViews';

export const PluginLeftSidebarSlot = React.memo(function PluginLeftSidebarSlot({
    desktopDensity = false,
    fill = false,
    onNavigate,
}: {
    desktopDensity?: boolean;
    fill?: boolean;
    onNavigate: (path: string) => void;
}) {
    const views = usePluginSurfaceViews('left-sidebar');

    return views.map((view) => {
        if (view.componentId !== 'relationship-advisor-history') return null;
        return (
            <RelationshipAdvisorSidebarHistory
                desktopDensity={desktopDensity}
                fill={fill}
                key={`${view.pluginId}:${view.viewId}`}
                onNavigate={onNavigate}
            />
        );
    });
});
