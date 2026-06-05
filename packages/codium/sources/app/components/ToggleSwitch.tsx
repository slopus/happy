import { useState } from 'react'
import './ToggleSwitch.css'

interface ToggleSwitchProps {
    label: string
    defaultChecked?: boolean
}

export function ToggleSwitch({ label, defaultChecked = false }: ToggleSwitchProps) {
    const [checked, setChecked] = useState(defaultChecked)

    return (
        <button
            type="button"
            className={checked ? 'toggle-switch toggle-switch--checked' : 'toggle-switch'}
            role="switch"
            aria-checked={checked}
            aria-label={label}
            onClick={() => setChecked((value) => !value)}
        >
            <span className="toggle-switch__track">
                <span className="toggle-switch__thumb" />
            </span>
        </button>
    )
}
