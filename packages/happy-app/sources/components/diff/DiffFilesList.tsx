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
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { layout } from '@/components/layout';
import { DiffFileHeader, type DiffFileSummary } from './DiffFileHeader';
import { DiffFileView } from './DiffFileView';
import { useDiffPalette } from './DiffPalette';
import { useDiffDocument, type DiffSource } from './useDiffDocument';
import { DiffImageView } from './DiffImageView';

export interface DiffFileItem extends DiffFileSummary {
    /** Stable identity; defaults to `path` when omitted. */
    key?: string;
    /** Null while the patch is still being fetched. */
    source: DiffSource | null;
    /** Set instead of `source` for files that are pictures rather than text. */
    image?: { before: string | null; after: string | null };
    error?: string | null;
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
}: DiffFilesListProps) {
    const palette = useDiffPalette();
    const listRef = React.useRef<FlashListRef<DiffFileItem>>(null);
    const [overrides, setOverrides] = React.useState<Record<string, boolean>>({});

    const toggle = React.useCallback((path: string, current: boolean) => {
        setOverrides((prev) => ({ ...prev, [path]: !current }));
    }, []);

    React.useEffect(() => {
        if (!scrollToPath) return;
        const index = items.findIndex((f) => f.path === scrollToPath);
        if (index < 0) return;
        const id = requestAnimationFrame(() => {
            listRef.current?.scrollToIndex({ index, animated: true });
        });
        return () => cancelAnimationFrame(id);
    }, [scrollToPath, items]);

    const renderItem = React.useCallback(({ item }: { item: DiffFileItem }) => {
        const tooBig = item.additions + item.deletions > autoCollapseAbove;
        const collapsed = overrides[item.path] ?? (defaultCollapsed || tooBig);
        return (
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
            />
        );
    }, [overrides, autoCollapseAbove, defaultCollapsed, toggle, showLineNumbers, wrap, split, fontSize, scrollToPath, onExpandContext]);

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
}) {
    const palette = useDiffPalette();
    // Building only happens for expanded sections FlashList decided to mount.
    const doc = useDiffDocument(collapsed ? null : item.source);

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
            ) : item.error ? (
                <Message text={item.error} />
            ) : item.image ? (
                <DiffImageView before={item.image.before} after={item.image.after} />
            ) : !item.source ? (
                <View style={{ paddingVertical: 16, alignItems: 'center' }}>
                    <ActivityIndicator size="small" color={palette.textSecondary} />
                </View>
            ) : doc.files.length === 0 ? (
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
