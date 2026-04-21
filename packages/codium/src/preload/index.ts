import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export type ThemeSource = 'system' | 'light' | 'dark'
export type ThemeState = { source: ThemeSource; shouldUseDarkColors: boolean }

const theme = {
    get: (): Promise<ThemeState> => ipcRenderer.invoke('theme:get'),
    set: (source: ThemeSource): Promise<ThemeState> =>
        ipcRenderer.invoke('theme:set', source),
    onUpdate: (cb: (state: ThemeState) => void) => {
        const listener = (_: unknown, state: ThemeState) => cb(state)
        ipcRenderer.on('theme:updated', listener)
        return () => ipcRenderer.off('theme:updated', listener)
    },
}

const api = {}

if (process.contextIsolated) {
    try {
        contextBridge.exposeInMainWorld('electron', electronAPI)
        contextBridge.exposeInMainWorld('api', api)
        contextBridge.exposeInMainWorld('theme', theme)
    } catch (error) {
        console.error(error)
    }
} else {
    // @ts-expect-error augmenting window
    window.electron = electronAPI
    // @ts-expect-error augmenting window
    window.api = api
    // @ts-expect-error augmenting window
    window.theme = theme
}
