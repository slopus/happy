import * as React from 'react';
import { View, Text, Platform, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons, FontAwesome6 } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { toolFullViewStyles } from '../ToolFullView';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { LongPressCopy, useCopySelectable } from '@/components/LongPressCopy';
import { setPreviewHtml } from '../previewHtmlStore';

interface PreviewHtmlViewFullProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

const MIN_PREVIEW_HEIGHT = 200;
/** Safety cap to prevent infinite resize loops (e.g. content with 100vh) */
const MAX_PREVIEW_HEIGHT = 10000;

/**
 * Inject a script into HTML that reports document height to the parent via postMessage.
 * Uses ResizeObserver for dynamic content changes.
 */
function injectHeightScript(html: string): string {
    const script = `<script>(function(){function r(){var h=Math.max(document.documentElement.scrollHeight,document.body.scrollHeight);window.parent.postMessage({type:'happy-preview-resize',height:h},'*');}if(typeof ResizeObserver!=='undefined'){new ResizeObserver(r).observe(document.documentElement);}r();window.addEventListener('load',r);})()</script>`;
    if (html.includes('</body>')) return html.replace('</body>', script + '</body>');
    if (html.includes('</html>')) return html.replace('</html>', script + '</html>');
    return html + script;
}

/** Injected JS for native WebView to report content height */
const NATIVE_HEIGHT_SCRIPT = `(function(){function r(){var h=Math.max(document.documentElement.scrollHeight,document.body.scrollHeight);window.ReactNativeWebView.postMessage(JSON.stringify({type:'resize',height:h}));}if(typeof ResizeObserver!=='undefined'){new ResizeObserver(r).observe(document.documentElement);}r();window.addEventListener('load',r);})();true;`;

export const PreviewHtmlViewFull = React.memo<PreviewHtmlViewFullProps>(({ tool }) => {
    const html = typeof tool.input?.html === 'string' ? tool.input.html : null;
    const title = typeof tool.input?.title === 'string' ? tool.input.title : null;
    const selectable = useCopySelectable();
    const { theme } = useUnistyles();
    const [contentHeight, setContentHeight] = React.useState(MIN_PREVIEW_HEIGHT);

    // Web: listen for height messages from iframe
    React.useEffect(() => {
        if (Platform.OS !== 'web' || !html) return;
        const handler = (e: MessageEvent) => {
            if (e.data?.type === 'happy-preview-resize' && typeof e.data.height === 'number') {
                setContentHeight(Math.min(Math.max(e.data.height, MIN_PREVIEW_HEIGHT), MAX_PREVIEW_HEIGHT));
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [html, MAX_PREVIEW_HEIGHT]);

    // Native: callback from WebView onMessage
    const handleNativeHeight = React.useCallback((h: number) => {
        setContentHeight(Math.min(Math.max(h, MIN_PREVIEW_HEIGHT), MAX_PREVIEW_HEIGHT));
    }, [MAX_PREVIEW_HEIGHT]);

    // Inject height-reporting script into HTML for iframe
    const enhancedHtml = React.useMemo(() => html ? injectHeightScript(html) : null, [html]);

    // Loading state: tool is still running, HTML not yet available
    if (tool.state === 'running') {
        return (
            <View style={styles.centerContainer}>
                <ActivityIndicator size="small" />
            </View>
        );
    }

    // Error state: show error message (matches EditViewFull pattern)
    if (tool.state === 'error' && tool.result) {
        const errorText = String(tool.result);
        return (
            <View style={toolFullViewStyles.section}>
                <View style={toolFullViewStyles.sectionHeader}>
                    <Ionicons name="close-circle" size={20} color="#FF3B30" />
                    <Text style={toolFullViewStyles.sectionTitle}>Error</Text>
                </View>
                <LongPressCopy text={errorText}>
                    <View style={toolFullViewStyles.errorContainer}>
                        <Text selectable={selectable} style={toolFullViewStyles.errorText}>{errorText}</Text>
                    </View>
                </LongPressCopy>
            </View>
        );
    }

    // No HTML content
    if (!html) {
        return (
            <View style={styles.centerContainer}>
                <Text style={toolFullViewStyles.description}>No HTML content available</Text>
            </View>
        );
    }

    const router = useRouter();
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();

    const handleOpenInNewWindow = React.useCallback(() => {
        if (Platform.OS === 'web') {
            const win = window.open('', '_blank');
            if (win) {
                win.document.write(html);
                win.document.close();
            }
        } else if (sessionId) {
            setPreviewHtml(html, title);
            router.push(`/session/${sessionId}/preview`);
        }
    }, [html, title, sessionId, router]);

    return (
        <View style={styles.container}>
            <View style={styles.titleBar}>
                <Text style={styles.titleText} numberOfLines={1}>{title || 'Preview'}</Text>
                <Pressable style={styles.openButton} onPress={handleOpenInNewWindow}>
                    <FontAwesome6 name="window-restore" size={16} color={theme.colors.textSecondary} />
                </Pressable>
            </View>
            <View style={[styles.previewContainer, { height: contentHeight }]}>
                {Platform.OS === 'web' ? (
                    // @ts-ignore -- iframe is web-only DOM element, not in RN types
                    <iframe
                        srcDoc={enhancedHtml!}
                        sandbox="allow-scripts"
                        style={{ width: '100%', height: '100%', border: 'none' }}
                    />
                ) : (
                    <NativeWebView html={html} onHeightChange={handleNativeHeight} />
                )}
            </View>
        </View>
    );
});

/**
 * Lazy-loaded WebView for native platforms only.
 * Uses require() to avoid importing react-native-webview on web where it's unavailable.
 * Reports content height via onHeightChange for auto-sizing.
 */
function NativeWebView({ html, onHeightChange }: { html: string; onHeightChange: (h: number) => void }) {
    const WebView = require('react-native-webview').default;
    const handleMessage = React.useCallback((event: any) => {
        try {
            const data = JSON.parse(event.nativeEvent.data);
            if (data.type === 'resize' && typeof data.height === 'number') {
                onHeightChange(data.height);
            }
        } catch { /* ignore non-JSON messages */ }
    }, [onHeightChange]);

    return (
        <WebView
            source={{ html }}
            style={styles.webview}
            originWhitelist={['*']}
            javaScriptEnabled={true}
            scrollEnabled={true}
            injectedJavaScript={NATIVE_HEIGHT_SCRIPT}
            onMessage={handleMessage}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
    centerContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: 48,
    },
    titleBar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    titleText: {
        flex: 1,
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.text,
    },
    previewContainer: {
        position: 'relative',
        marginBottom: 24,
    },
    openButton: {
        padding: 6,
        marginLeft: 8,
    },
    webview: {
        flex: 1,
    },
}));
