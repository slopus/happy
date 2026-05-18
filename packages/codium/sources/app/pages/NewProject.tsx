import { useState } from 'react'
import { useSetAtom } from 'jotai'
import { useNavigate } from 'react-router-dom'
import { Page } from '@/app/components/Page'
import { createProjectAtom, type ProjectMode } from '@/app/workspace/store'
import './NewProject.css'

export function NewProjectPage() {
    const createProject = useSetAtom(createProjectAtom)
    const navigate = useNavigate()
    const [mode, setMode] = useState<ProjectMode>('worktree')
    const [error, setError] = useState<string | null>(null)

    const pickFolder = async () => {
        setError(null)
        const picked = await window.files.pickDirectory()
        if (!picked) return
        const worktreeResult = mode === 'worktree'
            ? await window.projects.createWorktree({
                projectPath: picked.path,
                projectName: picked.name,
            })
            : null
        if (worktreeResult?.kind === 'error') {
            setError(worktreeResult.message)
            return
        }
        if (worktreeResult?.kind === 'plain-fallback') {
            const usePlain = window.confirm(`${worktreeResult.reason} Create a plain project instead?`)
            if (!usePlain) {
                setError(worktreeResult.reason)
                return
            }
        }
        const initialWorkspace = worktreeResult?.kind === 'worktree'
            ? worktreeResult
            : null
        const projectMode = initialWorkspace ? mode : 'plain'
        const result = createProject({
            name: picked.name,
            path: picked.path,
            mode: projectMode,
            ...(initialWorkspace
                ? { workspaceRootName: initialWorkspace.projectWorkspaceName }
                : {}),
            ...(initialWorkspace
                ? {
                    initialWorkspace: {
                        name: initialWorkspace.name,
                        path: initialWorkspace.path,
                        kind: 'worktree' as const,
                        branchName: initialWorkspace.branchName,
                    },
                }
                : {}),
        })
        navigate(`/project/${result.project.id}/workspace/${result.workspace.id}/chat/${result.chat.id}`)
    }

    return (
        <Page title="New project">
            <div className="new-project">
                <div className="new-project__panel">
                    <h2 className="new-project__title">Choose a project folder</h2>
                    <p className="new-project__copy">
                        Codium opens chats and terminals inside a project workspace. Worktree projects create local git worktrees in the Happy workspace folder; plain projects create lightweight sections in the same folder.
                    </p>
                    <div className="new-project__mode" role="tablist" aria-label="Project type">
                        <button
                            type="button"
                            className={mode === 'worktree' ? 'new-project__mode-btn new-project__mode-btn--active' : 'new-project__mode-btn'}
                            onClick={() => setMode('worktree')}
                        >
                            Worktree
                        </button>
                        <button
                            type="button"
                            className={mode === 'plain' ? 'new-project__mode-btn new-project__mode-btn--active' : 'new-project__mode-btn'}
                            onClick={() => setMode('plain')}
                        >
                            Plain
                        </button>
                    </div>
                    {error && <div className="new-project__error">{error}</div>}
                    <button
                        type="button"
                        className="new-project__pick"
                        onClick={() => void pickFolder().catch((err) => {
                            setError(err instanceof Error ? err.message : String(err))
                        })}
                    >
                        Pick folder
                    </button>
                </div>
            </div>
        </Page>
    )
}
