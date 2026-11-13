import { create } from 'zustand';
import {
    applyRouteHistoryPathname,
    createRouteHistory,
    PendingRouteDirection,
    RouteHistoryState,
} from './browserNavigation';

interface BrowserNavigationState {
    routeHistory: RouteHistoryState | null;
    pendingRouteDirection: PendingRouteDirection;
    syncRoutePathname: (pathname: string) => void;
    syncBrowserHistory: (history: RouteHistoryState) => void;
    markRouteBack: () => void;
    markRouteForward: () => void;
    tryBeginBrowserNavigation: (direction: 'back' | 'forward') => boolean;
}

export const useBrowserNavigationStore = create<BrowserNavigationState>((set, get) => ({
    routeHistory: null,
    pendingRouteDirection: null,
    syncBrowserHistory: (routeHistory) => set({ routeHistory, pendingRouteDirection: null }),
    syncRoutePathname: (pathname) => set((state) => {
        return {
            routeHistory: state.routeHistory
                ? applyRouteHistoryPathname(state.routeHistory, pathname, state.pendingRouteDirection)
                : createRouteHistory(pathname),
            pendingRouteDirection: null,
        };
    }),
    markRouteBack: () => set({ pendingRouteDirection: 'back' }),
    markRouteForward: () => set({ pendingRouteDirection: 'forward' }),
    tryBeginBrowserNavigation: (direction) => {
        if (get().pendingRouteDirection) return false;
        set({ pendingRouteDirection: direction });
        return true;
    },
}));
