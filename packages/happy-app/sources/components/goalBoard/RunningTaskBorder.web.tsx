import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

const css = `@property --paws-task-angle{syntax:'<angle>';initial-value:0deg;inherits:false}
@keyframes paws-task-flow{to{--paws-task-angle:360deg}}
.paws-task-flow{animation:paws-task-flow 3.2s linear infinite}
@media(prefers-reduced-motion:reduce){.paws-task-flow{animation:none}}`;
export function RunningTaskBorder({ active }: { active: boolean }) {
    const { theme } = useUnistyles();
    if (!active) return null;
    return <><style>{css}</style><div aria-hidden className="paws-task-flow" style={{ position: 'absolute', inset: 0, padding: 2, zIndex: 2, borderRadius: 'inherit', pointerEvents: 'none',
        background: `conic-gradient(from var(--paws-task-angle), transparent 65%, color-mix(in srgb, ${theme.colors.textLink} 35%, transparent) 76%, ${theme.colors.textLink} 88%, ${theme.colors.textLink} 92%, transparent 98%)`,
        mask: 'linear-gradient(white 0 0) content-box, linear-gradient(white 0 0)', maskComposite: 'exclude' }} /></>;
}
