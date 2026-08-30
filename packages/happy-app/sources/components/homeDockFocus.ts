/**
 * Lets the session list open the home dock composer.
 *
 * The dock lives in `MainView`'s phone branch while the "+" buttons live deep
 * inside the list, so the request travels through a store rather than a prop
 * chain. The sidebar layout and the web tab bar render no dock at all, which is
 * why `requestHomeDockFocus` reports whether anything was listening: callers
 * fall back to the standalone new-session screen when nothing was.
 */
import { create } from 'zustand';

interface HomeDockFocusState {
    /** Bumped once per request; the mounted dock opens on each change. */
    requestId: number;
    /** Mounted docks. Zero in the sidebar layout and on web. */
    listeners: number;
}

export const useHomeDockFocusStore = create<HomeDockFocusState>()(() => ({
    requestId: 0,
    listeners: 0,
}));

/** Marks a dock as able to serve focus requests until it unmounts. */
export function registerHomeDockFocusListener(): () => void {
    useHomeDockFocusStore.setState((state) => ({ listeners: state.listeners + 1 }));
    return () => {
        useHomeDockFocusStore.setState((state) => ({ listeners: Math.max(0, state.listeners - 1) }));
    };
}

/** Asks the home dock to open. False when no dock is on screen. */
export function requestHomeDockFocus(): boolean {
    if (useHomeDockFocusStore.getState().listeners === 0) {
        return false;
    }
    useHomeDockFocusStore.setState((state) => ({ requestId: state.requestId + 1 }));
    return true;
}
