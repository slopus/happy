/**
 * Shared state for the sessions search box.
 *
 * The toggle icon lives in the sidebar's top controls next to "New session"
 * while the box and the filtered list live inside `SessionsListWrapper`, so
 * the state travels through a store rather than a prop chain — the same
 * pattern `homeDockFocus` uses. Closing the box also clears the query so the
 * list never stays silently filtered behind a hidden input.
 */
import { create } from 'zustand';

interface SessionSearchState {
    open: boolean;
    query: string;
}

export const useSessionSearchStore = create<SessionSearchState>()(() => ({
    open: false,
    query: '',
}));

export function toggleSessionSearch(): void {
    useSessionSearchStore.setState((state) => (state.open
        ? { open: false, query: '' }
        : { open: true }));
}

export function setSessionSearchQuery(query: string): void {
    useSessionSearchStore.setState({ query });
}
