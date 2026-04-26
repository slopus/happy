import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useAtom } from 'jotai'
import { Link } from 'react-router-dom'
import { effortAtom, modelAtom, type EffortLevel } from '@/app/state'
import { useInferenceModels } from '@/plugins'
import './Composer.css'

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
    const inferenceModels = useInferenceModels()

    const currentModel = inferenceModels.find((m) => m.model.id === model)?.model
    const currentEffort = EFFORTS.find((e) => e.id === effort) ?? EFFORTS[2]
    const groups = Array.from(new Set(inferenceModels.map(({ model: m }) => m.group)))

    const empty = inferenceModels.length === 0
    return (
        <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
                <button
                    type="button"
                    className={
                        empty
                            ? 'composer-footer__btn composer-footer__btn--model-effort composer-footer__btn--empty'
                            : 'composer-footer__btn composer-footer__btn--model-effort'
                    }
                    aria-label="Model and reasoning effort"
                >
                    {empty ? (
                        <span className="composer-footer__btn-text composer-footer__btn-text--muted">
                            Pick a model
                        </span>
                    ) : (
                        <>
                            <span className="composer-footer__btn-text composer-footer__btn-text--strong">
                                {currentModel?.label ?? 'No model'}
                            </span>
                            <span className="composer-footer__btn-text composer-footer__btn-text--muted">
                                {currentEffort.label}
                            </span>
                        </>
                    )}
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
                    {inferenceModels.length === 0 && (
                        <DropdownMenu.Group className="composer-menu__group">
                            <DropdownMenu.Label className="composer-menu__label">
                                No inference plugins connected
                            </DropdownMenu.Label>
                            <DropdownMenu.Item asChild>
                                <Link to="/plugins" className="composer-menu__item">
                                    <span>Open Plugins…</span>
                                </Link>
                            </DropdownMenu.Item>
                        </DropdownMenu.Group>
                    )}
                    {groups.map((g) => (
                        <DropdownMenu.Group key={g} className="composer-menu__group">
                            <DropdownMenu.Label className="composer-menu__label">
                                {g}
                            </DropdownMenu.Label>
                            {inferenceModels
                                .filter(({ model: m }) => m.group === g)
                                .map(({ model: m }) => (
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
