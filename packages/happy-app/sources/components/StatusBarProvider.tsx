import React from 'react';
import { Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useUnistyles } from 'react-native-unistyles';


export const StatusBarProvider = React.memo(() => {
    const { theme } = useUnistyles();
    const statusBarStyle = theme.dark ? 'light' : 'dark';

    // On web, sync the theme-color meta tag with the app's actual theme.
    // The static meta tags in +html.tsx use prefers-color-scheme media queries
    // which follow the *system* theme, but the app may be in a fixed theme
    // that differs. This keeps the iOS Safari status bar text legible.
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const meta = document.getElementById('theme-color') as HTMLMetaElement | null;
        if (meta) {
            meta.content = theme.colors.header.background;
        }
    }, [theme.dark, theme.colors.header.background]);

    return (
        <StatusBar style={statusBarStyle} animated={true} />
    );
});