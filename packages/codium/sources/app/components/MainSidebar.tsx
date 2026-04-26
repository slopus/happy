import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useAtom, useSetAtom } from 'jotai'
import {
    preSettingsPathAtom,
    searchOpenAtom,
    terminalsAtom,
    type TerminalEntry,
} from '@/app/state'
import { SidebarResizer } from './SidebarResizer'
import './MainSidebar.css'

function NewChatIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z" />
        </svg>
    )
}

function SearchIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
        </svg>
    )
}

function AutomationsIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2 3 14h8l-1 8 10-12h-8l1-8Z" />
        </svg>
    )
}

function PluginsIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 4h2a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2h1v4h-1a2 2 0 0 0-2 2v2a2 2 0 0 1-2 2h-2v-1a2 2 0 0 0-2-2 2 2 0 0 0-2 2v1H6a2 2 0 0 1-2-2v-2a2 2 0 0 0-2-2H1v-4h1a2 2 0 0 0 2-2V6a2 2 0 0 1 2-2h4v1a2 2 0 0 0 2 2 2 2 0 0 0 2-2V4Z" />
        </svg>
    )
}

function ComponentsIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 4h7v7H4z" />
            <path d="M13 4h7v7h-7z" />
            <path d="M4 13h7v7H4z" />
            <path d="M13 13h7v7h-7z" />
        </svg>
    )
}

function TerminalIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="m4 6 6 6-6 6" />
            <path d="M12 19h8" />
        </svg>
    )
}

function PlusIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
        </svg>
    )
}

function CloseIcon() {
    return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
        </svg>
    )
}

function GearIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.36.15.68.36.94.62A2 2 0 0 1 21 11h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
    )
}

export function MainSidebar() {
    const location = useLocation()
    const navigate = useNavigate()
    const setPreSettings = useSetAtom(preSettingsPathAtom)
    const setSearchOpen = useSetAtom(searchOpenAtom)
    const [terminals, setTerminals] = useAtom(terminalsAtom)

    const openSettings = () => {
        setPreSettings(location.pathname)
        navigate('/settings')
    }

    const addTerminal = () => {
        const id =
            typeof crypto !== 'undefined' && 'randomUUID' in crypto
                ? crypto.randomUUID()
                : `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const next: TerminalEntry = {
            id,
            title: `Terminal ${terminals.length + 1}`,
        }
        setTerminals([...terminals, next])
        navigate(`/terminal/${id}`)
    }

    const closeTerminal = (targetId: string) => {
        const remaining = terminals.filter((t) => t.id !== targetId)
        setTerminals(remaining)
        if (location.pathname === `/terminal/${targetId}`) {
            const next = remaining[remaining.length - 1]
            navigate(next ? `/terminal/${next.id}` : '/chat/new')
        }
    }

    return (
        <aside className="app__sidebar">
            <SidebarResizer />
            <div className="app__sidebar-nav">
                <NavLink
                    to="/chat/new"
                    className={({ isActive }) =>
                        isActive ? 'app__nav-item app__nav-item--active' : 'app__nav-item'
                    }
                >
                    <NewChatIcon />
                    <span>New chat</span>
                </NavLink>
                <button
                    type="button"
                    className="app__nav-item"
                    onClick={() => setSearchOpen(true)}
                >
                    <SearchIcon />
                    <span>Search</span>
                    <kbd className="app__nav-kbd">⌘K</kbd>
                </button>
                <NavLink
                    to="/automations"
                    className={({ isActive }) =>
                        isActive ? 'app__nav-item app__nav-item--active' : 'app__nav-item'
                    }
                >
                    <AutomationsIcon />
                    <span>Automations</span>
                </NavLink>
                <NavLink
                    to="/plugins"
                    className={({ isActive }) =>
                        isActive ? 'app__nav-item app__nav-item--active' : 'app__nav-item'
                    }
                >
                    <PluginsIcon />
                    <span>Plugins</span>
                </NavLink>
                <NavLink
                    to="/components"
                    className={({ isActive }) =>
                        isActive ? 'app__nav-item app__nav-item--active' : 'app__nav-item'
                    }
                >
                    <ComponentsIcon />
                    <span>Components</span>
                </NavLink>
                <button
                    type="button"
                    className="app__nav-item"
                    onClick={addTerminal}
                >
                    <PlusIcon />
                    <span>New terminal</span>
                </button>
                {terminals.length > 0 && (
                    <div className="app__sidebar-section">
                        <div className="app__sidebar-section-header">Terminals</div>
                        {terminals.map((t) => (
                            <div key={t.id} className="app__sidebar-row">
                                <NavLink
                                    to={`/terminal/${t.id}`}
                                    className={({ isActive }) =>
                                        isActive
                                            ? 'app__nav-item app__sidebar-row-main app__nav-item--active'
                                            : 'app__nav-item app__sidebar-row-main'
                                    }
                                >
                                    <TerminalIcon />
                                    <span>{t.title}</span>
                                </NavLink>
                                <button
                                    type="button"
                                    className="app__sidebar-row-close"
                                    aria-label={`Close ${t.title}`}
                                    onClick={() => closeTerminal(t.id)}
                                >
                                    <CloseIcon />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
            <div className="app__sidebar-footer">
                <button type="button" className="app__nav-item" onClick={openSettings}>
                    <GearIcon />
                    <span>Settings</span>
                </button>
            </div>
        </aside>
    )
}
