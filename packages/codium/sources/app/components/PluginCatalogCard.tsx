import './PluginCatalogCard.css'

interface PluginCatalogCardProps {
    name: string
    description: string
    action?: string
}

function ArrowIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14" />
            <path d="m13 6 6 6-6 6" />
        </svg>
    )
}

export function PluginCatalogCard({
    name,
    description,
    action = 'Try in Chat',
}: PluginCatalogCardProps) {
    return (
        <div className="plugin-catalog-card">
            <div className="plugin-catalog-card__meta">
                <div className="plugin-catalog-card__name">{name}</div>
                <div className="plugin-catalog-card__description">{description}</div>
            </div>
            <button
                type="button"
                className="plugin-catalog-card__action"
                aria-label={action}
            >
                <ArrowIcon />
            </button>
        </div>
    )
}
