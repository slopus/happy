import React, { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

interface DraggableProjectGroupProps {
    projectPath: string;
    index: number;
    onReorder: (fromIndex: number, toIndex: number) => void;
    children: React.ReactNode;
}

/**
 * Wraps a project group section to enable drag-to-reorder on web.
 * Uses a raw HTML div with HTML5 Drag and Drop API because React Native Web's
 * View silently drops draggable/onDrag* props.
 * On native platforms, renders children directly.
 */
export const DraggableProjectGroup = React.memo(function DraggableProjectGroup(props: DraggableProjectGroupProps) {
    if (Platform.OS !== 'web') {
        return <>{props.children}</>;
    }

    return <DraggableProjectGroupWeb {...props} />;
});

function DraggableProjectGroupWeb({
    index,
    onReorder,
    children,
}: DraggableProjectGroupProps) {
    const { theme } = useUnistyles();
    const [isDragging, setIsDragging] = useState(false);
    const [isDragOver, setIsDragOver] = useState(false);
    const dragCounterRef = useRef(0);

    const handleDragStart = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.dataTransfer.setData('text/plain', String(index));
        e.dataTransfer.effectAllowed = 'move';
        setIsDragging(true);
    }, [index]);

    const handleDragEnd = useCallback(() => {
        setIsDragging(false);
        setIsDragOver(false);
        dragCounterRef.current = 0;
    }, []);

    const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        dragCounterRef.current++;
        setIsDragOver(true);
    }, []);

    const handleDragLeave = useCallback(() => {
        dragCounterRef.current--;
        if (dragCounterRef.current === 0) {
            setIsDragOver(false);
        }
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    }, []);

    const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragOver(false);
        dragCounterRef.current = 0;
        const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (!isNaN(fromIndex) && fromIndex !== index) {
            onReorder(fromIndex, index);
        }
    }, [index, onReorder]);

    return (
        <div
            draggable
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            style={{
                opacity: isDragging ? 0.5 : 1,
                borderTopWidth: isDragOver ? 2 : 0,
                borderTopStyle: isDragOver ? 'solid' : undefined,
                borderTopColor: isDragOver ? theme.colors.textLink : undefined,
            }}
        >
            {children}
        </div>
    );
}
