import { MarkdownSpan, parseMarkdown } from './parseMarkdown';
import * as React from 'react';
import { Image, Pressable, View, Platform, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { HorizontalScrollView } from '../HorizontalScrollView';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '../StyledText';
import { Typography } from '@/constants/Typography';
import { SimpleSyntaxHighlighter } from '../SimpleSyntaxHighlighter';
import { Modal } from '@/modal';
import { useLocalSetting } from '@/sync/storage';
import { storeTempText } from '@/sync/persistence';
import { imageViewer } from '@/sync/imageViewer';
import { OtaPreviewCard } from '@/components/OtaPreviewCard';
import { FinanceChartCard } from '@/components/FinanceChartCard';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { MermaidRenderer } from './MermaidRenderer';
import { t } from '@/text';
import { isHttpMarkdownLink } from './linkUtils';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { hapticsLight } from '../haptics';
import {
    MAX_IMAGE_STYLE_OPTION_COUNT,
    buildImageStyleContinuationPrompt,
    parseImageStyleOptions,
    type ParsedImageStyleOption,
} from '@/components/agents/imageStyleOptions';
import { MAX_IMAGE_AGENT_VARIANTS_PER_STYLE } from '@/components/agents/imageAgentPrompt';

// Option type for callback
export type Option = {
    title: string;
};

export type MarkdownViewVariant = 'default' | 'foldedPrompt';

export const MarkdownView = React.memo((props: { 
    markdown: string;
    onOptionPress?: (option: Option) => void;
    sessionId?: string;
    variant?: MarkdownViewVariant;
}) => {
    const blocks = React.useMemo(() => parseMarkdown(props.markdown), [props.markdown]);
    const variant = props.variant ?? 'default';
    
    // Backwards compatibility: The original version just returned the view, wrapping the list of blocks.
    // It made each of the individual text elements selectable. When we enable the markdownCopyV2 feature,
    // we disable the selectable property on individual text segments on mobile only. Instead, the long press
    // will be handled by a wrapper Pressable. If we don't disable the selectable property, then you will see
    // the native copy modal come up at the same time as the long press handler is fired.
    const markdownCopyV2 = useLocalSetting('markdownCopyV2');
    const selectable = Platform.OS === 'web' || !markdownCopyV2;
    const router = useRouter();

    const handleLinkPress = React.useCallback((url: string) => {
        if (!isHttpMarkdownLink(url)) {
            return;
        }

        void openExternalUrl(url);
    }, []);

    const handleLongPress = React.useCallback(() => {
        try {
            const textId = storeTempText(props.markdown);
            router.push(`/text-selection?textId=${textId}`);
        } catch (error) {
            console.error('Error storing text for selection:', error);
            Modal.alert('Error', 'Failed to open text selection. Please try again.');
        }
    }, [props.markdown, router]);
    const renderContent = () => {
        return (
            <View style={{ width: '100%' }}>
                {blocks.map((block, index) => {
                    if (block.type === 'text') {
                        return <RenderTextBlock spans={block.content} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} onLinkPress={handleLinkPress} variant={variant} />;
                    } else if (block.type === 'header') {
                        return <RenderHeaderBlock level={block.level} spans={block.content} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} onLinkPress={handleLinkPress} variant={variant} />;
                    } else if (block.type === 'horizontal-rule') {
                        return <View style={style.horizontalRule} key={index} />;
                    } else if (block.type === 'list') {
                        return <RenderListBlock items={block.items} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} onLinkPress={handleLinkPress} variant={variant} />;
                    } else if (block.type === 'numbered-list') {
                        return <RenderNumberedListBlock items={block.items} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} onLinkPress={handleLinkPress} variant={variant} />;
                    } else if (block.type === 'code-block') {
                        return <RenderCodeBlock content={block.content} language={block.language} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} variant={variant} />;
                    } else if (block.type === 'mermaid') {
                        return <MermaidRenderer content={block.content} key={index} />;
                    } else if (block.type === 'options') {
                        return <RenderOptionsBlock items={block.items} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} onOptionPress={props.onOptionPress} variant={variant} />;
                    } else if (block.type === 'table') {
                        return <RenderTableBlock headers={block.headers} rows={block.rows} onLinkPress={handleLinkPress} selectable={selectable} key={index} first={index === 0} last={index === blocks.length - 1} variant={variant} />;
                    } else if (block.type === 'image') {
                        return <RenderImageBlock url={block.url} alt={block.alt} key={index} first={index === 0} last={index === blocks.length - 1} />;
                    } else if (block.type === 'ota-preview') {
                        return <RenderOtaPreviewBlock preview={block.preview} key={index} first={index === 0} last={index === blocks.length - 1} />;
                    } else if (block.type === 'finance-chart') {
                        return <RenderFinanceChartBlock chart={block.chart} key={index} first={index === 0} last={index === blocks.length - 1} />;
                    } else {
                        return null;
                    }
                })}
            </View>
        );
    }

    if (!markdownCopyV2) {
        return renderContent();
    }
    
    if (Platform.OS === 'web') {
        return renderContent();
    }
    
    // Use GestureDetector with LongPress gesture - it doesn't block pan gestures
    // so horizontal scrolling in code blocks and tables still works
    const longPressGesture = Gesture.LongPress()
        .minDuration(500)
        .onStart(() => {
            hapticsLight();
            handleLongPress();
        })
        .runOnJS(true);

    return (
        <GestureDetector gesture={longPressGesture}>
            <View style={{ width: '100%' }}>
                {renderContent()}
            </View>
        </GestureDetector>
    );
});

type RenderSpanProps = {
    spans: MarkdownSpan[];
    baseStyle?: any;
    selectable: boolean;
    onLinkPress: (url: string) => void;
    variant?: MarkdownViewVariant;
};

function RenderTextBlock(props: { spans: MarkdownSpan[], first: boolean, last: boolean, selectable: boolean, onLinkPress: (url: string) => void, variant: MarkdownViewVariant }) {
    const textStyle = getTextStyle(props.variant);
    return <Text selectable={props.selectable} style={[textStyle, props.first && style.first, props.last && style.last]}><RenderSpans spans={props.spans} baseStyle={textStyle} selectable={props.selectable} onLinkPress={props.onLinkPress} variant={props.variant} /></Text>;
}

function RenderHeaderBlock(props: { level: 1 | 2 | 3 | 4 | 5 | 6, spans: MarkdownSpan[], first: boolean, last: boolean, selectable: boolean, onLinkPress: (url: string) => void, variant: MarkdownViewVariant }) {
    const s = (style as any)[`header${props.level}`];
    const headerStyle = props.variant === 'foldedPrompt'
        ? [style.foldedHeader, props.first && style.first, props.last && style.last]
        : [style.header, s, props.first && style.first, props.last && style.last];
    return <Text selectable={props.selectable} style={headerStyle}><RenderSpans spans={props.spans} baseStyle={headerStyle} selectable={props.selectable} onLinkPress={props.onLinkPress} variant={props.variant} /></Text>;
}

const BULLETS = ['•', '◦', '▪'] as const;

function RenderListBlock(props: { items: { depth: number, spans: MarkdownSpan[] }[], first: boolean, last: boolean, selectable: boolean, onLinkPress: (url: string) => void, variant: MarkdownViewVariant }) {
    const listStyle = [getTextStyle(props.variant), style.list, props.variant === 'foldedPrompt' && style.foldedList];
    return (
        <View style={{ flexDirection: 'column', marginBottom: 8, gap: 6 }}>
            {props.items.map((item, index) => (
                <View key={index} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingLeft: item.depth * 16 }}>
                    <Text selectable={false} style={[listStyle, { marginRight: 8, marginTop: 1 }]}>{BULLETS[Math.min(item.depth, BULLETS.length - 1)]}</Text>
                    <Text selectable={props.selectable} style={[listStyle, { flex: 1 }]}><RenderSpans spans={item.spans} baseStyle={listStyle} selectable={props.selectable} onLinkPress={props.onLinkPress} variant={props.variant} /></Text>
                </View>
            ))}
        </View>
    );
}

function RenderNumberedListBlock(props: { items: { number: number, depth: number, spans: MarkdownSpan[] }[], first: boolean, last: boolean, selectable: boolean, onLinkPress: (url: string) => void, variant: MarkdownViewVariant }) {
    const listStyle = [getTextStyle(props.variant), style.list, props.variant === 'foldedPrompt' && style.foldedList];
    return (
        <View style={{ flexDirection: 'column', marginBottom: 8, gap: 6 }}>
            {props.items.map((item, index) => (
                <View key={index} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingLeft: item.depth * 16 }}>
                    <Text selectable={false} style={[listStyle, { marginRight: 8, marginTop: 1 }]}>{item.number}.</Text>
                    <Text selectable={props.selectable} style={[listStyle, { flex: 1 }]}><RenderSpans spans={item.spans} baseStyle={listStyle} selectable={props.selectable} onLinkPress={props.onLinkPress} variant={props.variant} /></Text>
                </View>
            ))}
        </View>
    );
}

function RenderCodeBlock(props: { content: string, language: string | null, first: boolean, last: boolean, selectable: boolean, variant: MarkdownViewVariant }) {
    const { theme } = useUnistyles();
    const [isHovered, setIsHovered] = React.useState(false);
    const foldedPrompt = props.variant === 'foldedPrompt';

    const copyCode = React.useCallback(async () => {
        try {
            await Clipboard.setStringAsync(props.content);
            Modal.alert(t('common.success'), t('markdown.codeCopied'), [{ text: t('common.ok'), style: 'cancel' }]);
        } catch (error) {
            console.error('Failed to copy code:', error);
            Modal.alert(t('common.error'), t('markdown.copyFailed'), [{ text: t('common.ok'), style: 'cancel' }]);
        }
    }, [props.content]);

    return (
        <View
            style={[style.codeBlock, foldedPrompt && style.foldedCodeBlock, props.first && style.first, props.last && style.last]}
            // @ts-ignore - Web only events
            onMouseEnter={() => setIsHovered(true)}
            // @ts-ignore - Web only events
            onMouseLeave={() => setIsHovered(false)}
        >
            {props.language && <Text selectable={props.selectable} style={style.codeLanguage}>{props.language}</Text>}
            <HorizontalScrollView
                contentContainerStyle={foldedPrompt ? style.foldedCodeContent : style.codeContent}
                testID="markdown-code-scroll"
            >
                <SimpleSyntaxHighlighter
                    code={props.content}
                    language={props.language}
                    selectable={props.selectable}
                    textStyle={foldedPrompt ? style.foldedCodeText : undefined}
                    monochromeColor={foldedPrompt ? theme.colors.textSecondary : undefined}
                />
            </HorizontalScrollView>
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

function RenderImageBlock(props: { url: string, alt: string, first: boolean, last: boolean }) {
    const accessibleLabel = props.alt || 'Markdown image';

    return (
        <View style={[style.imageBlock, props.first && style.first, props.last && style.last]}>
            {/* Tap to open the fullscreen zoomable viewer. */}
            <Pressable
                onPress={() => imageViewer.open({ uri: props.url })}
                accessibilityRole="button"
                accessibilityLabel={accessibleLabel}
            >
                <Image
                    source={{ uri: props.url }}
                    style={style.image}
                    accessibilityLabel={accessibleLabel}
                    resizeMode="contain"
                />
            </Pressable>
            {props.alt ? (
                <Text style={style.imageCaption}>{props.alt}</Text>
            ) : null}
        </View>
    );
}

function RenderOtaPreviewBlock(props: { preview: import('@/utils/sessionOtaPreviews').SessionOtaPreview, first: boolean, last: boolean }) {
    return (
        <View style={[style.otaPreviewBlock, props.first && style.first, props.last && style.last]}>
            <OtaPreviewCard preview={props.preview} variant="message" />
        </View>
    );
}

function RenderFinanceChartBlock(props: { chart: import('@/utils/sessionFinanceCharts').SessionFinanceChart, first: boolean, last: boolean }) {
    return (
        <View style={[style.otaPreviewBlock, props.first && style.first, props.last && style.last]}>
            <FinanceChartCard chart={props.chart} />
        </View>
    );
}

function RenderOptionsBlock(props: {
    items: string[],
    first: boolean,
    last: boolean,
    selectable: boolean,
    onOptionPress?: (option: Option) => void,
    variant: MarkdownViewVariant,
}) {
    const { theme } = useUnistyles();
    const imageStyleOptions = React.useMemo(() => parseImageStyleOptions(props.items), [props.items]);

    if (props.onOptionPress && imageStyleOptions.length > 0) {
        return (
            <RenderImageStyleOptionsBlock
                items={imageStyleOptions}
                first={props.first}
                last={props.last}
                onOptionPress={props.onOptionPress}
                variant={props.variant}
            />
        );
    }

    // When none of the preset options fit, the user can tap "Other…" to reveal an
    // inline text field and send a free-form reply through the same onOptionPress
    // channel as the preset cards.
    const [customMode, setCustomMode] = React.useState(false);
    const [customText, setCustomText] = React.useState('');
    const inputRef = React.useRef<TextInput>(null);

    const submitCustom = React.useCallback(() => {
        const value = customText.trim();
        if (!value) {
            return;
        }
        props.onOptionPress?.({ title: value });
        setCustomText('');
        setCustomMode(false);
    }, [customText, props.onOptionPress]);

    return (
        <View style={[style.optionsContainer, props.variant === 'foldedPrompt' && style.foldedOptionsContainer, props.first && style.first, props.last && style.last]}>
            {props.items.map((item, index) => {
                if (props.onOptionPress) {
                    return (
                        <Pressable
                            key={index}
                            style={({ pressed }) => [
                                style.optionItem,
                                props.variant === 'foldedPrompt' && style.foldedOptionItem,
                                pressed && style.optionItemPressed
                            ]}
                            onPress={() => props.onOptionPress?.({ title: item })}
                        >
                            <Text selectable={props.selectable} style={[style.optionText, props.variant === 'foldedPrompt' && style.foldedOptionText]}>{item}</Text>
                        </Pressable>
                    );
                } else {
                    return (
                        <View key={index} style={[style.optionItem, props.variant === 'foldedPrompt' && style.foldedOptionItem]}>
                            <Text selectable={props.selectable} style={[style.optionText, props.variant === 'foldedPrompt' && style.foldedOptionText]}>{item}</Text>
                        </View>
                    );
                }
            })}
            {props.onOptionPress ? (
                customMode ? (
                    <View style={style.optionCustomRow}>
                        <TextInput
                            ref={inputRef}
                            style={[style.optionCustomInput, props.variant === 'foldedPrompt' && style.foldedOptionCustomInput]}
                            value={customText}
                            onChangeText={setCustomText}
                            placeholder={t('agentInput.customOptionPlaceholder')}
                            placeholderTextColor={theme.colors.textSecondary}
                            multiline
                            autoFocus
                            onSubmitEditing={submitCustom}
                            blurOnSubmit
                            returnKeyType="send"
                        />
                        <Pressable
                            style={({ pressed }) => [
                                style.optionCustomSend,
                                !customText.trim() && style.optionCustomSendDisabled,
                                pressed && customText.trim() && style.optionItemPressed,
                            ]}
                            disabled={!customText.trim()}
                            onPress={submitCustom}
                        >
                            <Ionicons name="arrow-up" size={18} color={theme.colors.surface} />
                        </Pressable>
                    </View>
                ) : (
                    <Pressable
                        style={({ pressed }) => [
                            style.optionItem,
                            style.optionOtherItem,
                            props.variant === 'foldedPrompt' && style.foldedOptionItem,
                            pressed && style.optionItemPressed,
                        ]}
                        onPress={() => setCustomMode(true)}
                    >
                        <Ionicons name="create-outline" size={16} color={theme.colors.textSecondary} />
                        <Text style={[style.optionText, style.optionOtherText, props.variant === 'foldedPrompt' && style.foldedOptionText]}>{t('agentInput.customOption')}</Text>
                    </Pressable>
                )
            ) : null}
        </View>
    );
}

function RenderImageStyleOptionsBlock(props: {
    items: ParsedImageStyleOption[];
    first: boolean;
    last: boolean;
    onOptionPress: (option: Option) => void;
    variant: MarkdownViewVariant;
}) {
    const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
    const [drawCount, setDrawCount] = React.useState(1);
    const selectedStyles = React.useMemo(() => {
        const selected = new Set(selectedIds);
        return props.items
            .filter((item) => selected.has(item.style.id))
            .map((item) => item.style);
    }, [props.items, selectedIds]);
    const selectedCount = selectedIds.length;

    const toggle = React.useCallback((item: ParsedImageStyleOption) => {
        setSelectedIds((current) => {
            if (current.includes(item.style.id)) {
                return current.filter((id) => id !== item.style.id);
            }
            if (current.length >= MAX_IMAGE_STYLE_OPTION_COUNT) {
                return current;
            }
            return [...current, item.style.id];
        });
    }, []);

    const submit = React.useCallback(() => {
        if (selectedStyles.length === 0) return;
        props.onOptionPress({ title: buildImageStyleContinuationPrompt(selectedStyles, { variantsPerStyle: drawCount }) });
    }, [drawCount, props, selectedStyles]);

    return (
        <View style={[style.optionsContainer, style.imageStyleOptionsContainer, props.variant === 'foldedPrompt' && style.foldedImageStyleOptionsContainer, props.first && style.first, props.last && style.last]}>
            <View style={style.imageStyleOptionGrid}>
                {props.items.map((item) => {
                    const selected = selectedIds.includes(item.style.id);
                    return (
                        <Pressable
                            key={item.style.id}
                            style={({ pressed }) => [
                                style.imageStyleOptionChip,
                                props.variant === 'foldedPrompt' && style.foldedImageStyleOptionChip,
                                selected && style.imageStyleOptionChipSelected,
                                pressed && style.optionItemPressed,
                            ]}
                            onPress={() => toggle(item)}
                        >
                            <Text
                                selectable={false}
                                style={[
                                    style.imageStyleOptionText,
                                    props.variant === 'foldedPrompt' && style.foldedImageStyleOptionText,
                                    selected && style.imageStyleOptionTextSelected,
                                ]}
                                numberOfLines={2}
                            >
                                {item.title}
                            </Text>
                            {selected && (
                                <Ionicons name="checkmark-circle" size={15} color={style.imageStyleOptionCheck.color} />
                            )}
                        </Pressable>
                    );
                })}
            </View>
            <View style={style.imageStyleDrawRow}>
                <View style={style.imageStyleDrawLabel}>
                    <Ionicons name="dice-outline" size={15} color={style.imageStyleDrawLabelText.color} />
                    <Text style={style.imageStyleDrawLabelText} numberOfLines={1}>
                        {t('agents.imageVariantsPerStyle', { count: drawCount })}
                    </Text>
                </View>
                <View style={style.imageStyleDrawOptions}>
                    {Array.from({ length: MAX_IMAGE_AGENT_VARIANTS_PER_STYLE }, (_, index) => index + 1).map((count) => {
                        const selected = drawCount === count;
                        return (
                            <Pressable
                                key={count}
                                onPress={() => setDrawCount(count)}
                                style={({ pressed }) => [
                                    style.imageStyleDrawOption,
                                    selected && style.imageStyleDrawOptionSelected,
                                    pressed && style.optionItemPressed,
                                ]}
                            >
                                <Text style={[style.imageStyleDrawOptionText, selected && style.imageStyleDrawOptionTextSelected]}>
                                    {count}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
            </View>
            <Pressable
                style={({ pressed }) => [
                    style.imageStyleOptionSend,
                    props.variant === 'foldedPrompt' && style.foldedImageStyleOptionSend,
                    selectedCount === 0 && style.imageStyleOptionSendDisabled,
                    pressed && selectedCount > 0 && style.optionItemPressed,
                ]}
                disabled={selectedCount === 0}
                onPress={submit}
            >
                <Text style={style.imageStyleOptionSendText}>
                    {t('common.continue')} · {selectedCount}/{MAX_IMAGE_STYLE_OPTION_COUNT}
                </Text>
                <Ionicons name="arrow-up" size={16} color={style.imageStyleOptionSendIcon.color} />
            </Pressable>
        </View>
    );
}

function RenderSpans(props: RenderSpanProps) {
    const variant = props.variant ?? 'default';
    return (<>
        {props.spans.map((span, index) => {
            if (span.url) {
                const isExternalLink = isHttpMarkdownLink(span.url);
                return (
                    <Text
                        key={index}
                        selectable={props.selectable}
                        accessibilityRole={isExternalLink ? 'link' : undefined}
                        style={[props.baseStyle, isExternalLink && getLinkStyle(variant), span.styles.map(s => getSpanStyle(s, variant))]}
                        {...(isExternalLink && Platform.OS === 'web' ? { onClick: () => props.onLinkPress(span.url!) } as any : {})}
                        onPress={isExternalLink && Platform.OS !== 'web'
                            ? () => props.onLinkPress(span.url!)
                            : undefined}
                    >
                        {span.text}
                    </Text>
                );
            } else {
                return <Text key={index} selectable={props.selectable} style={[props.baseStyle, span.styles.map(s => getSpanStyle(s, variant))]}>{span.text}</Text>
            }
        })}
    </>)
}

function getTextStyle(variant: MarkdownViewVariant) {
    return variant === 'foldedPrompt' ? style.foldedText : style.text;
}

function getLinkStyle(variant: MarkdownViewVariant) {
    return variant === 'foldedPrompt' ? style.foldedLink : style.link;
}

function getSpanStyle(spanStyle: MarkdownSpan['styles'][number], variant: MarkdownViewVariant) {
    if (variant === 'foldedPrompt' && spanStyle === 'code') {
        return style.foldedCode;
    }
    return style[spanStyle];
}

// Plain-text length of a span array — used to estimate column widths.
function spansLength(spans: MarkdownSpan[]): number {
    let n = 0;
    for (const s of spans) n += s.text.length;
    return n;
}

const TABLE_MIN_COL_WIDTH = 80;
const TABLE_MAX_COL_WIDTH = 360;
const TABLE_CHAR_WIDTH = 8.5;  // approx px per char at 16px default font
const TABLE_CELL_H_PADDING = 24;

// Row-first layout with content-estimated column widths.
//
// - Each column's width is picked from the widest text in that column (header +
//   rows), clamped to [MIN, MAX]. This gives column-alignment across rows and
//   lets narrow columns (like "1, 2, 3") stay narrow.
// - Each row is a flex row — default `alignItems: 'stretch'` makes all cells in
//   a row match the tallest cell's height.
// - Wrapped in a horizontal ScrollView so wide tables still scroll instead of
//   being squashed unreadably.
function RenderTableBlock(props: {
    headers: MarkdownSpan[][],
    rows: MarkdownSpan[][][],
    onLinkPress: (url: string) => void,
    selectable: boolean,
    first: boolean,
    last: boolean,
    variant: MarkdownViewVariant,
}) {
    const columnCount = props.headers.length;
    const rowCount = props.rows.length;
    const isLastCol = (colIndex: number) => colIndex === columnCount - 1;
    const isLastRow = (rowIndex: number) => rowIndex === rowCount - 1;
    const foldedPrompt = props.variant === 'foldedPrompt';
    const headerTextStyle = foldedPrompt ? [style.tableHeaderText, style.foldedTableHeaderText] : style.tableHeaderText;
    const cellTextStyle = foldedPrompt ? [style.tableCellText, style.foldedTableCellText] : style.tableCellText;

    const columnWidths = React.useMemo(() => {
        const widths = new Array(columnCount).fill(0);
        for (let c = 0; c < columnCount; c++) {
            widths[c] = Math.max(widths[c], spansLength(props.headers[c] ?? []));
        }
        for (const row of props.rows) {
            for (let c = 0; c < columnCount; c++) {
                widths[c] = Math.max(widths[c], spansLength(row[c] ?? []));
            }
        }
        return widths.map(len => Math.min(TABLE_MAX_COL_WIDTH, Math.max(TABLE_MIN_COL_WIDTH, len * TABLE_CHAR_WIDTH + TABLE_CELL_H_PADDING)));
    }, [props.headers, props.rows, columnCount]);

    return (
        <View style={[style.tableContainer, foldedPrompt && style.foldedTableContainer, props.first && style.first, props.last && style.last]}>
            {/* flexGrow:0 stops iOS from stretching the horizontal ScrollView
                vertically to fill the parent — the cause of the table's frame
                extending down past the last row into empty space. */}
            <HorizontalScrollView style={{ flexGrow: 0 }} testID="markdown-table-scroll">
                <View style={{ alignSelf: 'flex-start' }}>
                    {/* Header row */}
                    <View style={[style.tableRow, style.tableHeaderRow]}>
                        {props.headers.map((header, colIndex) => (
                            <View
                                key={`header-${colIndex}`}
                                style={[style.tableCell, foldedPrompt && style.foldedTableCell, style.tableHeaderCell, { width: columnWidths[colIndex] }, !isLastCol(colIndex) && style.tableCellBorderRight]}
                            >
                                <Text style={headerTextStyle}>
                                    <RenderSpans spans={header} baseStyle={headerTextStyle} onLinkPress={props.onLinkPress} selectable={props.selectable} variant={props.variant} />
                                </Text>
                            </View>
                        ))}
                    </View>
                    {/* Data rows */}
                    {props.rows.map((row, rowIndex) => (
                        <View
                            key={`row-${rowIndex}`}
                            style={[style.tableRow, !isLastRow(rowIndex) && style.tableRowBorderBottom]}
                        >
                            {props.headers.map((_, colIndex) => (
                                <View
                                    key={`cell-${rowIndex}-${colIndex}`}
                                    style={[style.tableCell, foldedPrompt && style.foldedTableCell, { width: columnWidths[colIndex] }, !isLastCol(colIndex) && style.tableCellBorderRight]}
                                >
                                    <Text style={cellTextStyle}>
                                        <RenderSpans spans={row[colIndex] ?? []} baseStyle={cellTextStyle} onLinkPress={props.onLinkPress} selectable={props.selectable} variant={props.variant} />
                                    </Text>
                                </View>
                            ))}
                        </View>
                    ))}
                </View>
            </HorizontalScrollView>
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
    foldedText: {
        ...Typography.mono(),
        fontSize: 12,
        lineHeight: 18,
        marginTop: 4,
        marginBottom: 4,
        color: theme.colors.textSecondary,
        fontWeight: '400',
    },

    italic: {
        fontStyle: 'italic',
    },
    bold: {
        ...Typography.default('semiBold'),
        fontWeight: '700',
    },
    semibold: {
        ...Typography.default('semiBold'),
        fontWeight: '600',
    },
    code: {
        ...Typography.mono(),
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.text,
    },
    foldedCode: {
        ...Typography.mono(),
        fontSize: 12,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    link: {
        ...Typography.default(),
        color: theme.colors.text,
        fontWeight: '400',
        textDecorationLine: 'underline',
        cursor: 'pointer',
    },
    foldedLink: {
        ...Typography.mono(),
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 18,
        fontWeight: '400',
        textDecorationLine: 'underline',
        cursor: 'pointer',
    },

    // Headers

    header: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    foldedHeader: {
        ...Typography.mono(),
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
        fontWeight: '600',
        marginTop: 6,
        marginBottom: 4,
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
    foldedList: {
        ...Typography.mono(),
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 18,
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
        width: '100%',
    },
    foldedCodeBlock: {
        marginVertical: 6,
    },
    codeContent: {
        paddingHorizontal: 16,
        paddingVertical: 16,
        alignItems: 'flex-start',
    },
    foldedCodeContent: {
        paddingHorizontal: 12,
        paddingVertical: 10,
        alignItems: 'flex-start',
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
    foldedCodeText: {
        fontSize: 12,
        lineHeight: 18,
    },
    horizontalRule: {
        height: 1,
        backgroundColor: theme.colors.divider,
        marginTop: 8,
        marginBottom: 8,
    },
    imageBlock: {
        width: '100%',
        maxWidth: 520,
        marginVertical: 8,
        alignSelf: 'flex-start',
        gap: 8,
    },
    image: {
        width: '100%',
        minHeight: 160,
        height: 240,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHighest,
    },
    imageCaption: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.textSecondary,
    },
    otaPreviewBlock: {
        width: '100%',
        maxWidth: 520,
        alignSelf: 'flex-start',
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
        flexDirection: 'column',
        gap: 8,
        marginVertical: 8,
    },
    foldedOptionsContainer: {
        gap: 6,
        marginVertical: 6,
    },
    imageStyleOptionsContainer: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        padding: 8,
    },
    foldedImageStyleOptionsContainer: {
        backgroundColor: 'transparent',
        borderWidth: 0,
        borderRadius: 8,
        padding: 0,
    },
    imageStyleOptionGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    imageStyleOptionChip: {
        minHeight: 42,
        minWidth: 96,
        maxWidth: 150,
        flexGrow: 1,
        flexBasis: '30%',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6,
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 9,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    foldedImageStyleOptionChip: {
        minHeight: 34,
        minWidth: 86,
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 6,
    },
    imageStyleOptionChipSelected: {
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.surface,
    },
    imageStyleOptionText: {
        ...Typography.default('semiBold'),
        flex: 1,
        fontSize: 13,
        lineHeight: 17,
        color: theme.colors.text,
    },
    foldedImageStyleOptionText: {
        fontSize: 12,
        lineHeight: 16,
    },
    imageStyleOptionTextSelected: {
        color: theme.colors.text,
    },
    imageStyleOptionCheck: {
        color: theme.colors.accent,
    },
    imageStyleDrawRow: {
        minHeight: 34,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        paddingHorizontal: 2,
    },
    imageStyleDrawLabel: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    imageStyleDrawLabelText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    imageStyleDrawOptions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    imageStyleDrawOption: {
        width: 28,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHighest,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    imageStyleDrawOptionSelected: {
        backgroundColor: theme.colors.text,
        borderColor: theme.colors.text,
    },
    imageStyleDrawOptionText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    imageStyleDrawOptionTextSelected: {
        color: theme.colors.surface,
    },
    imageStyleOptionSend: {
        marginTop: 2,
        height: 38,
        borderRadius: 19,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: theme.colors.text,
    },
    foldedImageStyleOptionSend: {
        height: 34,
        borderRadius: 17,
    },
    imageStyleOptionSendDisabled: {
        opacity: 0.35,
    },
    imageStyleOptionSendText: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.surface,
    },
    imageStyleOptionSendIcon: {
        color: theme.colors.surface,
    },
    optionItem: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    foldedOptionItem: {
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    optionItemPressed: {
        opacity: 0.7,
        backgroundColor: theme.colors.surfaceHigh,
    },
    optionText: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.text,
    },
    foldedOptionText: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
    },
    optionOtherItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderStyle: 'dashed',
    },
    optionOtherText: {
        color: theme.colors.textSecondary,
    },
    optionCustomRow: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: 8,
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    optionCustomInput: {
        ...Typography.default(),
        flex: 1,
        fontSize: 16,
        lineHeight: 22,
        maxHeight: 120,
        color: theme.colors.text,
        paddingTop: Platform.OS === 'ios' ? 6 : 4,
        paddingBottom: Platform.OS === 'ios' ? 6 : 4,
    },
    foldedOptionCustomInput: {
        fontSize: 13,
        lineHeight: 18,
    },
    optionCustomSend: {
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.text,
    },
    optionCustomSendDisabled: {
        opacity: 0.3,
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
        maxWidth: '100%',
        alignSelf: 'flex-start',
    },
    foldedTableContainer: {
        marginVertical: 6,
    },
    tableRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
    },
    tableRowBorderBottom: {
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    tableHeaderRow: {
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    tableCell: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        alignItems: 'flex-start',
        flexShrink: 0,
    },
    foldedTableCell: {
        paddingHorizontal: 10,
        paddingVertical: 6,
    },
    tableCellBorderRight: {
        borderRightWidth: 1,
        borderRightColor: theme.colors.divider,
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
    foldedTableHeaderText: {
        ...Typography.mono(),
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 18,
        fontWeight: '600',
    },
    tableCellText: {
        ...Typography.default(),
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 24,
    },
    foldedTableCellText: {
        ...Typography.mono(),
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 18,
        fontWeight: '400',
    },

    // Add global style for Web platform (Unistyles supports this via compiler plugin)
    ...(Platform.OS === 'web' ? {
        // Web-only CSS styles
        _____web_global_styles: {}
    } : {}),
}));
