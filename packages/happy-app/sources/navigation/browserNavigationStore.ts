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
    markRouteBack: () => void;
    markRouteForward: () => void;
}

export const useBrowserNavigationStore = create<BrowserNavigationState>((set) => ({
    routeHistory: null,
    pendingRouteDirection: null,
    syncRoutePathname: (pathname) => set((state) => ({
        routeHistory: state.routeHistory
            ? applyRouteHistoryPathname(state.routeHistory, pathname, state.pendingRouteDirection)
            : createRouteHistory(pathname),
        pendingRouteDirection: null,
    })),
    markRouteBack: () => set({ pendingRouteDirection: 'back' }),
    markRouteForward: () => set({ pendingRouteDirection: 'forward' }),
}));
