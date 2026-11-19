import { Platform, useWindowDimensions } from 'react-native';
import { isDesktopRightPanelAvailable } from '@/utils/desktopNavigationLayout';

/** Physical capability survives dialog layout isolation and collapsed sidebars. */
export function useDesktopFileWorkspaceAvailable() {
    const { width } = useWindowDimensions();
    return Platform.OS === 'web' && isDesktopRightPanelAvailable({
        isTablet: true, supportsPersistentPanel: true, windowWidth: width,
    });
}
