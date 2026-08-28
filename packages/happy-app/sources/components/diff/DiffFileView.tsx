/**
 * Renders one file's diff.
 *
 * Three layouts share the same row data:
 *
 *   scroll (default) — line numbers and the +/- marker sit in a gutter pinned
 *     over a horizontal ScrollView, so code slides underneath while the gutter
 *     stays put. This is the thing that makes long lines usable on a phone.
 *   wrap — no horizontal scroll, the gutter is inline and content wraps.
 *   split — old and new side by side. Both cells live in one flex row, so a
 *     wrapped line grows the row and the two sides can never drift apart.
 *
 * Rows carry no logic: every span was classified and colored at build time, so
 * a row is a `<Text>` with a handful of children and nothing to recompute while
 * scrolling.
 */

import * as React from 'react';
import { LayoutChangeEvent, Platform, Pressable, Text, View } from 'react-native';
import { HorizontalScrollView } from '@/components/HorizontalScrollView';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { DEFAULT_DIFF_FONT_SIZE, MonoProbe, useDiffMetrics, type DiffMetrics } from './DiffMetrics';
import { useDiffPalette, type DiffPalette } from './DiffPalette';
import { buildSplitRows, type DiffLineRow, type SplitRow } from './engine/splitRows';
import type { DiffFile, DiffRow, DiffSpan } from './engine/types';
import { selectVisibleRows } from './layout';
import { useProgressiveRows } from './useProgressiveRows';

/**
 * Indentation is content in a diff. react-native-web collapses runs of spaces
 * unless `white-space` says otherwise, so code rows opt out explicitly; native
 * preserves them already.
 */
const PRE = Platform.OS === 'web' ? ({ whiteSpace: 'pre' } as any) : null;
const PRE_WRAP = Platform.OS === 'web' ? ({ whiteSpace: 'pre-wrap' } as any) : null;

export interface DiffFileViewProps {
    file: DiffFile;
    /** Body font size. Defaults to a phone-friendly 12. */
    fontSize?: number;
    showLineNumbers?: boolean;
    /** Wrap long lines instead of scrolling horizontally. */
    wrap?: boolean;
    /**
     * Side-by-side layout. Implies wrapping — two columns plus a horizontal
     * scroll each is unusable, and split is only offered on wide screens.
     */
    split?: boolean;
    /** Draw the `@@` separators between hunks. */
    showHunkHeaders?: boolean;
    /**
     * Render at most this many rows and offer a "show the rest" button.
     * Keeps a 12k-line file from ever mounting 12k views by accident.
     */
    collapseAfter?: number;
    /** Long-press to select text. Off by default — selectable rows cost measurably more. */
    selectable?: boolean;
    /**
     * Called when the reader taps a "N unchanged lines" separator. A patch does
     * not contain the lines it skipped, so only callers that can ask their
     * source for a wider diff pass this; without it the separators are inert.
     */
    onExpandContext?: () => void;
    /** Extra rows of breathing room above and below the code. */
    paddingVertical?: number;
    onLineLongPress?: (row: Extract<DiffRow, { kind: 'line' }>) => void;
}

export const DiffFileView = React.memo(function DiffFileView({
    file,
    fontSize = DEFAULT_DIFF_FONT_SIZE,
    showLineNumbers = true,
    wrap = false,
    split = false,
    showHunkHeaders = true,
    collapseAfter = 400,
    selectable = false,
    paddingVertical = 4,
    onLineLongPress,
    onExpandContext,
}: DiffFileViewProps) {
    const palette = useDiffPalette();
    const metrics = useDiffMetrics(fontSize);
    const [expanded, setExpanded] = React.useState(false);
    const [viewportWidth, setViewportWidth] = React.useState(0);

    const { rows: selectedRows, hiddenCount: hiddenRowCount } = React.useMemo(
        () => selectVisibleRows(file.rows, { showHunkHeaders, expanded, collapseAfter }),
        [file.rows, showHunkHeaders, expanded, collapseAfter],
    );

    // Paint a screenful now, mount the remainder over the next few frames.
    const rows = useProgressiveRows(selectedRows);

    const gutterWidth = metrics.gutterWidth(file.maxLineNo, showLineNumbers);
    const onLayout = React.useCallback((e: LayoutChangeEvent) => {
        setViewportWidth(e.nativeEvent.layout.width);
    }, []);

    const body = split ? (
        <SplitBody
            rows={rows}
            palette={palette}
            metrics={metrics}
            gutterWidth={gutterWidth}
            showLineNumbers={showLineNumbers}
            selectable={selectable}
            paddingVertical={paddingVertical}
            onLineLongPress={onLineLongPress}
            onExpandContext={onExpandContext}
        />
    ) : wrap ? (
        <View style={{ paddingVertical }}>
            {rows.map((row) => (
                <DiffRowInline
                    key={row.key}
                    row={row}
                    palette={palette}
                    metrics={metrics}
                    gutterWidth={gutterWidth}
                    showLineNumbers={showLineNumbers}
                    selectable={selectable}
                    onLongPress={onLineLongPress}
                    onExpandContext={onExpandContext}
                />
            ))}
        </View>
    ) : (
        <ScrollBody
            rows={rows}
            file={file}
            palette={palette}
            metrics={metrics}
            gutterWidth={gutterWidth}
            viewportWidth={viewportWidth}
            showLineNumbers={showLineNumbers}
            selectable={selectable}
            paddingVertical={paddingVertical}
            onLineLongPress={onLineLongPress}
            onExpandContext={onExpandContext}
        />
    );

    return (
        <View style={{ backgroundColor: palette.surface }} onLayout={onLayout}>
            <MonoProbe fontSize={fontSize} />
            {body}
            {hiddenRowCount > 0 ? (
                <Pressable
                    onPress={() => setExpanded(true)}
                    style={{
                        paddingVertical: 10,
                        alignItems: 'center',
                        backgroundColor: palette.hunkBg,
                        borderTopWidth: 1,
                        borderTopColor: palette.divider,
                    }}
                >
                    <Text style={{ ...Typography.default('semiBold'), fontSize: 13, color: palette.hunkText }}>
                        {t('diff.showMoreLines', { count: hiddenRowCount })}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
});

// ────────────────────────────────────────────────────────────────────────────
// Horizontal-scroll layout
// ────────────────────────────────────────────────────────────────────────────

const ScrollBody = React.memo(function ScrollBody({
    rows,
    file,
    palette,
    metrics,
    gutterWidth,
    viewportWidth,
    showLineNumbers,
    selectable,
    paddingVertical,
    onLineLongPress,
    onExpandContext,
}: {
    rows: DiffRow[];
    file: DiffFile;
    palette: DiffPalette;
    metrics: DiffMetrics;
    gutterWidth: number;
    viewportWidth: number;
    showLineNumbers: boolean;
    selectable: boolean;
    paddingVertical: number;
    onLineLongPress?: (row: Extract<DiffRow, { kind: 'line' }>) => void;
    onExpandContext?: () => void;
}) {
    // A couple of columns of slack keeps the last glyph off the right edge.
    const codeWidth = Math.ceil((file.maxColumns + 2) * metrics.charWidth) + 8;
    const minWidth = Math.max(0, viewportWidth - gutterWidth);
    const contentWidth = Math.max(codeWidth, minWidth);
    const scrollable = codeWidth > minWidth;

    return (
        <View style={{ position: 'relative' }}>
            <HorizontalScrollView
                scrollEnabled={scrollable}
                showsHorizontalScrollIndicator={scrollable}
                contentContainerStyle={{ paddingLeft: gutterWidth, paddingVertical }}
                // Keeps the gutter overlay from eating the first touch column.
                scrollEventThrottle={16}
            >
                <View style={{ width: contentWidth }}>
                    {rows.map((row) => (
                        <DiffRowCode
                            key={row.key}
                            row={row}
                            palette={palette}
                            metrics={metrics}
                            selectable={selectable}
                            onLongPress={onLineLongPress}
                            onExpandContext={onExpandContext}
                        />
                    ))}
                </View>
            </HorizontalScrollView>

            <View
                pointerEvents="none"
                style={{
                    position: 'absolute',
                    left: 0,
                    top: paddingVertical,
                    width: gutterWidth,
                    backgroundColor: palette.surface,
                }}
            >
                {rows.map((row) => (
                    <DiffRowGutter
                        key={row.key}
                        row={row}
                        palette={palette}
                        metrics={metrics}
                        width={gutterWidth}
                        showLineNumbers={showLineNumbers}
                    />
                ))}
            </View>
        </View>
    );
});

// ────────────────────────────────────────────────────────────────────────────
// Split layout
// ────────────────────────────────────────────────────────────────────────────

const SplitBody = React.memo(function SplitBody({
    rows,
    palette,
    metrics,
    gutterWidth,
    showLineNumbers,
    selectable,
    paddingVertical,
    onLineLongPress,
    onExpandContext,
}: {
    rows: DiffRow[];
    palette: DiffPalette;
    metrics: DiffMetrics;
    gutterWidth: number;
    showLineNumbers: boolean;
    selectable: boolean;
    paddingVertical: number;
    onLineLongPress?: (row: DiffLineRow) => void;
    onExpandContext?: () => void;
}) {
    const splitRows = React.useMemo(() => buildSplitRows(rows), [rows]);

    return (
        <View style={{ paddingVertical }}>
            {splitRows.map((row) => (
                <DiffSplitRow
                    key={row.key}
                    row={row}
                    palette={palette}
                    metrics={metrics}
                    gutterWidth={gutterWidth}
                    showLineNumbers={showLineNumbers}
                    selectable={selectable}
                    onLongPress={onLineLongPress}
                    onExpandContext={onExpandContext}
                />
            ))}
        </View>
    );
});

const DiffSplitRow = React.memo(function DiffSplitRow({
    row,
    palette,
    metrics,
    gutterWidth,
    showLineNumbers,
    selectable,
    onLongPress,
    onExpandContext,
}: {
    row: SplitRow;
    palette: DiffPalette;
    metrics: DiffMetrics;
    gutterWidth: number;
    showLineNumbers: boolean;
    selectable: boolean;
    onLongPress?: (row: DiffLineRow) => void;
    onExpandContext?: () => void;
}) {
    if (row.kind === 'full') {
        if (row.row.kind === 'hunk') {
            return <HunkBar row={row.row} palette={palette} metrics={metrics} onExpandContext={onExpandContext} />;
        }
        return (
            <View style={{ paddingVertical: 12, alignItems: 'center' }}>
                <Text style={{ ...Typography.default(), fontSize: 13, color: palette.textSecondary }}>
                    {messageText(row.row.code)}
                </Text>
            </View>
        );
    }

    return (
        <View style={{ flexDirection: 'row', alignItems: 'stretch' }}>
            <DiffSplitCell
                line={row.left}
                side="old"
                palette={palette}
                metrics={metrics}
                gutterWidth={gutterWidth}
                showLineNumbers={showLineNumbers}
                selectable={selectable}
                onLongPress={onLongPress}
            />
            <View style={{ width: 1, backgroundColor: palette.divider }} />
            <DiffSplitCell
                line={row.right}
                side="new"
                palette={palette}
                metrics={metrics}
                gutterWidth={gutterWidth}
                showLineNumbers={showLineNumbers}
                selectable={selectable}
                onLongPress={onLongPress}
            />
        </View>
    );
});

/**
 * One column of a split row. An absent line renders as a filler cell rather
 * than an empty one, so the eye reads "nothing here" instead of "blank line".
 */
const DiffSplitCell = React.memo(function DiffSplitCell({
    line,
    side,
    palette,
    metrics,
    gutterWidth,
    showLineNumbers,
    selectable,
    onLongPress,
}: {
    line: DiffLineRow | null;
    side: 'old' | 'new';
    palette: DiffPalette;
    metrics: DiffMetrics;
    gutterWidth: number;
    showLineNumbers: boolean;
    selectable: boolean;
    onLongPress?: (row: DiffLineRow) => void;
}) {
    if (!line) {
        return <View style={{ flex: 1, minWidth: 0, minHeight: metrics.lineHeight, backgroundColor: palette.hunkBg }} />;
    }

    // A context line is drawn on both sides; a change only ever belongs to one.
    const type = line.type;
    const number = side === 'old' ? line.oldNo : line.newNo;
    const marker = type === 'ctx' ? '' : side === 'old' ? '−' : '+';

    return (
        <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', backgroundColor: palette.rowBg[type] }}>
            <View
                style={{
                    width: gutterWidth,
                    flexDirection: 'row',
                    alignItems: 'flex-start',
                    backgroundColor: palette.gutterBg[type],
                }}
            >
                {showLineNumbers ? (
                    <Text
                        style={{
                            ...Typography.mono(),
                            flex: 1,
                            textAlign: 'right',
                            fontSize: metrics.fontSize - 1,
                            lineHeight: metrics.lineHeight,
                            color: palette.lineNumber,
                        }}
                    >
                        {number ?? ''}
                    </Text>
                ) : null}
                <Text
                    style={{
                        ...Typography.mono(),
                        width: Math.ceil(metrics.charWidth * 2),
                        textAlign: 'center',
                        fontSize: metrics.fontSize,
                        lineHeight: metrics.lineHeight,
                        color: palette.marker[type],
                    }}
                >
                    {marker}
                </Text>
            </View>
            <Text
                selectable={selectable}
                onLongPress={onLongPress ? () => onLongPress(line) : undefined}
                style={{
                    ...Typography.mono(),
                    flex: 1,
                    fontSize: metrics.fontSize,
                    lineHeight: metrics.lineHeight,
                    color: palette.syntax.plain,
                    paddingLeft: 6,
                    paddingRight: 8,
                    ...PRE_WRAP,
                }}
            >
                {renderSpans(line.spans, palette)}
            </Text>
        </View>
    );
});

// ────────────────────────────────────────────────────────────────────────────
// Rows
// ────────────────────────────────────────────────────────────────────────────

/** The scrolling half of a row: code only. */
const DiffRowCode = React.memo(function DiffRowCode({
    row,
    palette,
    metrics,
    selectable,
    onLongPress,
    onExpandContext,
}: {
    row: DiffRow;
    palette: DiffPalette;
    metrics: DiffMetrics;
    selectable: boolean;
    onLongPress?: (row: Extract<DiffRow, { kind: 'line' }>) => void;
    onExpandContext?: () => void;
}) {
    if (row.kind === 'hunk') {
        const canExpand = Boolean(onExpandContext && row.hidden);
        return (
            <Pressable onPress={canExpand ? onExpandContext : undefined} disabled={!canExpand}>
                <Text
                    numberOfLines={1}
                    style={{
                        ...Typography.mono(),
                        fontSize: metrics.fontSize - 1,
                        lineHeight: metrics.lineHeight,
                        height: metrics.lineHeight,
                        backgroundColor: palette.hunkBg,
                        color: palette.hunkText,
                    }}
                >
                    {row.hidden
                        ? `${canExpand ? '⤢' : '⋯'} ${t('diff.unchangedLines', { count: row.hidden })}`
                        : row.text}
                    {row.section ? <Text style={{ color: palette.sectionText }}>{`   ${row.section}`}</Text> : null}
                </Text>
            </Pressable>
        );
    }
    if (row.kind === 'message') {
        return (
            <Text
                numberOfLines={1}
                style={{
                    ...Typography.default(),
                    fontSize: metrics.fontSize,
                    lineHeight: metrics.lineHeight,
                    height: metrics.lineHeight,
                    color: palette.textSecondary,
                }}
            >
                {messageText(row.code)}
            </Text>
        );
    }
    return (
        <Text
            numberOfLines={1}
            selectable={selectable}
            onLongPress={onLongPress ? () => onLongPress(row) : undefined}
            style={{
                ...Typography.mono(),
                fontSize: metrics.fontSize,
                lineHeight: metrics.lineHeight,
                height: metrics.lineHeight,
                backgroundColor: palette.rowBg[row.type],
                color: palette.syntax.plain,
                paddingLeft: 6,
                ...PRE,
            }}
        >
            {renderSpans(row.spans, palette)}
        </Text>
    );
});

/** The pinned half of a row: line numbers and the change marker. */
const DiffRowGutter = React.memo(function DiffRowGutter({
    row,
    palette,
    metrics,
    width,
    showLineNumbers,
}: {
    row: DiffRow;
    palette: DiffPalette;
    metrics: DiffMetrics;
    width: number;
    showLineNumbers: boolean;
}) {
    if (row.kind === 'hunk') {
        return (
            <View style={{ height: metrics.lineHeight, width, backgroundColor: palette.hunkBg, justifyContent: 'center' }}>
                <Text
                    numberOfLines={1}
                    style={{
                        ...Typography.mono(),
                        fontSize: metrics.fontSize - 1,
                        color: palette.hunkText,
                        paddingLeft: 6,
                    }}
                >
                    {'···'}
                </Text>
            </View>
        );
    }
    if (row.kind === 'message') {
        return <View style={{ height: metrics.lineHeight, width }} />;
    }

    const number = row.type === 'del' ? row.oldNo : row.newNo;
    return (
        <View
            style={{
                height: metrics.lineHeight,
                width,
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: palette.gutterBg[row.type],
            }}
        >
            {showLineNumbers ? (
                <Text
                    numberOfLines={1}
                    style={{
                        ...Typography.mono(),
                        flex: 1,
                        textAlign: 'right',
                        fontSize: metrics.fontSize - 1,
                        lineHeight: metrics.lineHeight,
                        color: palette.lineNumber,
                    }}
                >
                    {number ?? ''}
                </Text>
            ) : null}
            <Text
                style={{
                    ...Typography.mono(),
                    width: Math.ceil(metrics.charWidth * 2),
                    textAlign: 'center',
                    fontSize: metrics.fontSize,
                    lineHeight: metrics.lineHeight,
                    color: palette.marker[row.type],
                }}
            >
                {row.type === 'add' ? '+' : row.type === 'del' ? '−' : ''}
            </Text>
        </View>
    );
});

/** Wrap-mode row: gutter and code in one flex line, height driven by content. */
const DiffRowInline = React.memo(function DiffRowInline({
    row,
    palette,
    metrics,
    gutterWidth,
    showLineNumbers,
    selectable,
    onLongPress,
    onExpandContext,
}: {
    row: DiffRow;
    palette: DiffPalette;
    metrics: DiffMetrics;
    gutterWidth: number;
    showLineNumbers: boolean;
    selectable: boolean;
    onLongPress?: (row: Extract<DiffRow, { kind: 'line' }>) => void;
    onExpandContext?: () => void;
}) {
    if (row.kind === 'hunk') {
        return <HunkBar row={row} palette={palette} metrics={metrics} onExpandContext={onExpandContext} />;
    }
    if (row.kind === 'message') {
        return (
            <View style={{ paddingVertical: 12, alignItems: 'center' }}>
                <Text style={{ ...Typography.default(), fontSize: 13, color: palette.textSecondary }}>{messageText(row.code)}</Text>
            </View>
        );
    }

    const number = row.type === 'del' ? row.oldNo : row.newNo;
    return (
        <View style={{ flexDirection: 'row', backgroundColor: palette.rowBg[row.type] }}>
            <View
                style={{
                    width: gutterWidth,
                    flexDirection: 'row',
                    alignItems: 'flex-start',
                    backgroundColor: palette.gutterBg[row.type],
                }}
            >
                {showLineNumbers ? (
                    <Text
                        style={{
                            ...Typography.mono(),
                            flex: 1,
                            textAlign: 'right',
                            fontSize: metrics.fontSize - 1,
                            lineHeight: metrics.lineHeight,
                            color: palette.lineNumber,
                        }}
                    >
                        {number ?? ''}
                    </Text>
                ) : null}
                <Text
                    style={{
                        ...Typography.mono(),
                        width: Math.ceil(metrics.charWidth * 2),
                        textAlign: 'center',
                        fontSize: metrics.fontSize,
                        lineHeight: metrics.lineHeight,
                        color: palette.marker[row.type],
                    }}
                >
                    {row.type === 'add' ? '+' : row.type === 'del' ? '−' : ''}
                </Text>
            </View>
            <Text
                selectable={selectable}
                onLongPress={onLongPress ? () => onLongPress(row) : undefined}
                style={{
                    ...Typography.mono(),
                    flex: 1,
                    fontSize: metrics.fontSize,
                    lineHeight: metrics.lineHeight,
                    color: palette.syntax.plain,
                    paddingLeft: 6,
                    paddingRight: 8,
                    ...PRE_WRAP,
                }}
            >
                {renderSpans(row.spans, palette)}
            </Text>
        </View>
    );
});

const HunkBar = React.memo(function HunkBar({
    row,
    palette,
    metrics,
    onExpandContext,
}: {
    row: Extract<DiffRow, { kind: 'hunk' }>;
    palette: DiffPalette;
    metrics: DiffMetrics;
    onExpandContext?: () => void;
}) {
    const canExpand = Boolean(onExpandContext && row.hidden);
    return (
        <Pressable
            onPress={canExpand ? onExpandContext : undefined}
            disabled={!canExpand}
            style={{
                height: metrics.lineHeight,
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 8,
                gap: 8,
                backgroundColor: palette.hunkBg,
            }}
        >
            <Text numberOfLines={1} style={{ ...Typography.mono(), fontSize: metrics.fontSize - 1, color: palette.hunkText }}>
                {row.hidden
                    ? `${canExpand ? '⤢' : '⋯'} ${t('diff.unchangedLines', { count: row.hidden })}`
                    : row.text}
            </Text>
            {row.section ? (
                <Text
                    numberOfLines={1}
                    style={{ ...Typography.mono(), flex: 1, fontSize: metrics.fontSize - 1, color: palette.sectionText }}
                >
                    {row.section}
                </Text>
            ) : null}
        </Pressable>
    );
});

/** Message rows carry a marker rather than copy, so the text follows the app language. */
function messageText(code: 'binary' | 'empty'): string {
    return code === 'binary' ? t('diff.binaryFile') : t('diff.noChanges');
}

/**
 * Spans render as nested `<Text>`. Runs without syntax color or word emphasis
 * collapse to a bare string child, which is meaningfully cheaper across a few
 * thousand rows.
 */
function renderSpans(spans: DiffSpan[], palette: DiffPalette): React.ReactNode {
    if (spans.length === 0) return ' ';
    return spans.map((span, i) => {
        const color = span.k === 'plain' ? undefined : palette.syntax[span.k];
        const background = span.e === 1 ? palette.wordBg.add : span.e === 2 ? palette.wordBg.del : undefined;
        if (!color && !background) return span.t;
        return (
            <Text key={i} style={{ color, backgroundColor: background }}>
                {span.t}
            </Text>
        );
    });
}
