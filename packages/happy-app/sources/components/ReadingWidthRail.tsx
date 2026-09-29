import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';

type ReadingWidthRailProps = {
    value: number;
    min: number;
    max: number;
    label: string;
    accentColor: string;
    trackColor: string;
    iconColor: string;
    onValueChange: (value: number) => void;
    onValueCommit: (value: number) => void;
};

/** A small, web-only rail with pointer capture and an elastic edge response. */
export function ReadingWidthRail({
    value, min, max, label, accentColor, trackColor, iconColor, onValueChange, onValueCommit,
}: ReadingWidthRailProps) {
    const railRef = React.useRef<HTMLDivElement>(null);
    const activePointer = React.useRef<number | null>(null);
    const latestValue = React.useRef(value);
    const [active, setActive] = React.useState(false);
    const [hovered, setHovered] = React.useState(false);
    const [stretch, setStretch] = React.useState(0);

    React.useEffect(() => {
        if (activePointer.current === null) latestValue.current = value;
    }, [value]);

    const clamp = (next: number) => Math.min(max, Math.max(min, next));
    const updateFromPointer = (clientX: number) => {
        const bounds = railRef.current?.getBoundingClientRect();
        if (!bounds?.width) return;
        const next = clamp(Math.round(min + ((clientX - bounds.left) / bounds.width) * (max - min)));
        const outside = clientX < bounds.left ? clientX - bounds.left : clientX > bounds.right ? clientX - bounds.right : 0;
        latestValue.current = next;
        setStretch(Math.sign(outside) * Math.min(12, Math.abs(outside) * 0.2));
        onValueChange(next);
    };
    const finishPointer = (event: React.PointerEvent<HTMLDivElement>) => {
        if (activePointer.current !== event.pointerId) return;
        if (event.type === 'pointerup') updateFromPointer(event.clientX);
        activePointer.current = null;
        setActive(false);
        setStretch(0);
        onValueCommit(latestValue.current);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };
    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const steps: Record<string, number> = {
            ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1,
            PageDown: -10, PageUp: 10,
        };
        if (!(event.key in steps) && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        const next = clamp(event.key === 'Home' ? min : event.key === 'End' ? max : value + steps[event.key]);
        latestValue.current = next;
        onValueChange(next);
        onValueCommit(next);
    };
    const percentage = max === min ? 0 : ((clamp(value) - min) / (max - min)) * 100;

    return <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={`${value} px`}
        data-testid="dreamskin-reading-width-slider"
        onKeyDown={handleKeyDown}
        onPointerDown={(event) => {
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            activePointer.current = event.pointerId;
            latestValue.current = value;
            event.currentTarget.setPointerCapture(event.pointerId);
            setActive(true);
            updateFromPointer(event.clientX);
        }}
        onPointerMove={(event) => {
            if (activePointer.current === event.pointerId) updateFromPointer(event.clientX);
        }}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
        onLostPointerCapture={finishPointer}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        style={{
            width: '100%', height: 34, display: 'flex', alignItems: 'center', gap: 10,
            cursor: active ? 'grabbing' : 'grab', touchAction: 'none', userSelect: 'none',
            borderRadius: 8, outlineColor: accentColor,
        }}
    >
        <Ionicons name="contract-outline" size={15} color={iconColor} aria-hidden={true} />
        <div ref={railRef} data-reading-width-track="true" aria-hidden="true" style={{
            flex: 1, height: '100%', display: 'flex', alignItems: 'center',
        }}>
            <div style={{
                width: '100%', height: active || hovered ? 8 : 6,
                position: 'relative', borderRadius: 999,
                backgroundColor: trackColor,
                transform: `translateX(${stretch}px) scaleX(${1 + Math.abs(stretch) / 100})`,
                transition: active ? 'height 160ms ease' : 'height 160ms ease, transform 320ms cubic-bezier(.2, 1.6, .3, 1)',
            }}>
                <div style={{ width: `${percentage}%`, height: '100%', backgroundColor: accentColor, borderRadius: 999 }} />
                <div style={{
                    position: 'absolute', top: '50%', left: `${percentage}%`,
                    width: active || hovered ? 16 : 14, height: active || hovered ? 16 : 14,
                    borderRadius: '50%', backgroundColor: accentColor,
                    border: '2px solid white', boxShadow: '0 1px 5px rgba(0,0,0,.24)',
                    transform: 'translate(-50%, -50%)', transition: 'width 160ms ease, height 160ms ease',
                }} />
            </div>
        </div>
        <Ionicons name="expand-outline" size={15} color={iconColor} aria-hidden={true} />
    </div>;
}
