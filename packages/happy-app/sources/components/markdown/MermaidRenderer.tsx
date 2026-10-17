import { Feather } from '@expo/vector-icons';
import type { PanzoomGlobalOptions, PanzoomObject } from '@panzoom/panzoom';
import * as React from 'react';
import { Modal, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { WebView } from 'react-native-webview';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { DesktopShortcutTooltip } from '@/components/DesktopShortcutTooltip';
import { useHappyAction } from '@/hooks/useHappyAction';
import { downloadImage } from '@/utils/imageDownload';
import { t } from '@/text';
import {
    createMermaidThemeConfig,
    executeDiagramCommand,
    getDiagramFitScale,
    type DiagramCommand,
    type MermaidThemeConfig,
} from './mermaidRendererModel';
import { getMarkdownTypography, type MarkdownTypographyMode } from './markdownTypography';
import { createMermaidImageUri } from './mermaidSvgImage';
import { buildNativeDocument } from './mermaidNativeDocument';

type DiagramCanvasHandle = {
    execute: (command: DiagramCommand) => void;
    download: () => void;
};

type DiagramCanvasProps = {
    config: MermaidThemeConfig;
    content: string;
    fullscreen?: boolean;
    readableDesktopPreview?: boolean;
    onNaturalWidth?: (width: number) => void;
    onScaleChange?: (scale: number) => void;
    typography: MarkdownTypographyMode;
};

type PanzoomFactory = (
    element: HTMLElement | SVGElement,
    options: PanzoomGlobalOptions,
) => PanzoomObject;

export function initializeWebDiagramPanzoom(
    host: HTMLElement,
    createPanzoom: PanzoomFactory,
    options: { startScale?: number; onScaleChange?: (scale: number) => void } = {},
): { dispose: () => void; panzoom: PanzoomObject } {
    const startScale = options.startScale ?? 1;
    const scaleHandler = (event: Event) => {
        const scale = (event as CustomEvent<{ scale: number }>).detail?.scale;
        if (Number.isFinite(scale) && scale > 0) options.onScaleChange?.(scale);
    };
    host.addEventListener('panzoomchange', scaleHandler);
    const panzoom = createPanzoom(host, {
        canvas: true,
        maxScale: 5,
        minScale: Math.min(0.1, startScale / 2),
        startScale,
        step: 0.25,
    });
    const wheelTarget = host.parentElement;
    const wheelHandler = (event: WheelEvent) => {
        if (!event.ctrlKey && !event.metaKey) return;
        panzoom.zoomWithWheel(event);
    };

    wheelTarget?.addEventListener('wheel', wheelHandler, { passive: false });

    return {
        panzoom,
        dispose: () => {
            host.removeEventListener('panzoomchange', scaleHandler);
            wheelTarget?.removeEventListener('wheel', wheelHandler);
            panzoom.destroy();
        },
    };
}

let nextDiagramId = 0;

function DiagramError(props: { content: string; typography: MarkdownTypographyMode }) {
    const typography = getMarkdownTypography(props.typography);
    return (
        <View style={[styles.canvas, styles.errorContainer]}>
            <View style={styles.errorContent}>
                <Text style={[styles.errorText, typography.strong]}>{t('markdown.mermaidRenderFailed')}</Text>
                <View style={styles.codeBlock}>
                    <Text style={[styles.codeText, typography.inlineCode]}>{props.content}</Text>
                </View>
            </View>
        </View>
    );
}

const WebDiagramCanvas = React.forwardRef<DiagramCanvasHandle, DiagramCanvasProps>((props, ref) => {
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const panzoomRef = React.useRef<PanzoomObject | null>(null);
    const [hasError, setHasError] = React.useState(false);
    const [svgContent, setSvgContent] = React.useState<string | null>(null);
    const imageUri = React.useMemo(
        () => svgContent && !props.fullscreen ? createMermaidImageUri(svgContent) : null,
        [props.fullscreen, svgContent],
    );
    const [, download] = useHappyAction(async () => {
        if (!svgContent) return;
        await downloadImage({ uri: createMermaidImageUri(svgContent), filename: 'paws-diagram.svg' });
    }, { fallbackErrorMessage: t('imageViewer.downloadFailedMessage') });

    React.useImperativeHandle(ref, () => ({
        execute: (command) => {
            const panzoom = panzoomRef.current;
            if (!panzoom) return;
            executeDiagramCommand(panzoom, command);
        },
        download: () => { download(); },
    }), [download]);

    React.useEffect(() => {
        let cancelled = false;
        setHasError(false);
        setSvgContent(null);

        void (async () => {
            try {
                const { getWebMermaidRuntime } = await import('./mermaidWebRuntime');
                const runtime = await getWebMermaidRuntime();
                const id = `mermaid-${Date.now()}-${nextDiagramId++}`;
                const svg = await runtime.render(id, props.content, props.config);
                if (!cancelled) setSvgContent(svg);
            } catch (error) {
                if (!cancelled) {
                    console.warn(`[Mermaid] ${t('markdown.mermaidRenderFailed')}: ${error instanceof Error ? error.message : String(error)}`);
                    setHasError(true);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [props.config, props.content]);

    React.useEffect(() => {
        if (!props.fullscreen) return;
        const host = containerRef.current;
        const svg = host?.querySelector('svg');
        if (!host || !svg) return;

        svg.style.display = 'block';
        svg.style.height = '100%';
        svg.style.maxHeight = '100%';
        svg.style.maxWidth = '100%';
        svg.style.width = '100%';
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

        let disposed = false;
        let disposePanzoom: (() => void) | null = null;
        let resizeObserver: ResizeObserver | null = null;
        const width = svg.viewBox?.baseVal.width || host.clientWidth || 1;
        const height = svg.viewBox?.baseVal.height || host.clientHeight || 1;
        host.style.width = `${width}px`;
        host.style.height = `${height}px`;
        const fitScale = () => getDiagramFitScale(width, height,
            Math.max(1, (host.parentElement?.clientWidth ?? width) - 32),
            Math.max(1, (host.parentElement?.clientHeight ?? height) - 32));

        // Interaction contract and regression matrix:
        // docs/mermaid-panzoom-integration.md
        void import('@panzoom/panzoom').then((module) => {
            if (disposed) return;
            const { dispose, panzoom } = initializeWebDiagramPanzoom(host, module.default, {
                startScale: fitScale(),
                onScaleChange: props.onScaleChange,
            });
            panzoomRef.current = panzoom;
            disposePanzoom = dispose;
            props.onScaleChange?.(fitScale());
            if (typeof ResizeObserver !== 'undefined' && host.parentElement) {
                let previousScale = fitScale();
                resizeObserver = new ResizeObserver(() => {
                    if (disposed) return;
                    const nextScale = fitScale();
                    if (nextScale === previousScale) return;
                    previousScale = nextScale;
                    panzoom.setOptions({ startScale: nextScale, minScale: Math.min(0.1, nextScale / 2) });
                    panzoom.reset({ animate: false });
                });
                resizeObserver.observe(host.parentElement);
            }
        });

        return () => {
            disposed = true;
            resizeObserver?.disconnect();
            disposePanzoom?.();
            panzoomRef.current = null;
        };
    }, [props.fullscreen, props.onScaleChange, svgContent]);

    if (hasError) return <DiagramError content={props.content} typography={props.typography} />;

    return (
        <View style={[styles.canvas, props.fullscreen ? styles.canvasFullscreen : styles.canvasPreview,
            !props.fullscreen && props.readableDesktopPreview && styles.canvasDesktopPreview]}>
            {svgContent ? (
                !props.fullscreen ? (
                    // Desktop uses natural 16px text, mobile keeps its width-fit preview. Clip overflow, don't height-fit.
                    // The passive image leaves scrolling to the chat, with the complete diagram in the lightbox.
                    // @ts-ignore React Native Web intentionally hosts this image.
                    <img
                        alt=""
                        draggable={false}
                        onLoad={(event: React.SyntheticEvent<HTMLImageElement>) => {
                            const width = event.currentTarget.naturalWidth;
                            if (Number.isFinite(width) && width > 0) props.onNaturalWidth?.(width);
                        }}
                        src={imageUri ?? undefined}
                        style={{ alignSelf: 'flex-start', display: 'block', flexShrink: 0, height: 'auto', padding: 16, paddingTop: 46,
                            boxSizing: 'border-box', width: props.readableDesktopPreview ? 'auto' : '100%' }}
                    />
                ) : (
                    // The SVG is generated by Mermaid from the fenced code block.
                    // @ts-ignore React Native Web intentionally hosts this DOM viewport.
                    <div
                        style={{
                            alignItems: 'center',
                            cursor: 'grab',
                            display: 'flex',
                            height: '100%',
                            justifyContent: 'center',
                            minHeight: 0,
                            overflow: 'hidden',
                            touchAction: 'none',
                            width: '100%',
                        }}
                    >
                        {/* @ts-ignore React Native Web intentionally hosts this DOM scene. */}
                        <div
                            ref={containerRef}
                            style={{
                                alignItems: 'center',
                                display: 'flex',
                                flexShrink: 0,
                                height: '100%',
                                justifyContent: 'center',
                                width: '100%',
                            }}
                            dangerouslySetInnerHTML={{ __html: svgContent }}
                        />
                    </div>
                )
            ) : (
                <View style={styles.loadingContainer}>
                    <View style={styles.loadingPlaceholder} />
                </View>
            )}
        </View>
    );
});

WebDiagramCanvas.displayName = 'WebDiagramCanvas';

const NativeDiagramCanvas = React.forwardRef<DiagramCanvasHandle, DiagramCanvasProps>((props, ref) => {
    const webViewRef = React.useRef<WebView>(null);
    const [hasError, setHasError] = React.useState(false);
    const [previewHeight, setPreviewHeight] = React.useState<number | null>(null);
    const [, saveImage] = useHappyAction(async (uri: string) => {
        await downloadImage({ uri, filename: 'paws-diagram.svg' });
    }, { fallbackErrorMessage: t('imageViewer.downloadFailedMessage') });
    const html = React.useMemo(
        () => buildNativeDocument(props.content, props.config, props.fullscreen === true),
        [props.config, props.content, props.fullscreen],
    );
    const source = React.useMemo(() => ({ html }), [html]);

    React.useEffect(() => {
        setHasError(false);
        setPreviewHeight(null);
    }, [html]);

    React.useImperativeHandle(ref, () => ({
        execute: (command) => {
            webViewRef.current?.injectJavaScript(`window.__pawsMermaid?.${command}(); true;`);
        },
        download: () => { webViewRef.current?.injectJavaScript('window.__pawsMermaid?.download(); true;'); },
    }), []);

    if (hasError) return <DiagramError content={props.content} typography={props.typography} />;

    return (
        <View
            pointerEvents={props.fullscreen ? 'auto' : 'none'}
            style={[styles.canvas, props.fullscreen ? styles.canvasFullscreen : styles.canvasPreview,
                !props.fullscreen && styles.nativePreview,
                !props.fullscreen && previewHeight !== null && { height: previewHeight }]}
        >
            <WebView
                ref={webViewRef}
                source={source}
                style={styles.webView}
                nestedScrollEnabled
                overScrollMode="never"
                scrollEnabled={props.fullscreen === true}
                showsHorizontalScrollIndicator={false}
                showsVerticalScrollIndicator={false}
                onError={() => setHasError(true)}
                onHttpError={() => setHasError(true)}
                onRenderProcessGone={() => setHasError(true)}
                onMessage={(event) => {
                    try {
                        const data = JSON.parse(event.nativeEvent.data);
                        if (data.type === 'error') {
                            setHasError(true);
                        } else if (data.type === 'previewHeight' && Number.isFinite(data.height) && data.height > 0) {
                            setPreviewHeight(data.height);
                        } else if (data.type === 'scale' && Number.isFinite(data.scale) && data.scale > 0) {
                            props.onScaleChange?.(data.scale);
                        } else if (data.type === 'download' && typeof data.uri === 'string' && data.uri.startsWith('data:image/svg+xml;base64,')) {
                            saveImage(data.uri);
                        }
                    } catch {
                        // Ignore messages that are not part of the diagram protocol.
                    }
                }}
            />
        </View>
    );
});

NativeDiagramCanvas.displayName = 'NativeDiagramCanvas';

const DiagramCanvas = Platform.OS === 'web' ? WebDiagramCanvas : NativeDiagramCanvas;

function DiagramToolbar(props: {
    execute: (command: DiagramCommand) => void;
    scale: number | null;
}) {
    return (
        <View style={styles.toolbar} testID="mermaid-zoom-toolbar">
            <DiagramButton
                accessibilityLabel={t('keyboardShortcuts.zoomOut')}
                disabled={props.scale === null}
                icon="minus"
                onPress={() => props.execute('zoomOut')}
                tooltipPlacement="above"
                testID="mermaid-zoom-out"
            />
            <DiagramButton
                accessibilityLabel={t('keyboardShortcuts.resetZoom')}
                disabled={props.scale === null}
                label={props.scale === null ? '—' : `${Math.round(props.scale * 100)}%`}
                onPress={() => props.execute('reset')}
                tooltipPlacement="above"
                testID="mermaid-zoom-reset"
            />
            <DiagramButton
                accessibilityLabel={t('keyboardShortcuts.zoomIn')}
                disabled={props.scale === null}
                icon="plus"
                onPress={() => props.execute('zoomIn')}
                tooltipPlacement="above"
                testID="mermaid-zoom-in"
            />
        </View>
    );
}

function DiagramButton(props: {
    accessibilityLabel: string;
    disabled?: boolean;
    icon?: React.ComponentProps<typeof Feather>['name'];
    label?: string;
    onPress: () => void;
    testID: string;
    tooltipPlacement?: 'above' | 'below';
}) {
    const { theme } = useUnistyles();
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    return (
        <View>
            <Pressable
                accessibilityLabel={props.accessibilityLabel}
                accessibilityRole="button"
                accessibilityState={{ disabled: props.disabled === true }}
                disabled={props.disabled}
                hitSlop={6}
                onHoverIn={() => setHovered(true)}
                onHoverOut={() => setHovered(false)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onPress={props.onPress}
                style={({ pressed }) => [styles.toolbarButton, props.label && styles.zoomLabelButton,
                    (hovered || focused || pressed) && styles.toolbarButtonPressed, props.disabled && styles.toolbarButtonDisabled]}
                testID={props.testID}
            >
                {props.label ? (
                    <Text style={styles.zoomLabel} testID="mermaid-zoom-percent">{props.label}</Text>
                ) : props.icon ? <Feather color={theme.colors.text} name={props.icon} size={20} /> : null}
            </Pressable>
            <DesktopShortcutTooltip
                align="center"
                compact
                label={props.accessibilityLabel}
                placement={props.tooltipPlacement ?? 'below'}
                testID={`${props.testID}-tooltip`}
                visible={Platform.OS === 'web' && (hovered || focused)}
            />
        </View>
    );
}

function DiagramSurface(props: {
    canvasRef: React.RefObject<DiagramCanvasHandle | null>;
    config: MermaidThemeConfig;
    content: string;
    fullscreen?: boolean;
    typography: MarkdownTypographyMode;
    onCloseFullscreen?: () => void;
    onOpenFullscreen?: () => void;
}) {
    const { theme } = useUnistyles();
    const { width: windowWidth } = useWindowDimensions();
    const readableDesktopPreview = Platform.OS === 'web' && windowWidth >= 768;
    const [naturalWidth, setNaturalWidth] = React.useState<number | null>(null);
    const [scale, setScale] = React.useState<number | null>(null);
    const execute = React.useCallback((command: DiagramCommand) => {
        props.canvasRef.current?.execute(command);
    }, [props.canvasRef]);

    if (!props.fullscreen) {
        return (
            <Pressable
                accessibilityLabel={t('markdown.mermaidOpenFullscreen')}
                accessibilityRole="button"
                onPress={props.onOpenFullscreen}
                style={[styles.previewTrigger, readableDesktopPreview && naturalWidth !== null && { width: naturalWidth + 34 }]}
                testID="mermaid-fullscreen-open"
            >
                <View style={styles.surface} testID="mermaid-inline-surface">
                    <DiagramCanvas
                        ref={props.canvasRef}
                        config={props.config}
                        content={props.content}
                        onNaturalWidth={setNaturalWidth}
                        readableDesktopPreview={readableDesktopPreview}
                        typography={props.typography}
                    />
                    <View pointerEvents="none" style={styles.previewBadge} testID="mermaid-preview-badge">
                        <Feather color={theme.colors.textSecondary} name="maximize-2" size={16} />
                    </View>
                </View>
            </Pressable>
        );
    }

    return (
        <View style={styles.fullscreenLayout} testID="mermaid-fullscreen-layout">
            <View style={[styles.surface, styles.surfaceFullscreen]} testID="mermaid-fullscreen-surface">
                <DiagramCanvas
                    ref={props.canvasRef}
                    config={props.config}
                    content={props.content}
                    fullscreen
                    onScaleChange={setScale}
                    typography={props.typography}
                />
            </View>
            <View style={styles.topActions} testID="mermaid-lightbox-actions">
                <DiagramButton
                    accessibilityLabel={t('imageViewer.download')}
                    disabled={scale === null}
                    icon="download"
                    onPress={() => props.canvasRef.current?.download()}
                    testID="mermaid-download"
                />
                <DiagramButton
                    accessibilityLabel={t('markdown.mermaidCloseFullscreen')}
                    icon="x"
                    onPress={() => props.onCloseFullscreen?.()}
                    testID="mermaid-fullscreen-close"
                />
            </View>
            <DiagramToolbar execute={execute} scale={scale} />
        </View>
    );
}

export const MermaidRenderer = React.memo((props: { content: string; typography?: MarkdownTypographyMode }) => {
    const { theme } = useUnistyles();
    const [fullscreen, setFullscreen] = React.useState(false);
    const inlineCanvasRef = React.useRef<DiagramCanvasHandle>(null);
    const fullscreenCanvasRef = React.useRef<DiagramCanvasHandle>(null);
    const config = React.useMemo(() => createMermaidThemeConfig(theme), [theme]);
    const closeFullscreen = React.useCallback(() => setFullscreen(false), []);
    const openFullscreen = React.useCallback(() => setFullscreen(true), []);

    return (
        <View style={styles.container}>
            <DiagramSurface
                canvasRef={inlineCanvasRef}
                config={config}
                content={props.content}
                onOpenFullscreen={openFullscreen}
                typography={props.typography ?? 'default'}
            />
            <Modal
                animationType="fade"
                onRequestClose={closeFullscreen}
                navigationBarTranslucent
                statusBarTranslucent
                transparent
                visible={fullscreen}
            >
                {fullscreen ? (
                    <View style={styles.fullscreenBackdrop} testID="mermaid-fullscreen-backdrop">
                        <DiagramSurface
                            canvasRef={fullscreenCanvasRef}
                            config={config}
                            content={props.content}
                            fullscreen
                            onCloseFullscreen={closeFullscreen}
                            typography={props.typography ?? 'default'}
                        />
                    </View>
                ) : null}
            </Modal>
        </View>
    );
});

const styles = StyleSheet.create((theme, runtime) => ({
    container: {
        marginVertical: 8,
        width: '100%',
    },
    previewTrigger: {
        alignSelf: 'flex-start',
        maxWidth: '100%',
        width: '100%',
    },
    surface: {
        backgroundColor: theme.colors.surfaceHighest,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        overflow: 'hidden',
        width: '100%',
    },
    surfaceFullscreen: {
        borderRadius: 20,
        borderWidth: 0,
        flex: 1,
        width: '100%',
    },
    fullscreenBackdrop: {
        backgroundColor: theme.colors.modal.backdrop,
        flex: 1,
    },
    fullscreenLayout: {
        alignItems: 'center',
        flex: 1,
        paddingBottom: runtime.insets.bottom + 80,
        paddingTop: runtime.insets.top + 64,
        paddingHorizontal: runtime.screen.width >= 768 ? 28 : 12,
        width: '100%',
    },
    topActions: {
        position: 'absolute',
        top: runtime.insets.top + 10,
        right: 12,
        flexDirection: 'row',
        gap: 8,
        zIndex: 2,
    },
    toolbar: {
        alignItems: 'center',
        alignSelf: 'center',
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.divider,
        borderRadius: 32,
        borderWidth: StyleSheet.hairlineWidth,
        position: 'absolute',
        bottom: runtime.insets.bottom + 16,
        flexDirection: 'row',
        gap: 4,
        padding: 4,
        zIndex: 1,
    },
    toolbarButton: {
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceHigh,
        ...(Platform.OS === 'web' ? { outlineColor: theme.colors.textSecondary } : {}),
        borderRadius: 22,
        height: 44,
        justifyContent: 'center',
        width: 44,
    },
    toolbarButtonPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    toolbarButtonDisabled: { opacity: 0.4 },
    zoomLabelButton: {
        backgroundColor: theme.colors.surface,
        width: 68,
    },
    zoomLabel: {
        ...Typography.default(),
        color: theme.colors.text,
        fontSize: 14,
    },
    canvas: {
        backgroundColor: theme.colors.surfaceHighest,
        minHeight: 220,
        overflow: 'hidden',
        width: '100%',
    },
    canvasFullscreen: {
        backgroundColor: theme.colors.surface,
        flex: 1,
        minHeight: 0,
    },
    canvasPreview: {
        maxHeight: Math.round(runtime.screen.height * 0.7),
        minHeight: 0,
    },
    canvasDesktopPreview: {
        maxHeight: Math.min(480, Math.round(runtime.screen.height * 0.6)),
    },
    nativePreview: {
        height: Math.round(runtime.screen.height * 0.7),
    },
    previewBadge: {
        alignItems: 'center',
        backgroundColor: theme.colors.surface,
        borderRadius: 6,
        height: 30,
        justifyContent: 'center',
        position: 'absolute',
        right: 8,
        top: 8,
        width: 30,
    },
    webView: {
        backgroundColor: theme.colors.surfaceHighest,
        flex: 1,
    },
    loadingContainer: {
        alignItems: 'center',
        flex: 1,
        justifyContent: 'center',
        minHeight: 220,
    },
    loadingPlaceholder: {
        backgroundColor: theme.colors.divider,
        borderRadius: 4,
        height: 20,
        width: 200,
    },
    errorContainer: {
        padding: 16,
    },
    errorContent: {
        flexDirection: 'column',
        gap: 12,
    },
    errorText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 16,
    },
    codeBlock: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 4,
        padding: 12,
    },
    codeText: {
        ...Typography.mono(),
        color: theme.colors.text,
        fontSize: 14,
        lineHeight: 20,
    },
}));
