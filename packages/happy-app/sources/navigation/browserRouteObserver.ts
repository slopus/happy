import type { RouteHistoryState } from './browserNavigation';

type BrowserRouteTarget = Pick<Window, 'history' | 'location' | 'addEventListener' | 'removeEventListener'>;
const ENTRY_MARKER = '__pawsNavigationEntry';
interface RouteMemory {
    scope: string;
    entries: { key: number; route: string }[];
    cursor: number;
    nextKey: number;
}
// Expo can remount the shortcut component while reusing the same browser document.
const routeMemories = new WeakMap<History, RouteMemory>();
const documentObservers = new WeakMap<History, { sync: (state: RouteHistoryState) => void }>();

/** The router can remount React roots during traversal; keep one observer per document. */
export function ensureBrowserRouteObserver(target: BrowserRouteTarget, sync: (state: RouteHistoryState) => void): void {
    const existing = documentObservers.get(target.history);
    if (existing) {
        existing.sync = sync;
        const memory = routeMemories.get(target.history);
        if (memory) sync({ stack: memory.entries.map(entry => entry.route), cursor: memory.cursor });
        return;
    }
    const observer = { sync };
    documentObservers.set(target.history, observer);
    observeBrowserRoute(target, state => observer.sync(state));
}

/** Track browser entries independently of router ids that can change on pop. */
export function observeBrowserRoute(target: BrowserRouteTarget, sync: (state: RouteHistoryState) => void): () => void {
    const history = target.history;
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    const route = () => `${target.location.pathname}${target.location.search}${target.location.hash ?? ''}`;
    let memory = routeMemories.get(history);
    if (!memory) {
        memory = { scope: globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2), entries: [{ key: 0, route: route() }], cursor: 0, nextKey: 1 };
        routeMemories.set(history, memory);
    }
    const scope = memory.scope;
    let nextKey = memory.nextKey;
    let active = true;
    let entries = memory.entries;
    let cursor = memory.cursor;
    const keyOf = (state: unknown): number | null => {
        const marker = (state as Record<string, any> | null)?.[ENTRY_MARKER];
        return marker?.scope === scope && Number.isSafeInteger(marker.key) ? marker.key : null;
    };
    const tagged = (state: unknown, key: number): unknown => {
        // Preserve primitive/null state semantics for integrations that use them.
        if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
        const prototype = Object.getPrototypeOf(state);
        if (prototype !== Object.prototype && prototype !== null) return state;
        return { ...state, [ENTRY_MARKER]: { scope, key } };
    };
    const publish = () => {
        Object.assign(memory, { entries, cursor, nextKey });
        sync({ stack: entries.map(entry => entry.route), cursor });
    };
    const reset = () => {
        const key = nextKey++;
        entries = [{ key, route: route() }]; cursor = 0;
        originalReplace.call(history, tagged(history.state, key), '');
    };
    const align = (resetUnknown = false) => {
        const key = keyOf(history.state);
        const index = key === null ? -1 : entries.findIndex(entry => entry.key === key);
        if (index >= 0) cursor = index;
        else if (resetUnknown) reset();
    };
    const pop = (event: Event) => {
        if (!active) return;
        const state = 'state' in event ? (event as PopStateEvent).state : history.state;
        const key = keyOf(state);
        const index = key === null ? -1 : entries.findIndex(entry => entry.key === key);
        if (index >= 0) {
            cursor = index;
            entries[cursor] = { key: entries[cursor].key, route: route() };
        } else reset(); // Never invent a back target predating this App mount.
        publish();
    };
    const hashChange = () => {
        if (!active || entries[cursor].route === route()) return;
        reset(); publish();
    };
    const push: History['pushState'] = function (this: History, data, title, url) {
        if (!active) { originalPush.call(this, data, title, url); return; }
        align();
        const key = nextKey++;
        originalPush.call(this, tagged(data, key), title, url);
        entries = [...entries.slice(0, cursor + 1), { key, route: route() }];
        cursor = entries.length - 1; publish();
    };
    const replace: History['replaceState'] = function (this: History, data, title, url) {
        if (!active) { originalReplace.call(this, data, title, url); return; }
        align();
        originalReplace.call(this, tagged(data, entries[cursor].key), title, url);
        entries[cursor] = { key: entries[cursor].key, route: route() }; publish();
    };
    align(true);
    originalReplace.call(history, tagged(history.state, entries[cursor].key), '');
    history.pushState = push;
    history.replaceState = replace;
    // Observe the popped entry before router listeners replace its own state id.
    target.addEventListener('popstate', pop, true);
    target.addEventListener('hashchange', hashChange);
    publish();
    return () => {
        active = false;
        target.removeEventListener('popstate', pop, true);
        target.removeEventListener('hashchange', hashChange);
        if (history.pushState === push) history.pushState = originalPush;
        if (history.replaceState === replace) history.replaceState = originalReplace;
    };
}
