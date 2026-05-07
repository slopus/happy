import { create } from 'zustand';

/**
 * Cross-component bridge: lets the global SidebarNavigator's back / forward
 * buttons drive the file-diff / file-view overlay stack owned by SessionView.
 *
 * SessionView publishes its current handlers + canBack / canForward whenever
 * its overlay stack changes. SidebarNavigator reads them and runs them before
 * falling through to router-level navigation.
 */
interface OverlayNavState {
    canBack: boolean;
    canForward: boolean;
    back: () => boolean;
    forward: () => boolean;
}

interface OverlayNavStore extends OverlayNavState {
    publish: (state: OverlayNavState) => void;
    reset: () => void;
}

const initial: OverlayNavState = {
    canBack: false,
    canForward: false,
    back: () => false,
    forward: () => false,
};

export const useOverlayNav = create<OverlayNavStore>((set) => ({
    ...initial,
    publish: (state) => set(state),
    reset: () => set(initial),
}));
