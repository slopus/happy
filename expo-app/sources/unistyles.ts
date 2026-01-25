import { Appearance } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';

import { darkTheme, lightTheme } from './theme';
import { loadThemePreference } from './sync/persistence';

const appThemes = {
    light: lightTheme,
    dark: darkTheme
};

const breakpoints = {
    xs: 0, // <-- make sure to register one breakpoint with value 0
    sm: 300,
    md: 500,
    lg: 800,
    xl: 1200
};

type AppThemes = typeof appThemes;
type AppBreakpoints = typeof breakpoints;

declare module 'react-native-unistyles' {
    export interface UnistylesThemes extends AppThemes { }
    export interface UnistylesBreakpoints extends AppBreakpoints { }
}

const themePreference = loadThemePreference();

const getInitialTheme = (): 'light' | 'dark' => {
    if (themePreference === 'adaptive') {
        const systemTheme = Appearance.getColorScheme();
        return systemTheme === 'dark' ? 'dark' : 'light';
    }
    return themePreference;
};

const settings = themePreference === 'adaptive'
    ? {
        adaptiveThemes: true,
        CSSVars: true,
    }
    : {
        initialTheme: getInitialTheme(),
        CSSVars: true,
    };

StyleSheet.configure({
    settings,
    breakpoints,
    themes: appThemes,
});

const setRootBackgroundColor = () => {
    if (themePreference === 'adaptive') {
        const systemTheme = Appearance.getColorScheme();
        const color = systemTheme === 'dark'
            ? appThemes.dark.colors.groupped.background
            : appThemes.light.colors.groupped.background;
        UnistylesRuntime.setRootViewBackgroundColor(color);
        void SystemUI.setBackgroundColorAsync(color);
        return;
    }

    const color = themePreference === 'dark'
        ? appThemes.dark.colors.groupped.background
        : appThemes.light.colors.groupped.background;
    UnistylesRuntime.setRootViewBackgroundColor(color);
    void SystemUI.setBackgroundColorAsync(color);
};

setRootBackgroundColor();

