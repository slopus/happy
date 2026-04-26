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
]

/**
 * Additional theme presets synthesized from VS Code-style code themes shipped
 * with Codex (Dracula, Catppuccin, Tokyo Night, One Dark Pro, Gruvbox, …).
 *
 * Each entry exposes accent/ink/surface from the code theme's `editor.*` and
 * `focusBorder` fields; semantic colors / contrast / fonts inherit codex
 * defaults for the variant. Auto-generated by `.cdp-scripts/build-presets.mjs`.
 */
const EXTRA_THEME_PARTIALS: { name: string; codeThemeId: string; variant: ThemeMode; partial: Partial<ChromeTheme> }[] = [
    { name: 'Andromeeda',                 codeThemeId: 'andromeeda',                 variant: 'dark',  partial: { accent: '#746f77', ink: '#d5ced9', surface: '#23262e' } },
    { name: 'Ayu Dark',                   codeThemeId: 'ayu-dark',                   variant: 'dark',  partial: { accent: '#e6b450', ink: '#bfbdb6', surface: '#0b0e14' } },
    { name: 'Catppuccin Frappe',          codeThemeId: 'catppuccin-frappe',          variant: 'dark',  partial: { accent: '#ca9ee6', ink: '#c6d0f5', surface: '#303446' } },
    { name: 'Catppuccin Latte',           codeThemeId: 'catppuccin-latte',           variant: 'light', partial: { accent: '#8839ef', ink: '#4c4f69', surface: '#eff1f5' } },
    { name: 'Catppuccin Macchiato',       codeThemeId: 'catppuccin-macchiato',       variant: 'dark',  partial: { accent: '#c6a0f6', ink: '#cad3f5', surface: '#24273a' } },
    { name: 'Catppuccin Mocha',           codeThemeId: 'catppuccin-mocha',           variant: 'dark',  partial: { accent: '#cba6f7', ink: '#cdd6f4', surface: '#1e1e2e' } },
    { name: 'Dracula',                    codeThemeId: 'dracula',                    variant: 'dark',  partial: { accent: '#bd93f9', ink: '#f8f8f2', surface: '#282a36' } },
    { name: 'Dracula Soft',               codeThemeId: 'dracula-soft',               variant: 'dark',  partial: { accent: '#bd93f9', ink: '#f6f6f4', surface: '#282a36' } },
    { name: 'Everforest Dark',            codeThemeId: 'everforest-dark',            variant: 'dark',  partial: { accent: '#a7c080', ink: '#d3c6aa', surface: '#2d353b' } },
    { name: 'Everforest Light',           codeThemeId: 'everforest-light',           variant: 'light', partial: { accent: '#93b259', ink: '#5c6a72', surface: '#fdf6e3' } },
    { name: 'GitHub Dark Default',        codeThemeId: 'github-dark-default',        variant: 'dark',  partial: { accent: '#1f6feb', ink: '#e6edf3', surface: '#0d1117' } },
    { name: 'GitHub Dark Dimmed',         codeThemeId: 'github-dark-dimmed',         variant: 'dark',  partial: { accent: '#316dca', ink: '#adbac7', surface: '#22272e' } },
    { name: 'GitHub Dark High Contrast',  codeThemeId: 'github-dark-high-contrast',  variant: 'dark',  partial: { accent: '#409eff', ink: '#f0f3f6', surface: '#0a0c10' } },
    { name: 'GitHub Light Default',       codeThemeId: 'github-light-default',       variant: 'light', partial: { accent: '#0969da', ink: '#1f2328', surface: '#ffffff' } },
    { name: 'GitHub Light High Contrast', codeThemeId: 'github-light-high-contrast', variant: 'light', partial: { accent: '#0349b4', ink: '#0e1116', surface: '#ffffff' } },
    { name: 'Gruvbox Dark Hard',          codeThemeId: 'gruvbox-dark-hard',          variant: 'dark',  partial: { accent: '#fabd2f', ink: '#ebdbb2', surface: '#1d2021' } },
    { name: 'Gruvbox Dark Medium',        codeThemeId: 'gruvbox-dark-medium',        variant: 'dark',  partial: { accent: '#fabd2f', ink: '#ebdbb2', surface: '#282828' } },
    { name: 'Gruvbox Dark Soft',          codeThemeId: 'gruvbox-dark-soft',          variant: 'dark',  partial: { accent: '#fabd2f', ink: '#ebdbb2', surface: '#32302f' } },
    { name: 'Gruvbox Light Hard',         codeThemeId: 'gruvbox-light-hard',         variant: 'light', partial: { accent: '#b57614', ink: '#3c3836', surface: '#f9f5d7' } },
    { name: 'Gruvbox Light Medium',       codeThemeId: 'gruvbox-light-medium',       variant: 'light', partial: { accent: '#b57614', ink: '#3c3836', surface: '#fbf1c7' } },
    { name: 'Gruvbox Light Soft',         codeThemeId: 'gruvbox-light-soft',         variant: 'light', partial: { accent: '#b57614', ink: '#3c3836', surface: '#f2e5bc' } },
    { name: 'Houston',                    codeThemeId: 'houston',                    variant: 'dark',  partial: { accent: '#00daef', ink: '#eef0f9', surface: '#17191e' } },
    { name: 'Kanagawa Dragon',            codeThemeId: 'kanagawa-dragon',            variant: 'dark',  partial: { accent: '#7fb4ca', ink: '#c5c9c5', surface: '#181616' } },
    { name: 'Kanagawa Lotus',             codeThemeId: 'kanagawa-lotus',             variant: 'light', partial: { accent: '#4d699b', ink: '#545464', surface: '#f2ecbc' } },
    { name: 'Kanagawa Wave',              codeThemeId: 'kanagawa-wave',              variant: 'dark',  partial: { accent: '#7e9cd8', ink: '#dcd7ba', surface: '#1f1f28' } },
    { name: 'Laserwave',                  codeThemeId: 'laserwave',                  variant: 'dark',  partial: { accent: '#eb64b9', ink: '#ffffff', surface: '#27212e' } },
    { name: 'Material Theme',             codeThemeId: 'material-theme',             variant: 'dark',  partial: { accent: '#80cbc4', ink: '#eeffff', surface: '#263238' } },
    { name: 'Material Theme Darker',      codeThemeId: 'material-theme-darker',      variant: 'dark',  partial: { accent: '#80cbc4', ink: '#eeffff', surface: '#212121' } },
    { name: 'Material Theme Lighter',     codeThemeId: 'material-theme-lighter',     variant: 'light', partial: { accent: '#39adb5', ink: '#90a4ae', surface: '#fafafa' } },
    { name: 'Material Theme Ocean',       codeThemeId: 'material-theme-ocean',       variant: 'dark',  partial: { accent: '#80cbc4', ink: '#babed8', surface: '#0f111a' } },
    { name: 'Material Theme Palenight',   codeThemeId: 'material-theme-palenight',   variant: 'dark',  partial: { accent: '#80cbc4', ink: '#babed8', surface: '#292d3e' } },
    { name: 'Min Light',                  codeThemeId: 'min-light',                  variant: 'light', partial: { accent: '#1976d2', ink: '#212121', surface: '#ffffff' } },
    { name: 'Monokai',                    codeThemeId: 'monokai',                    variant: 'dark',  partial: { accent: '#a6e22e', ink: '#f8f8f2', surface: '#272822' } },
    { name: 'Night Owl',                  codeThemeId: 'night-owl',                  variant: 'dark',  partial: { accent: '#7e57c2', ink: '#d6deeb', surface: '#011627' } },
    { name: 'Nord',                       codeThemeId: 'nord',                       variant: 'dark',  partial: { accent: '#88c0d0', ink: '#d8dee9', surface: '#2e3440' } },
    { name: 'One Dark Pro',               codeThemeId: 'one-dark-pro',               variant: 'dark',  partial: { accent: '#61afef', ink: '#abb2bf', surface: '#282c34' } },
    { name: 'One Light',                  codeThemeId: 'one-light',                  variant: 'light', partial: { accent: '#526fff', ink: '#383a42', surface: '#fafafa' } },
    { name: 'Pierre Dark',                codeThemeId: 'pierre-dark',                variant: 'dark',  partial: { accent: '#009fff', ink: '#fbfbfb', surface: '#070707' } },
    { name: 'Pierre Light',               codeThemeId: 'pierre-light',               variant: 'light', partial: { accent: '#009fff', ink: '#070707', surface: '#ffffff' } },
    { name: 'Plastic',                    codeThemeId: 'plastic',                    variant: 'dark',  partial: { accent: '#1085ff', ink: '#a9b2c3', surface: '#21252b' } },
    { name: 'Poimandres',                 codeThemeId: 'poimandres',                 variant: 'dark',  partial: { accent: '#5fb3a1', ink: '#a6accd', surface: '#1b1e28' } },
    { name: 'Red',                        codeThemeId: 'red',                        variant: 'dark',  partial: { accent: '#ff6666', ink: '#f8f8f8', surface: '#390000' } },
    { name: 'Rose Pine',                  codeThemeId: 'rose-pine',                  variant: 'dark',  partial: { accent: '#c4a7e7', ink: '#e0def4', surface: '#191724' } },
    { name: 'Rose Pine Dawn',             codeThemeId: 'rose-pine-dawn',             variant: 'light', partial: { accent: '#907aa9', ink: '#575279', surface: '#faf4ed' } },
    { name: 'Rose Pine Moon',             codeThemeId: 'rose-pine-moon',             variant: 'dark',  partial: { accent: '#c4a7e7', ink: '#e0def4', surface: '#232136' } },
    { name: 'Slack Dark',                 codeThemeId: 'slack-dark',                 variant: 'dark',  partial: { accent: '#0077b5', ink: '#e6e6e6', surface: '#222222' } },
    { name: 'Slack Ochin',                codeThemeId: 'slack-ochin',                variant: 'light', partial: { accent: '#005ed4', ink: '#000000', surface: '#ffffff' } },
    { name: 'Snazzy Light',               codeThemeId: 'snazzy-light',               variant: 'light', partial: { accent: '#09a1ed', ink: '#565869', surface: '#fafbfc' } },
    { name: 'Solarized Dark',             codeThemeId: 'solarized-dark',             variant: 'dark',  partial: { accent: '#2aa198', ink: '#839496', surface: '#002b36' } },
    { name: 'Solarized Light',            codeThemeId: 'solarized-light',            variant: 'light', partial: { accent: '#268bd2', ink: '#657b83', surface: '#fdf6e3' } },
    { name: 'Tokyo Night',                codeThemeId: 'tokyo-night',                variant: 'dark',  partial: { accent: '#7aa2f7', ink: '#a9b1d6', surface: '#1a1b26' } },
    { name: 'Vesper',                     codeThemeId: 'vesper',                     variant: 'dark',  partial: { accent: '#ffc799', ink: '#ffffff', surface: '#101010' } },
    { name: 'Vitesse Black',              codeThemeId: 'vitesse-black',              variant: 'dark',  partial: { accent: '#4d9375', ink: '#dbd7ca', surface: '#000000' } },
    { name: 'Vitesse Dark',               codeThemeId: 'vitesse-dark',               variant: 'dark',  partial: { accent: '#4d9375', ink: '#dbd7ca', surface: '#121212' } },
    { name: 'Vitesse Light',              codeThemeId: 'vitesse-light',              variant: 'light', partial: { accent: '#1c6b48', ink: '#393a34', surface: '#ffffff' } },
]

/**
 * All built-in theme entries — codex defaults + first-class chrome theme
 * partials + code-theme-derived. The arrays are merged in priority order:
 * later sources are skipped when a (codeThemeId, variant) pair was already
 * registered by an earlier source. This guarantees a unique selection in the
 * picker even if a code theme later gets shipped with a chrome partial.
 */
export const BUILTIN_THEMES: ThemeEntry[] = (() => {
    const out: ThemeEntry[] = []
    const seen = new Set<string>()
    const push = (entry: ThemeEntry) => {
        const key = `${entry.variant}:${entry.codeThemeId}`
        if (seen.has(key)) return
        seen.add(key)
        out.push(entry)
    }
    push({ codeThemeId: 'codex', variant: 'light', theme: CODEX_LIGHT_DEFAULT })
    push({ codeThemeId: 'codex', variant: 'dark',  theme: CODEX_DARK_DEFAULT  })
    for (const p of CODEX_THEME_PARTIALS) {
        push({ codeThemeId: p.codeThemeId, variant: p.variant, theme: mergeWithDefault(p.partial, p.variant) })
    }
    for (const p of EXTRA_THEME_PARTIALS) {
        // Code-theme-derived presets default to opaque windows: they were
        // authored for VS Code (no vibrancy), and translucent vibrancy would
        // distort their carefully-chosen surface color.
        push({
            codeThemeId: p.codeThemeId,
            variant: p.variant,
            theme: mergeWithDefault({ ...p.partial, opaqueWindows: true }, p.variant),
        })
    }
    return out
})()

/**
 * Display name for a built-in theme by codeThemeId. CODEX_THEME_PARTIALS take
 * precedence — for shared codeThemeIds, that name wins.
 */
export const THEME_DISPLAY_NAMES: Record<string, string> = (() => {
    const out: Record<string, string> = { codex: 'Codex' }
    for (const p of EXTRA_THEME_PARTIALS) out[p.codeThemeId] = p.name
    for (const p of CODEX_THEME_PARTIALS) out[p.codeThemeId] = p.name
    return out
})()

/** Theme name lookup helpers. */
export function themesForMode(mode: ThemeMode): ThemeEntry[] {
    return BUILTIN_THEMES.filter((e) => e.variant === mode)
}

export function findTheme(codeThemeId: string, variant: ThemeMode): ThemeEntry | undefined {
    return BUILTIN_THEMES.find((e) => e.codeThemeId === codeThemeId && e.variant === variant)
}
