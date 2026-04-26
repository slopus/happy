import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export type ThemeSource = 'system' | 'light' | 'dark'
export type ThemeState = { source: ThemeSource; shouldUseDarkColors: boolean }

const theme = {
    get: (): Promise<ThemeState> => ipcRenderer.invoke('theme:get'),
    set: (source: ThemeSource): Promise<ThemeState> =>
        ipcRenderer.invoke('theme:set', source),
    setOpaque: (opaque: boolean) => ipcRenderer.send('theme:set-opaque', opaque),
    onUpdate: (cb: (state: ThemeState) => void) => {
        const listener = (_: unknown, state: ThemeState) => cb(state)
        ipcRenderer.on('theme:updated', listener)
        return () => ipcRenderer.off('theme:updated', listener)
    },
}

const api = {}

const win = {
    isFullScreenSync: (): boolean =>
        ipcRenderer.sendSync('win:sync:is-fullscreen') as boolean,
    onFullScreenChange: (cb: (fullscreen: boolean) => void) => {
        const listener = (_: unknown, fullscreen: boolean) => cb(fullscreen)
        ipcRenderer.on('win:fullscreen', listener)
        return () => ipcRenderer.off('win:fullscreen', listener)
    },
}

const files = {
    pick: () =>
        ipcRenderer.invoke('files:pick') as Promise<
            Array<{ path: string; name: string; ext: string }>
        >,
    pickDirectory: () =>
        ipcRenderer.invoke('files:pick-directory') as Promise<{
            path: string
            name: string
            ext: string
        } | null>,
    readDataUrl: (filePath: string) =>
        ipcRenderer.invoke('files:read-data-url', filePath) as Promise<
            string | null
        >,
}

const pty = {
    create: (opts: { cols?: number; rows?: number; cwd?: string } = {}) =>
        ipcRenderer.invoke('pty:create', opts) as Promise<string>,
    write: (id: string, data: string) => ipcRenderer.send('pty:write', id, data),
    resize: (id: string, cols: number, rows: number) =>
        ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string) => ipcRenderer.send('pty:kill', id),
    onData: (id: string, cb: (data: string) => void) => {
        const channel = `pty:data:${id}`
        const listener = (_: unknown, data: string) => cb(data)
        ipcRenderer.on(channel, listener)
        return () => ipcRenderer.off(channel, listener)
    },
    onExit: (id: string, cb: () => void) => {
        const channel = `pty:exit:${id}`
        const listener = () => cb()
        ipcRenderer.on(channel, listener)
        return () => ipcRenderer.off(channel, listener)
    },
}

if (process.contextIsolated) {
    try {
        contextBridge.exposeInMainWorld('electron', electronAPI)
        contextBridge.exposeInMainWorld('api', api)
        contextBridge.exposeInMainWorld('theme', theme)
        contextBridge.exposeInMainWorld('pty', pty)
        contextBridge.exposeInMainWorld('win', win)
        contextBridge.exposeInMainWorld('files', files)
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
    // @ts-expect-error augmenting window
    window.pty = pty
    // @ts-expect-error augmenting window
    window.win = win
    // @ts-expect-error augmenting window
    window.files = files
}
