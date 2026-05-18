import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useAtom } from 'jotai'
import { modelAtom } from '@/app/state'
import { AGENT_MODELS } from '@/agents/catalog'
import './Composer.css'

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

export function ModelPicker() {
    const [model, setModel] = useAtom(modelAtom)
    const current = AGENT_MODELS.find((m) => m.id === model) ?? AGENT_MODELS[0]
    const groups = Array.from(new Set(AGENT_MODELS.map((m) => m.group)))

    return (
        <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
                <button className="composer-footer__btn" aria-label="Model">
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
                    {groups.map((g) => (
                        <DropdownMenu.Group key={g} className="composer-menu__group">
                            <DropdownMenu.Label className="composer-menu__label">
                                {g}
                            </DropdownMenu.Label>
                            {AGENT_MODELS.filter((m) => m.group === g).map((m) => (
                                <DropdownMenu.Item
                                    key={m.id}
                                    className="composer-menu__item"
                                    onSelect={() => setModel(m.id)}
                                >
                                    <span>{m.label}</span>
                                    {model === m.id && <Check />}
                                </DropdownMenu.Item>
                            ))}
                        </DropdownMenu.Group>
                    ))}
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    )
}
