import { MarkdownSpan, parseMarkdown } from './parseMarkdown';
import { parseMarkdownSpans } from './parseMarkdownSpans';
import { Link } from 'expo-router';
import * as React from 'react';
import { Pressable, ScrollView, View, Platform, Image as RNImage, Modal as RNModal, Linking } from 'react-native';
import { createPortal } from 'react-dom';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '../StyledText';
import { Typography } from '@/constants/Typography';
import { SimpleSyntaxHighlighter } from '../SimpleSyntaxHighlighter';
import { Modal } from '@/modal';
import { useLocalSetting } from '@/sync/storage';
import { storeTempText } from '@/sync/persistence';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { MermaidRenderer } from './MermaidRenderer';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';

// Option type for callback
export type Option = {
    title: string;
};

// Context for timestamp accent color (course-themed)
const TimestampColorContext = React.createContext<string | undefined>(undefined);

// Context for image gallery (collect all images in a message for prev/next navigation)
type ImageGalleryContextType = {
    images: { alt: string; url: string }[];
    openPreview: (url: string) => void;
};
const ImageGalleryContext = React.createContext<ImageGalleryContextType>({ images: [], openPreview: () => {} });

// Context for file path press handler (threaded through to RenderSpans)
const FilePathPressContext = React.createContext<((path: string) => void) | undefined>(undefined);

export const MarkdownView = React.memo((props: {
    markdown: string;
    onOptionPress?: (option: Option) => void;
    onTimestampPress?: (seconds: number) => void;
    onFilePathPress?: (path: string) => void;
    timestampColor?: string;
}) => {
    const blocks = React.useMemo(() => parseMarkdown(props.markdown), [props.markdown]);
    const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);

    // Collect all images from parsed blocks for gallery navigation
    const allImages = React.useMemo(() => {
        return blocks
            .filter((b): b is { type: 'image'; alt: string; url: string } => b.type === 'image')
            .map(b => ({ alt: b.alt, url: b.url }));
    }, [blocks]);

    const galleryContext = React.useMemo(() => ({
        images: allImages,
        openPreview: (url: string) => setPreviewUrl(url),
    }), [allImages]);
    
    // Backwards compatibility: The original version just returned the view, wrapping the list of blocks.
    // It made each of the individual text elements selectable. When we enable the markdownCopyV2 feature,
    // we disable the selectable property on individual text segments on mobile only. Instead, the long press
    // will be handled by a wrapper Pressable. If we don't disable the selectable property, then you will see
    // the native copy modal come up at the same time as the long press handler is fired.
    const markdownCopyV2 = useLocalSetting('markdownCopyV2');
    const selectable = Platform.OS === 'web' || !markdownCopyV2;
    const router = useRouter();

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
        const inner = (
            <View style={{ width: '100%' }}>
                {blocks.map((block, index) => {
                    if (block.type === 'text') {
                        return <RenderTextBlock spans={block.content} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} onTimestampPress={props.onTimestampPress} />;
                    } else if (block.type === 'header') {
                        return <RenderHeaderBlock level={block.level} spans={block.content} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} />;
                    } else if (block.type === 'horizontal-rule') {
                        return <View style={style.horizontalRule} key={index} />;
                    } else if (block.type === 'list') {
                        return <RenderListBlock items={block.items} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} onTimestampPress={props.onTimestampPress} />;
                    } else if (block.type === 'numbered-list') {
                        return <RenderNumberedListBlock items={block.items} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} onTimestampPress={props.onTimestampPress} />;
                    } else if (block.type === 'code-block') {
                        return <RenderCodeBlock content={block.content} language={block.language} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} />;
                    } else if (block.type === 'mermaid') {
                        return <MermaidRenderer content={block.content} key={index} />;
                    } else if (block.type === 'd2') {
                        return <MermaidRenderer content={block.content} diagramType="d2" key={index} />;
                    } else if (block.type === 'options') {
                        return <RenderOptionsBlock items={block.items} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} onOptionPress={props.onOptionPress} />;
                    } else if (block.type === 'image') {
                        return <RenderImageBlock alt={block.alt} url={block.url} key={index} />;
                    } else if (block.type === 'details') {
                        return <RenderDetailsBlock summary={block.summary} contentMarkdown={block.contentMarkdown} key={index} onOptionPress={props.onOptionPress} onTimestampPress={props.onTimestampPress} />;
                    } else if (block.type === 'table') {
                        return <RenderTableBlock headers={block.headers} rows={block.rows} key={index} first={index === 0} last={index === blocks.length - 1} onTimestampPress={props.onTimestampPress} />;
                    } else {
                        return null;
                    }
                })}
            </View>
        );

        const wrapped = (
            <FilePathPressContext.Provider value={props.onFilePathPress}>
            <ImageGalleryContext.Provider value={galleryContext}>
                {props.timestampColor
                    ? <TimestampColorContext.Provider value={props.timestampColor}>{inner}</TimestampColorContext.Provider>
                    : inner}
                {previewUrl && (
                    <ImagePreviewModal
                        url={previewUrl}
                        images={allImages}
                        onClose={() => setPreviewUrl(null)}
                        onNavigate={(url) => setPreviewUrl(url)}
                    />
                )}
            </ImageGalleryContext.Provider>
            </FilePathPressContext.Provider>
        );
        return wrapped;
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

function RenderTextBlock(props: { spans: MarkdownSpan[], first: boolean, last: boolean, selectable: boolean, onTimestampPress?: (seconds: number) => void }) {
    return <Text selectable={props.selectable} style={[style.text, props.first && style.first, props.last && style.last]}><RenderSpans spans={props.spans} baseStyle={style.text} onTimestampPress={props.onTimestampPress} /></Text>;
}

function RenderHeaderBlock(props: { level: 1 | 2 | 3 | 4 | 5 | 6, spans: MarkdownSpan[], first: boolean, last: boolean, selectable: boolean }) {
    const s = (style as any)[`header${props.level}`];
    const headerStyle = [style.header, s, props.first && style.first, props.last && style.last];
    return <Text selectable={props.selectable} style={headerStyle}><RenderSpans spans={props.spans} baseStyle={headerStyle} /></Text>;
}

function RenderListBlock(props: { items: MarkdownSpan[][], first: boolean, last: boolean, selectable: boolean, onTimestampPress?: (seconds: number) => void }) {
    const listStyle = [style.text, style.list];
    return (
        <View style={{ flexDirection: 'column', marginBottom: 8, gap: 1 }}>
            {props.items.map((item, index) => (
                <Text selectable={props.selectable} style={listStyle} key={index}>- <RenderSpans spans={item} baseStyle={listStyle} onTimestampPress={props.onTimestampPress} /></Text>
            ))}
        </View>
    );
}

function RenderNumberedListBlock(props: { items: { number: number, spans: MarkdownSpan[] }[], first: boolean, last: boolean, selectable: boolean, onTimestampPress?: (seconds: number) => void }) {
    const listStyle = [style.text, style.list];
    return (
        <View style={{ flexDirection: 'column', marginBottom: 8, gap: 1 }}>
            {props.items.map((item, index) => (
                <Text selectable={props.selectable} style={listStyle} key={index}>{item.number.toString()}. <RenderSpans spans={item.spans} baseStyle={listStyle} onTimestampPress={props.onTimestampPress} /></Text>
            ))}
        </View>
    );
}

// Detect touch-only device (no mouse hover support)
const isTouchDevice = Platform.OS === 'web' && typeof window !== 'undefined' && window.matchMedia?.('(hover: none)')?.matches;

function RenderCodeBlock(props: { content: string, language: string | null, first: boolean, last: boolean, selectable: boolean }) {
    const [isHovered, setIsHovered] = React.useState(false);
    const [codeCopied, setCodeCopied] = React.useState(false);

    const copyCode = React.useCallback(async () => {
        try {
            await Clipboard.setStringAsync(props.content);
            setCodeCopied(true);
            setTimeout(() => setCodeCopied(false), 2000);
        } catch (error) {
            console.error('Failed to copy code:', error);
        }
    }, [props.content]);

    // On touch devices, always show the copy button
    const showCopyButton = isTouchDevice || isHovered;

    return (
        <View
            style={[style.codeBlock, props.first && style.first, props.last && style.last]}
            // @ts-ignore - Web only events
            onMouseEnter={() => setIsHovered(true)}
            // @ts-ignore - Web only events
            onMouseLeave={() => setIsHovered(false)}
        >
            {props.language && <Text selectable={props.selectable} style={style.codeLanguage}>{props.language}</Text>}
            <ScrollView
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
                style={[style.copyButtonWrapper, showCopyButton && style.copyButtonWrapperVisible]}
                {...(Platform.OS === 'web' ? ({ className: 'copy-button-wrapper' } as any) : {})}
            >
                <Pressable
                    style={style.copyButton}
                    onPress={copyCode}
                >
                    <Text style={style.copyButtonText}>{codeCopied ? '✓' : t('common.copy')}</Text>
                </Pressable>
            </View>
        </View>
    );
}

function RenderOptionsBlock(props: { 
    items: string[], 
    first: boolean, 
    last: boolean, 
    selectable: boolean,
    onOptionPress?: (option: Option) => void 
}) {
    return (
        <View style={[style.optionsContainer, props.first && style.first, props.last && style.last]}>
            {props.items.map((item, index) => {
                if (props.onOptionPress) {
                    return (
                        <Pressable
                            key={index}
                            style={({ pressed }) => [
                                style.optionItem,
                                pressed && style.optionItemPressed
                            ]}
                            onPress={() => props.onOptionPress?.({ title: item })}
                        >
                            <Text selectable={false} style={style.optionText}>{item}</Text>
                        </Pressable>
                    );
                } else {
                    return (
                        <View key={index} style={style.optionItem}>
                            <Text selectable={props.selectable} style={style.optionText}>{item}</Text>
                        </View>
                    );
                }
            })}
        </View>
    );
}

function RenderDetailsBlock(props: {
    summary: string;
    contentMarkdown: string;
    onOptionPress?: (option: Option) => void;
    onTimestampPress?: (seconds: number) => void;
}) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    return (
        <View style={{ marginVertical: 4 }}>
            <Pressable
                onPress={() => setOpen(prev => !prev)}
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    paddingVertical: 6,
                }}
            >
                <Ionicons
                    name={open ? 'chevron-down' : 'chevron-forward'}
                    size={14}
                    color={theme.colors.textSecondary}
                />
                <Text style={{
                    fontSize: 15,
                    color: theme.colors.text,
                    ...Typography.default('semiBold'),
                }}>
                    {props.summary}
                </Text>
            </Pressable>
            {open && props.contentMarkdown && (
                <View style={{ paddingLeft: 20, paddingTop: 2 }}>
                    <MarkdownView
                        markdown={props.contentMarkdown}
                        onOptionPress={props.onOptionPress}
                        onTimestampPress={props.onTimestampPress}
                    />
                </View>
            )}
        </View>
    );
}

function RenderSpans(props: { spans: MarkdownSpan[], baseStyle?: any, onTimestampPress?: (seconds: number) => void }) {
    const tsColor = React.useContext(TimestampColorContext);
    const onFilePathPress = React.useContext(FilePathPressContext);
    return (<>
        {props.spans.map((span, index) => {
            if (span.url?.startsWith('timestamp:')) {
                const seconds = parseInt(span.url.slice(10), 10);
                if (props.onTimestampPress) {
                    const c = tsColor || '#2BACCC';
                    return (
                        <Text
                            key={index}
                            onPress={() => props.onTimestampPress!(seconds)}
                            style={{
                                ...Typography.mono(),
                                fontSize: 13,
                                lineHeight: 18,
                                fontWeight: '600',
                                borderRadius: 4,
                                paddingHorizontal: 5,
                                paddingVertical: 2,
                                overflow: 'hidden',
                                color: c,
                                backgroundColor: 'rgba(255,255,255,0.08)',
                            }}
                        >
                            {span.text}
                        </Text>
                    );
                }
                return <Text key={index} selectable style={style.timestampInactive}>{span.text}</Text>;
            } else if (span.url?.startsWith('filepath:')) {
                const filePath = span.url.slice(9);
                const hasHandler = !!onFilePathPress;
                return (
                    <Text
                        key={index}
                        selectable
                        onPress={hasHandler ? () => onFilePathPress!(filePath) : undefined}
                        style={[
                            span.styles.includes('code') ? style.code : props.baseStyle,
                            hasHandler && style.filePathLink,
                            span.styles.filter(s => s !== 'code').map(s => style[s]),
                        ]}
                    >
                        {span.text}
                    </Text>
                );
            } else if (span.url) {
                const isExternalUrl = span.url.startsWith('http://') || span.url.startsWith('https://');
                const handlePress = () => {
                    if (isExternalUrl) {
                        if (Platform.OS === 'web') {
                            window.open(span.url!, '_blank', 'noopener,noreferrer');
                        } else {
                            Linking.openURL(span.url!);
                        }
                    } else if (onFilePathPress) {
                        onFilePathPress(span.url!);
                    }
                };
                return (
                    <Text
                        key={index}
                        selectable
                        onPress={handlePress}
                        style={[style.link, span.styles.map(s => style[s])]}
                    >
                        {span.text}
                    </Text>
                );
            } else {
                return <Text key={index} selectable style={[props.baseStyle, span.styles.map(s => style[s])]}>{span.text}</Text>
            }
        })}
    </>)
}

function RenderImageBlock(props: { alt: string; url: string }) {
    const [aspectRatio, setAspectRatio] = React.useState<number | null>(null);
    const [loadError, setLoadError] = React.useState(false);
    const gallery = React.useContext(ImageGalleryContext);

    React.useEffect(() => {
        setLoadError(false);
        setAspectRatio(null);
        if (Platform.OS === 'web') {
            const img = new (window as any).Image();
            img.onload = () => {
                if (img.naturalWidth && img.naturalHeight) {
                    setAspectRatio(img.naturalWidth / img.naturalHeight);
                }
            };
            img.onerror = () => setLoadError(true);
            img.src = props.url;
        } else {
            RNImage.getSize(props.url, (w, h) => {
                if (w && h) setAspectRatio(w / h);
            }, () => setLoadError(true));
        }
    }, [props.url]);

    if (loadError) {
        return null;
    }

    // Don't render placeholder — wait for real dimensions
    if (aspectRatio === null) {
        return (
            <View style={[style.imageContainer, { height: 100, alignItems: 'center', justifyContent: 'center' }]}>
                <Text style={{ color: style.imageAlt.color, fontSize: 12 }}>...</Text>
            </View>
        );
    }

    return (
        <Pressable onPress={() => gallery.openPreview(props.url)}>
            <View style={style.imageContainer}>
                <RNImage
                    source={{ uri: props.url }}
                    style={{ width: '100%', aspectRatio, borderTopLeftRadius: 12, borderTopRightRadius: 12 }}
                    onError={() => setLoadError(true)}
                />
                {props.alt ? <Text style={style.imageAlt}>{props.alt}</Text> : null}
            </View>
        </Pressable>
    );
}

// Full-screen image preview modal with navigation and download
function ImagePreviewModal(props: {
    url: string;
    images: { alt: string; url: string }[];
    onClose: () => void;
    onNavigate: (url: string) => void;
}) {
    const { theme } = useUnistyles();
    const currentIndex = props.images.findIndex(img => img.url === props.url);
    const total = props.images.length;
    const currentAlt = currentIndex >= 0 ? props.images[currentIndex].alt : '';

    const goTo = React.useCallback((direction: 'prev' | 'next') => {
        if (total <= 1) return;
        const newIndex = direction === 'prev'
            ? (currentIndex - 1 + total) % total
            : (currentIndex + 1) % total;
        props.onNavigate(props.images[newIndex].url);
    }, [currentIndex, total, props.images, props.onNavigate]);

    const handleDownload = React.useCallback(() => {
        if (Platform.OS === 'web') {
            const a = document.createElement('a');
            a.href = props.url;
            a.download = currentAlt || 'image';
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.click();
        } else {
            Linking.openURL(props.url);
        }
    }, [props.url, currentAlt]);

    // Keyboard navigation (web)
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'ArrowLeft') { goTo('prev'); e.preventDefault(); }
            if (e.key === 'ArrowRight') { goTo('next'); e.preventDefault(); }
            if (e.key === 'Escape') { props.onClose(); e.preventDefault(); }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [goTo, props.onClose]);

    const overlay = (
        // @ts-ignore - Web only
        <div
            onClick={props.onClose}
            style={{
                position: 'fixed',
                top: 0, left: 0, right: 0, bottom: 0,
                backgroundColor: 'rgba(0,0,0,0.92)',
                zIndex: 99999,
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                cursor: 'zoom-out',
            }}
        >
            {/* Header bar */}
            {/* @ts-ignore */}
            <div style={{
                position: 'absolute', top: 0, left: 0, right: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 16px',
                zIndex: 10,
            }}>
                {/* @ts-ignore */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {/* @ts-ignore */}
                    <div onClick={props.onClose} style={{ cursor: 'pointer', padding: 8 }}>
                        <Ionicons name="close" size={24} color="#fff" />
                    </div>
                    {total > 1 && (
                        // @ts-ignore
                        <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14 }}>
                            {currentIndex + 1} / {total}
                        </span>
                    )}
                </div>
                {/* @ts-ignore */}
                <div onClick={(e: any) => { e.stopPropagation(); handleDownload(); }} style={{ cursor: 'pointer', padding: 8 }}>
                    <Ionicons name="download-outline" size={22} color="#fff" />
                </div>
            </div>

            {/* Image */}
            {/* @ts-ignore */}
            <img
                src={props.url}
                onClick={(e: any) => e.stopPropagation()}
                style={{ maxWidth: '92%', maxHeight: '90%', objectFit: 'contain', borderRadius: 8, cursor: 'default' }}
            />

            {/* Navigation arrows */}
            {total > 1 && (
                <>
                    {/* @ts-ignore */}
                    <div
                        onClick={(e: any) => { e.stopPropagation(); goTo('prev'); }}
                        style={{
                            position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
                            width: 48, height: 48, borderRadius: 24,
                            backgroundColor: 'rgba(0,0,0,0.5)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            cursor: 'pointer',
                        }}
                    >
                        <Ionicons name="chevron-back" size={28} color="#fff" />
                    </div>
                    {/* @ts-ignore */}
                    <div
                        onClick={(e: any) => { e.stopPropagation(); goTo('next'); }}
                        style={{
                            position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                            width: 48, height: 48, borderRadius: 24,
                            backgroundColor: 'rgba(0,0,0,0.5)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            cursor: 'pointer',
                        }}
                    >
                        <Ionicons name="chevron-forward" size={28} color="#fff" />
                    </div>
                </>
            )}

            {/* Alt text */}
            {currentAlt ? (
                // @ts-ignore
                <div style={{
                    position: 'absolute', bottom: 16,
                    color: 'rgba(255,255,255,0.7)', fontSize: 14,
                    textAlign: 'center', padding: '0 32px',
                }}>
                    {currentAlt}
                </div>
            ) : null}
        </div>
    );

    if (Platform.OS === 'web') {
        return createPortal(overlay, document.body);
    }

    // Native (iOS/Android)
    return (
        <RNModal visible transparent animationType="fade" onRequestClose={props.onClose}>
            <Pressable
                style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', justifyContent: 'center', alignItems: 'center' }}
                onPress={props.onClose}
            >
                <RNImage
                    source={{ uri: props.url }}
                    style={{ width: '90%', height: '80%' }}
                    resizeMode="contain"
                />

                {/* Navigation arrows */}
                {total > 1 && (
                    <>
                        <Pressable
                            onPress={() => goTo('prev')}
                            style={{ position: 'absolute', left: 8, top: '50%', width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' }}
                        >
                            <Ionicons name="chevron-back" size={28} color="#fff" />
                        </Pressable>
                        <Pressable
                            onPress={() => goTo('next')}
                            style={{ position: 'absolute', right: 8, top: '50%', width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' }}
                        >
                            <Ionicons name="chevron-forward" size={28} color="#fff" />
                        </Pressable>
                    </>
                )}

                {/* Counter */}
                {total > 1 && (
                    <View style={{ position: 'absolute', top: 54, left: 16 }}>
                        <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14 }}>
                            {currentIndex + 1} / {total}
                        </Text>
                    </View>
                )}
            </Pressable>
        </RNModal>
    );
}

// Table rendering uses column-first layout to ensure consistent column widths.
// Each column is rendered as a vertical container with all its cells (header + data).
// This ensures that cells in the same column have the same width, determined by the widest content.
function RenderTableBlock(props: {
    headers: string[],
    rows: string[][],
    first: boolean,
    last: boolean,
    onTimestampPress?: (seconds: number) => void,
}) {
    const columnCount = props.headers.length;
    const rowCount = props.rows.length;
    const isLastRow = (rowIndex: number) => rowIndex === rowCount - 1;

    return (
        <View style={[style.tableContainer, props.first && style.first, props.last && style.last]}>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={true}
                nestedScrollEnabled={true}
                style={style.tableScrollView}
            >
                <View style={style.tableContent}>
                    {/* Render each column as a vertical container */}
                    {props.headers.map((header, colIndex) => (
                        <View
                            key={`column-${colIndex}`}
                            style={[
                                style.tableColumn,
                                colIndex === columnCount - 1 && style.tableColumnLast
                            ]}
                        >
                            {/* Header cell for this column */}
                            <View style={[style.tableCell, style.tableHeaderCell, style.tableCellFirst]}>
                                <Text style={style.tableHeaderText}>{header}</Text>
                            </View>
                            {/* Data cells for this column */}
                            {props.rows.map((row, rowIndex) => {
                                const cellText = row[colIndex] ?? '';
                                const spans = parseMarkdownSpans(cellText, false);
                                return (
                                    <View
                                        key={`cell-${rowIndex}-${colIndex}`}
                                        style={[
                                            style.tableCell,
                                            isLastRow(rowIndex) && style.tableCellLast
                                        ]}
                                    >
                                        <Text style={style.tableCellText}>
                                            <RenderSpans spans={spans} baseStyle={style.tableCellText} onTimestampPress={props.onTimestampPress} />
                                        </Text>
                                    </View>
                                );
                            })}
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
    link: {
        ...Typography.default(),
        color: theme.colors.textLink,
        fontWeight: '400',
    },
    filePathLink: {
        color: theme.colors.textLink,
        cursor: 'pointer',
        textDecorationLine: 'underline',
        textDecorationStyle: 'dotted',
    },
    timestamp: {
        ...Typography.mono(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textLink,
        fontWeight: '600',
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 4,
        paddingHorizontal: 5,
        paddingVertical: 2,
        overflow: 'hidden' as const,
    },
    timestampInactive: {
        ...Typography.mono(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 4,
        paddingHorizontal: 5,
        paddingVertical: 2,
        overflow: 'hidden' as const,
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
        flexDirection: 'column',
        gap: 8,
        marginVertical: 8,
    },
    optionItem: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
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
    },
    tableScrollView: {
        flexGrow: 0,
    },
    tableContent: {
        flexDirection: 'row',
    },
    tableColumn: {
        flexDirection: 'column',
        borderRightWidth: 1,
        borderRightColor: theme.colors.divider,
    },
    tableColumnLast: {
        borderRightWidth: 0,
    },
    tableCell: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
        alignItems: 'flex-start',
    },
    tableCellFirst: {
        borderTopWidth: 0,
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

    //
    // Image
    //

    imageContainer: {
        marginVertical: 4,
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: theme.colors.surfaceHighest,
        borderWidth: 0.5,
        borderColor: theme.colors.divider,
    },
    image: {
        width: '100%',
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
    },
    imageAlt: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
        paddingVertical: 8,
        paddingHorizontal: 12,
        textAlign: 'center',
    },

    // Add global style for Web platform (Unistyles supports this via compiler plugin)
    ...(Platform.OS === 'web' ? {
        // Web-only CSS styles
        _____web_global_styles: {}
    } : {}),
}));