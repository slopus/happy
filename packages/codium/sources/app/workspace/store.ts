import { atom } from 'jotai'
import { v4 as uuid } from 'uuid'
import {
    chatOrderAtom,
    chatsAtom,
    type Chat,
    type ChatMessage,
} from '@/app/chat/store'

export type ProjectMode = 'worktree' | 'plain'
export type WorkspaceKind = 'worktree' | 'section'
export type WorkspaceTabKind = 'chat' | 'terminal'

export interface Project {
    id: string
    name: string
    path: string
    mode: ProjectMode
    workspaceRootName?: string
    workspaceIds: string[]
    activeWorkspaceId?: string
    createdAt: number
    updatedAt: number
}

export interface Workspace {
    id: string
    projectId: string
    name: string
    path: string
    kind: WorkspaceKind
    branchName?: string
    chatIds: string[]
    terminalIds: string[]
    activeTabId?: string
    createdAt: number
    updatedAt: number
}

export interface TerminalEntry {
    id: string
    workspaceId: string
    title: string
    cwd: string
    createdAt: number
}

export const projectsAtom = atom<Record<string, Project>>({})
export const projectOrderAtom = atom<string[]>([])
export const workspacesAtom = atom<Record<string, Workspace>>({})
export const terminalsAtom = atom<Record<string, TerminalEntry>>({})

export const projectListAtom = atom((get) => {
    const projects = get(projectsAtom)
    return get(projectOrderAtom)
        .map((id) => projects[id])
        .filter((project): project is Project => Boolean(project))
})

export const workspaceByIdAtomFamily = (id: string) =>
    atom((get) => get(workspacesAtom)[id])

export const projectByIdAtomFamily = (id: string) =>
    atom((get) => get(projectsAtom)[id])

export const activeWorkspaceTabsAtomFamily = (workspaceId: string) =>
    atom((get) => {
        const workspace = get(workspacesAtom)[workspaceId]
        if (!workspace) return []
        const chats = get(chatsAtom)
        const terminals = get(terminalsAtom)
        return [
            ...workspace.chatIds
                .map((id) => chats[id])
                .filter((chat): chat is Chat => Boolean(chat))
                .map((chat) => ({
                    id: chat.id,
                    kind: 'chat' as const,
                    title: chat.title,
                })),
            ...workspace.terminalIds
                .map((id) => terminals[id])
                .filter((terminal): terminal is TerminalEntry => Boolean(terminal))
                .map((terminal) => ({
                    id: terminal.id,
                    kind: 'terminal' as const,
                    title: terminal.title,
                })),
        ]
    })

export const hydrateWorkspaceAtom = atom(
    null,
    (
        _get,
        set,
        snapshot: {
            projects?: Record<string, Project>
            projectOrder?: string[]
            workspaces?: Record<string, Workspace>
            terminals?: Record<string, TerminalEntry>
        },
    ) => {
        set(projectsAtom, snapshot.projects ?? {})
        set(projectOrderAtom, snapshot.projectOrder ?? [])
        set(workspacesAtom, snapshot.workspaces ?? {})
        set(terminalsAtom, snapshot.terminals ?? {})
    },
)

function createChatRecord(workspaceId: string, title = 'New chat', firstUserMessage?: string): Chat {
    const now = Date.now()
    const messages: ChatMessage[] = firstUserMessage
        ? [{ id: uuid(), role: 'user', text: firstUserMessage, finished: true }]
        : []
    return {
        id: uuid(),
        workspaceId,
        title,
        messages,
        sessionId: uuid(),
        status: 'idle',
        createdAt: now,
        updatedAt: now,
    }
}

export const createProjectAtom = atom(
    null,
    (
        _get,
        set,
        init: {
            name: string
            path: string
            mode: ProjectMode
            workspaceRootName?: string
            initialWorkspace?: {
                name: string
                path: string
                kind: WorkspaceKind
                branchName?: string
            }
        },
    ) => {
        const now = Date.now()
        const projectId = uuid()
        const workspaceId = uuid()
        const chat = createChatRecord(workspaceId)
        const initialWorkspace = init.initialWorkspace
        const workspace: Workspace = {
            id: workspaceId,
            projectId,
            name: initialWorkspace?.name ?? (init.mode === 'worktree' ? 'main' : 'Section 1'),
            path: initialWorkspace?.path ?? init.path,
            kind: initialWorkspace?.kind ?? (init.mode === 'worktree' ? 'worktree' : 'section'),
            branchName: initialWorkspace?.branchName,
            chatIds: [chat.id],
            terminalIds: [],
            activeTabId: chat.id,
            createdAt: now,
            updatedAt: now,
        }
        const project: Project = {
            id: projectId,
            name: init.name,
            path: init.path,
            mode: init.mode,
            workspaceRootName: init.workspaceRootName,
            workspaceIds: [workspaceId],
            activeWorkspaceId: workspaceId,
            createdAt: now,
            updatedAt: now,
        }
        set(projectsAtom, (prev) => ({ ...prev, [projectId]: project }))
        set(projectOrderAtom, (prev) => [projectId, ...prev])
        set(workspacesAtom, (prev) => ({ ...prev, [workspaceId]: workspace }))
        set(chatsAtom, (prev) => ({ ...prev, [chat.id]: chat }))
        set(chatOrderAtom, (prev) => [chat.id, ...prev])
        return { project, workspace, chat }
    },
)

export const deleteProjectAtom = atom(
    null,
    (get, set, projectId: string) => {
        const project = get(projectsAtom)[projectId]
        if (!project) return
        const workspaces = get(workspacesAtom)
        const workspaceIds = new Set(project.workspaceIds)
        const chatIds = new Set<string>()
        const terminalIds = new Set<string>()
        for (const workspaceId of workspaceIds) {
            const workspace = workspaces[workspaceId]
            if (!workspace) continue
            for (const chatId of workspace.chatIds) chatIds.add(chatId)
            for (const terminalId of workspace.terminalIds) terminalIds.add(terminalId)
        }

        set(projectsAtom, (prev) => {
            const next = { ...prev }
            delete next[projectId]
            return next
        })
        set(projectOrderAtom, (prev) => prev.filter((id) => id !== projectId))
        set(workspacesAtom, (prev) => {
            const next = { ...prev }
            for (const workspaceId of workspaceIds) delete next[workspaceId]
            return next
        })
        set(chatsAtom, (prev) => {
            const next = { ...prev }
            for (const chatId of chatIds) delete next[chatId]
            return next
        })
        set(chatOrderAtom, (prev) => prev.filter((id) => !chatIds.has(id)))
        set(terminalsAtom, (prev) => {
            const next = { ...prev }
            for (const terminalId of terminalIds) delete next[terminalId]
            return next
        })
    },
)

export const createWorkspaceAtom = atom(
    null,
    (
        get,
        set,
        init: {
            projectId: string
            name: string
            path: string
            kind: WorkspaceKind
            branchName?: string
        },
    ) => {
        const project = get(projectsAtom)[init.projectId]
        if (!project) return null
        const now = Date.now()
        const workspaceId = uuid()
        const chat = createChatRecord(workspaceId)
        const workspace: Workspace = {
            id: workspaceId,
            projectId: init.projectId,
            name: init.name,
            path: init.path,
            kind: init.kind,
            branchName: init.branchName,
            chatIds: [chat.id],
            terminalIds: [],
            activeTabId: chat.id,
            createdAt: now,
            updatedAt: now,
        }
        set(workspacesAtom, (prev) => ({ ...prev, [workspaceId]: workspace }))
        set(projectsAtom, (prev) => ({
            ...prev,
            [project.id]: {
                ...project,
                workspaceIds: [...project.workspaceIds, workspaceId],
                activeWorkspaceId: workspaceId,
                updatedAt: now,
            },
        }))
        set(chatsAtom, (prev) => ({ ...prev, [chat.id]: chat }))
        set(chatOrderAtom, (prev) => [chat.id, ...prev])
        return { workspace, chat }
    },
)

export const createChatInWorkspaceAtom = atom(
    null,
    (get, set, workspaceId: string) => {
        const workspace = get(workspacesAtom)[workspaceId]
        if (!workspace) return null
        const chat = createChatRecord(workspaceId)
        set(chatsAtom, (prev) => ({ ...prev, [chat.id]: chat }))
        set(chatOrderAtom, (prev) => [chat.id, ...prev])
        set(workspacesAtom, (prev) => ({
            ...prev,
            [workspaceId]: {
                ...workspace,
                chatIds: [...workspace.chatIds, chat.id],
                activeTabId: chat.id,
                updatedAt: Date.now(),
            },
        }))
        return chat
    },
)

export const createTerminalInWorkspaceAtom = atom(
    null,
    (get, set, workspaceId: string) => {
        const workspace = get(workspacesAtom)[workspaceId]
        if (!workspace) return null
        const id = uuid()
        const terminal: TerminalEntry = {
            id,
            workspaceId,
            title: `Terminal ${workspace.terminalIds.length + 1}`,
            cwd: workspace.path,
            createdAt: Date.now(),
        }
        set(terminalsAtom, (prev) => ({ ...prev, [id]: terminal }))
        set(workspacesAtom, (prev) => ({
            ...prev,
            [workspaceId]: {
                ...workspace,
                terminalIds: [...workspace.terminalIds, id],
                activeTabId: id,
                updatedAt: Date.now(),
            },
        }))
        return terminal
    },
)

export const closeTerminalAtom = atom(
    null,
    (get, set, terminalId: string) => {
        const terminal = get(terminalsAtom)[terminalId]
        if (!terminal) return
        const workspace = get(workspacesAtom)[terminal.workspaceId]
        set(terminalsAtom, (prev) => {
            const next = { ...prev }
            delete next[terminalId]
            return next
        })
        if (!workspace) return
        const terminalIds = workspace.terminalIds.filter((id) => id !== terminalId)
        set(workspacesAtom, (prev) => ({
            ...prev,
            [workspace.id]: {
                ...workspace,
                terminalIds,
                activeTabId: workspace.activeTabId === terminalId
                    ? workspace.chatIds.at(-1) ?? terminalIds.at(-1)
                    : workspace.activeTabId,
                updatedAt: Date.now(),
            },
        }))
    },
)

export const setWorkspaceActiveTabAtom = atom(
    null,
    (get, set, args: { workspaceId: string; tabId: string }) => {
        const workspace = get(workspacesAtom)[args.workspaceId]
        if (!workspace) return
        if (
            !workspace.chatIds.includes(args.tabId)
            && !workspace.terminalIds.includes(args.tabId)
        ) {
            return
        }
        set(workspacesAtom, (prev) => ({
            ...prev,
            [workspace.id]: {
                ...workspace,
                activeTabId: args.tabId,
                updatedAt: Date.now(),
            },
        }))
    },
)
