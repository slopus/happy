import type { ChromeTheme, ThemeEntry, ThemeMode } from './types'

const DEFAULT_FONT_UI = 'Geist, Inter'
const DEFAULT_FONT_CODE = '"Geist Mono", ui-monospace, "SFMono-Regular"'

/** Codex's shipped default light/dark themes (extracted from app.asar). */
export const CODEX_LIGHT_DEFAULT: ChromeTheme = {
    accent: '#339cff',
    ink: '#1a1c1f',
    surface: '#ffffff',
    contrast: 45,
    opaqueWindows: false,
    fonts: { ui: null, code: null },
    semanticColors: {
        diffAdded: '#00a240',
        diffRemoved: '#ba2623',
        skill: '#924ff7',
    },
}

export const CODEX_DARK_DEFAULT: ChromeTheme = {
    accent: '#339cff',
    ink: '#ffffff',
    surface: '#181818',
    contrast: 60,
    opaqueWindows: false,
    fonts: { ui: null, code: null },
    semanticColors: {
        diffAdded: '#40c977',
        diffRemoved: '#fa423e',
        skill: '#ad7bf9',
    },
}

/** Resolve null fonts back to the codex defaults. */
export function effectiveFonts(theme: ChromeTheme) {
    return {
        ui: theme.fonts.ui ?? DEFAULT_FONT_UI,
        code: theme.fonts.code ?? DEFAULT_FONT_CODE,
    }
}

/** Merge a partial theme on top of the codex default for a given mode. */
export function mergeWithDefault(
    partial: Partial<ChromeTheme>,
    mode: ThemeMode
): ChromeTheme {
    const base = mode === 'light' ? CODEX_LIGHT_DEFAULT : CODEX_DARK_DEFAULT
    return {
        accent: partial.accent ?? base.accent,
        ink: partial.ink ?? base.ink,
        surface: partial.surface ?? base.surface,
        contrast: partial.contrast ?? base.contrast,
        opaqueWindows: partial.opaqueWindows ?? base.opaqueWindows,
        fonts: {
            ui: partial.fonts?.ui ?? base.fonts.ui,
            code: partial.fonts?.code ?? base.fonts.code,
        },
        semanticColors: {
            diffAdded: partial.semanticColors?.diffAdded ?? base.semanticColors.diffAdded,
            diffRemoved: partial.semanticColors?.diffRemoved ?? base.semanticColors.diffRemoved,
            skill: partial.semanticColors?.skill ?? base.semanticColors.skill,
        },
    }
}

/** Theme partials extracted from Codex's app.asar. */
const CODEX_THEME_PARTIALS: { name: string; codeThemeId: string; variant: ThemeMode; partial: Partial<ChromeTheme> }[] = [
    {
        name: 'Linear Dark', codeThemeId: 'linear-dark', variant: 'dark',
        partial: {
            accent: '#606acc', ink: '#e3e4e6', surface: '#0f0f11',
            opaqueWindows: true, fonts: { ui: 'Inter', code: null },
            semanticColors: { diffAdded: '#69c967', diffRemoved: '#ff7e78', skill: '#c2a1ff' },
        },
    },
    {
        name: 'Linear Light', codeThemeId: 'linear-light', variant: 'light',
        partial: {
            ink: '#1b1b1b', surface: '#fcfcfd',
            opaqueWindows: true, fonts: { ui: 'Inter', code: null },
            semanticColors: { diffAdded: '#52a450', diffRemoved: '#c94446', skill: '#8160d8' },
        },
    },
    {
        name: 'Vercel Dark', codeThemeId: 'vercel-dark', variant: 'dark',
        partial: {
            accent: '#006efe', ink: '#ededed', surface: '#000000', contrast: 50,
            opaqueWindows: true,
            fonts: { ui: 'Geist, Inter', code: '"Geist Mono", ui-monospace, "SFMono-Regular"' },
            semanticColors: { diffAdded: '#00AD3A', diffRemoved: '#F13342', skill: '#9540D5' },
        },
    },
    {
        name: 'Vercel Light', codeThemeId: 'vercel-light', variant: 'light',
        partial: {
            accent: '#006aff', ink: '#171717', surface: '#ffffff', contrast: 40,
            opaqueWindows: true,
            fonts: { ui: 'Geist, Inter', code: '"Geist Mono", ui-monospace, "SFMono-Regular"' },
            semanticColors: { diffAdded: '#28A948', diffRemoved: '#EB001D', skill: '#A100F8' },
        },
    },
    {
        name: 'Raycast Dark', codeThemeId: 'raycast-dark', variant: 'dark',
        partial: { accent: '#ff6363', ink: '#fefefe', surface: '#101010', opaqueWindows: true },
    },
    {
        name: 'Raycast Light', codeThemeId: 'raycast-light', variant: 'light',
        partial: { accent: '#ff6363', ink: '#030303', surface: '#ffffff', opaqueWindows: true },
    },
    {
        name: 'Notion Dark', codeThemeId: 'notion-dark', variant: 'dark',
        partial: { opaqueWindows: true, fonts: { ui: null, code: null } },
    },
    {
        name: 'Notion Light', codeThemeId: 'notion-light', variant: 'light',
        partial: { opaqueWindows: true, fonts: { ui: null, code: null } },
    },
    {
        name: 'Matrix Dark', codeThemeId: 'matrix-dark', variant: 'dark',
        partial: { opaqueWindows: true, fonts: { ui: 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace', code: null } },
    },
    {
        name: 'Lobster Dark', codeThemeId: 'lobster-dark', variant: 'dark',
        partial: { fonts: { ui: 'Satoshi', code: null } },
    },
    {
        name: 'Sentry Dark', codeThemeId: 'sentry-dark', variant: 'dark',
        partial: { fonts: { ui: null, code: null } },
    },
    {
        name: 'Proof Light', codeThemeId: 'proof-light', variant: 'light',
        partial: { opaqueWindows: true, fonts: { ui: null, code: null } },
    },
    {
        // User-supplied entry — GitHub Dark mirroring github-dark-default code theme.
        name: 'GitHub Dark', codeThemeId: 'github-dark-default', variant: 'dark',
        partial: {
            accent: '#1f6feb', ink: '#e6edf3', surface: '#0d1117', contrast: 60,
            opaqueWindows: false,
            fonts: { ui: null, code: null },
            semanticColors: { diffAdded: '#3fb950', diffRemoved: '#f85149', skill: '#bc8cff' },
        },
    },
]

/** All built-in theme entries (codex defaults + extracted presets). */
export const BUILTIN_THEMES: ThemeEntry[] = [
    { codeThemeId: 'codex', variant: 'light', theme: CODEX_LIGHT_DEFAULT },
    { codeThemeId: 'codex', variant: 'dark',  theme: CODEX_DARK_DEFAULT  },
    ...CODEX_THEME_PARTIALS.map((p) => ({
        codeThemeId: p.codeThemeId,
        variant: p.variant,
        theme: mergeWithDefault(p.partial, p.variant),
    })),
]

/** Theme name lookup helpers. */
export function themesForMode(mode: ThemeMode): ThemeEntry[] {
    return BUILTIN_THEMES.filter((e) => e.variant === mode)
}

export function findTheme(codeThemeId: string, variant: ThemeMode): ThemeEntry | undefined {
    return BUILTIN_THEMES.find((e) => e.codeThemeId === codeThemeId && e.variant === variant)
}
