import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useAtom } from 'jotai'
import { effortAtom, type EffortLevel } from '@/app/state'

const EFFORTS: { id: EffortLevel; label: string }[] = [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
]

function ChevronDown() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
        </svg>
    )
}

function Check() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
        </svg>
    )
}

export function EffortPicker() {
    const [effort, setEffort] = useAtom(effortAtom)
    const current = EFFORTS.find((e) => e.id === effort) ?? EFFORTS[2]

    return (
        <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
                <button className="composer-footer__btn" aria-label="Reasoning effort">
                    <span className="composer-footer__btn-text">{current.label}</span>
                    <ChevronDown />
                </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content
                    className="composer-menu"
                    side="top"
                    align="end"
                    sideOffset={6}
                >
                    <DropdownMenu.Label className="composer-menu__label">
                        Reasoning effort
                    </DropdownMenu.Label>
                    {EFFORTS.map((e) => (
                        <DropdownMenu.Item
                            key={e.id}
                            className="composer-menu__item"
                            onSelect={() => setEffort(e.id)}
                        >
                            <span>{e.label}</span>
                            {effort === e.id && <Check />}
                        </DropdownMenu.Item>
                    ))}
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    )
}
