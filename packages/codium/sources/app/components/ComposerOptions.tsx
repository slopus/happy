import { useState } from 'react'
import type { Attachment } from './AttachmentChip'
import './ComposerOptions.css'

interface ComposerOptionsProps {
    onSelect: (attachments: Attachment[]) => void
}

function ProjectIcon() {
    return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
            <path d="M8 13h8" />
            <path d="M8 16h5" />
        </svg>
    )
}

function LaptopIcon() {
    return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
            <rect width="18" height="12" x="3" y="4" rx="2" />
            <path d="M2 20h20" />
        </svg>
    )
}

function BranchIcon() {
    return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="6" r="3" />
            <path d="M6 15V8a2 2 0 0 1 2-2h7" />
            <path d="M6 15v-4a2 2 0 0 1 2-2h2" />
        </svg>
    )
}

function ChevronDown() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
        </svg>
    )
}

export function ComposerOptions({ onSelect }: ComposerOptionsProps) {
    const [project, setProject] = useState('utopia')
    const [mode, setMode] = useState('Work locally')
    const [branch, setBranch] = useState('main')

    const pickDirectory = async (ext: 'project' | 'folder') => {
        const picked = await window.files.pickDirectory()
        if (!picked) return
        setProject(picked.name)
        onSelect([{ ...picked, ext }])
    }

    return (
        <div className="composer-options" aria-label="Composer context">
            <button
                type="button"
                className="composer-options__item"
                onClick={() => {
                    void pickDirectory('project')
                }}
            >
                <span className="composer-options__icon composer-options__icon--project">
                    <ProjectIcon />
                </span>
                <span className="composer-options__label">{project}</span>
                <ChevronDown />
            </button>
            <button
                type="button"
                className="composer-options__item"
                onClick={() =>
                    setMode((current) =>
                        current === 'Work locally' ? 'Cloud task' : 'Work locally'
                    )
                }
            >
                <span className="composer-options__icon">
                    <LaptopIcon />
                </span>
                <span className="composer-options__label">{mode}</span>
                <ChevronDown />
            </button>
            <button
                type="button"
                className="composer-options__item"
                onClick={() =>
                    setBranch((current) => (current === 'main' ? 'current branch' : 'main'))
                }
            >
                <span className="composer-options__icon">
                    <BranchIcon />
                </span>
                <span className="composer-options__label">{branch}</span>
                <ChevronDown />
            </button>
        </div>
    )
}
