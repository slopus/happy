import * as ContextMenu from '@radix-ui/react-context-menu'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useAtomValue, useSetAtom } from 'jotai'
import {
    preSettingsPathAtom,
    searchOpenAtom,
} from '@/app/state'
import {
    createWorkspaceAtom,
    deleteProjectAtom,
    projectListAtom,
    workspacesAtom,
    type Project,
} from '@/app/workspace/store'
import { SidebarResizer } from './SidebarResizer'
import './MainSidebar.css'

function NewProjectIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
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

function FolderIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        </svg>
    )
}

function BranchIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="6" r="3" />
            <path d="M6 15V8a2 2 0 0 1 2-2h7" />
        </svg>
    )
}

function SectionIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 5h16" />
            <path d="M4 12h16" />
            <path d="M4 19h16" />
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
    const projects = useAtomValue(projectListAtom)
    const workspaces = useAtomValue(workspacesAtom)
    const createWorkspace = useSetAtom(createWorkspaceAtom)
    const deleteProject = useSetAtom(deleteProjectAtom)

    const openSettings = () => {
        setPreSettings(location.pathname)
        navigate('/settings')
    }

    const addWorkspace = async (project: Project) => {
        if (project.mode === 'worktree') {
            const created = await window.projects.createWorktree({
                projectPath: project.path,
                projectName: project.name,
                projectWorkspaceName: project.workspaceRootName,
            })
            if (created.kind === 'plain-fallback') {
                const usePlain = window.confirm(`${created.reason} Create a plain section instead?`)
                if (!usePlain) return
                const result = createWorkspace({
                    projectId: project.id,
                    name: `Section ${project.workspaceIds.length + 1}`,
                    path: project.path,
                    kind: 'section',
                })
                if (result) {
                    navigate(`/project/${project.id}/workspace/${result.workspace.id}/chat/${result.chat.id}`)
                }
                return
            }
            if (created.kind === 'error') {
                window.alert(created.message)
                return
            }
            const result = createWorkspace({
                projectId: project.id,
                name: created.name,
                path: created.path,
                kind: 'worktree',
                branchName: created.branchName,
            })
            if (result) {
                navigate(`/project/${project.id}/workspace/${result.workspace.id}/chat/${result.chat.id}`)
            }
            return
        }

        const result = createWorkspace({
            projectId: project.id,
            name: `Section ${project.workspaceIds.length + 1}`,
            path: project.path,
            kind: 'section',
        })
        if (result) {
            navigate(`/project/${project.id}/workspace/${result.workspace.id}/chat/${result.chat.id}`)
        }
    }

    const removeProject = (project: Project) => {
        const confirmed = window.confirm(`Delete "${project.name}" from Codium? Files on disk are not removed.`)
        if (!confirmed) return
        deleteProject(project.id)
        if (location.pathname.startsWith(`/project/${project.id}/`)) {
            navigate('/projects/new')
        }
    }

    return (
        <aside className="app__sidebar">
            <SidebarResizer />
            <div className="app__sidebar-nav">
                <NavLink
                    to="/projects/new"
                    className={({ isActive }) =>
                        isActive ? 'app__nav-item app__nav-item--active' : 'app__nav-item'
                    }
                >
                    <NewProjectIcon />
                    <span>New project</span>
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
                    to="/components"
                    className={({ isActive }) =>
                        isActive ? 'app__nav-item app__nav-item--active' : 'app__nav-item'
                    }
                >
                    <ComponentsIcon />
                    <span>Components</span>
                </NavLink>

                {projects.length > 0 && (
                    <div className="app__sidebar-section">
                        <div className="app__sidebar-section-header">Projects</div>
                        {projects.map((project) => (
                            <ContextMenu.Root key={project.id}>
                                <ContextMenu.Trigger asChild>
                                    <div className="app__project">
                                        <div className="app__project-header">
                                            <div className="app__project-title" title={project.path}>
                                                <FolderIcon />
                                                <span>{project.name}</span>
                                            </div>
                                            <button
                                                type="button"
                                                className="app__project-add"
                                                aria-label={`Add ${project.mode === 'worktree' ? 'worktree' : 'section'} to ${project.name}`}
                                                onClick={() => void addWorkspace(project).catch((err) => {
                                                    window.alert(err instanceof Error ? err.message : String(err))
                                                })}
                                            >
                                                <PlusIcon />
                                            </button>
                                        </div>
                                        {project.workspaceIds.map((workspaceId) => {
                                            const workspace = workspaces[workspaceId]
                                            if (!workspace) return null
                                            const firstTab = workspace.activeTabId
                                                ?? workspace.chatIds[0]
                                                ?? workspace.terminalIds[0]
                                            if (!firstTab) return null
                                            const tabKind = workspace.chatIds.includes(firstTab)
                                                ? 'chat'
                                                : 'terminal'
                                            return (
                                                <NavLink
                                                    key={workspace.id}
                                                    to={`/project/${project.id}/workspace/${workspace.id}/${tabKind}/${firstTab}`}
                                                    className={({ isActive }) =>
                                                        isActive
                                                            ? 'app__nav-item app__nav-item--nested app__nav-item--active'
                                                            : 'app__nav-item app__nav-item--nested'
                                                    }
                                                >
                                                    {workspace.kind === 'worktree' ? <BranchIcon /> : <SectionIcon />}
                                                    <span className="app__sidebar-row-label">{workspace.name}</span>
                                                </NavLink>
                                            )
                                        })}
                                    </div>
                                </ContextMenu.Trigger>
                                <ContextMenu.Portal>
                                    <ContextMenu.Content className="app__context-menu">
                                        <ContextMenu.Item
                                            className="app__context-menu-item app__context-menu-item--danger"
                                            onSelect={() => removeProject(project)}
                                        >
                                            Delete project
                                        </ContextMenu.Item>
                                    </ContextMenu.Content>
                                </ContextMenu.Portal>
                            </ContextMenu.Root>
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
