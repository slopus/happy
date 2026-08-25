import { draggable, dropTargetForElements, type ElementDragPayload } from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
import { attachClosestEdge, extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';

export type SidebarDragData = {
    entity: 'list' | 'session';
    id: string;
    type: 'paws-sidebar-drag';
};

export type SidebarDropPosition = 'before' | 'after';

type RegisterSidebarDraggableOptions = {
    data: SidebarDragData;
    element: HTMLElement;
    onDragStart: (data: SidebarDragData) => void;
    onDrop: () => void;
};

type RegisterSidebarDropTargetOptions = {
    element: HTMLElement;
    onDrop: (data: SidebarDragData, position: SidebarDropPosition | null) => void;
    onTargetChange: (data: SidebarDragData, position: SidebarDropPosition | null) => void;
    onTargetLeave: () => void;
    targetId: string;
};

function readSidebarDragData(source: ElementDragPayload): SidebarDragData | null {
    const { data } = source;
    if (data.type !== 'paws-sidebar-drag') return null;
    if (data.entity !== 'list' && data.entity !== 'session') return null;
    if (typeof data.id !== 'string') return null;
    return { entity: data.entity, id: data.id, type: 'paws-sidebar-drag' };
}

function getDropPosition(data: Record<string | symbol, unknown>): SidebarDropPosition | null {
    const edge = extractClosestEdge(data);
    if (edge === 'top') return 'before';
    if (edge === 'bottom') return 'after';
    return null;
}

export function registerSidebarDraggable({ data, element, onDragStart, onDrop }: RegisterSidebarDraggableOptions): () => void {
    return draggable({
        element,
        getInitialData: () => data,
        onDragStart: () => onDragStart(data),
        onDrop,
    });
}

export function registerSidebarDropTarget({ element, onDrop, onTargetChange, onTargetLeave, targetId }: RegisterSidebarDropTargetOptions): () => void {
    const updateTarget = ({ source, targetData }: { source: ElementDragPayload; targetData: Record<string | symbol, unknown> }) => {
        const data = readSidebarDragData(source);
        if (!data) return;
        onTargetChange(data, data.entity === 'list' ? getDropPosition(targetData) : null);
    };

    return dropTargetForElements({
        element,
        canDrop: ({ source }) => {
            const data = readSidebarDragData(source);
            if (!data) return false;
            return data.entity === 'session' || (targetId !== 'unassigned' && data.id !== targetId);
        },
        getData: ({ input, source }) => {
            const data = readSidebarDragData(source);
            if (data?.entity !== 'list') return { targetId };
            return attachClosestEdge({ targetId }, { allowedEdges: ['top', 'bottom'], element, input });
        },
        getDropEffect: () => 'move',
        onDrag: ({ self, source }) => updateTarget({ source, targetData: self.data }),
        onDragEnter: ({ self, source }) => updateTarget({ source, targetData: self.data }),
        onDragLeave: onTargetLeave,
        onDrop: ({ self, source }) => {
            const data = readSidebarDragData(source);
            if (!data) return;
            onDrop(data, data.entity === 'list' ? getDropPosition(self.data) : null);
        },
    });
}
