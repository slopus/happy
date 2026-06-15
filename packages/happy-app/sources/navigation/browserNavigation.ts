export type BrowserNavigationDirection = 'back' | 'forward';
export type PendingRouteDirection = BrowserNavigationDirection | null;

export interface RouteHistoryState {
    stack: string[];
    cursor: number;
}

interface KeyboardNavigationEvent {
    key: string;
    defaultPrevented: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
}

interface MouseNavigationEvent {
    button: number;
}

export function createRouteHistory(pathname: string): RouteHistoryState {
    return {
        stack: [pathname],
        cursor: 0,
    };
}

export function canRouteBack(history: RouteHistoryState): boolean {
    return history.cursor > 0;
}

export function canUseRouteBack(history: RouteHistoryState, navigatorCanGoBack: boolean): boolean {
    return canRouteBack(history) && navigatorCanGoBack;
}

export function canRouteForward(history: RouteHistoryState): boolean {
    return history.cursor < history.stack.length - 1;
}

export function getNavigatorCanGoBack(navigator: { canGoBack: () => boolean }): boolean {
    try {
        return navigator.canGoBack();
    } catch {
        return false;
    }
}

export function applyRouteHistoryPathname(
    history: RouteHistoryState,
    pathname: string,
    pendingDirection: PendingRouteDirection
): RouteHistoryState {
    const current = history.stack[history.cursor];
    if (current === pathname) {
        return history;
    }

    if (pendingDirection === 'back') {
        const nextCursor = Math.max(0, history.cursor - 1);
        if (history.stack[nextCursor] === pathname) {
            return {
                ...history,
                cursor: nextCursor,
            };
        }
    }

    if (pendingDirection === 'forward') {
        const nextCursor = Math.min(history.stack.length - 1, history.cursor + 1);
        if (history.stack[nextCursor] === pathname) {
            return {
                ...history,
                cursor: nextCursor,
            };
        }
    }

    const stack = history.stack.slice(0, history.cursor + 1);
    stack.push(pathname);
    return {
        stack,
        cursor: stack.length - 1,
    };
}

export function getKeyboardNavigationDirection(event: KeyboardNavigationEvent): BrowserNavigationDirection | null {
    if (event.defaultPrevented) return null;
    if (event.key !== 'Escape') return null;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
    return 'back';
}

export function getMouseNavigationDirection(event: MouseNavigationEvent): BrowserNavigationDirection | null {
    if (event.button === 3) return 'back';
    if (event.button === 4) return 'forward';
    return null;
}
