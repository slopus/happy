import { ReactNode } from 'react'
import { useAtom } from 'jotai'
import { useNavigate } from 'react-router-dom'
import { sidebarOpenAtom } from '@/app/state'

export function Toolbar({ children }: { children?: ReactNode }) {
    return <div className="app__toolbar">{children}</div>
}

function SidebarIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2.5" />
            <path d="M9 4v16" />
        </svg>
    )
}

function ArrowLeftIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 6-6 6 6 6" />
        </svg>
    )
}

function ArrowRightIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="m9 6 6 6-6 6" />
        </svg>
    )
}

export function SidebarToggleBtn() {
    const [open, setOpen] = useAtom(sidebarOpenAtom)
    return (
        <button
            type="button"
            className="app__toolbar-btn"
            aria-label={open ? 'Hide sidebar' : 'Show sidebar'}
            onClick={() => setOpen((v) => !v)}
        >
            <SidebarIcon />
        </button>
    )
}

export function BackBtn() {
    const navigate = useNavigate()
    return (
        <button
            type="button"
            className="app__toolbar-btn"
            aria-label="Back"
            onClick={() => navigate(-1)}
        >
            <ArrowLeftIcon />
        </button>
    )
}

export function ForwardBtn() {
    const navigate = useNavigate()
    return (
        <button
            type="button"
            className="app__toolbar-btn"
            aria-label="Forward"
            onClick={() => navigate(1)}
        >
            <ArrowRightIcon />
        </button>
    )
}
