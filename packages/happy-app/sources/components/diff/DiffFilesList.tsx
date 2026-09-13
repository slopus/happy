/**
 * The pull-request view: every changed file, one after another.
 *
 * Files are the virtualization unit. That keeps each file's horizontal scroll
 * and pinned gutter intact (they'd break if rows were list items), while still
 * meaning a 60-file changeset only ever mounts the handful of sections near the
 * viewport.
 *
 * Sections take a *source*, not a built document, so parsing and highlighting
 * happen as a section scrolls into view rather than all at once up front — the
 * difference between a 300ms stall and no stall at all on a large changeset.
 * Header stats come from the caller (git already knows them), so a collapsed
 * file costs nothing.
 */

import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';
import { FlashList, type FlashListRef, type ListRenderItemInfo } from '@shopify/flash-list';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { layout } from '@/components/layout';
import { DiffFileHeader, type DiffFileSummary } from './DiffFileHeader';
import { DiffFileView } from './DiffFileView';
import { useDiffPalette } from './DiffPalette';
import { useDiffDocument, type DiffSource } from './useDiffDocument';
import { DiffImageView } from './DiffImageView';
import { DiffSyntaxCell, SyntaxViewport, SYNTAX_VIEWABILITY } from './syntax/viewport';

export interface DiffFileItem extends DiffFileSummary {
    /** Stable identity; defaults to `path` when omitted. */
    key?: string;
    /** Null while the patch is still being fetched. */
    source: DiffSource | null;
    /** Set instead of `source` for files that are pictures rather than text. */
    image?: { before: string | null; after: string | null };
    error?: string | null;
    /** Informational copy for files with no text body (for example empty or conflicting files). */
    message?: string;
}

export interface DiffFilesListProps {
    items: DiffFileItem[];
    /** Scrolls to this path once the list has it. */
    scrollToPath?: string | null;
    showLineNumbers?: boolean;
    wrap?: boolean;
    /** Side-by-side layout. Only makes sense on wide screens. */
    split?: boolean;
    fontSize?: number;
    header?: React.ReactNode;
    /** Files with more changed lines than this start collapsed. */
    autoCollapseAbove?: number;
    /**
     * Start every file collapsed, so the screen opens as a list of what
     * changed rather than a wall of code to scroll past.
     */
    defaultCollapsed?: boolean;
    /** Overrides the default "no changes" copy. */
    emptyText?: string;
    /**
     * Called when the reader taps an "N unchanged lines" separator, with the
     * file it belongs to. Callers that can re-fetch a wider diff pass this.
     */
    onExpandContext?: (path: string) => void;
    /** Requests the body for an expanded file whose source has not arrived yet. */
    onRequestContent?: (path: string) => void | Promise<void>;
}

export const DiffFilesList = React.memo(function DiffFilesList({
    items,
    scrollToPath,
    showLineNumbers = true,
    wrap = false,
    split = false,
    fontSize,
    header,
    autoCollapseAbove = 2000,
    defaultCollapsed = false,
    emptyText,
    onExpandContext,
    onRequestContent,
}: DiffFilesListProps) {
    const palette = useDiffPalette();
    const listRef = React.useRef<FlashListRef<DiffFileItem>>(null);
    const syntaxViewport = React.useMemo(() => new SyntaxViewport(), []);
    const [overrides, setOverrides] = React.useState<Record<string, boolean>>({});

    const toggle = React.useCallback((path: string, current: boolean) => {
        setOverrides((prev) => ({ ...prev, [path]: !current }));
    }, []);

    // Scroll to the requested file once, when it first appears in the list.
    // Items change identity every time a lazily loaded body arrives, and
    // re-scrolling on each of those would yank the reader back to the target
    // after they had moved on to another file. The target is marked consumed
    // only when the frame actually fires, so a cancelled frame retries.
    const consumedScrollTargetRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!scrollToPath) {
            consumedScrollTargetRef.current = null;
            return;
        }
        if (consumedScrollTargetRef.current === scrollToPath) return;
        const index = items.findIndex((f) => f.path === scrollToPath);
        if (index < 0) return;
        const id = requestAnimationFrame(() => {
            consumedScrollTargetRef.current = scrollToPath;
            listRef.current?.scrollToIndex({ index, animated: true });
        });
        return () => cancelAnimationFrame(id);
    }, [scrollToPath, items]);

    const renderItem = React.useCallback(({ item, target }: ListRenderItemInfo<DiffFileItem>) => {
        const tooBig = item.additions + item.deletions > autoCollapseAbove;
        const collapsed = overrides[item.path] ?? (defaultCollapsed || tooBig);
        return (
            <DiffSyntaxCell viewport={syntaxViewport} itemKey={item.key ?? item.path} enabled={target !== 'Measurement'}>
                <FileSection
                    item={item}
                    collapsed={collapsed}
                    // The "N changed lines" line explains why a file is closed when
                    // its size forced it. When everything starts closed it explains
                    // nothing and doubles the height of the list, so it is dropped.
                    showSizeHint={collapsed && tooBig}
                    onToggle={() => toggle(item.path, collapsed)}
                    showLineNumbers={showLineNumbers}
                    wrap={wrap}
                    split={split}
                    fontSize={fontSize}
                    highlighted={scrollToPath === item.path}
                    onExpandContext={onExpandContext}
                    onRequestContent={onRequestContent}
                />
            </DiffSyntaxCell>
        );
    }, [overrides, autoCollapseAbove, defaultCollapsed, toggle, showLineNumbers, wrap, split, fontSize, scrollToPath, onExpandContext, onRequestContent, syntaxViewport]);

    return (
        <View style={{ flex: 1, backgroundColor: palette.surface }}>
            <FlashList
                ref={listRef}
                data={items}
                renderItem={renderItem}
                keyExtractor={(item) => item.key ?? item.path}
                ListHeaderComponent={header ? <>{header}</> : undefined}
                ListEmptyComponent={
                    <View style={{ padding: 32, alignItems: 'center' }}>
                        <Text style={{ ...Typography.default(), color: palette.textSecondary }}>{emptyText ?? t('diff.noChanges')}</Text>
                    </View>
                }
                contentContainerStyle={{ paddingBottom: 32 }}
                drawDistance={Platform.OS === 'web' ? 2000 : 800}
                viewabilityConfig={SYNTAX_VIEWABILITY}
                onViewableItemsChanged={syntaxViewport.update}
            />
        </View>
    );
});

const FileSection = React.memo(function FileSection({
    item,
    collapsed,
    showSizeHint,
    onToggle,
    showLineNumbers,
    wrap,
    split,
    fontSize,
    highlighted,
    onExpandContext,
    onRequestContent,
}: {
    item: DiffFileItem;
    collapsed: boolean;
    showSizeHint: boolean;
    onToggle: () => void;
    showLineNumbers: boolean;
    wrap: boolean;
    split: boolean;
    fontSize?: number;
    highlighted: boolean;
    onExpandContext?: (path: string) => void;
    onRequestContent?: (path: string) => void | Promise<void>;
}) {
    const palette = useDiffPalette();
    const requestedContentRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        const unavailable = !item.source && !item.image && item.error == null && item.message == null;
        if (collapsed || !unavailable || !onRequestContent) {
            // A collapse or a fulfilled/error/message result makes a later
            // expansion eligible for a fresh request if the body is still
            // unavailable.
            if (collapsed || !unavailable) requestedContentRef.current = null;
            return;
        }

        if (requestedContentRef.current === item.path) return;
        requestedContentRef.current = item.path;
        try {
            // The parent owns loading/error state. Catch a rejected async
            // callback here so a transport failure cannot become an
            // unhandled promise rejection in the renderer.
            void Promise.resolve(onRequestContent(item.path)).catch(() => undefined);
        } catch {
            // A synchronous callback failure is likewise parent-owned.
        }
    }, [collapsed, item.path, item.source, item.image, item.error, item.message, onRequestContent]);

    // Building only happens for expanded sections FlashList decided to mount.
    const doc = useDiffDocument(collapsed || item.error != null || item.message != null || item.image ? null : item.source);
    const hasTextRows = doc.files.some((file) => file.rows.some((row) => row.kind === 'line'));

    return (
        <View
            style={{
                width: '100%',
                maxWidth: layout.maxWidth,
                alignSelf: 'center',
                borderBottomWidth: 1,
                borderBottomColor: palette.divider,
                backgroundColor: highlighted ? palette.hunkBg : undefined,
            }}
        >
            <DiffFileHeader file={item} collapsed={collapsed} onToggle={onToggle} />
            {collapsed ? (
                showSizeHint ? (
                    <Pressable onPress={onToggle} style={{ paddingVertical: 12, alignItems: 'center' }}>
                        <Text style={{ ...Typography.default(), fontSize: 13, color: palette.textSecondary }}>
                            {t('diff.tapToExpand', { count: item.additions + item.deletions })}
                        </Text>
                    </Pressable>
                ) : null
            ) : item.error != null ? (
                <Message text={item.error} />
            ) : item.message != null ? (
                <Message text={item.message} />
            ) : item.image ? (
                <DiffImageView before={item.image.before} after={item.image.after} />
            ) : !item.source ? (
                <View style={{ paddingVertical: 16, alignItems: 'center' }}>
                    <ActivityIndicator size="small" color={palette.textSecondary} />
                </View>
            ) : doc.error != null ? (
                <Message text={doc.error} />
            ) : doc.files.length === 0 || (item.source.kind === 'contents' && !hasTextRows) ? (
                <Message text={t('diff.noChanges')} />
            ) : (
                doc.files.map((file, i) => (
                    <DiffFileView
                        key={`${file.path}:${i}`}
                        file={file}
                        showLineNumbers={showLineNumbers}
                        wrap={wrap}
                        split={split}
                        fontSize={fontSize}
                        collapseAfter={600}
                        selectable={Platform.OS !== 'android'}
                        onExpandContext={onExpandContext ? () => onExpandContext(item.path) : undefined}
                    />
                ))
            )}
        </View>
    );
});

const Message = React.memo(function Message({ text }: { text: string }) {
    const palette = useDiffPalette();
    return (
        <View style={{ paddingVertical: 16, alignItems: 'center' }}>
            <Text style={{ ...Typography.default(), fontSize: 13, color: palette.textSecondary }}>{text}</Text>
        </View>
    );
});
