import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useMemo } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
    activeWorkspaceTabsAtomFamily,
    createChatInWorkspaceAtom,
    createTerminalInWorkspaceAtom,
    setWorkspaceActiveTabAtom,
    workspaceByIdAtomFamily,
} from '@/app/workspace/store'
import './WorkspaceTabs.css'

function PlusIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
        </svg>
    )
}

function TerminalIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="m4 7 5 5-5 5" />
            <path d="M11 17h9" />
        </svg>
    )
}

function parseWorkspace(pathname: string): { projectId: string; workspaceId: string } | null {
    const match = pathname.match(/^\/project\/([^/]+)\/workspace\/([^/]+)\//)
    if (!match) return null
    return { projectId: match[1], workspaceId: match[2] }
}

export function WorkspaceTabs() {
    const location = useLocation()
    const navigate = useNavigate()
    const parsed = parseWorkspace(location.pathname)
    const workspaceId = parsed?.workspaceId ?? ''
    const workspaceAtom = useMemo(() => workspaceByIdAtomFamily(workspaceId), [workspaceId])
    const tabsAtom = useMemo(() => activeWorkspaceTabsAtomFamily(workspaceId), [workspaceId])
    const workspace = useAtomValue(workspaceAtom)
    const tabs = useAtomValue(tabsAtom)
    const createChat = useSetAtom(createChatInWorkspaceAtom)
    const createTerminal = useSetAtom(createTerminalInWorkspaceAtom)
    const setActiveTab = useSetAtom(setWorkspaceActiveTabAtom)

    useEffect(() => {
        if (!parsed) return
        const match = location.pathname.match(/\/(?:chat|terminal)\/([^/]+)$/)
        if (!match) return
        setActiveTab({ workspaceId: parsed.workspaceId, tabId: match[1] })
    }, [location.pathname, parsed?.workspaceId, setActiveTab])

    if (!parsed || !workspace) return null

    const base = `/project/${parsed.projectId}/workspace/${parsed.workspaceId}`

    const addChat = () => {
        const chat = createChat(parsed.workspaceId)
        if (chat) navigate(`${base}/chat/${chat.id}`)
    }

    const addTerminal = () => {
        const terminal = createTerminal(parsed.workspaceId)
        if (terminal) navigate(`${base}/terminal/${terminal.id}`)
    }

    return (
        <div className="workspace-tabs">
            <div className="workspace-tabs__meta">
                <span className="workspace-tabs__name">{workspace.name}</span>
                <span className="workspace-tabs__path">{workspace.path}</span>
            </div>
            <div className="workspace-tabs__list" role="tablist" aria-label="Workspace tabs">
                {tabs.map((tab) => (
                    <NavLink
                        key={`${tab.kind}:${tab.id}`}
                        to={`${base}/${tab.kind}/${tab.id}`}
                        className={({ isActive }) =>
                            isActive
                                ? 'workspace-tabs__tab workspace-tabs__tab--active'
                                : 'workspace-tabs__tab'
                        }
                    >
                        <span>{tab.title}</span>
                    </NavLink>
                ))}
                <button
                    type="button"
                    className="workspace-tabs__button"
                    aria-label="New chat"
                    onClick={addChat}
                >
                    <PlusIcon />
                </button>
                <button
                    type="button"
                    className="workspace-tabs__button"
                    aria-label="New terminal"
                    onClick={addTerminal}
                >
                    <TerminalIcon />
                </button>
            </div>
        </div>
    )
}
