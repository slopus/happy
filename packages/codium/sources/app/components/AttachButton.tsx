import './AttachButton.css'

interface AttachButtonProps {
    onSelect: (files: Array<{ path: string; name: string; ext: string }>) => void
}

function PlusIcon() {
    return (
        <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M12 5v14" />
            <path d="M5 12h14" />
        </svg>
    )
}

export function AttachButton({ onSelect }: AttachButtonProps) {
    const onClick = async () => {
        const picked = await window.files.pick()
        if (picked.length) onSelect(picked)
    }

    return (
        <button
            type="button"
            className="composer-footer__btn composer-footer__btn--icon attach-button"
            aria-label="Add files and more"
            onClick={onClick}
        >
            <PlusIcon />
        </button>
    )
}
