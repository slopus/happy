import './AutomationTemplateCard.css'

interface AutomationTemplateCardProps {
    title: string
}

export function AutomationTemplateCard({ title }: AutomationTemplateCardProps) {
    return (
        <button type="button" className="automation-template-card">
            {title}
        </button>
    )
}
