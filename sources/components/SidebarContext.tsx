import * as React from 'react';
import { useLocalSettings, storage } from '@/sync/storage';
import { useIsTablet } from '@/utils/responsive';

interface SidebarContextValue {
    isCollapsed: boolean;
    toggleCollapsed: () => void;
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

export const SidebarProvider = React.memo(({ children }: { children: React.ReactNode }) => {
    const localSettings = useLocalSettings();
    const isTablet = useIsTablet();
    const isCollapsed = isTablet && localSettings.sidebarCollapsed;

    const toggleCollapsed = React.useCallback(() => {
        storage.getState().applyLocalSettings({
            sidebarCollapsed: !localSettings.sidebarCollapsed
        });
    }, [localSettings.sidebarCollapsed]);

    const value = React.useMemo(() => ({
        isCollapsed,
        toggleCollapsed,
    }), [isCollapsed, toggleCollapsed]);

    return (
        <SidebarContext.Provider value={value}>
            {children}
        </SidebarContext.Provider>
    );
});

export function useSidebar(): SidebarContextValue {
    const context = React.useContext(SidebarContext);
    if (!context) {
        throw new Error('useSidebar must be used within a SidebarProvider');
    }
    return context;
}

// Width constants for sidebar
export const SIDEBAR_WIDTH_COLLAPSED = 72;
export const SIDEBAR_WIDTH_MIN = 250;
export const SIDEBAR_WIDTH_MAX = 360;
