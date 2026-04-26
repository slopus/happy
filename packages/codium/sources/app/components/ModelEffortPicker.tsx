import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useAtom } from 'jotai'
import { effortAtom, modelAtom, type EffortLevel } from '@/app/state'
import './Composer.css'

interface ModelOption {
    id: string
    label: string
    group: string
}

const MODELS: ModelOption[] = [
    { id: 'gpt-5-5',            label: '5.5',         group: 'OpenAI' },
    { id: 'gpt-5-4',            label: '5.4',         group: 'OpenAI' },
    { id: 'claude-sonnet-4-6',  label: 'Sonnet 4.6',  group: 'Anthropic' },
    { id: 'claude-opus-4-6',    label: 'Opus 4.6',    group: 'Anthropic' },
    { id: 'claude-opus-4-7',    label: 'Opus 4.7',    group: 'Anthropic' },
]

const EFFORTS: { id: EffortLevel; label: string }[] = [
    { id: 'low',    label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high',   label: 'High' },
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

export function ModelEffortPicker() {
    const [model, setModel] = useAtom(modelAtom)
    const [effort, setEffort] = useAtom(effortAtom)
    const currentModel = MODELS.find((m) => m.id === model) ?? MODELS[0]
    const currentEffort = EFFORTS.find((e) => e.id === effort) ?? EFFORTS[2]
    const groups = Array.from(new Set(MODELS.map((m) => m.group)))

    return (
        <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
                <button
                    type="button"
                    className="composer-footer__btn composer-footer__btn--model-effort"
                    aria-label="Model and reasoning effort"
                >
                    <span className="composer-footer__btn-text composer-footer__btn-text--strong">
                        {currentModel.label}
                    </span>
                    <span className="composer-footer__btn-text composer-footer__btn-text--muted">
                        {currentEffort.label}
                    </span>
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
                            {MODELS.filter((m) => m.group === g).map((m) => (
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
                    <DropdownMenu.Group className="composer-menu__group">
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
                    </DropdownMenu.Group>
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    )
}
