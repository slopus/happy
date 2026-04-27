import { ElectronAPI } from '@electron-toolkit/preload'

export type ThemeSource = 'system' | 'light' | 'dark'
export type ThemeState = { source: ThemeSource; shouldUseDarkColors: boolean }

export type ThemeApi = {
    get(): Promise<ThemeState>
    set(source: ThemeSource): Promise<ThemeState>
    setOpaque(args: { opaque: boolean; surface?: string }): void
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

export interface CodexAuthSnapshot {
    status: 'unconfigured' | 'connected'
    email?: string
    accountId?: string
    accessToken?: string
    expiresAt?: number
}

export type CodexAuthApi = {
    status(): Promise<CodexAuthSnapshot>
    login(): Promise<CodexAuthSnapshot>
    logout(): Promise<void>
    cancelLogin(): void
}

export type {
    AgentEffort,
    AgentEvent,
    AgentPermissionMode,
    AgentStartOptions,
} from '../../shared/agent-protocol'

export type AgentApi = {
    start(args: {
        sessionId: string
        prompt: string
        resume: boolean
        options: import('../../shared/agent-protocol').AgentStartOptions
    }): void
    send(sessionId: string, text: string): void
    interrupt(sessionId: string): void
    stop(sessionId: string): void
    onEvent(
        sessionId: string,
        cb: (ev: import('../../shared/agent-protocol').AgentEvent) => void,
    ): () => void
    onClosed(sessionId: string, cb: () => void): () => void
}

declare global {
    interface Window {
        electron: ElectronAPI
        api: unknown
        theme: ThemeApi
        pty: PtyApi
        win: WinApi
        files: FilesApi
        codexAuth: CodexAuthApi
        agent: AgentApi
    }
}
