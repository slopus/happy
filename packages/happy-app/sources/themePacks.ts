import { lightTheme, darkTheme } from './theme';
import { ACCENTS, THEME_PACK_IDS, type AccentMode, type ThemePackId } from './themePacksData';

export { ACCENTS, THEME_PACK_IDS, type ThemePackId } from './themePacksData';

/**
 * Paws 主题包系统
 *
 * 思路：lightTheme/darkTheme 是「焦糖奶油」基础主题（含全部功能色）。
 * 每个主题包只覆盖「品牌/强调」相关的少数颜色（主按钮、fab、链接、背景/表面色调、
 * 文字、首页粒子），其余功能色（成功/错误/diff/终端/语法）全部继承基础主题。
 *
 * 每个包含亮(light)/暗(dark)两态。最终注册到 unistyles 的主题名为 `${packId}Light`
 * / `${packId}Dark`，共 7×2 = 14 套。
 */

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
            groupped: { ...base.colors.groupped, background: a.bg },
            header: { ...base.colors.header, background: a.surface },
            fab: { ...base.colors.fab, background: a.primary, backgroundPressed: a.primaryPressed, icon: a.onPrimary },
            button: {
                ...base.colors.button,
                primary: { ...base.colors.button.primary, background: a.primary, tint: a.onPrimary },
            },
            particle: { primary: a.particleA, accent: a.particleB },
            accent: a.primary,
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

export const appThemes = builtThemes as Record<`${ThemePackId}Light` | `${ThemePackId}Dark`, typeof lightTheme>;

export type AppThemeName = keyof typeof appThemes;

/** 由主题包 + 有效明暗态解析出注册的主题名 */
export function resolveThemeName(pack: ThemePackId, isDark: boolean): AppThemeName {
    const id = (THEME_PACK_IDS.includes(pack) ? pack : 'caramel');
    return `${id}${isDark ? 'Dark' : 'Light'}` as AppThemeName;
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
