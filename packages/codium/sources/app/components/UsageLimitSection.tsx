import './UsageLimitSection.css'

interface UsageLimitSectionProps {
    title: string
    description: string
    percent: number
    meta: string
    action?: string
}

export function UsageLimitSection({
    title,
    description,
    percent,
    meta,
    action = 'Manage',
}: UsageLimitSectionProps) {
    const clamped = Math.max(0, Math.min(100, percent))

    return (
        <section className="usage-limit-section">
            <div className="usage-limit-section__header">
                <div>
                    <h3 className="usage-limit-section__title">{title}</h3>
                    <p className="usage-limit-section__description">{description}</p>
                </div>
                <button type="button" className="usage-limit-section__action">
                    {action}
                </button>
            </div>
            <div className="usage-limit-section__meter" aria-label={`${title} ${clamped}% used`}>
                <div
                    className="usage-limit-section__fill"
                    style={{ width: `${clamped}%` }}
                />
            </div>
            <div className="usage-limit-section__meta">
                <span>{meta}</span>
                <span>{clamped}%</span>
            </div>
        </section>
    )
}
