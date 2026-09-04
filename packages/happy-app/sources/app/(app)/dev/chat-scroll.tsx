import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { FlashList, FlashListRef } from '@shopify/flash-list';

/**
 * Harness for the chat list's scroll contract.
 *
 * ChatList's scrolling was debugged for a long time by reading Metro logs off a
 * real session, which is slow and never the same twice: the content depends on
 * whatever the agent last said. This screen reproduces only the things that
 * actually move the viewport and reports the resulting position on screen, so
 * a UI test can assert "AT BOTTOM" instead of grepping for offsets.
 *
 * The two layouts are side by side on purpose. A chat has one fixed reference
 * point — the newest message, at the bottom — and the two differ in whether
 * the scroll origin is that point or the opposite end of the content:
 *
 *   NORMAL:   offset 0 is the oldest message. The newest is at the far end, so
 *             every viewport resize and content change needs a correction to
 *             keep it in view.
 *   INVERTED: offset 0 IS the newest message. A viewport resize needs no
 *             correction at all, because the anchor is the edge that moved.
 *
 * "shrink viewport" is the important control: it takes height away from the
 * list itself, which is what the keyboard does. An earlier version of this
 * harness only grew `contentContainerStyle.paddingBottom` — a content-height
 * change — so it passed while the real screen still jumped on focus.
 *
 * Deep link: happy://dev/chat-scroll
 */

const AT_BOTTOM_SLOP = 8;
/** Roughly an iPhone keyboard. */
const KEYBOARD_HEIGHT = 340;
/**
 * How close to the newest message the reader must be, in points, for native
 * mVCP to carry them along when a message arrives. Generous: the reader is
 * either at the newest message or deliberately reading history, and the few
 * hundred points in between are the streaming bottom row growing.
 */
const AUTOSCROLL_TOP_POINTS = 200;

type Row = { id: string; height: number; label: string };

let nextId = 0;
function makeRow(label: string, height: number): Row {
    nextId += 1;
    return { id: `row-${nextId}`, height, label };
}

// Heights chosen to be badly estimable: FlashList sizes unmeasured rows from a
// running average of measured ones, so a list of uniform rows would hide every
// correction bug this harness exists to catch.
function makeRows(count: number, prefix: string): Row[] {
    const heights = [40, 320, 64, 800, 48, 160, 1200, 56];
    return Array.from({ length: count }, (_, i) =>
        makeRow(`${prefix} ${i}`, heights[i % heights.length]),
    );
}

/**
 * The row that stands in for a work-group toggle. The experiment it exists for:
 * when a group expands, does the row the reader tapped stay where it was?
 *
 * `maintainVisibleContentPosition` pins one subview — the first one at or past
 * the top edge, counting from `minIndexForVisible`. FlashList hardcodes that to
 * 0, so in an inverted list the pinned row is always the bottom-most visible
 * one, and every insertion above it therefore pushes upward. The only lever
 * left is *which side of the toggle the content is inserted on*, and that is
 * what `expandSide` switches between.
 */
const GROUP_TOGGLE_ID = 'group-toggle';

/** Built once so the group keeps its identity across expand/collapse cycles. */
const GROUP_ROWS = makeRows(5, 'work');

type ExpandSide = 'below' | 'above';

export default function ChatScrollHarness() {
    const listRef = React.useRef<FlashListRef<Row>>(null);
    // Oldest-first, the order the screen reads in. The inverted list reverses
    // it, so both modes show the same conversation.
    //
    // The two short rows on the end keep the toggle on screen at rest; a tall
    // one would park it past the bottom edge and there would be nothing to tap.
    const [base, setBase] = React.useState<Row[]>(() => [
        ...makeRows(12, 'msg'),
        makeRow('reply', 120),
        makeRow('reply tail', 90),
    ]);
    const [expanded, setExpanded] = React.useState(false);
    const [expandSide, setExpandSide] = React.useState<ExpandSide>('below');
    // Whether to insta-jump the offset so the ribbon lands back on its pixel.
    const [pinRibbon, setPinRibbon] = React.useState(false);
    // The ribbon's distance from the OLDEST end, saved across the expansion.
    //
    // That end is the invariant one. An expansion only ever inserts content
    // between the ribbon and the newest end, so everything from the ribbon
    // outward keeps its position relative to the far end of the content —
    // which means restoring this one number puts the ribbon back exactly,
    // without measuring a single inserted row.
    const pendingPinRef = React.useRef<number | null>(null);

    const rows = React.useMemo(() => {
        // Fixed, so appends land after the ribbon and push it back into
        // history. Anchoring it to the end instead would keep it permanently
        // beside the newest message, where autoscrollToTopThreshold is always
        // armed and no expansion can be tested on its own.
        const at = Math.min(12, base.length);
        const toggle = { id: GROUP_TOGGLE_ID, height: 44, label: expanded ? 'Hide ^' : 'Worked 15m33s >' };
        const group = expanded ? GROUP_ROWS : [];
        const block = expandSide === 'below' ? [toggle, ...group] : [...group, toggle];
        return [...base.slice(0, at), ...block, ...base.slice(at)];
    }, [base, expanded, expandSide]);
    const setRows = setBase;
    const [inverted, setInverted] = React.useState(false);
    const [keyboardUp, setKeyboardUp] = React.useState(false);
    const [metrics, setMetrics] = React.useState({ offsetY: 0, contentHeight: 0, viewportHeight: 0 });
    // The worst distance from the newest message seen since the last reset.
    //
    // This is the measurement that matters and the one this harness originally
    // lacked. A jump is by definition transient: the list leaves the newest
    // message and comes back, so anything sampled after the animation settles
    // reports success while the reader plainly saw it move. Watching the peak
    // catches it.
    const [peakGap, setPeakGap] = React.useState(0);
    const metricsRef = React.useRef(metrics);
    metricsRef.current = metrics;

    // In an inverted list the newest message is at offset 0, so "at bottom"
    // means the opposite end of the scroll range.
    const measure = React.useCallback((next: { offsetY: number; contentHeight: number; viewportHeight: number }) => {
        metricsRef.current = next;
        setMetrics(next);
        if (next.contentHeight <= 0 || next.viewportHeight <= 0) return;
        const gap = inverted
            ? next.offsetY
            : Math.max(0, next.contentHeight - next.viewportHeight - next.offsetY);
        setPeakGap((prev) => Math.max(prev, gap));
    }, [inverted]);

    // How far the tapped row moved on screen across the last expand/collapse.
    // This is the whole point of the experiment: peakGap answers "did the list
    // hold the newest message", which says nothing about whether the row under
    // the reader's thumb stayed put.
    const toggleViewRef = React.useRef<View | null>(null);
    const beforeYRef = React.useRef<number | null>(null);
    const [toggleShift, setToggleShift] = React.useState('—');

    const onToggleGroup = React.useCallback(() => {
        const node = toggleViewRef.current;
        if (!node) return;
        node.measureInWindow((_x, y) => {
            beforeYRef.current = y;
            if (pinRibbon) {
                const m = metricsRef.current;
                pendingPinRef.current = m.contentHeight - m.viewportHeight - m.offsetY;
            }
            setExpanded((v) => !v);
        });
    }, [pinRibbon]);

    React.useEffect(() => {
        const before = beforeYRef.current;
        if (before === null) return;
        beforeYRef.current = null;
        // One tick past the commit, so native layout and any mVCP correction
        // have both landed.
        const timer = setTimeout(() => {
            // Pessimistic by default. A row pushed off the screen is recycled,
            // and measureInWindow on a detached view never calls back at all —
            // so waiting for the callback to tell us it left would leave the
            // readout showing the previous run's verdict.
            setToggleShift('OFF-SCREEN');
            toggleViewRef.current?.measureInWindow((_x, y) => {
                const delta = Math.round(y - before);
                setToggleShift(delta === 0 ? 'PINNED (0)' : `MOVED ${delta > 0 ? '+' : ''}${delta}`);
            });
        }, 150);
        return () => clearTimeout(timer);
    }, [expanded]);

    const resetMeasurements = React.useCallback(() => {
        const cleared = { offsetY: 0, contentHeight: 0, viewportHeight: 0 };
        metricsRef.current = cleared;
        setMetrics(cleared);
        setPeakGap(0);
    }, []);

    const distanceFromNewest = inverted
        ? metrics.offsetY
        : Math.max(0, metrics.contentHeight - metrics.viewportHeight - metrics.offsetY);
    const atBottom = metrics.contentHeight > 0 && distanceFromNewest <= AT_BOTTOM_SLOP;
    const heldBottom = peakGap <= AT_BOTTOM_SLOP;

    const data = React.useMemo(
        () => (inverted ? [...rows].reverse() : rows),
        [rows, inverted],
    );

    // NORMAL needs both halves of maintainVisibleContentPosition: a top anchor
    // to hold position when history is prepended, and a bottom pin to chase
    // the newest message when anything else changes.
    //
    // INVERTED needs neither for the cases below — offset 0 is already the
    // newest message — but keeps the anchor so that a new message arriving
    // while the reader is back in history does not shove their content.
    // Note the two different units. autoscrollToBottomThreshold is FlashList's
    // own, implemented in JS, and is a fraction of the viewport.
    // autoscrollToTopThreshold is not implemented in FlashList at all — it is
    // forwarded to React Native's native maintainVisibleContentPosition, where
    // the value is in points. Passing a fraction there is indistinguishable
    // from switching it off.
    const mvcp = React.useMemo(() => (inverted
        ? { autoscrollToTopThreshold: AUTOSCROLL_TOP_POINTS }
        : {
            startRenderingFromBottom: true,
            autoscrollToBottomThreshold: 0.2,
            animateAutoScrollToBottom: false,
        }
    ), [inverted]);

    const renderItem = React.useCallback(({ item }: { item: Row }) => {
        if (item.id === GROUP_TOGGLE_ID) {
            return (
                <Pressable
                    ref={(node) => { toggleViewRef.current = node; }}
                    testID="harness-group-toggle"
                    onPress={onToggleGroup}
                    style={{ height: item.height, justifyContent: 'center', paddingHorizontal: 12, backgroundColor: '#ffe9b0' }}
                >
                    <Text>{item.label}</Text>
                </Pressable>
            );
        }
        return (
            <View style={{ height: item.height, borderBottomWidth: 1, borderBottomColor: '#eee', justifyContent: 'center', paddingHorizontal: 12 }}>
                <Text>{item.label} · {item.height}px</Text>
            </View>
        );
    }, [onToggleGroup]);

    // Remounts on mode change: inversion changes the meaning of every offset,
    // so carrying scroll state across would prove nothing.
    const listKey = inverted ? 'inverted' : 'normal';

    return (
        <>
            <Stack.Screen options={{ headerTitle: 'Chat Scroll Harness' }} />
            <View style={{ flex: 1 }}>
                <View style={{ flex: 1 }}>
                    <FlashList
                        key={listKey}
                        ref={listRef}
                        data={data}
                        inverted={inverted}
                        keyExtractor={(item) => item.id}
                        renderItem={renderItem}
                        maintainVisibleContentPosition={mvcp}
                        ListHeaderComponent={<View style={{ height: 120 }} />}
                        scrollEventThrottle={16}
                        onLoad={() => {
                            // Inverted already opens on the newest message.
                            if (!inverted) listRef.current?.scrollToEnd({ animated: false });
                        }}
                        onScroll={(e) => {
                            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
                            measure({
                                offsetY: contentOffset.y,
                                contentHeight: contentSize.height,
                                viewportHeight: layoutMeasurement.height,
                            });
                        }}
                        // A list resting at offset 0 — every inverted one —
                        // emits no scroll events, so position has to be read
                        // from layout too or the readout goes stale.
                        onLayout={(e) => measure({ ...metricsRef.current, viewportHeight: e.nativeEvent.layout.height })}
                        onContentSizeChange={(_w, h) => {
                            measure({ ...metricsRef.current, contentHeight: h });
                            const saved = pendingPinRef.current;
                            if (saved === null) return;
                            // First content-size report after the insert. If
                            // FlashList is still estimating the new rows this
                            // lands short and a second correction follows —
                            // which is exactly what the frame capture checks.
                            pendingPinRef.current = null;
                            const target = Math.max(0, h - metricsRef.current.viewportHeight - saved);
                            listRef.current?.scrollToOffset({ offset: target, animated: false });
                        }}
                    />
                </View>

                {/* Readout. A UI test asserts on these strings. */}
                <View style={{ padding: 8, backgroundColor: heldBottom ? '#d6f5d6' : '#f9d6d6' }}>
                    <Text testID="harness-verdict" style={{ fontWeight: 'bold', fontSize: 16 }}>
                        {heldBottom ? 'HELD BOTTOM' : 'JUMPED'} · {inverted ? 'INVERTED' : 'NORMAL'}
                    </Text>
                    <Text testID="harness-metrics">
                        peak={Math.round(peakGap)} now={Math.round(distanceFromNewest)} y={Math.round(metrics.offsetY)} content={Math.round(metrics.contentHeight)} view={Math.round(metrics.viewportHeight)} {atBottom ? 'at-bottom' : 'off-bottom'}
                    </Text>
                    <Text testID="harness-toggle-shift" style={{ fontWeight: 'bold' }}>
                        tapped row: {toggleShift} · insert {expandSide} · pin {pinRibbon ? 'ON' : 'off'} · {expanded ? 'expanded' : 'collapsed'}
                    </Text>
                </View>

                <View style={{ flexDirection: 'row', flexWrap: 'wrap', padding: 8, gap: 8 }}>
                    <Button label="mode" onPress={() => {
                        setInverted((v) => !v);
                        // Inversion changes what every offset means, and the
                        // list remounts, so carrying the old numbers over
                        // would report the previous mode's position.
                        resetMeasurements();
                    }} />
                    <Button label="reset peak" onPress={() => setPeakGap(0)} />
                    <Button label="shrink viewport" onPress={() => setKeyboardUp(true)} />
                    <Button label="grow viewport" onPress={() => setKeyboardUp(false)} />
                    <Button label="append" onPress={() => setRows((prev) => [...prev, makeRow('appended', 220)])} />
                    <Button label="append tall" onPress={() => setRows((prev) => [...prev, makeRow('appended tall', 1400)])} />
                    <Button label="prepend" onPress={() => setRows((prev) => [...makeRows(8, 'older'), ...prev])} />
                    <Button label="insert below" onPress={() => { setExpanded(false); setExpandSide('below'); setToggleShift('—'); }} />
                    <Button label="insert above" onPress={() => { setExpanded(false); setExpandSide('above'); setToggleShift('—'); }} />
                    <Button label="pin ribbon" onPress={() => { setExpanded(false); setExpandSide('below'); setPinRibbon((v) => !v); setToggleShift('—'); }} />
                </View>

                {/* Stands in for the keyboard: takes height away from the list. */}
                {keyboardUp && <View style={{ height: KEYBOARD_HEIGHT, backgroundColor: '#ccd' }} />}
            </View>
        </>
    );
}

function Button(props: { label: string; onPress: () => void }) {
    return (
        <Pressable
            testID={`harness-${props.label.replace(/\s+/g, '-')}`}
            onPress={props.onPress}
            style={{ paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#222', borderRadius: 6 }}
        >
            <Text style={{ color: 'white' }}>{props.label}</Text>
        </Pressable>
    );
}
