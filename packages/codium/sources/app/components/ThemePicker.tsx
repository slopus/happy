import { useTheme } from '@/theme'
import {
    BUILTIN_THEMES,
    type ChromeTheme,
    type ThemeEntry,
    type ThemeMode,
} from '@/theme/index'
import './ThemePicker.css'

const PRETTY_NAME: Record<string, string> = {
    codex: 'Codex',
    'linear-light': 'Linear',
    'linear-dark': 'Linear',
    'vercel-light': 'Vercel',
    'vercel-dark': 'Vercel',
    'raycast-light': 'Raycast',
    'raycast-dark': 'Raycast',
    'notion-light': 'Notion',
    'notion-dark': 'Notion',
    'matrix-dark': 'Matrix',
    'lobster-dark': 'Lobster',
    'sentry-dark': 'Sentry',
    'proof-light': 'Proof',
    'github-dark-default': 'GitHub',
}

function ThemeSwatch({ theme }: { theme: ChromeTheme }) {
    return (
        <div
            className="theme-picker__swatch"
            style={{ background: theme.surface, color: theme.ink }}
        >
            <div
                className="theme-picker__swatch-dot"
                style={{ background: theme.accent }}
                aria-hidden
            />
            <span className="theme-picker__swatch-label">Aa</span>
        </div>
    )
}

interface RowProps {
    mode: ThemeMode
    activeId: string
}

function ThemePickerRow({ mode, activeId }: RowProps) {
    const { applyPreset } = useTheme()
    const entries = BUILTIN_THEMES.filter((e) => e.variant === mode)
    return (
        <div className="theme-picker__row" role="radiogroup" aria-label={`${mode} themes`}>
            {entries.map((entry: ThemeEntry) => {
                const active = entry.codeThemeId === activeId
                const name = PRETTY_NAME[entry.codeThemeId] ?? entry.codeThemeId
                return (
                    <button
                        key={`${entry.variant}:${entry.codeThemeId}`}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={
                            active
                                ? 'theme-picker__card theme-picker__card--active'
                                : 'theme-picker__card'
                        }
                        onClick={() => applyPreset(entry)}
                    >
                        <ThemeSwatch theme={entry.theme} />
                        <span className="theme-picker__name">{name}</span>
                    </button>
                )
            })}
        </div>
    )
}

export function ThemePicker() {
    const { lightId, darkId } = useTheme()
    return (
        <div className="theme-picker">
            <div className="theme-picker__group">
                <span className="theme-picker__group-label">Light themes</span>
                <ThemePickerRow mode="light" activeId={lightId} />
            </div>
            <div className="theme-picker__group">
                <span className="theme-picker__group-label">Dark themes</span>
                <ThemePickerRow mode="dark" activeId={darkId} />
            </div>
        </div>
    )
}
