import * as React from 'react';
import { View } from 'react-native';
import type { DisplayItem } from '@/hooks/useGroupedMessages';
import type { ReadingState } from '@/sync/localHistoryStore';

export type TranscriptReadingAdapter = {
    key: string;
    read: () => Promise<ReadingState | null>;
    save: (state: ReadingState) => Promise<unknown> | void;
    wireId: (renderedId: string) => string | null;
    wireSeq: (renderedId: string) => number | null;
    blockKey?: (renderedId: string) => string | null;
};
export const itemMessages = (item: DisplayItem) => item.type === 'message' ? [item.message] : item.messages;

/** Reducer IDs are transient across bounded history replay. React row identity
 * follows the source block so refreshed history keeps mounted text/media views. */
export function transcriptRenderKey(item: DisplayItem, adapter?: TranscriptReadingAdapter): string {
    const message = itemMessages(item)[0];
    if (!message || !adapter?.blockKey) return item.id;
    const wire = adapter.wireId(message.id);
    const block = adapter.blockKey(message.id);
    return wire && block ? JSON.stringify([item.type, wire, block]) : item.id;
}
export function expandedGroupKeys(items: DisplayItem[], collapsed: Set<string>, wireId: TranscriptReadingAdapter['wireId']) {
    return items.flatMap(item => {
        if ((item.type !== 'tool-group' && item.type !== 'agent-work-group') || collapsed.has(item.id)) return [];
        const members = [...new Set(item.messages.map(message => wireId(message.id)).filter((id): id is string => id !== null))].slice(-300);
        return members.length ? [JSON.stringify([item.type, members])] : [];
    });
}
export function groupIsExpanded(item: DisplayItem, keys: string[], wireId: TranscriptReadingAdapter['wireId']) {
    const members = new Set(itemMessages(item).map(message => wireId(message.id)));
    return keys.some(key => { const group = parseGroupKey(key); return group?.type === item.type && group.members.some(id => members.has(id)); });
}
function parseGroupKey(key: string): { type: string; members: string[] } | null {
    try {
        const [type, stored] = JSON.parse(key);
        const members = Array.isArray(stored) ? stored : [stored]; // legacy one-member key
        return typeof type === 'string' && members.every(id => typeof id === 'string') ? { type, members } : null;
    } catch { return null; }
}
/** An expansion is one bounded alias set, not independent booleans per member.
 * Collapsing any surviving part removes its trimmed members' aliases as well. */
export function setGroupExpansion(keys: string[], item: DisplayItem, expanded: boolean, wireId: TranscriptReadingAdapter['wireId']) {
    const members = new Set(itemMessages(item).map(message => wireId(message.id)).filter((id): id is string => id !== null));
    const matching = keys.filter(key => { const parsed = parseGroupKey(key); return parsed?.type === item.type && parsed.members.some(id => members.has(id)); });
    const next = keys.filter(key => !matching.includes(key));
    if (expanded && members.size) {
        // Put currently rendered members last so repeated observation of an
        // oversized group cannot rotate the bounded alias set indefinitely.
        const aliases = [...new Set([...matching.flatMap(key => parseGroupKey(key)?.members ?? []).filter(id => !members.has(id)), ...members])].slice(-300);
        const encoded = JSON.stringify([item.type, aliases]);
        if (matching.length === 1 && matching[0] === encoded) return keys;
        next.push(encoded);
    }
    const bounded = next.slice(-256);
    return bounded.length === keys.length && bounded.every((key, index) => key === keys[index]) ? keys : bounded;
}
export function findAnchorIndex(items: DisplayItem[], wire: string, wireId: TranscriptReadingAdapter['wireId'], block?: string,
    blockKey?: TranscriptReadingAdapter['blockKey']) {
    return items.findIndex(item => itemMessages(item).some(message => wireId(message.id) === wire
        && (block === undefined || blockKey?.(message.id) === block)));
}

export function handleTranscriptWebWheel(
    event: { shiftKey: boolean; deltaX: number; deltaY: number; preventDefault: () => void },
    node: { scrollTop: number },
    claimUserScroll: () => void,
) {
    claimUserScroll();
    if (event.shiftKey && Math.abs(event.deltaX) > 0 && Math.abs(event.deltaY) < 1) {
        node.scrollTop += event.deltaX;
        event.preventDefault();
    }
}

type Measurable = { measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void };
type Markers = { register: (id: string, node: Measurable, depth: number) => () => void; layout: () => void };
export const TranscriptReadingContext = React.createContext<Markers | null>(null);
export const TranscriptGroupExpansionContext = React.createContext<{
    isExpanded: (item: DisplayItem) => boolean;
    toggle: (item: DisplayItem) => void;
    observe?: (item: DisplayItem) => void;
} | null>(null);
export function TranscriptReadingMarker(props: { messageId: string; depth?: number; children: React.ReactNode }) {
    const markers = React.useContext(TranscriptReadingContext);
    const unregister = React.useRef<(() => void) | null>(null);
    const ref = React.useCallback((node: Measurable | null) => {
        unregister.current?.(); unregister.current = null;
        if (node) unregister.current = markers?.register(props.messageId, node, props.depth ?? 0) ?? null;
    }, [markers, props.messageId, props.depth]);
    if (!markers) return <>{props.children}</>;
    return <View ref={ref as any} collapsable={false} onLayout={markers.layout}>{props.children}</View>;
}
async function measure(node: Measurable | null | undefined): Promise<{ y: number; height: number } | null> {
    if (!node?.measureInWindow) return null;
    return new Promise(resolve => {
        const timeout = setTimeout(() => resolve(null), 250);
        node.measureInWindow!((_x, y, _width, height) => { clearTimeout(timeout); resolve({ y, height }); });
    });
}

/** Real viewport/member measurements supply signed offsets. scrollToIndex only
 * mounts an offscreen target; it is never treated as a successful restoration. */
export function useTranscriptReading(options: {
    adapter?: TranscriptReadingAdapter;
    items: DisplayItem[];
    inverted: boolean;
    isAtLatest: boolean;
    followLatestOnLayout?: boolean;
    synchronousAnchoring?: boolean;
    externallyScheduled?: boolean;
    canCapture?: () => boolean;
    listRef: React.RefObject<any>;
    viewportRef: React.RefObject<any>;
    expanded: string[];
    restoreExpanded: (keys: string[]) => void;
}) {
    const current = React.useRef(options); current.current = options;
    const nodes = React.useRef(new Map<Measurable, { id: string; depth: number }>());
    const latest = React.useRef<ReadingState | null>(null);
    const pending = React.useRef<ReadingState | null>(null);
    const ready = React.useRef(false);
    const offset = React.useRef(0);
    const following = React.useRef(options.isAtLatest);
    const userScrolling = React.useRef(false);
    const userDirection = React.useRef<'older' | 'newer' | undefined>(undefined);
    const generation = React.useRef(0);
    const ownershipEpoch = React.useRef(0);
    const latestIntent = React.useRef(0);
    const latestEpoch = React.useRef(-1);
    const deferredCapture = React.useRef(false);
    const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const followLatestFrame = React.useRef<number | null>(null);
    const followLatestTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastCapture = React.useRef(0);
    const mountedTarget = React.useRef<string | null>(null);
    const adapterKey = options.adapter?.key;
    const projection = options.items.map(item => item.id).join('|');
    const previousProjection = React.useRef(projection);
    if (projection !== previousProjection.current) {
        previousProjection.current = projection;
        if (!options.synchronousAnchoring && !following.current && latest.current && latestEpoch.current === ownershipEpoch.current) {
            pending.current = latest.current; mountedTarget.current = null;
        }
    }
    const measurements = React.useCallback(async () => {
        if (current.current.externallyScheduled) {
            const viewportNode = current.current.viewportRef.current as HTMLElement | null;
            if (!viewportNode?.getBoundingClientRect) return null;
            const viewport = viewportNode.getBoundingClientRect();
            const rows = [...nodes.current].flatMap(([node, entry]) => {
                const element = node as HTMLElement;
                if (!element.isConnected || !element.getBoundingClientRect) return [];
                const bounds = element.getBoundingClientRect();
                return [{ ...entry, bounds: { y: bounds.top, height: bounds.height } }];
            });
            return { viewport: { y: viewport.top, height: viewport.height }, rows };
        }
        const viewport = await measure(current.current.viewportRef.current);
        if (!viewport) return null;
        const rows = await Promise.all([...nodes.current].map(async ([node, entry]) => ({ ...entry, bounds: await measure(node) })));
        return { viewport, rows: rows.filter(row => row.bounds !== null) as Array<{ id: string; depth: number; bounds: { y: number; height: number } }> };
    }, []);
    const persist = React.useCallback(() => {
        const adapter = current.current.adapter;
        if (ready.current && adapter && latest.current && latestEpoch.current === ownershipEpoch.current) void Promise.resolve(adapter.save({ ...latest.current,
            expandedGroupIds: current.current.expanded, followLatest: following.current && current.current.isAtLatest })).catch(() => undefined);
    }, []);
    const cancelFollowLatest = React.useCallback(() => {
        if (followLatestFrame.current !== null) {
            cancelAnimationFrame(followLatestFrame.current);
            followLatestFrame.current = null;
        }
        if (followLatestTimer.current !== null) {
            clearTimeout(followLatestTimer.current);
            followLatestTimer.current = null;
        }
    }, []);
    const scheduleFollowLatest = React.useCallback(() => {
        if (followLatestFrame.current !== null || followLatestTimer.current !== null) return;
        const run = () => {
            followLatestFrame.current = null;
            followLatestTimer.current = null;
            const { listRef, inverted } = current.current;
            if (inverted || current.current.followLatestOnLayout === false || !following.current || !current.current.isAtLatest) return;
            listRef.current?.scrollToEnd?.({ animated: false });
        };
        if (typeof requestAnimationFrame === 'function') followLatestFrame.current = requestAnimationFrame(run);
        else followLatestTimer.current = setTimeout(run, 0);
    }, []);
    const capture = React.useCallback(async () => {
        if (current.current.canCapture?.() === false) return;
        const { adapter } = current.current;
        if (!adapter) return;
        if (!ready.current) { deferredCapture.current = true; return; }
        if (pending.current) return;
        const owner = generation.current;
        const epoch = ownershipEpoch.current;
        const result = await measurements();
        if (!result || owner !== generation.current || epoch !== ownershipEpoch.current || adapter !== current.current.adapter
            || current.current.canCapture?.() === false) return;
        const { viewport } = result;
        const row = result.rows.filter(row => row.bounds.y < viewport.y + viewport.height && row.bounds.y + row.bounds.height > viewport.y
            && adapter.wireId(row.id) && adapter.wireSeq(row.id) !== null)
            .sort((a, b) => b.depth - a.depth || Math.abs(a.bounds.y - viewport.y) - Math.abs(b.bounds.y - viewport.y))[0];
        if (!row) return;
        latest.current = { version: 1, anchorId: adapter.wireId(row.id)!, anchorSeq: adapter.wireSeq(row.id)!,
            ...(adapter.blockKey?.(row.id) != null ? { anchorBlock: adapter.blockKey(row.id)! } : {}),
            offset: row.bounds.y - viewport.y, expandedGroupIds: current.current.expanded, followLatest: following.current && current.current.isAtLatest };
        latestEpoch.current = epoch;
        persist();
    }, [measurements, persist]);
    const layout = React.useCallback(async () => {
        const { adapter, items, listRef, inverted } = current.current;
        const target = pending.current;
        if (!inverted && current.current.followLatestOnLayout !== false && !target && following.current && current.current.isAtLatest && (!adapter || ready.current)) {
            scheduleFollowLatest();
            return;
        }
        if (!adapter || !target) return;
        const owner = generation.current;
        const result = await measurements();
        if (!result || owner !== generation.current || target !== pending.current) return;
        const row = result.rows.filter(row => adapter.wireId(row.id) === target.anchorId
            && (target.anchorBlock === undefined || adapter.blockKey?.(row.id) === target.anchorBlock)).sort((a, b) => b.depth - a.depth)[0];
        if (!row) {
            const index = findAnchorIndex(items, target.anchorId, adapter.wireId, target.anchorBlock, adapter.blockKey);
            if (index >= 0 && mountedTarget.current !== target.anchorId) {
                mountedTarget.current = target.anchorId;
                listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0.5 });
            }
            return;
        }
        const correction = row.bounds.y - result.viewport.y - target.offset;
        offset.current = Math.max(0, offset.current + (inverted ? -correction : correction));
        listRef.current?.scrollToOffset({ offset: offset.current, animated: false });
        pending.current = null;
    }, [measurements, scheduleFollowLatest]);
    React.useEffect(() => {
        const adapter = options.adapter;
        const owner = ++generation.current;
        const epoch = ++ownershipEpoch.current;
        const intent = latestIntent.current;
        ready.current = false; latest.current = null; latestEpoch.current = -1; pending.current = null; mountedTarget.current = null;
        deferredCapture.current = false;
        following.current = current.current.isAtLatest;
        userScrolling.current = false;
        userDirection.current = undefined;
        current.current.restoreExpanded([]);
        if (adapter) void adapter.read().then(state => {
            if (owner !== generation.current) return;
            ready.current = true;
            if (epoch === ownershipEpoch.current && intent === latestIntent.current && state) {
                latest.current = state; latestEpoch.current = epoch;
                following.current = state.followLatest === true;
                current.current.restoreExpanded(state.expandedGroupIds);
                if (!state.followLatest) pending.current = state;
            }
            const shouldCapture = deferredCapture.current;
            deferredCapture.current = false;
            if (shouldCapture && !pending.current) void capture();
            if (!current.current.inverted && following.current && !pending.current) void layout();
        }).catch(() => {
            if (owner !== generation.current) return;
            ready.current = true;
            const shouldCapture = deferredCapture.current;
            deferredCapture.current = false;
            if (shouldCapture) void capture();
        });
        return () => {
            // Save to the captured owner, never to an account mounted later.
            if (ready.current && adapter && latest.current && latestEpoch.current === ownershipEpoch.current) {
                void Promise.resolve(adapter.save(latest.current)).catch(() => undefined);
            }
            generation.current += 1; if (timer.current) clearTimeout(timer.current); cancelFollowLatest();
        };
    }, [adapterKey, options.adapter, capture, cancelFollowLatest]);
    React.useEffect(() => {
        if (latest.current) latest.current.expandedGroupIds = options.expanded;
    }, [options.expanded]);
    React.useEffect(() => { void layout(); }, [projection, options.expanded, layout]);
    const markers = React.useMemo<Markers>(() => ({
        register(id, node, depth) { nodes.current.set(node, { id, depth }); return () => { nodes.current.delete(node); }; },
        layout() { void layout(); },
    }), [layout]);
    return {
        markers: options.adapter ? markers : null, layout, capture,
        // The Web mask translates before its native scroll event is delivered.
        adjustOffset(y: number) { offset.current = y; },
        scroll(y: number, distanceFromBottom: number) {
            const previousY = offset.current;
            offset.current = y;
            if (current.current.inverted || userScrolling.current) {
                // Web can deliver a layout-induced scroll event after the user
                // has returned to the latest edge. Keep following when the
                // offset did not move; only a real upward user movement should
                // take ownership away from latest-output following.
                const transientLatestLayout = !current.current.inverted
                    && following.current
                    && Math.abs(y - previousY) <= 1;
                following.current = current.current.isAtLatest
                    && userDirection.current !== 'older'
                    && (distanceFromBottom <= 50 || transientLatestLayout);
            }
            if (current.current.externallyScheduled) return;
            if (Date.now() - lastCapture.current > 120) { lastCapture.current = Date.now(); void capture(); }
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => { void capture(); }, 120);
        },
        cancelRestore(direction?: 'older' | 'newer') {
            cancelFollowLatest();
            ownershipEpoch.current += 1;
            pending.current = null;
            mountedTarget.current = null;
            following.current = false;
            userScrolling.current = true;
            userDirection.current = direction;
        },
        pin() {
            if (current.current.synchronousAnchoring) return;
            if (latest.current && latestEpoch.current === ownershipEpoch.current && !following.current) pending.current = latest.current;
        },
        jumpLatest() { latestIntent.current += 1; pending.current = null; following.current = true; userScrolling.current = false; cancelFollowLatest();
            if (latest.current) { latest.current.followLatest = true; persist(); } },
    };
}
