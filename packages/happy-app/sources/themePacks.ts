import { lightTheme, darkTheme } from './theme';
import { ACCENTS, THEME_PACK_IDS, type AccentMode, type ThemePackId } from './themePacksData';
import { PHOTO_DESKTOP_SKINS, isPhotoSkinActive, type DesktopSkinId } from './desktopSkin';
import { multiplyColorOpacity } from './utils/colorOpacity';

export { ACCENTS, THEME_PACK_IDS, type ThemePackId } from './themePacksData';

/**
 * Paws 主题包系统
 *
 * 思路：lightTheme/darkTheme 是「焦糖奶油」基础主题（含全部功能色）。
 * 每个主题包只覆盖「品牌/强调」相关的少数颜色（主按钮、fab、链接、背景/表面色调、
 * 文字、首页粒子），其余功能色（成功/错误/diff/终端/语法）全部继承基础主题。
 *
 * 每个包含亮(light)/暗(dark)两态。最终注册到 unistyles 的主题名为 `${packId}Light`
 * / `${packId}Dark`，共 7×2 = 14 套；PC 照片皮肤按来源明暗态另行注册。
 */

// Blend the rail against its actual panel, retaining each palette's neutral tint.
function sliderTrack(surface: string, text: string, dark: boolean): string {
    const amount = dark ? 0.4 : 0.2;
    return `#${[1, 3, 5].map((offset) => Math.round(
        Number.parseInt(surface.slice(offset, offset + 2), 16) * (1 - amount)
        + Number.parseInt(text.slice(offset, offset + 2), 16) * amount,
    ).toString(16).padStart(2, '0')).join('')}`;
}

/** 把一个 accent 覆盖到基础主题上，生成完整主题对象 */
function applyAccent(base: typeof lightTheme, a: AccentMode): typeof lightTheme {
    return {
        ...base,
        colors: {
            ...base.colors,
            text: a.text,
            textSecondary: a.textSecondary,
            textLink: a.link,
            surface: a.surface,
            surfacePressed: a.surfaceHigh,
            surfaceSelected: a.surfaceHighest,
            surfaceHigh: a.surfaceHigh,
            surfaceHighest: a.surfaceHighest,
            // Image controls need a dark scrim in both appearances. Keep its
            // neutral tint and contrasting content tied to the active pack.
            imageOverlay: {
                ...base.colors.imageOverlay,
                surface: multiplyColorOpacity(base.dark ? a.surface : a.text, 0.76),
                surfacePressed: multiplyColorOpacity(base.dark ? a.surface : a.text, 0.90),
                surfaceSelected: multiplyColorOpacity(base.dark ? a.surface : a.text, 0.94),
                text: base.dark ? a.text : a.surface,
            },
            groupped: { ...base.colors.groupped, background: a.bg },
            header: { ...base.colors.header, background: a.surface, tint: a.text },
            fab: { ...base.colors.fab, background: a.primary, backgroundPressed: a.primaryPressed, icon: a.onPrimary },
            button: {
                ...base.colors.button,
                primary: { ...base.colors.button.primary, background: a.primary, tint: a.onPrimary },
            },
            particle: { primary: a.particleA, accent: a.particleB },
            accent: a.primary,
            slider: { track: sliderTrack(a.surfaceHigh, a.textSecondary, base.dark) },
            // 选中态 / 单选的边框与圆点也跟随主题包主色
            radio: { ...base.colors.radio, active: a.primary, dot: a.primary },
            // 输入框 / 消息输入栏背景也随主题包（否则各主题下都停留在焦糖米色）
            input: { ...base.colors.input, background: a.surfaceHigh, text: a.text, placeholder: a.textSecondary },
            // 用户消息气泡背景随主题包
            userMessageBackground: a.surfaceHighest,
            userMessageText: a.text,
        },
    };
}

// 生成全部 14 套命名主题
const builtThemes: Record<string, typeof lightTheme> = {};
for (const spec of ACCENTS) {
    builtThemes[`${spec.id}Light`] = applyAccent(lightTheme, spec.light);
    builtThemes[`${spec.id}Dark`] = applyAccent(darkTheme, spec.dark);
}

for (const skin of PHOTO_DESKTOP_SKINS) {
    const base = skin.appearance === 'light' ? lightTheme : darkTheme;
    const themed = applyAccent(base, skin.accent);
    builtThemes[skin.themeName] = {
        ...themed,
        colors: {
            ...themed.colors,
            desktopSkin: skin.desktopSkin,
            modal: { ...themed.colors.modal, backdrop: skin.modalBackdrop },
            divider: skin.divider,
            header: { ...base.colors.header, background: skin.headerBackground, tint: skin.accent.text },
            button: {
                ...themed.colors.button,
                secondary: { ...base.colors.button.secondary, tint: skin.accent.textSecondary },
            },
        },
    };
}

export const appThemes = builtThemes as Record<`${ThemePackId}Light` | `${ThemePackId}Dark` | typeof PHOTO_DESKTOP_SKINS[number]['themeName'], typeof lightTheme>;

export type AppThemeName = keyof typeof appThemes;

/** 由主题包 + 有效明暗态解析出注册的主题名 */
export function resolveThemeName(pack: ThemePackId, isDark: boolean): AppThemeName {
    const id = (THEME_PACK_IDS.includes(pack) ? pack : 'caramel');
    return `${id}${isDark ? 'Dark' : 'Light'}` as AppThemeName;
}

export function resolveDesktopThemeName(
    pack: ThemePackId,
    isDark: boolean,
    skin: DesktopSkinId,
    platform: string,
    viewportWidth: number,
    pathname = '',
): AppThemeName {
    if (isPhotoSkinActive(skin, platform, viewportWidth, pathname)) {
        return PHOTO_DESKTOP_SKINS.find((item) => item.id === skin)?.themeName as AppThemeName;
    }
    return resolveThemeName(pack, isDark);
}

/** 保留当前主题包，仅切换亮暗模式。 */
export function resolveThemeMode(
    currentThemeName: AppThemeName | string | null | undefined,
    isDark: boolean,
): AppThemeName {
    const pack = THEME_PACK_IDS.find((id) => (
        currentThemeName === `${id}Light` || currentThemeName === `${id}Dark`
    )) ?? 'caramel';
    return resolveThemeName(pack, isDark);
}
