import './SelectButton.css'

interface SelectButtonProps {
    label: string
    width?: number
}

function ChevronDownIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
        </svg>
    )
}

export function SelectButton({ label, width = 240 }: SelectButtonProps) {
    return (
        <button
            type="button"
            className="select-button"
            style={{ width }}
            aria-label={label}
        >
            <span className="select-button__label">{label}</span>
            <ChevronDownIcon />
        </button>
    )
}
