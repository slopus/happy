import './OptionCard.css'

interface OptionCardProps {
    title: string
    description: string
    selected?: boolean
}

export function OptionCard({
    title,
    description,
    selected = false,
}: OptionCardProps) {
    return (
        <button
            type="button"
            className={selected ? 'option-card option-card--selected' : 'option-card'}
        >
            <span className="option-card__mark" aria-hidden="true">
                {selected ? '✓' : ''}
            </span>
            <span className="option-card__title">{title}</span>
            <span className="option-card__description">{description}</span>
        </button>
    )
}
