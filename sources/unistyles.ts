import { StyleSheet } from 'react-native-unistyles';

//
// Theme
//

const lightTheme = {
    colors: {
        primary: '#ff1ff4',
        secondary: '#1ff4ff'
        // any nesting, spreading, arrays, etc.
    },
    // functions, external imports, etc.
    gap: (v: number) => v * 8
};

const otherTheme = {
    colors: {
        primary: '#aa12ff',
        secondary: 'pink'
    },
    gap: (v: number) => v * 8
};

const appThemes = {
    light: lightTheme,
    other: otherTheme
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