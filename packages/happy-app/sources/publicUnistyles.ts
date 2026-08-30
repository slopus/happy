import { Appearance } from 'react-native';
import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { appThemes, resolveThemeName } from './themePacks';

const breakpoints = { xs: 0, sm: 300, md: 500, lg: 800, xl: 1200 };
const initialTheme = resolveThemeName('caramel', Appearance.getColorScheme() === 'dark');

StyleSheet.configure({
    settings: { initialTheme, CSSVars: true },
    breakpoints,
    themes: appThemes,
});
UnistylesRuntime.setRootViewBackgroundColor(appThemes[initialTheme].colors.groupped.background);
