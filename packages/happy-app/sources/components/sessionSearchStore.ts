/**
 * Shared state for the sessions search box.
 *
 * The toggle icon lives in the sidebar's top controls next to "New session"
 * while the box and the filtered list live inside `SessionsListWrapper`, so
 * the state travels through a store rather than a prop chain — the same
 * pattern `homeDockFocus` uses. Closing the box also clears the query so the
 * list never stays silently filtered behind a hidden input.
 *
 * Opening the box also kicks off the one-time load of the sessions older than
 * the 150 the boot fetch brings in: the filter runs over the store, so without
 * that the search would silently stop at roughly a week of history.
 */
import { create } from 'zustand';
import { sync } from '@/sync/sync';

interface SessionSearchState {
    open: boolean;
    query: string;
    /** True while older sessions are still being paged in. */
    loadingHistory: boolean;
}

export const useSessionSearchStore = create<SessionSearchState>()(() => ({
    open: false,
    query: '',
    loadingHistory: false,
}));

export function toggleSessionSearch(): void {
    const { open } = useSessionSearchStore.getState();
    if (open) {
        useSessionSearchStore.setState({ open: false, query: '' });
        return;
    }
    useSessionSearchStore.setState({ open: true, loadingHistory: true });
    sync.loadAllSessionsForSearch()
        .catch((error) => console.warn('Session history load failed', error))
        .finally(() => useSessionSearchStore.setState({ loadingHistory: false }));
}

export function setSessionSearchQuery(query: string): void {
    useSessionSearchStore.setState({ query });
}
