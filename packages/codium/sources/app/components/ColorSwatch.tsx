import './ColorSwatch.css'

interface ColorSwatchProps {
    label: string
    color: string
    selected?: boolean
}

export function ColorSwatch({ label, color, selected = false }: ColorSwatchProps) {
    return (
        <button
            type="button"
            className={selected ? 'color-swatch color-swatch--selected' : 'color-swatch'}
            aria-label={label}
            title={label}
            style={{ backgroundColor: color }}
        />
    )
}
