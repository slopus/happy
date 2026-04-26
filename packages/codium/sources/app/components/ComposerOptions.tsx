import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useState } from 'react'
import type { Attachment } from './AttachmentChip'
import './ComposerOptions.css'

interface ComposerOptionsProps {
    onSelect: (attachments: Attachment[]) => void
}

function Check() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
        </svg>
    )
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

const MODE_OPTIONS = ['Work locally', 'Cloud task'] as const
const BRANCH_OPTIONS = ['main', 'current branch', 'detached HEAD'] as const

interface OptionMenuProps<T extends string> {
    icon: React.ReactNode
    iconClassName?: string
    label: string
    value: T
    onSelect: (next: T) => void
    options: readonly T[]
    /** Optional bottom action (e.g. "Choose folder…") */
    action?: { label: string; onSelect: () => void }
}

function OptionMenu<T extends string>({
    icon,
    iconClassName,
    label,
    value,
    onSelect,
    options,
    action,
}: OptionMenuProps<T>) {
    return (
        <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
                <button type="button" className="composer-options__item" aria-label={label}>
                    <span className={iconClassName ? `composer-options__icon ${iconClassName}` : 'composer-options__icon'}>
                        {icon}
                    </span>
                    <span className="composer-options__label">{value}</span>
                    <ChevronDown />
                </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content
                    className="composer-menu"
                    side="top"
                    align="start"
                    sideOffset={6}
                >
                    <DropdownMenu.Group className="composer-menu__group">
                        {options.map((opt) => (
                            <DropdownMenu.Item
                                key={opt}
                                className="composer-menu__item"
                                onSelect={() => onSelect(opt)}
                            >
                                <span>{opt}</span>
                                {opt === value && <Check />}
                            </DropdownMenu.Item>
                        ))}
                    </DropdownMenu.Group>
                    {action && (
                        <DropdownMenu.Group className="composer-menu__group">
                            <DropdownMenu.Item
                                className="composer-menu__item"
                                onSelect={action.onSelect}
                            >
                                <span>{action.label}</span>
                            </DropdownMenu.Item>
                        </DropdownMenu.Group>
                    )}
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    )
}

export function ComposerOptions({ onSelect }: ComposerOptionsProps) {
    const [project, setProject] = useState('utopia')
    const [recentProjects, setRecentProjects] = useState<string[]>([
        'utopia', 'happy', 'codex',
    ])
    const [mode, setMode] = useState<typeof MODE_OPTIONS[number]>('Work locally')
    const [branch, setBranch] = useState<typeof BRANCH_OPTIONS[number]>('main')

    const pickDirectory = async () => {
        const picked = await window.files.pickDirectory()
        if (!picked) return
        setProject(picked.name)
        setRecentProjects((prev) => [picked.name, ...prev.filter((p) => p !== picked.name)].slice(0, 5))
        onSelect([{ ...picked, ext: 'project' }])
    }

    return (
        <div className="composer-options" aria-label="Composer context">
            <OptionMenu
                icon={<ProjectIcon />}
                iconClassName="composer-options__icon--project"
                label="Project"
                value={project}
                onSelect={(next) => setProject(next)}
                options={recentProjects}
                action={{ label: 'Choose folder…', onSelect: () => void pickDirectory() }}
            />
            <OptionMenu
                icon={<LaptopIcon />}
                label="Run mode"
                value={mode}
                onSelect={setMode}
                options={MODE_OPTIONS}
            />
            <OptionMenu
                icon={<BranchIcon />}
                label="Branch"
                value={branch}
                onSelect={setBranch}
                options={BRANCH_OPTIONS}
            />
        </div>
    )
}
