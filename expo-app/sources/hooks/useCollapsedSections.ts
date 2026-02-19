import * as React from 'react';

/**
 * Hook to manage collapsed state for sections in SessionsList.
 * Stores state in a Set that persists across component re-mounts.
 * This is needed because FlatList may recycle/re-mount components.
 *
 * Pattern borrowed from useCollapsedTools.ts
 */

// Global set to store collapsed section IDs
const collapsedSectionIds = new Set<string>();

// Listeners for state changes
const listeners = new Set<() => void>();

// Listeners for collapse events (used to preserve scroll position)
const collapseListeners = new Set<(isCollapsing: boolean) => void>();

function notifyListeners() {
    listeners.forEach(listener => listener());
}

function notifyCollapseListeners(isCollapsing: boolean) {
    collapseListeners.forEach(listener => listener(isCollapsing));
}

/**
 * Hook to manage collapsed state for a single section.
 * @param sectionId - Unique identifier for the section
 * @returns Tuple of [isCollapsed, toggleCollapsed]
 */
export function useCollapsedSection(sectionId: string): [boolean, () => void] {
    const [, forceUpdate] = React.useReducer(x => x + 1, 0);

    // Subscribe to changes
    React.useEffect(() => {
        listeners.add(forceUpdate);
        return () => {
            listeners.delete(forceUpdate);
        };
    }, []);

    const isCollapsed = collapsedSectionIds.has(sectionId);

    const toggleCollapsed = React.useCallback(() => {
        const willCollapse = !collapsedSectionIds.has(sectionId);

        // Notify before state change (for scroll position preservation)
        notifyCollapseListeners(willCollapse);

        if (collapsedSectionIds.has(sectionId)) {
            collapsedSectionIds.delete(sectionId);
        } else {
            collapsedSectionIds.add(sectionId);
        }
        notifyListeners();
    }, [sectionId]);

    return [isCollapsed, toggleCollapsed];
}

/**
 * Hook to check if a section is collapsed (read-only).
 * Used by useVisibleSessionListViewData to filter items.
 */
export function useIsSectionCollapsed(sectionId: string): boolean {
    const [, forceUpdate] = React.useReducer(x => x + 1, 0);

    React.useEffect(() => {
        listeners.add(forceUpdate);
        return () => {
            listeners.delete(forceUpdate);
        };
    }, []);

    return collapsedSectionIds.has(sectionId);
}

/**
 * Hook to get all collapsed section IDs.
 * Returns a new Set on each change to trigger re-renders.
 */
export function useCollapsedSections(): Set<string> {
    const [, forceUpdate] = React.useReducer(x => x + 1, 0);

    React.useEffect(() => {
        listeners.add(forceUpdate);
        return () => {
            listeners.delete(forceUpdate);
        };
    }, []);

    return collapsedSectionIds;
}

/**
 * Hook to listen for collapse events.
 * Used by SessionsList to preserve scroll position.
 */
export function useSectionCollapseListener(callback: (isCollapsing: boolean) => void) {
    React.useEffect(() => {
        collapseListeners.add(callback);
        return () => {
            collapseListeners.delete(callback);
        };
    }, [callback]);
}
