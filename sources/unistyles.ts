import { StyleSheet } from 'react-native-unistyles';
import { darkTheme, lightTheme } from './theme';

//
// Theme
//

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
    // use as many breakpoints as you need
};

const settings = {
    initialTheme: 'light' as const,
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