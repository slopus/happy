import * as React from 'react';
import { DiffSyntaxPriority } from './usePreparedSyntax';

/** Visibility changes notify only the affected cells, not the entire chat list. */
export class SyntaxViewport {
    private visible = new Set<string>();
    private listeners = new Map<string, Set<() => void>>();

    priority(key: string): number { return this.visible.has(key) ? 2 : 1; }

    subscribe(key: string, listener: () => void): () => void {
        let set = this.listeners.get(key);
        if (!set) { set = new Set(); this.listeners.set(key, set); }
        set.add(listener);
        return () => {
            set!.delete(listener);
            if (!set!.size) this.listeners.delete(key);
        };
    }

    update = ({ viewableItems }: { viewableItems: { key: string; isViewable: boolean }[] }) => {
        const next = new Set(viewableItems.filter((item) => item.isViewable).map((item) => item.key));
        const changed = new Set([...this.visible, ...next]);
        const previous = this.visible;
        this.visible = next;
        for (const key of changed) {
            if (previous.has(key) === next.has(key)) continue;
            for (const listener of this.listeners.get(key) ?? []) listener();
        }
    };
}

export const SYNTAX_VIEWABILITY = { itemVisiblePercentThreshold: 1, minimumViewTime: 0 };

export const DiffSyntaxCell = React.memo(function DiffSyntaxCell({
    viewport, itemKey, enabled, children,
}: {
    viewport: SyntaxViewport;
    itemKey: string;
    enabled: boolean;
    children: React.ReactNode;
}) {
    const subscribe = React.useCallback((listener: () => void) => viewport.subscribe(itemKey, listener), [viewport, itemKey]);
    const snapshot = React.useCallback(() => enabled ? viewport.priority(itemKey) : 0, [viewport, itemKey, enabled]);
    const priority = React.useSyncExternalStore(subscribe, snapshot, snapshot);
    return <DiffSyntaxPriority.Provider value={priority}>{children}</DiffSyntaxPriority.Provider>;
});