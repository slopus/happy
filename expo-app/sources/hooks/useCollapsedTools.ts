import * as React from 'react';

/**
 * Hook to manage collapsed state for tools.
 * Stores state in a Set that persists across component re-mounts.
 * This is needed because FlatList may recycle/re-mount ToolView components.
 */

// Global set to store collapsed tool IDs
const collapsedToolIds = new Set<string>();

// Listeners for state changes
const listeners = new Set<() => void>();

// Listeners for collapse events (used by ChatList to preserve scroll)
const collapseListeners = new Set<(isCollapsing: boolean) => void>();

function notifyListeners() {
    listeners.forEach(listener => listener());
}

function notifyCollapseListeners(isCollapsing: boolean) {
    collapseListeners.forEach(listener => listener(isCollapsing));
}

export function useCollapsedTool(toolId: string): [boolean, () => void] {
    const [, forceUpdate] = React.useReducer(x => x + 1, 0);

    // Subscribe to changes
    React.useEffect(() => {
        listeners.add(forceUpdate);
        return () => {
            listeners.delete(forceUpdate);
        };
    }, []);

    const isCollapsed = collapsedToolIds.has(toolId);

    const toggleCollapsed = React.useCallback(() => {
        const willCollapse = !collapsedToolIds.has(toolId);

        // Notify before state change (for scroll position preservation)
        notifyCollapseListeners(willCollapse);

        if (collapsedToolIds.has(toolId)) {
            collapsedToolIds.delete(toolId);
        } else {
            collapsedToolIds.add(toolId);
        }
        notifyListeners();
    }, [toolId]);

    return [isCollapsed, toggleCollapsed];
}

/**
 * Hook to listen for collapse events.
 * Used by ChatList to preserve scroll position.
 */
export function useCollapseListener(callback: (isCollapsing: boolean) => void) {
    React.useEffect(() => {
        collapseListeners.add(callback);
        return () => {
            collapseListeners.delete(callback);
        };
    }, [callback]);
}
