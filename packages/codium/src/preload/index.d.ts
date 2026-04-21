import { ElectronAPI } from '@electron-toolkit/preload'

export type ThemeSource = 'system' | 'light' | 'dark'
export type ThemeState = { source: ThemeSource; shouldUseDarkColors: boolean }

export type ThemeApi = {
    get(): Promise<ThemeState>
    set(source: ThemeSource): Promise<ThemeState>
    onUpdate(cb: (state: ThemeState) => void): () => void
}

declare global {
    interface Window {
        electron: ElectronAPI
        api: unknown
        theme: ThemeApi
    }
}
