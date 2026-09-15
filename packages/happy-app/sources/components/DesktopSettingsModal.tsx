import { useRouter } from 'expo-router';
import * as React from 'react';
import { Platform } from 'react-native';
import { useIsTablet } from '@/utils/responsive';

type DesktopSettingsModalController = {
    isDesktop: boolean;
    openSettings: () => void;
    openActivity: () => void;
    openRoute: (pathname: string, params?: Record<string, string>) => void;
};

const DesktopSettingsModalContext = React.createContext<DesktopSettingsModalController | null>(null);

export function useDesktopSettingsModal(): DesktopSettingsModalController {
    const controller = React.useContext(DesktopSettingsModalContext);
    if (!controller) throw new Error('useDesktopSettingsModal must be used within DesktopSettingsModalProvider');
    return controller;
}

/** Entry points only; the app navigator owns modal history and screen rendering. */
export function DesktopSettingsModalProvider({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const isTablet = useIsTablet();
    const isDesktop = Platform.OS === 'web' && isTablet;
    const openRoute = React.useCallback((pathname: string, params?: Record<string, string>) => {
        if (isDesktop) {
            router.push({ pathname, params: { ...params, desktopModal: '1' } } as any);
            return;
        }

        router.push((params ? { pathname, params } : pathname) as any);
    }, [isDesktop, router]);
    const controller = React.useMemo(() => ({
        isDesktop,
        openSettings: () => openRoute('/settings'),
        openActivity: () => openRoute('/inbox'),
        openRoute,
    }), [isDesktop, openRoute]);
    return <DesktopSettingsModalContext.Provider value={controller}>{children}</DesktopSettingsModalContext.Provider>;
}
