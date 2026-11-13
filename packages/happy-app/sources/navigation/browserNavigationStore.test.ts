import { beforeEach, expect, test } from 'vitest';
import { useBrowserNavigationStore } from './browserNavigationStore';

beforeEach(() => useBrowserNavigationStore.setState({ routeHistory: null, pendingRouteDirection: null }));

test('keeps native pathname sync and marks free of the browser in-flight lock', () => {
    const nav = useBrowserNavigationStore.getState();
    nav.syncRoutePathname('/');
    nav.syncRoutePathname('/session/one');
    nav.markRouteBack();
    nav.markRouteBack(); // Native may pop a parameter-only entry with no pathname change.
    nav.syncRoutePathname('/session/one');
    expect(useBrowserNavigationStore.getState().pendingRouteDirection).toBeNull();
    nav.markRouteBack();
    nav.syncRoutePathname('/');
    expect(useBrowserNavigationStore.getState().routeHistory?.cursor).toBe(0);
});

test('accepts only one browser movement until a committed entry arrives', () => {
    const nav = useBrowserNavigationStore.getState();
    nav.syncBrowserHistory({ stack: ['/', '/projects'], cursor: 1 });
    expect(nav.tryBeginBrowserNavigation('back')).toBe(true);
    expect(nav.tryBeginBrowserNavigation('back')).toBe(false);
    expect(nav.tryBeginBrowserNavigation('forward')).toBe(false);
    nav.syncBrowserHistory({ stack: ['/', '/projects'], cursor: 0 });
    expect(nav.tryBeginBrowserNavigation('forward')).toBe(true);
});
