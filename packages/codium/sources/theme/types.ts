export type ThemeMode = 'light' | 'dark'
export type ThemeSource = 'system' | 'light' | 'dark'

export interface ChromeTheme {
    accent: string
    ink: string
    surface: string
    contrast: number
    opaqueWindows: boolean
    fonts: {
        ui: string | null
        code: string | null
    }
    semanticColors: {
        diffAdded: string
        diffRemoved: string
        skill: string
    }
}

/**
 * Canonical theme entry — pairs a code theme with its chrome theme and a variant.
 * Mirrors Codex's internal shape:
 *   { codeThemeId, theme, variant }
 */
export interface ThemeEntry {
    codeThemeId: string
    theme: ChromeTheme
    variant: ThemeMode
}

export interface AppearanceState {
    appearanceTheme: ThemeSource
    light: ThemeEntry
    dark: ThemeEntry
}
