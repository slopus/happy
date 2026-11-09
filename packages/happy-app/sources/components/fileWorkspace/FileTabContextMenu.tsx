export type TabMenuAnchor = { path: string; x: number; y: number; trigger: HTMLElement | null };
export type FileTabContextMenuProps = {
    anchor: TabMenuAnchor | null; tabs: readonly string[]; saving: readonly string[];
    onClose: () => void; onAction: (paths: string[]) => void;
};

// The file workspace's desktop context menu is implemented by the Web module.
export function FileTabContextMenu(_props: FileTabContextMenuProps) { return null; }
