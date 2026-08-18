import { useLocalSearchParams, useRouter } from 'expo-router';
import * as React from 'react';

export type SettingsModalParams = Record<string, string | undefined>;

export type SettingsModalRouter = {
    back: () => void;
    navigate: (href: any) => void;
    push: (href: any) => void;
    replace: (href: any) => void;
};

type SettingsNavigationContextValue = {
    params: SettingsModalParams;
    router: SettingsModalRouter;
};

export const DesktopSettingsNavigationContext = React.createContext<SettingsNavigationContextValue | null>(null);

export function useSettingsRouter(): SettingsModalRouter | ReturnType<typeof useRouter> {
    const appRouter = useRouter();
    const navigation = React.useContext(DesktopSettingsNavigationContext);
    return navigation?.router ?? appRouter;
}

export function useSettingsSearchParams<T extends SettingsModalParams>(): T {
    const routeParams = useLocalSearchParams();
    const navigation = React.useContext(DesktopSettingsNavigationContext);
    return (navigation?.params ?? routeParams) as T;
}
