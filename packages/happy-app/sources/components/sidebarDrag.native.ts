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

export function registerSidebarDraggable(_options: RegisterSidebarDraggableOptions): () => void {
    return () => {};
}

export function registerSidebarDropTarget(_options: RegisterSidebarDropTargetOptions): () => void {
    return () => {};
}
