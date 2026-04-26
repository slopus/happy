import './ContextRing.css'

interface ContextRingProps {
    /** 0..1 — fraction of context used */
    ratio: number
    size?: number
    stroke?: number
}

export function ContextRing({ ratio, size = 12, stroke = 1.5 }: ContextRingProps) {
    const r = (size - stroke) / 2
    const c = 2 * Math.PI * r
    const clamped = Math.max(0, Math.min(1, ratio))
    const offset = c * (1 - clamped)
    const cx = size / 2
    const cy = size / 2
    return (
        <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            className="context-ring"
            role="img"
            aria-label={`Context: ${Math.round(clamped * 100)}% used`}
        >
            <circle
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke="var(--color-border-heavy)"
                strokeWidth={stroke}
            />
            <circle
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke="currentColor"
                strokeWidth={stroke}
                strokeLinecap="round"
                strokeDasharray={c}
                strokeDashoffset={offset}
                transform={`rotate(-90 ${cx} ${cy})`}
            />
        </svg>
    )
}
