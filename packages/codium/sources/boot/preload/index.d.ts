import { ElectronAPI } from '@electron-toolkit/preload'

export type ThemeSource = 'system' | 'light' | 'dark'
export type ThemeState = { source: ThemeSource; shouldUseDarkColors: boolean }

export type ThemeApi = {
    get(): Promise<ThemeState>
    set(source: ThemeSource): Promise<ThemeState>
    setOpaque(opaque: boolean): void
    onUpdate(cb: (state: ThemeState) => void): () => void
}

export type PtyApi = {
    create(opts?: { cols?: number; rows?: number; cwd?: string }): Promise<string>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): void
    onData(id: string, cb: (data: string) => void): () => void
    onExit(id: string, cb: () => void): () => void
}

export type WinApi = {
    isFullScreenSync(): boolean
    onFullScreenChange(cb: (fullscreen: boolean) => void): () => void
}

export type PickedFile = { path: string; name: string; ext: string }

export type FilesApi = {
    pick(): Promise<PickedFile[]>
    pickDirectory(): Promise<PickedFile | null>
    readDataUrl(path: string): Promise<string | null>
}

declare global {
    interface Window {
        electron: ElectronAPI
        api: unknown
        theme: ThemeApi
        pty: PtyApi
        win: WinApi
        files: FilesApi
    }
}
