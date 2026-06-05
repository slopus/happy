import { useState } from 'react'
import './SegmentedControl.css'

interface SegmentedControlProps {
    options: string[]
    initial?: string
    ariaLabel: string
}

export function SegmentedControl({
    options,
    initial,
    ariaLabel,
}: SegmentedControlProps) {
    const [selected, setSelected] = useState(initial ?? options[0])

    return (
        <div className="segmented-control" role="radiogroup" aria-label={ariaLabel}>
            {options.map((option) => (
                <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={selected === option}
                    className={
                        selected === option
                            ? 'segmented-control__option segmented-control__option--active'
                            : 'segmented-control__option'
                    }
                    onClick={() => setSelected(option)}
                >
                    {option}
                </button>
            ))}
        </div>
    )
}
