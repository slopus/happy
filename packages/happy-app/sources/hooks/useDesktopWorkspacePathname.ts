import { usePathname, useRootNavigationState } from 'expo-router';
import { getDesktopModalBackgroundPath } from '@/navigation/desktopModalRouter';

/** Keep the workspace's layout and navigation stable while a desktop dialog is open. */
export function useDesktopWorkspacePathname(): string {
    const pathname = usePathname();
    const state = useRootNavigationState();
    return getDesktopModalBackgroundPath(state) ?? pathname;
}
