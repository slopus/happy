import * as React from 'react';
import { useWindowDimensions } from 'react-native';
import { ComposerTooltipHost } from '../ComposerTooltipHost';
import type { SubagentActivityTooltipProps } from './SubagentActivityTooltip';

/** Read-only preview: it never takes focus or intercepts an outside pointer. */
export function SubagentActivityTooltip({ id, visible, onDismiss, children }: SubagentActivityTooltipProps) {
    const { width, height } = useWindowDimensions();

    React.useEffect(() => {
        if (!visible) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
            event.preventDefault();
            event.stopPropagation();
            onDismiss();
        };
        const onPointerDown = () => onDismiss();
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('scroll', onDismiss, true);
        window.addEventListener('resize', onDismiss);
        return () => {
            document.removeEventListener('keydown', onKeyDown, true);
            document.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('scroll', onDismiss, true);
            window.removeEventListener('resize', onDismiss);
        };
    }, [onDismiss, visible]);

    if (!visible) return null;
    return (
        <ComposerTooltipHost visible={visible}>
            <div id={id} role="tooltip" style={{
                position: 'absolute',
                bottom: '100%',
                marginBottom: 8,
                left: '50%',
                transform: 'translateX(-50%)',
                width: Math.min(380, Math.max(0, width - 24)),
                maxHeight: Math.max(0, height - 24),
                overflow: 'hidden',
                pointerEvents: 'none',
            }}>{children}</div>
        </ComposerTooltipHost>
    );
}
