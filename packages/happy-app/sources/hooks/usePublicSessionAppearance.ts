import * as React from 'react';
import { UnistylesRuntime } from 'react-native-unistyles';
import { appThemes, resolveThemeName, type AppThemeName, type ThemePackId } from '@/themePacks';

export type PublicSessionAppearanceMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'paws.public-share.appearance-mode';
const DARK_MODE_QUERY = '(prefers-color-scheme: dark)';
const useClientLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;

function browserWindow(): Window | null {
    return typeof window === 'undefined' ? null : window;
}

function readStoredMode(): PublicSessionAppearanceMode {
    try {
        const value = browserWindow()?.localStorage.getItem(STORAGE_KEY);
        return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
    } catch {
        return 'system';
    }
}

function writeStoredMode(mode: PublicSessionAppearanceMode): void {
    try {
        browserWindow()?.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
        // Storage can be unavailable in privacy-restricted browser contexts.
    }
}

function darkModeMediaQuery(): MediaQueryList | null {
    try {
        return browserWindow()?.matchMedia?.(DARK_MODE_QUERY) ?? null;
    } catch {
        return null;
    }
}

function subscribeToMediaQuery(mediaQuery: MediaQueryList, listener: (event: MediaQueryListEvent) => void): () => void {
    if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', listener);
        return () => mediaQuery.removeEventListener('change', listener);
    }
    mediaQuery.addListener(listener);
    return () => mediaQuery.removeListener(listener);
}

function applyPublicTheme(themeName: AppThemeName): void {
    UnistylesRuntime.setTheme(themeName);
    UnistylesRuntime.setRootViewBackgroundColor(appThemes[themeName].colors.groupped.background);
}

export function usePublicSessionAppearance(themePack: ThemePackId): {
    isReady: boolean;
    mode: PublicSessionAppearanceMode;
    setMode: (mode: PublicSessionAppearanceMode) => void;
} {
    const [mode, setMode] = React.useState<PublicSessionAppearanceMode>('system');
    const [systemIsDark, setSystemIsDark] = React.useState(false);
    const [browserReady, setBrowserReady] = React.useState(false);
    const [appliedThemeName, setAppliedThemeName] = React.useState<AppThemeName | null>(null);

    useClientLayoutEffect(() => {
        const previousThemeName = UnistylesRuntime.themeName;
        const previousBackground = UnistylesRuntime.getTheme().colors.groupped.background;
        return () => {
            if (previousThemeName) UnistylesRuntime.setTheme(previousThemeName);
            UnistylesRuntime.setRootViewBackgroundColor(previousBackground);
        };
    }, []);

    useClientLayoutEffect(() => {
        const storedMode = readStoredMode();
        const mediaQuery = darkModeMediaQuery();
        setMode(storedMode);
        setSystemIsDark(mediaQuery?.matches ?? false);
        setBrowserReady(true);
    }, []);

    React.useEffect(() => {
        if (browserReady) writeStoredMode(mode);
    }, [browserReady, mode]);

    useClientLayoutEffect(() => {
        if (!browserReady || mode !== 'system') return;
        const mediaQuery = darkModeMediaQuery();
        if (!mediaQuery) return;
        setSystemIsDark(mediaQuery.matches);
        const handleChange = (event: MediaQueryListEvent) => {
            const themeName = resolveThemeName(themePack, event.matches);
            applyPublicTheme(themeName);
            setAppliedThemeName(themeName);
            setSystemIsDark(event.matches);
        };
        return subscribeToMediaQuery(mediaQuery, handleChange);
    }, [browserReady, mode, themePack]);

    const isDark = mode === 'dark' || (mode === 'system' && systemIsDark);
    const desiredThemeName = browserReady ? resolveThemeName(themePack, isDark) : null;
    useClientLayoutEffect(() => {
        if (!desiredThemeName || appliedThemeName === desiredThemeName) return;
        applyPublicTheme(desiredThemeName);
        setAppliedThemeName(desiredThemeName);
    }, [appliedThemeName, desiredThemeName]);

    const selectMode = React.useCallback((nextMode: PublicSessionAppearanceMode) => {
        const nextSystemIsDark = nextMode === 'system'
            ? darkModeMediaQuery()?.matches ?? false
            : systemIsDark;
        if (browserReady) {
            const nextIsDark = nextMode === 'dark' || (nextMode === 'system' && nextSystemIsDark);
            const themeName = resolveThemeName(themePack, nextIsDark);
            applyPublicTheme(themeName);
            setAppliedThemeName(themeName);
        }
        if (nextMode === 'system') setSystemIsDark(nextSystemIsDark);
        setMode(nextMode);
    }, [browserReady, systemIsDark, themePack]);

    return {
        isReady: desiredThemeName !== null && appliedThemeName === desiredThemeName,
        mode,
        setMode: selectMode,
    };
}
