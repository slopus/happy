import { expect, test, vi } from 'vitest';
import { ensureBrowserRouteObserver, observeBrowserRoute } from './browserRouteObserver';

function fixture() {
    const events = new EventTarget();
    const location = { pathname: '/', search: '', hash: '' };
    const history = { state: { id: 'initial' } as any, pushState: vi.fn(), replaceState: vi.fn() };
    const states = new Map<string, unknown>();
    const navigate = (data: unknown, _title: string, route?: string | URL | null) => {
        if (route != null) {
            const url = new URL(String(route), 'http://fixture.test');
            Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash });
        }
        history.state = data;
        if ((data as any)?.id) states.set((data as any).id, data);
    };
    history.pushState.mockImplementation(navigate);
    history.replaceState.mockImplementation(navigate);
    const target = { history, location, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) } as unknown as Window;
    const sync = vi.fn();
    const pop = (id: string | null, route: string) => {
        const state = id === null ? null : states.get(id) ?? { id };
        navigate(state, '', route);
        const event = new Event('popstate');
        Object.defineProperty(event, 'state', { value: state });
        events.dispatchEvent(event);
    };
    return { target, history, sync, pop, events, states };
}

test('replaces the current entry without enabling a back target outside the App', () => {
    const f = fixture(); const stop = observeBrowserRoute(f.target, f.sync);
    f.target.history.replaceState({ id: 'initial' }, '', '/new');
    expect(f.sync).toHaveBeenLastCalledWith({ stack: ['/new'], cursor: 0 });
    stop();
});

test('tracks repeated URLs, hash routes and native browser back/forward by entry identity', () => {
    const f = fixture(); const stop = observeBrowserRoute(f.target, f.sync);
    f.target.history.pushState({ id: 'second' }, '', '/');
    f.target.history.pushState({ id: 'third' }, '', '/session/example?file=readme#L4');
    f.pop('initial', '/');
    expect(f.sync).toHaveBeenLastCalledWith({ stack: ['/', '/', '/session/example?file=readme#L4'], cursor: 0 });
    f.pop('third', '/session/example?file=readme#L4');
    expect(f.sync.mock.lastCall?.[0].cursor).toBe(2);
    f.pop('second', '/');
    f.target.history.pushState({ id: 'fourth' }, '', '/projects');
    expect(f.sync).toHaveBeenLastCalledWith({ stack: ['/', '/', '/projects'], cursor: 2 });
    stop();
});

test('resets at an unknown pre-App entry instead of inventing an in-app back target', () => {
    const f = fixture(); const stop = observeBrowserRoute(f.target, f.sync);
    f.target.history.pushState({ id: 'second' }, '', '/new');
    f.pop('older-unknown', '/');
    expect(f.sync).toHaveBeenLastCalledWith({ stack: ['/'], cursor: 0 });
    stop();
});

test('handles untracked hash navigation conservatively without inventing a back entry', () => {
    const f = fixture(); const stop = observeBrowserRoute(f.target, f.sync);
    f.target.location.hash = '#heading';
    f.events.dispatchEvent(new Event('hashchange'));
    expect(f.sync).toHaveBeenLastCalledWith({ stack: ['/#heading'], cursor: 0 });
    stop();
});

test('uses the pop event entry even if another listener has replaced history.state', () => {
    const f = fixture(); const stop = observeBrowserRoute(f.target, f.sync);
    f.target.history.pushState({ id: 'second' }, '', '/new');
    f.target.location.pathname = '/';
    f.history.state = { id: 'router-replacement' };
    const event = new Event('popstate');
    Object.defineProperty(event, 'state', { value: f.states.get('initial') });
    f.events.dispatchEvent(event);
    expect(f.sync).toHaveBeenLastCalledWith({ stack: ['/', '/new'], cursor: 0 });
    stop();
});

test('keeps entry identity when the router replaces its ids after back and forward', () => {
    const f = fixture(); const stop = observeBrowserRoute(f.target, f.sync);
    f.target.history.pushState({ id: 'second', routerField: 'preserved' }, '', '/projects');
    expect(f.history.state.routerField).toBe('preserved');
    f.pop('initial', '/');
    f.target.history.replaceState({ id: 'new-initial' }, '', '/');
    f.pop('second', '/projects');
    f.target.history.replaceState({ id: 'new-second' }, '', '/projects');
    expect(f.sync).toHaveBeenLastCalledWith({ stack: ['/', '/projects'], cursor: 1 });
    f.pop('new-initial', '/');
    expect(f.sync).toHaveBeenLastCalledWith({ stack: ['/', '/projects'], cursor: 0 });
    stop();
});

test('preserves the same document history when React remounts the observer', () => {
    const f = fixture(); const stop = observeBrowserRoute(f.target, f.sync);
    f.target.history.pushState({ id: 'second' }, '', '/projects');
    stop();
    const nextSync = vi.fn();
    const stopAgain = observeBrowserRoute(f.target, nextSync);
    expect(nextSync).toHaveBeenLastCalledWith({ stack: ['/', '/projects'], cursor: 1 });
    f.pop('initial', '/');
    expect(nextSync).toHaveBeenLastCalledWith({ stack: ['/', '/projects'], cursor: 0 });
    stopAgain();
});

test('uses one document observer across router root remounts and temporary null state', () => {
    const f = fixture();
    ensureBrowserRouteObserver(f.target, f.sync);
    const push = f.target.history.pushState;
    f.target.history.pushState({ id: 'second' }, '', '/projects');
    const next = vi.fn();
    ensureBrowserRouteObserver(f.target, next);
    expect(f.target.history.pushState).toBe(push);
    f.target.history.replaceState(null, '', '/');
    f.target.history.replaceState({ id: 'router-restored' }, '', '/projects');
    expect(next).toHaveBeenLastCalledWith({ stack: ['/', '/projects'], cursor: 1 });
    f.pop('initial', '/');
    expect(next).toHaveBeenLastCalledWith({ stack: ['/', '/projects'], cursor: 0 });
});

test('preserves non-record structured history values without flattening them', () => {
    const f = fixture(); const stop = observeBrowserRoute(f.target, f.sync);
    for (const value of [new Date(0), new Map([['key', 'value']]), new Set(['value']), new Uint8Array([1, 2]), null, 'literal']) {
        f.target.history.replaceState(value, '', '/new');
        expect(f.history.state).toBe(value);
    }
    stop();
});

test('restores owned wrappers and deactivates callbacks retained by a later wrapper', () => {
    const f = fixture(); const originalPush = f.history.pushState;
    const originalReplace = f.history.replaceState;
    const stop = observeBrowserRoute(f.target, f.sync);
    const observedPush = f.target.history.pushState;
    const outer: History['pushState'] = function (this: History, ...args) { observedPush.apply(this, args); };
    f.target.history.pushState = outer;
    stop();
    f.target.history.pushState(null, '', '/new');
    f.pop('initial', '/');
    expect(f.sync).toHaveBeenCalledTimes(1);
    expect(f.target.history.pushState).toBe(outer);
    expect(f.target.history.replaceState).toBe(originalReplace);
    expect(originalPush).toHaveBeenCalledOnce();
});
