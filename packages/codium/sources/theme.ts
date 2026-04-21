import { atom, useAtom } from 'jotai'
import { useEffect } from 'react'

export type ThemeSource = 'system' | 'light' | 'dark'
export type ThemeState = { source: ThemeSource; shouldUseDarkColors: boolean }

const STORAGE_KEY = 'codium.theme-source'

const readStoredSource = (): ThemeSource => {
    try {
        const v = localStorage.getItem(STORAGE_KEY)
        if (v === 'light' || v === 'dark' || v === 'system') return v
    } catch {}
    return 'system'
}

const systemIsDark = () =>
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches

const initialSource = readStoredSource()
const initialDark =
    initialSource === 'dark' || (initialSource === 'system' && systemIsDark())

export const themeSourceAtom = atom<ThemeSource>(initialSource)
export const themeIsDarkAtom = atom<boolean>(initialDark)

const applyThemeClass = (dark: boolean) => {
    const root = document.documentElement
    root.classList.toggle('electron-dark', dark)
    root.classList.toggle('electron-light', !dark)
    root.style.colorScheme = dark ? 'dark' : 'light'
}

export function useTheme() {
    const [source, setSource] = useAtom(themeSourceAtom)
    const [isDark, setIsDark] = useAtom(themeIsDarkAtom)

    useEffect(() => {
        void window.theme.get().then((state) => {
            setSource(state.source)
            setIsDark(state.shouldUseDarkColors)
            applyThemeClass(state.shouldUseDarkColors)
        })
        const off = window.theme.onUpdate((state: ThemeState) => {
            setSource(state.source)
            setIsDark(state.shouldUseDarkColors)
            applyThemeClass(state.shouldUseDarkColors)
        })
        return off
    }, [setSource, setIsDark])

    const setTheme = async (next: ThemeSource) => {
        try {
            localStorage.setItem(STORAGE_KEY, next)
        } catch {}
        const state = await window.theme.set(next)
        setSource(state.source)
        setIsDark(state.shouldUseDarkColors)
        applyThemeClass(state.shouldUseDarkColors)
    }

    return { source, isDark, setTheme }
}
