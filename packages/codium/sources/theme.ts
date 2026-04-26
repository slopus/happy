import { atom, useAtom, useAtomValue } from 'jotai'
import { useEffect } from 'react'
import {
    applyTheme,
    CODEX_DARK_DEFAULT,
    CODEX_LIGHT_DEFAULT,
    type ChromeTheme,
    type ThemeMode,
    type ThemeSource,
} from './theme/index'

export type { ThemeSource, ThemeMode, ChromeTheme } from './theme/index'
export type ThemeState = { source: ThemeSource; shouldUseDarkColors: boolean }

const SOURCE_KEY = 'codium.theme-source'
const LIGHT_KEY = 'codium.theme.light'
const DARK_KEY = 'codium.theme.dark'

const readJSON = <T>(key: string, fallback: T): T => {
    try {
        const raw = localStorage.getItem(key)
        if (!raw) return fallback
        const parsed = JSON.parse(raw)
        return { ...fallback, ...parsed } as T
    } catch {
        return fallback
    }
}

const readSource = (): ThemeSource => {
    try {
        const v = localStorage.getItem(SOURCE_KEY)
        if (v === 'light' || v === 'dark' || v === 'system') return v
    } catch {}
    return 'system'
}

const systemIsDark = () =>
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches

const initialSource = readSource()
const initialLight = readJSON<ChromeTheme>(LIGHT_KEY, CODEX_LIGHT_DEFAULT)
const initialDark = readJSON<ChromeTheme>(DARK_KEY, CODEX_DARK_DEFAULT)

export const themeSourceAtom = atom<ThemeSource>(initialSource)
export const themeIsDarkAtom = atom<boolean>(
    initialSource === 'dark' || (initialSource === 'system' && systemIsDark())
)
export const lightThemeAtom = atom<ChromeTheme>(initialLight)
export const darkThemeAtom = atom<ChromeTheme>(initialDark)

const resolveMode = (source: ThemeSource, dark: boolean): ThemeMode =>
    source === 'system' ? (dark ? 'dark' : 'light') : source

const persistTheme = (mode: ThemeMode, theme: ChromeTheme) => {
    try {
        localStorage.setItem(mode === 'light' ? LIGHT_KEY : DARK_KEY, JSON.stringify(theme))
    } catch {}
}

if (typeof window !== 'undefined') {
    const mode = resolveMode(initialSource, initialSource === 'dark' || (initialSource === 'system' && systemIsDark()))
    applyTheme(mode === 'light' ? initialLight : initialDark, mode)
}

export function useTheme() {
    const [source, setSource] = useAtom(themeSourceAtom)
    const [isDark, setIsDark] = useAtom(themeIsDarkAtom)
    const [light, setLight] = useAtom(lightThemeAtom)
    const [dark, setDark] = useAtom(darkThemeAtom)

    const reapply = (s: ThemeSource, d: boolean) => {
        const mode = resolveMode(s, d)
        const t = mode === 'light' ? light : dark
        applyTheme(t, mode)
        try {
            window.theme.setOpaque(!!t.opaqueWindows)
        } catch {}
    }

    useEffect(() => {
        void window.theme.get().then((state) => {
            setSource(state.source)
            setIsDark(state.shouldUseDarkColors)
            reapply(state.source, state.shouldUseDarkColors)
        })
        const off = window.theme.onUpdate((state: ThemeState) => {
            setSource(state.source)
            setIsDark(state.shouldUseDarkColors)
            reapply(state.source, state.shouldUseDarkColors)
        })
        return off
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        reapply(source, isDark)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [light, dark])

    const setTheme = async (next: ThemeSource) => {
        try {
            localStorage.setItem(SOURCE_KEY, next)
        } catch {}
        const state = await window.theme.set(next)
        setSource(state.source)
        setIsDark(state.shouldUseDarkColors)
        reapply(state.source, state.shouldUseDarkColors)
    }

    const updateLight = (patch: Partial<ChromeTheme>) => {
        const next = { ...light, ...patch }
        setLight(next)
        persistTheme('light', next)
    }
    const updateDark = (patch: Partial<ChromeTheme>) => {
        const next = { ...dark, ...patch }
        setDark(next)
        persistTheme('dark', next)
    }

    return { source, isDark, setTheme, light, dark, updateLight, updateDark }
}

export function useResolvedTheme() {
    const source = useAtomValue(themeSourceAtom)
    const isDark = useAtomValue(themeIsDarkAtom)
    const light = useAtomValue(lightThemeAtom)
    const dark = useAtomValue(darkThemeAtom)
    const mode = resolveMode(source, isDark)
    return { mode, theme: mode === 'light' ? light : dark }
}
