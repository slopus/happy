import React, { useCallback, useRef } from 'react';
import { View, Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

interface ResizableDividerProps {
    onResize: (delta: number) => void;
    onResizeEnd?: () => void;
    direction?: 'vertical' | 'horizontal'; // vertical = col-resize (default), horizontal = row-resize
}

export const ResizableDivider = React.memo(({ onResize, onResizeEnd, direction = 'vertical' }: ResizableDividerProps) => {
    const { theme } = useUnistyles();
    const startPos = useRef(0);
    const isDragging = useRef(false);
    const [hovered, setHovered] = React.useState(false);
    const [dragging, setDragging] = React.useState(false);

    const isHorizontal = direction === 'horizontal';

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        startPos.current = isHorizontal ? e.clientY : e.clientX;
        isDragging.current = true;
        setDragging(true);

        const handleMouseMove = (ev: MouseEvent) => {
            if (!isDragging.current) return;
            const current = isHorizontal ? ev.clientY : ev.clientX;
            const delta = current - startPos.current;
            startPos.current = current;
            onResize(delta);
        };

        const handleMouseUp = () => {
            isDragging.current = false;
            setDragging(false);
            onResizeEnd?.();
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = isHorizontal ? 'row-resize' : 'col-resize';
        document.body.style.userSelect = 'none';
    }, [onResize, onResizeEnd, isHorizontal]);

    if (Platform.OS !== 'web') return null;

    const isActive = hovered || dragging;

    if (isHorizontal) {
        return (
            <View
                // @ts-ignore - web mouse events
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                onMouseDown={handleMouseDown}
                style={{
                    height: 6,
                    cursor: 'row-resize',
                    backgroundColor: isActive ? theme.colors.accent : 'transparent',
                    opacity: isActive ? 0.4 : 1,
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 100,
                }}
            >
                <View style={{
                    height: 1,
                    width: '100%',
                    backgroundColor: theme.colors.divider,
                }} />
            </View>
        );
    }

    return (
        <View
            // @ts-ignore - web mouse events
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onMouseDown={handleMouseDown}
            style={{
                width: 12,
                cursor: 'col-resize',
                backgroundColor: 'transparent',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 100,
            }}
        >
            <View style={{
                width: 2,
                height: '100%',
                backgroundColor: isActive ? theme.colors.accent : 'transparent',
                opacity: isActive ? 0.5 : 0,
            }} />
        </View>
    );
});
