import * as React from 'react';
import {
    loadSessionManagementFocusOrder,
    saveSessionManagementFocusOrder,
    type SessionManagementPreferences,
} from '@/sync/persistence';
import { useSetting, useSettingUpdater } from '@/sync/storage';

export type SessionManagementQueue = 'pinned' | 'focus';

function sameArray(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((item, index) => item === b[index]);
}

function unique(items: string[]): string[] {
    return Array.from(new Set(items));
}

let currentFocusOrder = loadSessionManagementFocusOrder();
const listeners = new Set<() => void>();

function emitPreferencesChanged() {
    listeners.forEach((listener) => listener());
}

function subscribePreferences(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function getSessionManagementFocusOrderSnapshot(): string[] {
    return currentFocusOrder;
}

function updateSessionManagementFocusOrder(updater: (current: string[]) => string[]) {
    const next = updater(currentFocusOrder);
    if (next === currentFocusOrder) {
        return;
    }
    currentFocusOrder = next;
    saveSessionManagementFocusOrder(next);
    emitPreferencesChanged();
}

/**
 * Reads account-synced pinning and maintains the device-local focus queue.
 * Synced pins are never pruned from a local session snapshot because settings
 * and session events can arrive out of order across devices.
 */
export function useSessionManagementPreferences(
    validSessionIds: string[],
    options: { prune?: boolean } = {},
) {
    const prune = options.prune ?? true;
    const validSessionIdSet = React.useMemo(() => new Set(validSessionIds), [validSessionIds]);
    const sessionPinnedOrder = useSetting('sessionPinnedOrder');
    const updateSessionPinnedOrder = useSettingUpdater('sessionPinnedOrder');
    const focusOrder = React.useSyncExternalStore(
        subscribePreferences,
        getSessionManagementFocusOrderSnapshot,
        getSessionManagementFocusOrderSnapshot,
    );
    const preferences = React.useMemo<SessionManagementPreferences>(() => ({
        pinnedOrder: sessionPinnedOrder,
        focusOrder,
    }), [focusOrder, sessionPinnedOrder]);

    React.useEffect(() => {
        const pinnedSet = new Set(sessionPinnedOrder);
        updateSessionManagementFocusOrder((current) => {
            const next = unique(current).filter((id) => (
                !pinnedSet.has(id) && (!prune || validSessionIdSet.has(id))
            ));
            return sameArray(next, current) ? current : next;
        });
    }, [prune, sessionPinnedOrder, validSessionIdSet]);

    const isPinned = React.useCallback((sessionId: string) => (
        preferences.pinnedOrder.includes(sessionId)
    ), [preferences.pinnedOrder]);

    const isFocused = React.useCallback((sessionId: string) => (
        preferences.focusOrder.includes(sessionId)
    ), [preferences.focusOrder]);

    const moveToPinned = React.useCallback((sessionId: string) => {
        updateSessionPinnedOrder((current) => [sessionId, ...current.filter((id) => id !== sessionId)]);
        updateSessionManagementFocusOrder((current) => current.filter((id) => id !== sessionId));
    }, [updateSessionPinnedOrder]);

    const moveToFocus = React.useCallback((sessionId: string) => {
        updateSessionPinnedOrder((current) => current.filter((id) => id !== sessionId));
        updateSessionManagementFocusOrder((current) => [sessionId, ...current.filter((id) => id !== sessionId)]);
    }, [updateSessionPinnedOrder]);

    const togglePinned = React.useCallback((sessionId: string) => {
        updateSessionPinnedOrder((current) => {
            const pinned = current.includes(sessionId);
            return pinned
                ? current.filter((id) => id !== sessionId)
                : [sessionId, ...current];
        });
        updateSessionManagementFocusOrder((current) => current.filter((id) => id !== sessionId));
    }, [updateSessionPinnedOrder]);

    const toggleFocus = React.useCallback((sessionId: string) => {
        const focused = focusOrder.includes(sessionId);
        if (!focused) {
            updateSessionPinnedOrder((current) => current.filter((id) => id !== sessionId));
        }
        updateSessionManagementFocusOrder((current) => {
            return focused
                ? current.filter((id) => id !== sessionId)
                : [sessionId, ...current.filter((id) => id !== sessionId)];
        });
    }, [focusOrder, updateSessionPinnedOrder]);

    const moveWithinQueueByOffset = React.useCallback((queue: SessionManagementQueue, sessionId: string, offset: number) => {
        const reorder = (current: string[]) => {
            const order = current.slice();
            const index = order.indexOf(sessionId);
            if (index === -1) {
                return current;
            }

            const nextIndex = Math.max(0, Math.min(order.length - 1, index + offset));
            if (nextIndex === index) {
                return current;
            }

            order.splice(index, 1);
            order.splice(nextIndex, 0, sessionId);
            return order;
        };
        if (queue === 'pinned') {
            updateSessionPinnedOrder(reorder);
        } else {
            updateSessionManagementFocusOrder(reorder);
        }
    }, [updateSessionPinnedOrder]);

    const moveWithinQueue = React.useCallback((queue: SessionManagementQueue, sessionId: string, direction: 'up' | 'down') => {
        moveWithinQueueByOffset(queue, sessionId, direction === 'up' ? -1 : 1);
    }, [moveWithinQueueByOffset]);

    const moveToQueueTop = React.useCallback((queue: SessionManagementQueue, sessionId: string) => {
        if (queue === 'pinned') {
            moveToPinned(sessionId);
        } else {
            moveToFocus(sessionId);
        }
    }, [moveToFocus, moveToPinned]);

    return {
        preferences,
        isPinned,
        isFocused,
        moveToPinned,
        moveToFocus,
        togglePinned,
        toggleFocus,
        moveWithinQueue,
        moveWithinQueueByOffset,
        moveToQueueTop,
    };
}
