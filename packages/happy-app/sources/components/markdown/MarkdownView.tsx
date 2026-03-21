import { MarkdownSpan, OptionItem as OptionItemData, parseMarkdown } from './parseMarkdown';
import { resolveMarkdownLink } from './markdownLinkUtils';
import { Link } from 'expo-router';
import * as React from 'react';
import { Pressable, ScrollView, View, Platform, ActivityIndicator } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '../StyledText';
import { Typography } from '@/constants/Typography';
import { SimpleSyntaxHighlighter } from '../SimpleSyntaxHighlighter';
import { Modal } from '@/modal';
import { useLocalSetting } from '@/sync/storage';
import { storeTempText } from '@/sync/persistence';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { hapticsLight } from '@/components/haptics';
import { showCopiedToast } from '@/components/Toast';
import { MermaidRenderer } from './MermaidRenderer';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

// Option type for callback
export type Option = {
    title: string;
    recommended?: boolean;
    destructive?: boolean;
};

// Loading state for options - tracks which option is loading (by index)
export type OptionsLoadingState = {
    loadingIndex: number | null;
};

export const MarkdownView = React.memo((props: {
    markdown: string;
    onOptionPress?: (option: Option, allOptions: OptionItemData[]) => void;
    onOptionLongPress?: (option: Option, allOptions: OptionItemData[]) => void;
    optionsLoadingState?: OptionsLoadingState;
    sessionId?: string;
    sessionWorkingDirectory?: string | null;
    sessionHomeDirectory?: string | null;
    hideOptions?: boolean;
}) => {
    const blocks = React.useMemo(() => parseMarkdown(props.markdown), [props.markdown]);

    // Backwards compatibility: The original version just returned the view, wrapping the list of blocks.
    // It made each of the individual text elements selectable. When we enable the markdownCopyV2 feature,
    // we disable the selectable property on individual text segments on mobile only. Instead, the long press
    // will be handled by a wrapper Pressable. If we don't disable the selectable property, then you will see
    // the native copy modal come up at the same time as the long press handler is fired.
    const markdownCopyV2 = useLocalSetting('markdownCopyV2');
    const selectable = Platform.OS === 'web' || !markdownCopyV2;
    const router = useRouter();
    const linkContext = React.useMemo(() => ({
        sessionId: props.sessionId,
        sessionWorkingDirectory: props.sessionWorkingDirectory ?? null,
        sessionHomeDirectory: props.sessionHomeDirectory ?? null,
    }), [props.sessionId, props.sessionWorkingDirectory, props.sessionHomeDirectory]);

    const handleLongPress = React.useCallback(() => {
        try {
            const textId = storeTempText(props.markdown);
            router.push(`/text-selection?textId=${textId}`);
        } catch (error) {
            console.error('Error storing text for selection:', error);
            Modal.alert('Error', 'Failed to open text selection. Please try again.');
        }
    }, [props.markdown, router]);

    // Separate blocks into groups: options blocks need to be outside the parent GestureDetector
    // to prevent long press conflicts with the markdownCopyV2 feature
    const renderBlockContent = (block: typeof blocks[number], index: number) => {
        if (block.type === 'text') {
            return <RenderTextBlock spans={block.content} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} />;
        } else if (block.type === 'header') {
            return <RenderHeaderBlock level={block.level} spans={block.content} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} />;
        } else if (block.type === 'horizontal-rule') {
            return <View style={style.horizontalRule} key={index} />;
        } else if (block.type === 'list') {
            return <RenderListBlock items={block.items} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} />;
        } else if (block.type === 'numbered-list') {
            return <RenderNumberedListBlock items={block.items} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} />;
        } else if (block.type === 'code-block') {
            return <RenderCodeBlock content={block.content} language={block.language} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} />;
        } else if (block.type === 'mermaid') {
            return <MermaidRenderer content={block.content} key={index} />;
        } else if (block.type === 'options') {
            if (props.hideOptions) return null;
            return <RenderOptionsBlock items={block.items} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} onOptionPress={props.onOptionPress} onOptionLongPress={props.onOptionLongPress} optionsLoadingState={props.optionsLoadingState} />;
        } else if (block.type === 'table') {
            return <RenderTableBlock headers={block.headers} rows={block.rows} key={index} first={index === 0} last={index === blocks.length - 1} />;
        } else {
            return null;
        }
    };

    const renderContent = () => {
        return (
            <View style={{ width: '100%' }}>
                {blocks.map((block, index) => renderBlockContent(block, index))}
            </View>
        );
    };

    // For web or when markdownCopyV2 is disabled, render everything normally
    if (!markdownCopyV2 || Platform.OS === 'web') {
        return (
            <MarkdownLinkContext.Provider value={linkContext}>
                {renderContent()}
            </MarkdownLinkContext.Provider>
        );
    }

    // For mobile with markdownCopyV2 enabled, we need to render options blocks OUTSIDE
    // the parent GestureDetector to prevent long press conflicts
    const longPressGesture = Gesture.LongPress()
        .minDuration(500)
        .onStart(() => {
            handleLongPress();
        })
        .runOnJS(true);

    // Group consecutive non-options blocks together, render options separately
    const elements: React.ReactNode[] = [];
    let currentNonOptionsGroup: { block: typeof blocks[number], index: number }[] = [];

    const flushNonOptionsGroup = () => {
        if (currentNonOptionsGroup.length > 0) {
            const groupKey = `group-${currentNonOptionsGroup[0].index}`;
            elements.push(
                <GestureDetector gesture={longPressGesture} key={groupKey}>
                    <View style={{ width: '100%' }}>
                        {currentNonOptionsGroup.map(({ block, index }) => renderBlockContent(block, index))}
                    </View>
                </GestureDetector>
            );
            currentNonOptionsGroup = [];
        }
    };

    blocks.forEach((block, index) => {
        if (block.type === 'options') {
            if (props.hideOptions) return;
            // Flush any accumulated non-options blocks first
            flushNonOptionsGroup();
            // Render options block directly without parent GestureDetector
            elements.push(renderBlockContent(block, index));
        } else {
            // Accumulate non-options blocks
            currentNonOptionsGroup.push({ block, index });
        }
    });

    // Flush remaining non-options blocks
    flushNonOptionsGroup();

    return (
        <MarkdownLinkContext.Provider value={linkContext}>
            <View style={{ width: '100%' }}>
                {elements}
            </View>
        </MarkdownLinkContext.Provider>
    );
});

const MarkdownLinkContext = React.createContext<{
    sessionId?: string;
    sessionWorkingDirectory?: string | null;
    sessionHomeDirectory?: string | null;
}>({});

function RenderTextBlock(props: { spans: MarkdownSpan[], first: boolean, last: boolean, selectable: boolean }) {
    return <Text selectable={props.selectable} style={[style.text, props.first && style.first, props.last && style.last]}><RenderSpans spans={props.spans} baseStyle={style.text} /></Text>;
}

function RenderHeaderBlock(props: { level: 1 | 2 | 3 | 4 | 5 | 6, spans: MarkdownSpan[], first: boolean, last: boolean, selectable: boolean }) {
    const s = (style as any)[`header${props.level}`];
    const headerStyle = [style.header, s, props.first && style.first, props.last && style.last];
    return <Text selectable={props.selectable} style={headerStyle}><RenderSpans spans={props.spans} baseStyle={headerStyle} isHeader={true} /></Text>;
}

function RenderListBlock(props: { items: MarkdownSpan[][], first: boolean, last: boolean, selectable: boolean }) {
    const listStyle = [style.text, style.list];
    return (
        <View style={{ flexDirection: 'column', marginBottom: 8, gap: 1 }}>
            {props.items.map((item, index) => (
                <Text selectable={props.selectable} style={listStyle} key={index}>- <RenderSpans spans={item} baseStyle={listStyle} /></Text>
            ))}
        </View>
    );
}

function RenderNumberedListBlock(props: { items: { number: number, spans: MarkdownSpan[] }[], first: boolean, last: boolean, selectable: boolean }) {
    const listStyle = [style.text, style.list];
    return (
        <View style={{ flexDirection: 'column', marginBottom: 8, gap: 1 }}>
            {props.items.map((item, index) => (
                <Text selectable={props.selectable} style={listStyle} key={index}>{item.number.toString()}. <RenderSpans spans={item.spans} baseStyle={listStyle} /></Text>
            ))}
        </View>
    );
}

function RenderCodeBlock(props: { content: string, language: string | null, first: boolean, last: boolean, selectable: boolean }) {
    const [isHovered, setIsHovered] = React.useState(false);
    const { scrollViewProps, wheelProps } = useWebHorizontalScroll();

    const copyCode = React.useCallback(async () => {
        try {
            await Clipboard.setStringAsync(props.content);
            hapticsLight(); showCopiedToast();
        } catch (error) {
            console.error('Failed to copy code:', error);
            Modal.alert(t('common.error'), t('markdown.copyFailed'), [{ text: t('common.ok'), style: 'cancel' }]);
        }
    }, [props.content]);

    return (
        <View
            style={[style.codeBlock, props.first && style.first, props.last && style.last]}
            // @ts-ignore - Web only events
            onMouseEnter={() => setIsHovered(true)}
            // @ts-ignore - Web only events
            onMouseLeave={() => setIsHovered(false)}
            {...wheelProps}
        >
            {props.language && <Text selectable={props.selectable} style={style.codeLanguage}>{props.language}</Text>}
            <ScrollView
                {...scrollViewProps}
                style={{ flexGrow: 0, flexShrink: 0 }}
                horizontal={true}
                contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 16 }}
                showsHorizontalScrollIndicator={false}
            >
                <SimpleSyntaxHighlighter
                    code={props.content}
                    language={props.language}
                    selectable={props.selectable}
                />
            </ScrollView>
            <View
                style={[style.copyButtonWrapper, isHovered && style.copyButtonWrapperVisible]}
                {...(Platform.OS === 'web' ? ({ className: 'copy-button-wrapper' } as any) : {})}
            >
                <Pressable
                    style={style.copyButton}
                    onPress={copyCode}
                >
                    <Text style={style.copyButtonText}>{t('common.copy')}</Text>
                </Pressable>
            </View>
        </View>
    );
}

// Individual option item component to use hooks properly
const OptionItem = React.memo((props: {
    item: OptionItemData,
    index: number,
    isThisLoading: boolean,
    isDisabled: boolean,
    onPress: () => void,
    onLongPress: () => void,
}) => {
    const { theme } = useUnistyles();
    // Use GestureDetector to handle long press, which takes priority over parent GestureDetector
    const longPressGesture = Gesture.LongPress()
        .minDuration(500)
        .onStart(() => {
            if (!props.isDisabled) {
                props.onLongPress();
            }
        })
        .runOnJS(true);

    const tapGesture = Gesture.Tap()
        .onEnd(() => {
            if (!props.isDisabled) {
                props.onPress();
            }
        })
        .runOnJS(true);

    // Race between tap and long press - first one to complete wins
    const composedGesture = Gesture.Race(tapGesture, longPressGesture);

    return (
        <GestureDetector gesture={composedGesture}>
            <View
                style={[
                    style.optionItem,
                    props.isDisabled && style.optionItemDisabled,
                ]}
            >
                <Text
                    selectable={false}
                    style={[
                        style.optionText,
                        props.item.destructive && style.optionTextDestructive,
                        props.isDisabled && style.optionTextDisabled,
                    ]}
                >
                    {props.item.title}
                </Text>
                {props.item.recommended && (
                    <View style={[
                            style.optionRecommendedBadge,
                            { opacity: theme.dark ? 0.8 : 0.2 },
                        ]}
                    >
                        <Text style={style.optionRecommendedBadgeText}>{t('message.optionRecommended')}</Text>
                    </View>
                )}
                {props.isThisLoading && (
                    <View style={style.optionLoadingOverlay}>
                        <ActivityIndicator size="small" />
                    </View>
                )}
            </View>
        </GestureDetector>
    );
});

function RenderOptionsBlock(props: {
    items: OptionItemData[],
    first: boolean,
    last: boolean,
    selectable: boolean,
    onOptionPress?: (option: Option, allOptions: OptionItemData[]) => void,
    onOptionLongPress?: (option: Option, allOptions: OptionItemData[]) => void,
    optionsLoadingState?: OptionsLoadingState
}) {
    const isLoading = props.optionsLoadingState?.loadingIndex !== null && props.optionsLoadingState?.loadingIndex !== undefined;

    const handleLongPress = React.useCallback((item: OptionItemData) => {
        // Only trigger long press on mobile
        if (Platform.OS !== 'web') {
            // Haptic feedback
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            props.onOptionLongPress?.(item, props.items);
        }
    }, [props.onOptionLongPress, props.items]);

    return (
        <View style={[style.optionsContainer, props.first && style.first, props.last && style.last]}>
            <View style={style.optionsInner}>
                {props.items.map((item, index) => {
                    const isThisLoading = props.optionsLoadingState?.loadingIndex === index;
                    const isDisabled = isLoading && !isThisLoading;

                    if (props.onOptionPress) {
                        return (
                            <OptionItem
                                key={index}
                                item={item}
                                index={index}
                                isThisLoading={isThisLoading}
                                isDisabled={isDisabled}
                                onPress={() => props.onOptionPress?.(item, props.items)}
                                onLongPress={() => handleLongPress(item)}
                            />
                        );
                    } else {
                        return (
                            <View key={index} style={style.optionItem}>
                                <Text selectable={props.selectable} style={[
                                    style.optionText,
                                    item.destructive && style.optionTextDestructive,
                                ]}>{item.title}</Text>
                            </View>
                        );
                    }
                })}
            </View>
        </View>
    );
}

function RenderSpans(props: { spans: MarkdownSpan[], baseStyle?: any, isHeader?: boolean, disableCodeLineHeight?: boolean }) {
    const linkContext = React.useContext(MarkdownLinkContext);
    return (<>
        {props.spans.map((span, index) => {
            const spanStyles = span.styles.map((s) => {
                if ((props.isHeader || props.disableCodeLineHeight) && s === 'code') {
                    return style.codeHeader;
                }
                return (style as any)[s];
            });
            if (span.url) {
                const link = resolveMarkdownLink({
                    rawUrl: span.url,
                    sessionId: linkContext.sessionId,
                    sessionWorkingDirectory: linkContext.sessionWorkingDirectory,
                    sessionHomeDirectory: linkContext.sessionHomeDirectory,
                });
                return (
                    <Link
                        key={index}
                        href={link.href as any}
                        target={link.target}
                        style={[style.link, spanStyles]}
                    >
                        {span.text}
                    </Link>
                );
            } else {
                return <Text key={index} selectable style={[props.baseStyle, spanStyles]}>{span.text}</Text>
            }
        })}
    </>)
}

// Hook: Web mouse wheel → horizontal scroll for ScrollView
function useWebHorizontalScroll() {
    const scrollRef = React.useRef<ScrollView>(null);
    const scrollOffsetRef = React.useRef(0);
    const contentWidthRef = React.useRef(0);
    const containerWidthRef = React.useRef(0);
    const handleWheel = React.useCallback((e: any) => {
        if (Platform.OS !== 'web' || !scrollRef.current) return;
        const deltaX = Number(e.deltaX || 0);
        const deltaY = Number(e.deltaY || 0);
        const hasHorizontalIntent = Math.abs(deltaX) > Math.abs(deltaY) || !!e.shiftKey;
        if (!hasHorizontalIntent) return;

        const delta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
        if (delta === 0) return;
        const maxScroll = Math.max(0, contentWidthRef.current - containerWidthRef.current);
        if (maxScroll <= 0) return;
        const next = Math.min(maxScroll, Math.max(0, scrollOffsetRef.current + delta));
        if (next === scrollOffsetRef.current) return;
        e.preventDefault();
        scrollOffsetRef.current = next;
        (scrollRef.current as any).scrollTo({ x: next, animated: false });
    }, []);
    const scrollViewProps = {
        ref: scrollRef,
        onScroll: (e: any) => { scrollOffsetRef.current = e.nativeEvent.contentOffset.x; },
        scrollEventThrottle: 16,
        onContentSizeChange: (w: number) => { contentWidthRef.current = w; },
        onLayout: (e: any) => { containerWidthRef.current = e.nativeEvent.layout.width; },
    };
    const wheelProps = Platform.OS === 'web' ? { onWheel: handleWheel } as any : {};
    return { scrollViewProps, wheelProps };
}

// Table rendering: column-first layout for natural column widths, with synchronized row heights.
// First pass measures each row's max height across columns, second render applies uniform heights.
function RenderTableBlock(props: {
    headers: MarkdownSpan[][],
    rows: MarkdownSpan[][][],
    first: boolean,
    last: boolean,
}) {
    const columnCount = props.headers.length;
    const rowCount = props.rows.length;
    const totalRows = 1 + rowCount; // header + data rows

    // Track measured heights: rowHeights[rowIndex] = max height across all columns
    const [rowHeights, setRowHeights] = React.useState<(number | undefined)[]>(() => new Array(totalRows).fill(undefined));
    const measuredRef = React.useRef<number[][]>(
        Array.from({ length: totalRows }, () => new Array(columnCount).fill(0))
    );
    const rowLockedRef = React.useRef<boolean[]>(new Array(totalRows).fill(false));
    const containerWidthRef = React.useRef(0);

    const resetMeasurements = React.useCallback(() => {
        const arr: number[][] = [];
        for (let i = 0; i < totalRows; i++) arr.push(new Array(columnCount).fill(0));
        measuredRef.current = arr;
        rowLockedRef.current = new Array(totalRows).fill(false);
        setRowHeights(new Array(totalRows).fill(undefined));
    }, [totalRows, columnCount]);

    // Reset measurement state whenever table shape changes
    React.useEffect(() => {
        resetMeasurements();
    }, [resetMeasurements]);

    const handleContainerLayout = React.useCallback((e: any) => {
        const width = Math.round(e.nativeEvent.layout.width || 0);
        if (width <= 0) {
            containerWidthRef.current = 0;
            return;
        }

        // A width change indicates a new layout pass context; re-measure from scratch.
        if (containerWidthRef.current !== width) {
            containerWidthRef.current = width;
            resetMeasurements();
        }
    }, [resetMeasurements]);

    const handleCellLayout = React.useCallback((rowIndex: number, colIndex: number, height: number) => {
        if (containerWidthRef.current <= 0) return;
        if (rowLockedRef.current[rowIndex]) return;
        const normalizedHeight = Math.ceil(height);
        if (normalizedHeight <= 1) return;

        const grid = measuredRef.current;
        if (!grid[rowIndex]) return;
        grid[rowIndex][colIndex] = normalizedHeight;

        // Lock row height after we have one valid measurement from every column.
        if (!grid[rowIndex].every((h) => h > 0)) return;
        const maxH = Math.max(...grid[rowIndex]);
        rowLockedRef.current[rowIndex] = true;
        setRowHeights(old => {
            if (old[rowIndex] === maxH) return old;
            const next = [...old];
            next[rowIndex] = maxH;
            return next;
        });
    }, []);

    const isLastRow = (rowIndex: number) => rowIndex === rowCount - 1;
    const { scrollViewProps, wheelProps } = useWebHorizontalScroll();

    return (
        <View
            style={[style.tableContainer, props.first && style.first, props.last && style.last]}
            onLayout={handleContainerLayout}
            {...wheelProps}
        >
            <ScrollView
                {...scrollViewProps}
                horizontal
                showsHorizontalScrollIndicator={Platform.OS !== 'web'}
                nestedScrollEnabled={true}
                style={style.tableScrollView}
            >
                <View style={style.tableContent}>
                    {props.headers.map((headerSpans, colIndex) => (
                        <View
                            key={`column-${colIndex}`}
                            style={[
                                style.tableColumn,
                                colIndex < columnCount - 1 && style.tableCellRightBorder
                            ]}
                        >
                            {/* Header cell */}
                            <View
                                style={[
                                    style.tableCell,
                                    style.tableHeaderCell,
                                    rowHeights[0] != null ? { height: rowHeights[0] } : undefined,
                                ]}
                                onLayout={(e) => handleCellLayout(0, colIndex, e.nativeEvent.layout.height)}
                            >
                                <Text style={style.tableHeaderText}>
                                    <RenderSpans spans={headerSpans} baseStyle={style.tableHeaderText} disableCodeLineHeight={true} />
                                </Text>
                            </View>
                            {/* Data cells */}
                            {props.rows.map((row, rowIndex) => (
                                <View
                                    key={`cell-${rowIndex}-${colIndex}`}
                                    style={[
                                        style.tableCell,
                                        isLastRow(rowIndex) && style.tableCellLast,
                                        rowHeights[rowIndex + 1] != null ? { height: rowHeights[rowIndex + 1] } : undefined,
                                    ]}
                                    onLayout={(e) => handleCellLayout(rowIndex + 1, colIndex, e.nativeEvent.layout.height)}
                                >
                                    <Text style={style.tableCellText}>
                                        <RenderSpans spans={row[colIndex] ?? []} baseStyle={style.tableCellText} disableCodeLineHeight={true} />
                                    </Text>
                                </View>
                            ))}
                        </View>
                    ))}
                </View>
            </ScrollView>
        </View>
    );
}


const style = StyleSheet.create((theme) => ({

    // Plain text

    text: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 24, // Reduced from 28 to 24
        marginTop: 8,
        marginBottom: 8,
        color: theme.colors.text,
        fontWeight: '400',
    },

    italic: {
        fontStyle: 'italic',
    },
    bold: {
        fontWeight: 'bold',
    },
    semibold: {
        fontWeight: '600',
    },
    code: {
        ...Typography.mono(),
        fontSize: 16,
        lineHeight: 21,  // Reduced from 24 to 21
        backgroundColor: theme.colors.surfaceHighest,
        color: theme.colors.text,
    },
    codeHeader: {
        ...Typography.mono(),
        fontSize: 16,
        backgroundColor: theme.colors.surfaceHighest,
        color: theme.colors.text,
    },
    link: {
        ...Typography.default(),
        color: theme.colors.textLink,
        fontWeight: '400',
    },

    // Headers

    header: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    header1: {
        fontSize: 16,
        lineHeight: 24,  // Reduced from 36 to 24
        fontWeight: '900',
        marginTop: 16,
        marginBottom: 8
    },
    header2: {
        fontSize: 20,
        lineHeight: 24,  // Reduced from 36 to 32
        fontWeight: '600',
        marginTop: 16,
        marginBottom: 8
    },
    header3: {
        fontSize: 16,
        lineHeight: 28,  // Reduced from 32 to 28
        fontWeight: '600',
        marginTop: 16,
        marginBottom: 8,
    },
    header4: {
        fontSize: 16,
        lineHeight: 24,
        fontWeight: '600',
        marginTop: 8,
        marginBottom: 8,
    },
    header5: {
        fontSize: 16,
        lineHeight: 24,  // Reduced from 28 to 24
        fontWeight: '600'
    },
    header6: {
        fontSize: 16,
        lineHeight: 24, // Reduced from 28 to 24
        fontWeight: '600'
    },

    //
    // List
    //

    list: {
        ...Typography.default(),
        color: theme.colors.text,
        marginTop: 0,
        marginBottom: 0,
    },

    //
    // Common
    //

    first: {
        // marginTop: 0
    },
    last: {
        // marginBottom: 0
    },

    //
    // Code Block
    //

    codeBlock: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
        marginVertical: 8,
        position: 'relative',
        zIndex: 1,
        maxWidth: '100%',
    },
    copyButtonWrapper: {
        position: 'absolute',
        top: 8,
        right: 8,
        opacity: 0,
        zIndex: 10,
        elevation: 10,
        pointerEvents: 'none',
    },
    copyButtonWrapperVisible: {
        opacity: 1,
        pointerEvents: 'auto',
    },
    codeLanguage: {
        ...Typography.mono(),
        color: theme.colors.textSecondary,
        fontSize: 12,
        marginTop: 8,
        paddingHorizontal: 16,
        marginBottom: 0,
    },
    codeText: {
        ...Typography.mono(),
        color: theme.colors.text,
        fontSize: 14,
        lineHeight: 20,
    },
    horizontalRule: {
        height: 1,
        backgroundColor: theme.colors.divider,
        marginTop: 8,
        marginBottom: 8,
    },
    copyButtonContainer: {
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 10,
        elevation: 10,
        opacity: 1,
    },
    copyButtonContainerHidden: {
        opacity: 0,
    },
    copyButton: {
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        cursor: 'pointer',
    },
    copyButtonHidden: {
        display: 'none',
    },
    copyButtonCopied: {
        backgroundColor: theme.colors.success,
        borderColor: theme.colors.success,
        opacity: 1,
    },
    copyButtonText: {
        ...Typography.default(),
        color: theme.colors.text,
        fontSize: 12,
        lineHeight: 16,
    },

    //
    // Options Block
    //

    optionsContainer: {
        marginVertical: 8,
    },
    optionsInner: {
        flexDirection: 'column',
        gap: 8,
        alignSelf: 'flex-start',
        maxWidth: '100%',
    },
    optionItem: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        flexDirection: 'row',
        alignItems: 'flex-start',
    },
    optionItemDisabled: {
        opacity: 0.5,
    },
    optionText: {
        ...Typography.default(),
        flexShrink: 1,
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.text,
    },
    optionTextDestructive: {
        color: theme.colors.textDestructive,
    },
    optionTextDisabled: {
        opacity: 0.6,
    },
    optionRecommendedBadge: {
        opacity: 0.8,
        backgroundColor: '#3A4A5C',
        borderRadius: 6,
        paddingHorizontal: 6,
        paddingVertical: 2,
        marginTop: 1,
        marginLeft: 12,
    },
    optionRecommendedBadgeText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        lineHeight: 18,
        color: '#fff',
    },
    optionLoadingOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: theme.colors.surfaceHighest,
        opacity: 0.8,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },

    //
    // Table
    //

    tableContainer: {
        marginVertical: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 8,
        overflow: 'hidden',
        alignSelf: 'flex-start',
        maxWidth: '100%',
    },
    tableScrollView: {
        flexGrow: 0,
    },
    tableContent: {
        flexDirection: 'row',
    },
    tableColumn: {
        flexDirection: 'column',
    },
    tableCell: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
        alignItems: 'flex-start',
        justifyContent: 'center',
    },
    tableCellRightBorder: {
        borderRightWidth: 1,
        borderRightColor: theme.colors.divider,
    },
    tableCellLast: {
        borderBottomWidth: 0,
    },
    tableHeaderCell: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    tableHeaderText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 24,
    },
    tableCellText: {
        ...Typography.default(),
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 24,
    },

    // Add global style for Web platform (Unistyles supports this via compiler plugin)
    ...(Platform.OS === 'web' ? {
        // Web-only CSS styles
        _____web_global_styles: {}
    } : {}),
}));
