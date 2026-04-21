import { useTheme } from './theme'
import type { ThemeSource } from './theme'

const OPTIONS: { value: ThemeSource; label: string }[] = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
]

export function ThemeSwitcher() {
    const { source, setTheme } = useTheme()
    return (
        <div className="theme-switch" role="radiogroup" aria-label="Theme">
            {OPTIONS.map((opt) => (
                <button
                    key={opt.value}
                    role="radio"
                    aria-checked={source === opt.value}
                    className={
                        source === opt.value
                            ? 'theme-switch__option theme-switch__option--active'
                            : 'theme-switch__option'
                    }
                    onClick={() => setTheme(opt.value)}
                >
                    {opt.label}
                </button>
            ))}
        </div>
    )
}
