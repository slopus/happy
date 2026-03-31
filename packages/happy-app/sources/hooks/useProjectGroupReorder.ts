import { useCallback } from 'react';
import { useSetting } from '@/sync/storage';
import { sync } from '@/sync/sync';

/**
 * Hook to reorder project groups in the session list.
 * Persists the ordering to settings so it survives app restarts.
 * The projectGroupOrder setting stores an ordered list of project paths;
 * groups matching those paths sort first, in that order.
 */
export function useProjectGroupReorder() {
    const projectGroupOrder = useSetting('projectGroupOrder');

    const reorderGroups = useCallback((fromIndex: number, toIndex: number, allPaths: string[]) => {
        // Initialize order from current visible order if empty
        const currentOrder = projectGroupOrder.length > 0 ? [...projectGroupOrder] : [...allPaths];

        // Ensure all visible paths are in the order array
        for (const path of allPaths) {
            if (!currentOrder.includes(path)) {
                currentOrder.push(path);
            }
        }

        if (fromIndex < 0 || fromIndex >= currentOrder.length || toIndex < 0 || toIndex >= currentOrder.length) return;

        const [moved] = currentOrder.splice(fromIndex, 1);
        currentOrder.splice(toIndex, 0, moved);

        sync.applySettings({ projectGroupOrder: currentOrder });
    }, [projectGroupOrder]);

    return { projectGroupOrder, reorderGroups };
}
