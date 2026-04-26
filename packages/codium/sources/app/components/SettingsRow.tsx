import type { ReactNode } from 'react'
import './SettingsRow.css'

interface SettingsRowProps {
    label: string
    description?: string
    children: ReactNode
}

export function SettingsRow({ label, description, children }: SettingsRowProps) {
    return (
        <div className="settings-row">
            <div className="settings-row__copy">
                <div className="settings-row__label">{label}</div>
                {description && (
                    <div className="settings-row__description">{description}</div>
                )}
            </div>
            <div className="settings-row__control">{children}</div>
        </div>
    )
}
