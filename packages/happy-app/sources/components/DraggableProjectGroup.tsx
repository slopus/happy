import React, { useCallback, useRef, useState } from 'react';
import { View, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

interface DraggableProjectGroupProps {
    projectPath: string;
    index: number;
    onReorder: (fromIndex: number, toIndex: number) => void;
    children: React.ReactNode;
}

/**
 * Wraps a project group section to enable drag-to-reorder on web.
 * Uses HTML5 Drag and Drop API. On native platforms, renders children directly.
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
    const [isDragging, setIsDragging] = useState(false);
    const [isDragOver, setIsDragOver] = useState(false);
    const dragCounterRef = useRef(0);

    const handleDragStart = useCallback((e: any) => {
        e.dataTransfer.setData('text/plain', String(index));
        e.dataTransfer.effectAllowed = 'move';
        setIsDragging(true);
    }, [index]);

    const handleDragEnd = useCallback(() => {
        setIsDragging(false);
        setIsDragOver(false);
        dragCounterRef.current = 0;
    }, []);

    const handleDragEnter = useCallback((e: any) => {
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

    const handleDragOver = useCallback((e: any) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    }, []);

    const handleDrop = useCallback((e: any) => {
        e.preventDefault();
        setIsDragOver(false);
        dragCounterRef.current = 0;
        const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (!isNaN(fromIndex) && fromIndex !== index) {
            onReorder(fromIndex, index);
        }
    }, [index, onReorder]);

    return (
        <View
            // @ts-ignore - web-only HTML5 drag props
            draggable
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            style={[
                isDragging && styles.dragging,
                isDragOver && styles.dragOver,
            ]}
        >
            {children}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    dragging: {
        opacity: 0.5,
    },
    dragOver: {
        borderTopWidth: 2,
        borderTopColor: theme.colors.textLink,
    },
}));
