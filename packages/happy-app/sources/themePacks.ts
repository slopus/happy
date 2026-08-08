import { lightTheme, darkTheme } from './theme';

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

// 单态可覆盖的品牌色
type AccentMode = {
    primary: string;        // 主按钮 / fab 背景
    primaryPressed: string; // 按下态
    onPrimary: string;      // 主按钮文字（深色主色上用浅字，亮色主色上用白字）
    link: string;           // 链接色
    bg: string;             // groupped 背景（页面底色）
    surface: string;        // 卡片 / header 表面
    surfaceHigh: string;
    surfaceHighest: string;
    text: string;           // 主文字
    textSecondary: string;  // 次文字
    particleA: string;      // 首页粒子主色
    particleB: string;      // 首页粒子点缀色
};

type AccentSpec = {
    id: string;
    /** UI 展示用：色板（亮态主色、暗态底色），不参与主题生成 */
    swatch: { primary: string; bg: string };
    light: AccentMode;
    dark: AccentMode;
};

// 暖中性文字（沿用基础主题）
const WARM_INK = '#3D2E22';
const WARM_INK_2 = '#9A8B7C';
const WARM_PAPER = '#F0E6DA';
const WARM_PAPER_2 = '#A89684';

export const ACCENTS: AccentSpec[] = [
    {
        id: 'caramel',
        swatch: { primary: '#C77D3E', bg: '#1A1512' },
        light: { primary: '#C77D3E', primaryPressed: '#A9662F', onPrimary: '#FFFFFF', link: '#3E84B0', bg: '#FBF7F0', surface: '#FFFDFA', surfaceHigh: '#F8F3EA', surfaceHighest: '#F0E8D9', text: WARM_INK, textSecondary: WARM_INK_2, particleA: '#C77D3E', particleB: '#5E97C0' },
        dark: { primary: '#E0975A', primaryPressed: '#C77D3E', onPrimary: '#1A1512', link: '#7FB6D9', bg: '#1A1512', surface: '#241C17', surfaceHigh: '#2B221B', surfaceHighest: '#352A20', text: WARM_PAPER, textSecondary: WARM_PAPER_2, particleA: '#E0975A', particleB: '#7FB6D9' },
    },
    {
        id: 'gingham',
        swatch: { primary: '#4E8FBF', bg: '#121821' },
        light: { primary: '#4E8FBF', primaryPressed: '#3E7CA6', onPrimary: '#FFFFFF', link: '#3E7CA6', bg: '#F4F7FA', surface: '#FFFFFF', surfaceHigh: '#EFF4F8', surfaceHighest: '#E4EDF4', text: '#21303D', textSecondary: '#7A8B98', particleA: '#5E97C0', particleB: '#C77D3E' },
        dark: { primary: '#6FB0DA', primaryPressed: '#5694BE', onPrimary: '#0E1620', link: '#8FC2E0', bg: '#121821', surface: '#1A2330', surfaceHigh: '#1F2A38', surfaceHighest: '#283544', text: '#E6EEF5', textSecondary: '#8FA2B0', particleA: '#6FB0DA', particleB: '#E0975A' },
    },
    {
        id: 'terminal',
        swatch: { primary: '#00FF88', bg: '#0A0A0B' },
        light: { primary: '#00A352', primaryPressed: '#008A45', onPrimary: '#FFFFFF', link: '#0090BE', bg: '#F4F6F4', surface: '#FFFFFF', surfaceHigh: '#EDF1ED', surfaceHighest: '#E2E8E2', text: '#16201A', textSecondary: '#6B7A70', particleA: '#00A352', particleB: '#0090BE' },
        dark: { primary: '#00FF88', primaryPressed: '#00CC6E', onPrimary: '#0A0A0B', link: '#00D4FF', bg: '#0A0A0B', surface: '#131316', surfaceHigh: '#18181C', surfaceHighest: '#202026', text: '#E5E5E7', textSecondary: '#6B6B76', particleA: '#00FF88', particleB: '#00D4FF' },
    },
    {
        id: 'acorn',
        swatch: { primary: '#D2691E', bg: '#1A130D' },
        light: { primary: '#D2691E', primaryPressed: '#B45617', onPrimary: '#FFFFFF', link: '#3E84B0', bg: '#FBF5EE', surface: '#FFFDF9', surfaceHigh: '#F6ECDF', surfaceHighest: '#EFE1CE', text: '#3A2616', textSecondary: '#9A8270', particleA: '#D2691E', particleB: '#8FA86B' },
        dark: { primary: '#E8843A', primaryPressed: '#C96C28', onPrimary: '#1A130D', link: '#8FB0C0', bg: '#1A130D', surface: '#241A12', surfaceHigh: '#2C2017', surfaceHighest: '#36281C', text: '#F2E4D4', textSecondary: '#AC9582', particleA: '#E8843A', particleB: '#C0A060' },
    },
    {
        id: 'sage',
        swatch: { primary: '#6E9B6A', bg: '#12170F' },
        light: { primary: '#6E9B6A', primaryPressed: '#5A8456', onPrimary: '#FFFFFF', link: '#4E8FBF', bg: '#F4F7F2', surface: '#FFFFFF', surfaceHigh: '#EDF2EA', surfaceHighest: '#E2EADD', text: '#23301F', textSecondary: '#7C8B77', particleA: '#6E9B6A', particleB: '#C08A5E' },
        dark: { primary: '#8FBE86', primaryPressed: '#74A36C', onPrimary: '#12170F', link: '#8FC2E0', bg: '#12170F', surface: '#1A2116', surfaceHigh: '#1F291B', surfaceHighest: '#283322', text: '#E6EFE2', textSecondary: '#94A38C', particleA: '#8FBE86', particleB: '#C0925E' },
    },
    {
        id: 'sakura',
        swatch: { primary: '#E0879F', bg: '#1B1316' },
        light: { primary: '#E0879F', primaryPressed: '#C96E87', onPrimary: '#FFFFFF', link: '#4E8FBF', bg: '#FCF4F6', surface: '#FFFFFF', surfaceHigh: '#F8ECF0', surfaceHighest: '#F2DFE6', text: '#3A222A', textSecondary: '#9A8089', particleA: '#E0879F', particleB: '#9FB6D9' },
        dark: { primary: '#F0A0B5', primaryPressed: '#D7869C', onPrimary: '#1B1316', link: '#9FC2E0', bg: '#1B1316', surface: '#251A1E', surfaceHigh: '#2D2025', surfaceHighest: '#38282E', text: '#F2E0E6', textSecondary: '#AC929A', particleA: '#F0A0B5', particleB: '#C09FD9' },
    },
    {
        id: 'grape',
        swatch: { primary: '#7C5CBF', bg: '#15111D' },
        light: { primary: '#7C5CBF', primaryPressed: '#6747A6', onPrimary: '#FFFFFF', link: '#4E8FBF', bg: '#F6F4FB', surface: '#FFFFFF', surfaceHigh: '#F0ECF8', surfaceHighest: '#E5DFF4', text: '#2C2340', textSecondary: '#857C98', particleA: '#9B7BD9', particleB: '#E0975A' },
        dark: { primary: '#A78BE0', primaryPressed: '#8C6FCB', onPrimary: '#15111D', link: '#9FB6E0', bg: '#15111D', surface: '#1E1828', surfaceHigh: '#241D31', surfaceHighest: '#2E2640', text: '#EBE4F5', textSecondary: '#A096B0', particleA: '#A78BE0', particleB: '#E0975A' },
    },
];

export type ThemePackId = typeof ACCENTS[number]['id'];
export const THEME_PACK_IDS = ACCENTS.map(a => a.id) as ThemePackId[];

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
