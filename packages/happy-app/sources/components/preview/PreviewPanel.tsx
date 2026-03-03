import * as React from 'react';
import { View, Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import WebView from 'react-native-webview';
import { storage, usePreviewState, useSelectedElement } from '@/sync/storage';
import { PreviewToolbar } from './PreviewToolbar';
import { DevServerPicker } from './DevServerPicker';
import { getInspectorScript } from './inspectorScript';
import { type SelectedElement } from 'happy-wire';
import { useAutoRefresh } from './useAutoRefresh';

interface PreviewPanelProps {
    sessionId: string;
    onClose: () => void;
}

export const PreviewPanel = React.memo(({ sessionId, onClose }: PreviewPanelProps) => {
    const { theme } = useUnistyles();
    const previewState = usePreviewState(sessionId);
    const webviewRef = React.useRef<WebView>(null);

    // Auto-refresh on code changes
    const handleAutoRefresh = React.useCallback((type: 'css' | 'full') => {
        if (!webviewRef.current) return;
        if (previewState?.hasHMR) return; // Skip if HMR is active
        webviewRef.current.postMessage(
            JSON.stringify({ type: type === 'css' ? 'css-update' : 'full-reload' })
        );
    }, [previewState?.hasHMR]);
    useAutoRefresh(sessionId, handleAutoRefresh);

    // Local state
    const [urlInput, setUrlInput] = React.useState(previewState?.url ?? '');
    const [scanning, setScanning] = React.useState(false);
    const [servers, setServers] = React.useState<Array<{ port: number; title?: string }>>([]);

    // Keep urlInput in sync with store url
    React.useEffect(() => {
        if (previewState?.url) {
            setUrlInput(previewState.url);
        }
    }, [previewState?.url]);

    // Scan for dev servers on mount (stub -- RPC integration comes later)
    React.useEffect(() => {
        setScanning(true);
        // TODO: Replace with actual RPC port-scan call
        const timer = setTimeout(() => {
            setServers([]);
            setScanning(false);
        }, 500);
        return () => clearTimeout(timer);
    }, []);

    const url = previewState?.url ?? null;
    const inspectMode = previewState?.inspectMode ?? false;

    // ---- Handlers ----

    const handleUrlSubmit = React.useCallback(() => {
        const trimmed = urlInput.trim();
        if (!trimmed) return;
        const normalized = trimmed.startsWith('http') ? trimmed : `http://${trimmed}`;
        storage.getState().setPreviewState(sessionId, { url: normalized });
    }, [urlInput, sessionId]);

    const handleServerSelect = React.useCallback((selectedUrl: string) => {
        setUrlInput(selectedUrl);
        storage.getState().setPreviewState(sessionId, { url: selectedUrl });
    }, [sessionId]);

    const handleRefreshScan = React.useCallback(() => {
        setScanning(true);
        // TODO: Replace with actual RPC port-scan call
        setTimeout(() => {
            setServers([]);
            setScanning(false);
        }, 500);
    }, []);

    const handleToggleInspect = React.useCallback(() => {
        const next = !inspectMode;
        storage.getState().setPreviewState(sessionId, { inspectMode: next });
        webviewRef.current?.postMessage(
            JSON.stringify({ type: 'set-inspect-mode', enabled: next })
        );
    }, [inspectMode, sessionId]);

    const handleRefresh = React.useCallback(() => {
        webviewRef.current?.reload();
    }, []);

    const handleClose = React.useCallback(() => {
        storage.getState().setPreviewState(sessionId, { isVisible: false });
        onClose();
    }, [sessionId, onClose]);

    const handleWebViewMessage = React.useCallback((event: { nativeEvent: { data: string } }) => {
        try {
            const data = JSON.parse(event.nativeEvent.data);
            if (!data || typeof data !== 'object') return;

            switch (data.type) {
                case 'element-selected':
                    storage.getState().setPreviewState(sessionId, {
                        selectedElement: data as SelectedElement,
                    });
                    break;
                case 'hmr-status':
                    storage.getState().setPreviewState(sessionId, {
                        hasHMR: data.hasHMR,
                    });
                    break;
            }
        } catch {
            // Ignore non-JSON messages
        }
    }, [sessionId]);

    return (
        <View style={styles.root}>
            <PreviewToolbar
                url={urlInput}
                onUrlChange={setUrlInput}
                onUrlSubmit={handleUrlSubmit}
                inspectMode={inspectMode}
                onToggleInspect={handleToggleInspect}
                onRefresh={handleRefresh}
                onClose={handleClose}
            />
            {url ? (
                <WebView
                    ref={webviewRef}
                    source={{ uri: url }}
                    style={{ flex: 1 }}
                    injectedJavaScript={getInspectorScript()}
                    onMessage={handleWebViewMessage}
                    javaScriptEnabled
                    domStorageEnabled
                    startInLoadingState
                    allowsInlineMediaPlayback
                />
            ) : (
                <DevServerPicker
                    servers={servers}
                    onSelect={handleServerSelect}
                    onRefreshScan={handleRefreshScan}
                    scanning={scanning}
                />
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        backgroundColor: theme.colors.background,
    },
}));
