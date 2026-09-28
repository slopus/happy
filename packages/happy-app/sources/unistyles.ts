import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { appThemes, resolveDesktopThemeName, type ThemePackId, type AppThemeName } from './themePacks';
import { loadThemePreference, loadThemePack, loadDesktopSkinId } from './sync/persistence';
import { Appearance, Dimensions, Platform } from 'react-native';
import { WEB_TABLET_MIN_WIDTH } from './utils/deviceCalculations';
import * as SystemUI from 'expo-system-ui';

//
// Theme
//
// Paws 多主题包系统：注册 7 套主题包 × 亮/暗 = 14 套命名主题。
// 明暗态由 themePreference（light/dark/adaptive）决定，主题包由 themePack 决定。
// 不用 unistyles 内置 adaptiveThemes（它要求主题名恰为 'light'/'dark'），改为手动管理。
//

const breakpoints = {
    xs: 0, // <-- make sure to register one breakpoint with value 0
    sm: 300,
    md: 500,
    lg: 800,
    xl: 1200
};

type ThemePref = 'light' | 'dark' | 'adaptive';

const systemIsDark = () => Appearance.getColorScheme() === 'dark';

/** 由偏好解析出当前是否暗色 */
function isDarkFor(pref: ThemePref): boolean {
    return pref === 'adaptive' ? systemIsDark() : pref === 'dark';
}

// Load persisted preferences
const themePreference = loadThemePreference();
const themePack = loadThemePack();
const currentPathname = () => Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.pathname : '';

const initialThemeName: AppThemeName = resolveDesktopThemeName(themePack, isDarkFor(themePreference), loadDesktopSkinId(), Platform.OS, Dimensions.get('window').width, currentPathname());

//
// Bootstrap
//

type AppThemes = typeof appThemes;
type AppBreakpoints = typeof breakpoints;

declare module 'react-native-unistyles' {
    export interface UnistylesThemes extends AppThemes { }
    export interface UnistylesBreakpoints extends AppBreakpoints { }
}

StyleSheet.configure({
    settings: {
        initialTheme: initialThemeName,
        CSSVars: true, // Enable CSS variables for web
    },
    breakpoints,
    themes: appThemes,
});

/**
 * 运行时切换主题（设置页和系统明暗变化都走这里）。
 * 同时更新根视图背景色，避免切换时闪白/闪黑。
 */
export function applyTheme(pack: ThemePackId, pref: ThemePref) {
    const name = resolveDesktopThemeName(pack, isDarkFor(pref), loadDesktopSkinId(), Platform.OS, Dimensions.get('window').width, currentPathname());
    UnistylesRuntime.setTheme(name);
    const color = appThemes[name].colors.groupped.background;
    UnistylesRuntime.setRootViewBackgroundColor(color);
    SystemUI.setBackgroundColorAsync(color);
}

// Set initial root background color
{
    const color = appThemes[initialThemeName].colors.groupped.background;
    UnistylesRuntime.setRootViewBackgroundColor(color);
    SystemUI.setBackgroundColorAsync(color);
}

// 系统明暗变化时，若当前为 adaptive，则自动跟随（读取最新持久化偏好）
Appearance.addChangeListener(() => {
    const pref = loadThemePreference();
    if (pref === 'adaptive') {
        applyTheme(loadThemePack(), 'adaptive');
    }
});

// Web：标签页重新可见时再同步一次（Appearance 在隐藏时可能漏掉变化）
if (Platform.OS === 'web') {
    let wasDesktopWidth = Dimensions.get('window').width >= WEB_TABLET_MIN_WIDTH;
    Dimensions.addEventListener('change', ({ window }) => {
        const isDesktopWidth = window.width >= WEB_TABLET_MIN_WIDTH;
        if (isDesktopWidth !== wasDesktopWidth) {
            wasDesktopWidth = isDesktopWidth;
            if (currentPathname().startsWith('/share/')) return;
            applyTheme(loadThemePack(), loadThemePreference());
        }
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            const pref = loadThemePreference();
            if (pref === 'adaptive') {
                applyTheme(loadThemePack(), 'adaptive');
            }
        }
    });
}
