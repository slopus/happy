/**
 * Fullscreen, zoomable Mermaid diagram viewer (native: iOS / Android).
 *
 * Opened via `Modal.show({ component: MermaidViewer, props: { content } })` from
 * the expand button on an inline diagram. Re-renders the diagram in a fullscreen
 * WebView and zooms the SVG *inside* the WebView. Pinch / pan / double-tap are
 * handled by injected JS, so there's no `svg-pan-zoom` dependency. The page, and
 * why its zoom is two-phase, are in `mermaidViewerHtml.ts`.
 *
 * Web has a separate implementation in `MermaidViewer.web.tsx`; it never sets
 * `will-change`, and was measured crisp under the same test.
 */
import * as React from 'react';
import { View, StyleSheet, Pressable, useWindowDimensions } from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { mermaidViewerHtml } from './mermaidViewerHtml';

interface MermaidViewerProps {
    content: string;
    onClose: () => void;
}

export function MermaidViewer({ content, onClose }: MermaidViewerProps) {
    const { width, height } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const html = React.useMemo(() => mermaidViewerHtml(content), [content]);

    return (
        <View style={[styles.root, { width, height }]}>
            <WebView
                source={{ html }}
                style={styles.webview}
                scrollEnabled={false}
                originWhitelist={['*']}
            />
            <Pressable
                onPress={onClose}
                hitSlop={16}
                style={[styles.close, { top: Math.max(insets.top, 12) + 4 }]}
                accessibilityRole="button"
                accessibilityLabel="Close diagram"
            >
                <Ionicons name="close" size={26} color="#fff" />
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { backgroundColor: '#000' },
    webview: { flex: 1, backgroundColor: '#000' },
    close: {
        position: 'absolute',
        right: 12,
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.45)',
    },
});
