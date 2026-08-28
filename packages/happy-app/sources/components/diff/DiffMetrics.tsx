/**
 * Monospace metrics for the diff renderer.
 *
 * Horizontal scrolling needs an exact content width, and an exact content width
 * needs the real advance width of the monospace font. IBM Plex Mono is 0.6em,
 * which we use as the first-frame estimate, then we measure a real string once
 * per font size and cache it forever. On web the fallback font may differ, so
 * the measurement matters there more than on native.
 */

import * as React from 'react';
import { Platform, Text, View } from 'react-native';
import { Typography } from '@/constants/Typography';
import { gutterWidthFor } from './layout';

/** IBM Plex Mono advance width, in em. */
const NOMINAL_RATIO = 0.6;
const SAMPLE = 'MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM'; // 50 chars

const measured = new Map<number, number>();
const listeners = new Set<() => void>();

/** Bumped on every measurement so `useSyncExternalStore` sees a new snapshot. */
let revision = 0;

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function getRevision(): number {
    return revision;
}

function notify(): void {
    revision++;
    for (const listener of listeners) listener();
}

export interface DiffMetrics {
    fontSize: number;
    lineHeight: number;
    charWidth: number;
    /** Width of the pinned gutter for the given maximum line number. */
    gutterWidth: (maxLineNo: number, showLineNumbers: boolean) => number;
}

export function useDiffMetrics(fontSize: number): DiffMetrics {
    // Re-renders when the probe lands a measurement, for every size at once.
    React.useSyncExternalStore(subscribe, getRevision, getRevision);

    const charWidth = measured.get(fontSize) ?? fontSize * NOMINAL_RATIO;
    const lineHeight = Math.round(fontSize * 1.5);

    return React.useMemo(() => ({
        fontSize,
        lineHeight,
        charWidth,
        gutterWidth: (maxLineNo: number, showLineNumbers: boolean) =>
            gutterWidthFor(charWidth, maxLineNo, showLineNumbers),
    }), [fontSize, lineHeight, charWidth]);
}

/**
 * Invisible probe that measures the mono font once per size. Mounted by
 * DiffFileView; rendering several of them is harmless because the cache is
 * keyed by font size and writes are idempotent.
 */
export const MonoProbe = React.memo(function MonoProbe({ fontSize }: { fontSize: number }) {
    if (measured.has(fontSize)) return null;
    return (
        <View style={{ position: 'absolute', opacity: 0, top: -9999, left: -9999 }} pointerEvents="none">
            <Text
                style={{ ...Typography.mono(), fontSize, includeFontPadding: false } as any}
                onLayout={(e) => {
                    const width = e.nativeEvent.layout.width / SAMPLE.length;
                    if (!width || measured.has(fontSize)) return;
                    // Ignore obviously broken measurements (font not loaded yet).
                    if (width < fontSize * 0.35 || width > fontSize * 1.2) return;
                    measured.set(fontSize, width);
                    notify();
                }}
            >
                {SAMPLE}
            </Text>
        </View>
    );
});

/** Default body font size for diffs, a touch smaller on phones than on web. */
export const DEFAULT_DIFF_FONT_SIZE = Platform.OS === 'web' ? 12.5 : 12;
