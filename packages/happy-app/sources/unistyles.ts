import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { darkTheme, darkCarbonTheme, darkWarmTheme, darkOceanTheme, darkOledTheme, lightTheme } from './theme';
import { loadThemePreference } from './sync/persistence';
import { Appearance } from 'react-native';
import * as SystemUI from 'expo-system-ui';

//
// Theme
//

const appThemes = {
    light: lightTheme,
    dark: darkTheme,
    darkCarbon: darkCarbonTheme,
    darkWarm: darkWarmTheme,
    darkOcean: darkOceanTheme,
    darkOled: darkOledTheme,
};

const breakpoints = {
    xs: 0, // <-- make sure to register one breakpoint with value 0
    sm: 300,
    md: 500,
    lg: 800,
    xl: 1200
    // use as many breakpoints as you need
};

// Load theme preference from storage
const themePreference = loadThemePreference();

// Determine initial theme key for Unistyles
type ThemeKey = keyof typeof appThemes;

const getInitialTheme = (): ThemeKey => {
    if (themePreference === 'adaptive') {
        const systemTheme = Appearance.getColorScheme();
        return systemTheme === 'dark' ? 'dark' : 'light';
    }
    // Return the preference directly — it matches appThemes keys
    return themePreference as ThemeKey;
};

const settings = themePreference === 'adaptive'
    ? {
        // When adaptive, let Unistyles handle theme switching automatically
        adaptiveThemes: true,
        CSSVars: true,
    }
    : {
        // When fixed theme, set the initial theme explicitly
        initialTheme: getInitialTheme(),
        CSSVars: true,
    };

//
// Bootstrap
//

type AppThemes = typeof appThemes
type AppBreakpoints = typeof breakpoints

declare module 'react-native-unistyles' {
    export interface UnistylesThemes extends AppThemes { }
    export interface UnistylesBreakpoints extends AppBreakpoints { }
}

StyleSheet.configure({
    settings,
    breakpoints,
    themes: appThemes,
})

// Set initial root view background color based on theme
const setRootBackgroundColor = () => {
    const key = themePreference === 'adaptive'
        ? (Appearance.getColorScheme() === 'dark' ? 'dark' : 'light')
        : themePreference as ThemeKey;
    const theme = appThemes[key] || appThemes.dark;
    const color = theme.colors.groupped.background;
    UnistylesRuntime.setRootViewBackgroundColor(color);
    SystemUI.setBackgroundColorAsync(color);
};

// Set initial background color
setRootBackgroundColor();