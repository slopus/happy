import * as React from 'react';
import { View, Platform, Text, Pressable, Modal, ScrollView } from 'react-native';
import { WebView } from 'react-native-webview';
import { StyleSheet, UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';

const KROKI_BASE_URL = process.env.EXPO_PUBLIC_LEARN_API_URL
    ? `${process.env.EXPO_PUBLIC_LEARN_API_URL}/kroki`
    : '/kroki';

export type DiagramType = 'mermaid' | 'd2';

// D2 default dark theme
const D2_DARK_THEME_ID = 200; // Dark Mauve

function d2HasExplicitTheme(source: string): boolean {
    return /theme-id\s*:/m.test(source);
}

function d2InjectDarkTheme(source: string): string {
    // Prepend vars block with dark theme
    return `vars: {\n  d2-config: {\n    theme-id: ${D2_DARK_THEME_ID}\n  }\n}\n${source}`;
}

// SVG cache to avoid re-rendering identical diagrams
const svgCache = new Map<string, string>();

async function renderViaKroki(diagramSource: string, diagramType: DiagramType = 'mermaid', isDark: boolean = true): Promise<string> {
    const cacheKey = `${diagramType}:${isDark}:${diagramSource}`;
    const cached = svgCache.get(cacheKey);
    if (cached) return cached;

    const url = `${KROKI_BASE_URL}/${diagramType}/svg`;

    let body: string;
    let contentType: string;

    if (diagramType === 'd2') {
        // Auto-inject Dark Mauve theme when in dark mode and no explicit theme set
        body = (isDark && !d2HasExplicitTheme(diagramSource))
            ? d2InjectDarkTheme(diagramSource)
            : diagramSource;
        contentType = 'text/plain';
    } else {
        // Always use 'neutral' theme — renders on light container for max contrast
        body = JSON.stringify({ diagram_source: diagramSource, diagram_options: { theme: 'neutral' } });
        contentType = 'application/json';
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body,
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Kroki error ${res.status}: ${errorText}`);
    }

    let svg = await res.text();

    // Make SVG responsive
    svg = svg.replace(
        /(<svg[^>]*)(>)/,
        '$1 style="width:100%;height:auto;max-width:100%"$2'
    );

    svgCache.set(cacheKey, svg);
    return svg;
}

// Naive D2→Mermaid converter for basic diagrams
function d2ToMermaid(d2Source: string): string {
    const lines = d2Source.split('\n');
    const mermaidLines: string[] = [];
    let directionSet = false;

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        // direction
        if (line.startsWith('direction:')) {
            const dir = line.split(':')[1]?.trim();
            if (dir === 'right') { mermaidLines.unshift('graph LR'); directionSet = true; }
            else if (dir === 'down') { mermaidLines.unshift('graph TD'); directionSet = true; }
            else if (dir === 'left') { mermaidLines.unshift('graph RL'); directionSet = true; }
            else if (dir === 'up') { mermaidLines.unshift('graph BT'); directionSet = true; }
            continue;
        }

        // Skip style lines, shape, vars blocks
        if (line.startsWith('style.') || line.startsWith('shape:') || line.startsWith('vars:') || line.startsWith('d2-config:') || line.startsWith('theme-id:')) continue;
        // Skip lone braces
        if (line === '{' || line === '}') continue;

        // Arrow: A -> B: label
        const arrowMatch = line.match(/^([^{}\->]+?)\s*->\s*([^{}\->:]+?)(?:\s*:\s*(.+?))?(?:\s*\{)?$/);
        if (arrowMatch) {
            const from = arrowMatch[1].trim().replace(/[^a-zA-Zа-яА-ЯёЁ0-9_ ]/g, '');
            const to = arrowMatch[2].trim().replace(/[^a-zA-Zа-яА-ЯёЁ0-9_ ]/g, '');
            const label = arrowMatch[3]?.trim();
            const fromId = from.replace(/\s+/g, '_');
            const toId = to.replace(/\s+/g, '_');
            if (label) {
                mermaidLines.push(`    ${fromId}["${from}"] -->|${label}| ${toId}["${to}"]`);
            } else {
                mermaidLines.push(`    ${fromId}["${from}"] --> ${toId}["${to}"]`);
            }
            continue;
        }

        // Container: Name: { — skip (mermaid subgraphs are complex)
        // Standalone node: Name or Name: label
        const nodeMatch = line.match(/^([a-zA-Zа-яА-ЯёЁ0-9_ ]+?)(?:\s*:\s*(.+?))?(?:\s*\{)?$/);
        if (nodeMatch && !line.endsWith('}')) {
            // Skip if it looks like a container opening (has {)
            if (line.includes('{')) continue;
            // Standalone node
            const name = nodeMatch[1].trim();
            const label = nodeMatch[2]?.trim();
            const id = name.replace(/\s+/g, '_');
            if (label) {
                mermaidLines.push(`    ${id}["${label}"]`);
            }
            // Don't add standalone nodes without labels — they'll be created by arrows
            continue;
        }
    }

    if (!directionSet) {
        mermaidLines.unshift('graph TD');
    }

    return mermaidLines.join('\n');
}

// Fullscreen modal for diagrams — maximum content, minimal chrome
const DiagramModal = React.memo(({ svg, visible, onClose, diagramType }: { svg: string; visible: boolean; onClose: () => void; diagramType?: DiagramType }) => {
    React.useEffect(() => {
        if (!visible || Platform.OS !== 'web') return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [visible, onClose]);

    if (!visible) return null;

    const isMermaid = (diagramType || 'mermaid') === 'mermaid';
    // Make SVG fill the viewport: strip fixed width/height from SVG, use viewBox only
    const expandedSvg = svg
        .replace(/(<svg[^>]*)\s+style="[^"]*"/g, '$1')
        .replace(/(<svg[^>]*)(>)/, '$1 style="width:100%;height:100%;max-width:100vw;max-height:100vh"$2');

    return (
        <Modal transparent animationType="fade" visible={visible} onRequestClose={onClose}>
            <Pressable
                onPress={onClose}
                style={{
                    flex: 1,
                    backgroundColor: isMermaid ? '#f0f1f3' : 'rgba(0,0,0,0.95)',
                    justifyContent: 'center', alignItems: 'center',
                    padding: 8,
                }}
            >
                <Pressable
                    onPress={onClose}
                    style={{ position: 'absolute', top: 16, right: 16, zIndex: 10, padding: 8,
                        backgroundColor: isMermaid ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.15)',
                        borderRadius: 20 }}
                >
                    <Ionicons name="close" size={22} color={isMermaid ? '#333' : '#fff'} />
                </Pressable>
                {Platform.OS === 'web' && (
                    // @ts-ignore
                    <div
                        style={{
                            width: '100%',
                            height: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            overflow: 'auto',
                        }}
                        onClick={(e: any) => e.stopPropagation()}
                        dangerouslySetInnerHTML={{ __html: expandedSvg }}
                    />
                )}
            </Pressable>
        </Modal>
    );
});

// Diagram renderer using Kroki server-side rendering
export const MermaidRenderer = React.memo((props: {
    content: string;
    diagramType?: DiagramType;
}) => {
    const { theme } = useUnistyles();
    const isDark = UnistylesRuntime.themeName?.startsWith('dark') ?? true;
    const [svgContent, setSvgContent] = React.useState<string | null>(null);
    const [hasError, setHasError] = React.useState(false);
    const [errorMsg, setErrorMsg] = React.useState('');
    const [retryKey, setRetryKey] = React.useState(0);
    const [fullscreen, setFullscreen] = React.useState(false);
    const [dimensions, setDimensions] = React.useState({ width: 0, height: 200 });
    const [codeExpanded, setCodeExpanded] = React.useState(false);
    // Track which type rendered successfully (for fallback display)
    const [renderedType, setRenderedType] = React.useState<DiagramType | null>(null);
    const [fallbackAttempted, setFallbackAttempted] = React.useState(false);

    const onLayout = React.useCallback((event: any) => {
        const { width } = event.nativeEvent.layout;
        setDimensions(prev => ({ ...prev, width }));
    }, []);

    React.useEffect(() => {
        let isMounted = true;
        setSvgContent(null);
        setHasError(false);
        setErrorMsg('');
        setRenderedType(null);
        setFallbackAttempted(false);
        setCodeExpanded(false);

        const originalType = props.diagramType || 'mermaid';

        const renderWithTimeout = (source: string, type: DiagramType) => Promise.race([
            renderViaKroki(source, type, isDark),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Kroki timeout')), 30000)
            ),
        ]);

        const render = async () => {
            // Attempt 1: original type
            try {
                const svg = await renderWithTimeout(props.content, originalType);
                if (isMounted) { setSvgContent(svg); setRenderedType(originalType); }
                return;
            } catch (firstError) {
                // Attempt 2: retry original after 2s
                try {
                    await new Promise(r => setTimeout(r, 2000));
                    if (!isMounted) return;
                    const svg = await renderWithTimeout(props.content, originalType);
                    if (isMounted) { setSvgContent(svg); setRenderedType(originalType); }
                    return;
                } catch {
                    // Original type failed twice
                }
            }

            // Attempt 3: if D2 failed, try Mermaid fallback via naive conversion
            if (originalType === 'd2') {
                if (isMounted) setFallbackAttempted(true);
                try {
                    const mermaidSource = d2ToMermaid(props.content);
                    if (mermaidSource.split('\n').length > 1) { // Has at least graph + 1 node
                        const svg = await renderWithTimeout(mermaidSource, 'mermaid');
                        if (isMounted) { setSvgContent(svg); setRenderedType('mermaid'); }
                        return;
                    }
                } catch (mermaidError) {
                    console.warn(`[Kroki] Mermaid fallback also failed: ${mermaidError instanceof Error ? mermaidError.message : String(mermaidError)}`);
                }
            }

            // All attempts failed
            if (isMounted) {
                setHasError(true);
                setErrorMsg(originalType === 'd2' ? 'D2 синтаксис не удалось отрендерить' : 'Ошибка рендеринга');
            }
        };

        render();
        return () => { isMounted = false; };
    }, [props.content, props.diagramType, isDark, retryKey]);

    if (hasError) {
        const maxCodeLines = 6;
        const codeLines = props.content.split('\n');
        const isLong = codeLines.length > maxCodeLines;
        const displayCode = codeExpanded ? props.content : codeLines.slice(0, maxCodeLines).join('\n') + (isLong ? '\n...' : '');

        return (
            <View style={[style.container, style.errorContainer]}>
                <View style={style.errorContent}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                            <Ionicons name="alert-circle-outline" size={16} color={theme.colors.textSecondary} />
                            <Text style={[style.errorText, { fontSize: 14 }]}>{errorMsg || 'Ошибка диаграммы'}</Text>
                        </View>
                        <Pressable onPress={() => setRetryKey(k => k + 1)} hitSlop={8}>
                            <Ionicons name="refresh-outline" size={18} color={theme.colors.textLink} />
                        </Pressable>
                    </View>
                    <Pressable
                        onPress={() => setCodeExpanded(p => !p)}
                        style={style.codeBlock}
                    >
                        <Text style={style.codeText} numberOfLines={codeExpanded ? undefined : maxCodeLines}>{displayCode}</Text>
                        {isLong && (
                            <Text style={{ fontSize: 11, color: theme.colors.textLink, marginTop: 4, ...Typography.default('semiBold') }}>
                                {codeExpanded ? 'Свернуть' : 'Показать всё'}
                            </Text>
                        )}
                    </Pressable>
                </View>
            </View>
        );
    }

    if (!svgContent) {
        return (
            <View style={[style.container, style.loadingContainer]}>
                <View style={style.loadingPlaceholder} />
            </View>
        );
    }

    // Determine display type for styling
    const displayType = renderedType || props.diagramType || 'mermaid';
    const isMermaidDisplay = displayType === 'mermaid';

    if (Platform.OS === 'web') {
        return (
            <>
                <Pressable onPress={() => setFullscreen(true)} style={style.container}>
                    {/* Fallback indicator */}
                    {fallbackAttempted && renderedType === 'mermaid' && (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4, opacity: 0.5 }}>
                            <Ionicons name="swap-horizontal-outline" size={12} color={theme.colors.textSecondary} />
                            <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                D2 → Mermaid fallback
                            </Text>
                        </View>
                    )}
                    {/* @ts-ignore - Web only */}
                    <div
                        style={{
                            backgroundColor: isMermaidDisplay ? '#f8f9fa' : 'transparent',
                            borderRadius: 10,
                            padding: isMermaidDisplay ? 8 : 0,
                            overflow: 'hidden',
                            cursor: 'zoom-in',
                        }}
                        dangerouslySetInnerHTML={{ __html: svgContent }}
                    />
                    <View style={{ position: 'absolute', bottom: 6, right: 6, opacity: 0.3 }}>
                        <Ionicons name="expand-outline" size={14} color={isMermaidDisplay ? '#666' : theme.colors.textSecondary} />
                    </View>
                </Pressable>
                <DiagramModal svg={svgContent} visible={fullscreen} onClose={() => setFullscreen(false)} diagramType={displayType} />
            </>
        );
    }

    // For iOS/Android, render SVG in WebView
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body {
                    margin: 0;
                    padding: ${isMermaidDisplay ? '4px' : '0'};
                    background-color: ${isMermaidDisplay ? '#f8f9fa' : 'transparent'};
                    display: flex;
                    justify-content: center;
                    align-items: center;
                }
                svg { width: 100%; height: auto; }
            </style>
        </head>
        <body>${svgContent}</body>
        </html>
    `;

    return (
        <View style={style.container} onLayout={onLayout}>
            <View style={[style.innerContainer, isMermaidDisplay && { backgroundColor: '#f8f9fa' }, { height: dimensions.height }]}>
                <WebView
                    source={{ html }}
                    style={{ flex: 1 }}
                    scrollEnabled={false}
                    onMessage={(event) => {
                        const data = JSON.parse(event.nativeEvent.data);
                        if (data.type === 'dimensions') {
                            setDimensions(prev => ({
                                ...prev,
                                height: Math.max(prev.height, data.height),
                            }));
                        }
                    }}
                />
            </View>
        </View>
    );
});

const style = StyleSheet.create((theme) => ({
    container: {
        marginVertical: 8,
        width: '100%',
    },
    innerContainer: {
        width: '100%',
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 12,
    },
    loadingContainer: {
        justifyContent: 'center',
        alignItems: 'center',
        height: 100,
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 12,
    },
    loadingPlaceholder: {
        width: 200,
        height: 20,
        backgroundColor: theme.colors.divider,
        borderRadius: 4,
    },
    errorContainer: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 12,
        padding: 14,
    },
    errorContent: {
        flexDirection: 'column',
        gap: 10,
    },
    errorText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 14,
    },
    codeBlock: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 8,
        padding: 12,
    },
    codeText: {
        ...Typography.mono(),
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 18,
    },
}));
