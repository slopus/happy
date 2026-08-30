import 'react-native-quick-base64';
import '../theme.css';
import * as React from 'react';
import * as SplashScreen from 'expo-splash-screen';
import { Slot, usePathname } from 'expo-router';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { initialWindowMetrics, SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useUnistyles } from 'react-native-unistyles';
import { ThemeCaptureRoot } from '@/components/ThemeTransition';
import { StatusBarProvider } from '@/components/StatusBarProvider';
import { isPublicSessionSharePath } from '@/utils/publicSessionShareRouting';
import { loadAppRootFonts } from '@/components/appRoot/appRootFonts';

const AuthenticatedRootLayout = React.lazy(() => import('@/components/appRoot/AuthenticatedRootLayout'));

export { ErrorBoundary } from 'expo-router';

SplashScreen.setOptions({ fade: true, duration: 300 });
void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
    const pathname = usePathname();
    if (isPublicSessionSharePath(pathname)) return <PublicShareRootLayout />;
    return (
        <React.Suspense fallback={null}>
            <AuthenticatedRootLayout />
        </React.Suspense>
    );
}

function usePawsNavigationTheme() {
    const { theme } = useUnistyles();
    return React.useMemo(() => {
        const base = theme.dark ? DarkTheme : DefaultTheme;
        return {
            ...base,
            colors: { ...base.colors, background: theme.colors.groupped.background },
        };
    }, [theme.colors.groupped.background, theme.dark]);
}

function PublicShareRootLayout() {
    const navigationTheme = usePawsNavigationTheme();
    const [fontsReady, setFontsReady] = React.useState(false);

    React.useEffect(() => {
        let active = true;
        void loadAppRootFonts()
            .catch((error) => console.log('[fonts] Public share font loading failed; using fallbacks.', error))
            .finally(() => {
                if (active) setFontsReady(true);
            });
        return () => { active = false; };
    }, []);

    React.useEffect(() => {
        if (fontsReady) void SplashScreen.hideAsync();
    }, [fontsReady]);

    if (!fontsReady) return null;
    return (
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
            <GestureHandlerRootView style={{ flex: 1 }}>
                <ThemeCaptureRoot>
                    <ThemeProvider value={navigationTheme}>
                        <StatusBarProvider />
                        <Slot />
                    </ThemeProvider>
                </ThemeCaptureRoot>
            </GestureHandlerRootView>
        </SafeAreaProvider>
    );
}
