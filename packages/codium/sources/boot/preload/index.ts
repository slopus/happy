import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
    HappyAuthenticatedClientStatus,
    HappyStateSnapshot,
} from '../../shared/happy-protocol'

export type ThemeSource = 'system' | 'light' | 'dark'
export type ThemeState = { source: ThemeSource; shouldUseDarkColors: boolean }

const theme = {
    get: (): Promise<ThemeState> => ipcRenderer.invoke('theme:get'),
    set: (source: ThemeSource): Promise<ThemeState> =>
        ipcRenderer.invoke('theme:set', source),
    setOpaque: (args: { opaque: boolean; surface?: string }) =>
        ipcRenderer.send('theme:set-opaque', args),
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

export interface CodexAuthSnapshot {
    status: 'unconfigured' | 'connected'
    email?: string
    accountId?: string
    accessToken?: string
    expiresAt?: number
}

export type ProjectWorktreeResult =
    | {
        kind: 'worktree'
        path: string
        name: string
        branchName: string
        projectWorkspaceName: string
      }
    | { kind: 'plain-fallback'; reason: string }
    | { kind: 'error'; message: string }

/* ─────── Agent (worker-backed Claude Agent SDK) ─────── */

export type {
    AgentEffort,
    AgentEvent,
    AgentPermissionMode,
    AgentStartOptions,
} from '../../shared/agent-protocol'

const agent = {
    start: (args: {
        sessionId: string
        prompt: string
        resume: boolean
        options: import('../../shared/agent-protocol').AgentStartOptions
    }) => ipcRenderer.send('agent:start', { kind: 'start', ...args }),
    send: (sessionId: string, text: string) =>
        ipcRenderer.send('agent:send', { kind: 'send', sessionId, text }),
    interrupt: (sessionId: string) =>
        ipcRenderer.send('agent:interrupt', { kind: 'interrupt', sessionId }),
    stop: (sessionId: string) =>
        ipcRenderer.send('agent:stop', { kind: 'stop', sessionId }),
    onEvent(
        sessionId: string,
        cb: (ev: import('../../shared/agent-protocol').AgentEvent) => void,
    ) {
        const channel = `agent:event:${sessionId}`
        const listener = (
            _: unknown,
            ev: import('../../shared/agent-protocol').AgentEvent,
        ) => cb(ev)
        ipcRenderer.on(channel, listener)
        return () => ipcRenderer.off(channel, listener)
    },
    onClosed(sessionId: string, cb: () => void) {
        const channel = `agent:closed:${sessionId}`
        const listener = () => cb()
        ipcRenderer.on(channel, listener)
        return () => ipcRenderer.off(channel, listener)
    },
}

/* ─────── Chats persistence (jotai store <-> <Happy home>/state.sqlite) ─────── */

export interface PersistedChats {
    chats: Record<string, unknown>
    order: string[]
    projects?: Record<string, unknown>
    projectOrder?: string[]
    workspaces?: Record<string, unknown>
    terminals?: Record<string, unknown>
}

const chats = {
    load: (): Promise<PersistedChats> => ipcRenderer.invoke('chats:load'),
    save: (state: PersistedChats): Promise<void> =>
        ipcRenderer.invoke('chats:save', state),
}

const codexAuth = {
    status: (): Promise<CodexAuthSnapshot> =>
        ipcRenderer.invoke('codex:auth:status'),
    login: (): Promise<CodexAuthSnapshot> =>
        ipcRenderer.invoke('codex:auth:login'),
    logout: (): Promise<void> => ipcRenderer.invoke('codex:auth:logout'),
    cancelLogin: () => ipcRenderer.send('codex:auth:cancel-login'),
}

const happy = {
    getState: (): Promise<HappyStateSnapshot> =>
        ipcRenderer.invoke('happy:state:get'),
    createAccount: (): Promise<HappyStateSnapshot> =>
        ipcRenderer.invoke('happy:create-account'),
    startLinkDevice: (): Promise<HappyStateSnapshot> =>
        ipcRenderer.invoke('happy:start-link-device'),
    restoreSecret: (secretKey: string): Promise<HappyStateSnapshot> =>
        ipcRenderer.invoke('happy:restore-secret', secretKey),
    cancelAuth: (): Promise<HappyStateSnapshot> =>
        ipcRenderer.invoke('happy:cancel-auth'),
    logout: (): Promise<HappyStateSnapshot> =>
        ipcRenderer.invoke('happy:logout'),
    clientStatus: (): Promise<HappyAuthenticatedClientStatus> =>
        ipcRenderer.invoke('happy:client-status'),
    onState(cb: (state: HappyStateSnapshot) => void) {
        const listener = (_: unknown, state: HappyStateSnapshot) => cb(state)
        ipcRenderer.on('happy:state', listener)
        return () => ipcRenderer.off('happy:state', listener)
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

const projects = {
    createWorktree: (args: {
        projectPath: string
        projectName: string
        projectWorkspaceName?: string
    }) =>
        ipcRenderer.invoke('projects:create-worktree', args) as Promise<ProjectWorktreeResult>,
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
        contextBridge.exposeInMainWorld('projects', projects)
        contextBridge.exposeInMainWorld('codexAuth', codexAuth)
        contextBridge.exposeInMainWorld('happy', happy)
        contextBridge.exposeInMainWorld('agent', agent)
        contextBridge.exposeInMainWorld('chats', chats)
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
    // @ts-expect-error augmenting window
    window.projects = projects
    // @ts-expect-error augmenting window
    window.codexAuth = codexAuth
    // @ts-expect-error augmenting window
    window.happy = happy
    // @ts-expect-error augmenting window
    window.agent = agent
    // @ts-expect-error augmenting window
    window.chats = chats
}
