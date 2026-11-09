import { Platform, useWindowDimensions } from 'react-native';
import { isDesktopRightPanelAvailable } from '@/utils/desktopNavigationLayout';
import { useDesktopWorkspaceLayout } from './useDesktopWorkspaceLayout';

/** Capability is independent of whether the current route displays its right panel. */
export function useDesktopFileWorkspaceAvailable() {
    const { enabled } = useDesktopWorkspaceLayout();
    const { width } = useWindowDimensions();
    return Platform.OS === 'web' && enabled && isDesktopRightPanelAvailable({
        isTablet: true, supportsPersistentPanel: true, windowWidth: width,
    });
}
