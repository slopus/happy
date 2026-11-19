import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import type { ProjectCatalogResizeHandleProps } from './ProjectCatalogResizeHandle';
import { getProjectCatalogMaximumWidth, getProjectCatalogWidth, projectPanelGap } from './projectWorkspaceLayout';

export function ProjectCatalogResizeHandle({ width, rowWidth, rightWidth, onResize }: ProjectCatalogResizeHandleProps) {
    const { theme } = useUnistyles();
    const start = React.useRef<{ x: number; width: number; pointerId: number } | null>(null);
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    const [dragging, setDragging] = React.useState(false);
    const maximum = getProjectCatalogMaximumWidth(rowWidth, rightWidth);
    const minimum = Math.min(280, maximum);
    const label = t('desktopWorkspace.resizePanel', { panel: t('projectGoals.tasks') });
    const resize = (value: number) => onResize(getProjectCatalogWidth(rowWidth, rightWidth, value));
    const end = () => { start.current = null; setDragging(false); };

    React.useEffect(() => {
        if (!dragging) return;
        const { cursor, userSelect } = document.body.style;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('blur', end);
        return () => {
            document.body.style.cursor = cursor;
            document.body.style.userSelect = userSelect;
            window.removeEventListener('blur', end);
        };
    }, [dragging]);

    return <div
        role="separator" tabIndex={0} aria-label={label} title={label} aria-orientation="vertical"
        aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={width}
        data-testid="project-catalog-resize-handle"
        onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onPointerDown={event => {
            if (event.button !== 0 || !event.isPrimary) return;
            event.preventDefault();
            event.currentTarget.focus();
            const renderedWidth = event.currentTarget.previousElementSibling?.getBoundingClientRect().width ?? width;
            start.current = { x: event.clientX, width: renderedWidth, pointerId: event.pointerId };
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(true);
        }}
        onPointerMove={event => {
            const active = start.current;
            if (active?.pointerId === event.pointerId) resize(active.width + event.clientX - active.x);
        }}
        onPointerUp={event => {
            if (start.current?.pointerId !== event.pointerId) return;
            resize(start.current.width + event.clientX - start.current.x);
            end();
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={end} onLostPointerCapture={end}
        onDoubleClick={() => onResize(undefined)}
        onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            resize(event.key === 'Home' ? minimum : event.key === 'End' ? maximum : width + (event.key === 'ArrowLeft' ? -16 : 16));
        }}
        style={{ width: projectPanelGap, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'col-resize', touchAction: 'none', outline: 'none' }}
    ><div style={{ width: 2, alignSelf: 'stretch', borderRadius: 1, background: hovered || focused || dragging ? theme.colors.textLink : 'transparent', pointerEvents: 'none' }} /></div>;
}
