import * as React from 'react';
import { View, Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import WebView from 'react-native-webview';
import { storage, usePreviewState, useSelectedElement } from '@/sync/storage';
import { PreviewToolbar } from './PreviewToolbar';
import { DeviceBar } from './DeviceBar';
import { DevServerPicker } from './DevServerPicker';
import { getInspectorScript } from './inspectorScript';
import { type SelectedElement } from '@slopus/happy-wire';
import { useAutoRefresh } from './useAutoRefresh';
import { apiSocket } from '@/sync/apiSocket';

interface ScreenshotData {
    base64: string;
    width: number;
    height: number;
}

interface PreviewPanelProps {
    sessionId: string;
    onClose: () => void;
    onScreenshot?: (data: ScreenshotData) => void;
}

export const PreviewPanel = React.memo(({ sessionId, onClose, onScreenshot }: PreviewPanelProps) => {
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

    // Scan for dev servers on mount via CLI RPC
    const doScan = React.useCallback(async () => {
        setScanning(true);
        try {
            const result = await apiSocket.sessionRPC<{ success: boolean; servers?: Array<{ port: number; title?: string }> }, Record<string, never>>(
                sessionId, 'preview:scan-ports', {}
            );
            setServers(result.success && result.servers ? result.servers : []);
        } catch {
            setServers([]);
        } finally {
            setScanning(false);
        }
    }, [sessionId]);

    React.useEffect(() => {
        doScan();
    }, [doScan]);

    const url = previewState?.url ?? null;
    const inspectMode = previewState?.inspectMode ?? false;
    const deviceBarVisible = previewState?.deviceBarVisible ?? false;
    const viewportPreset = previewState?.viewportPreset ?? 'auto';
    const viewportRotated = previewState?.viewportRotated ?? false;

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
        doScan();
    }, [doScan]);

    const handleToggleInspect = React.useCallback(() => {
        const next = !inspectMode;
        storage.getState().setPreviewState(sessionId, { inspectMode: next });
        webviewRef.current?.postMessage(
            JSON.stringify({ type: 'set-inspect-mode', enabled: next })
        );
    }, [inspectMode, sessionId]);

    const handleToggleDeviceBar = React.useCallback(() => {
        storage.getState().setPreviewState(sessionId, { deviceBarVisible: !deviceBarVisible });
    }, [deviceBarVisible, sessionId]);

    const handleSelectPreset = React.useCallback((presetId: string) => {
        storage.getState().setPreviewState(sessionId, {
            viewportPreset: presetId,
            viewportRotated: false,
        });
    }, [sessionId]);

    const handleToggleRotate = React.useCallback(() => {
        storage.getState().setPreviewState(sessionId, { viewportRotated: !viewportRotated });
    }, [viewportRotated, sessionId]);

    // Screenshot to chat
    const [screenshotLoading, setScreenshotLoading] = React.useState(false);
    const handleScreenshot = React.useCallback(async () => {
        if (!url || screenshotLoading) return;
        setScreenshotLoading(true);
        try {
            const result = await apiSocket.sessionRPC<
                { success: boolean; base64?: string; width?: number; height?: number; error?: string },
                { url: string }
            >(sessionId, 'preview:screenshot', { url });
            if (result.success && result.base64 && onScreenshot) {
                onScreenshot({
                    base64: result.base64,
                    width: result.width || 1280,
                    height: result.height || 800,
                });
            }
        } catch (err) {
            console.error('[preview] Screenshot failed:', err);
        } finally {
            setScreenshotLoading(false);
        }
    }, [url, sessionId, screenshotLoading, onScreenshot]);

    const handleRefresh = React.useCallback(() => {
        webviewRef.current?.reload();
    }, []);

    const handleClose = React.useCallback(() => {
        // If a page is loaded, go back to server picker first
        if (url) {
            storage.getState().setPreviewState(sessionId, { url: null });
            setUrlInput('');
            doScan();
            return;
        }
        // If already on picker, close the panel
        storage.getState().setPreviewState(sessionId, { isVisible: false });
        onClose();
    }, [sessionId, onClose, url, doScan]);

    const handleWebViewMessage = React.useCallback((event: { nativeEvent: { data: string } }) => {
        try {
            const data = JSON.parse(event.nativeEvent.data);
            if (!data || typeof data !== 'object') return;

            switch (data.type) {
                case 'element-selected':
                    storage.getState().setPreviewState(sessionId, {
                        selectedElement: data as SelectedElement,
                        selectedElements: [data as SelectedElement],
                    });
                    break;
                case 'element-added':
                    storage.getState().addSelectedElement(sessionId, data as SelectedElement);
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
                deviceBarVisible={deviceBarVisible}
                onToggleDeviceBar={handleToggleDeviceBar}
                onScreenshot={url && onScreenshot ? handleScreenshot : undefined}
                screenshotLoading={screenshotLoading}
                onRefresh={handleRefresh}
                onClose={handleClose}
            />
            {deviceBarVisible && (
                <DeviceBar
                    activePreset={viewportPreset}
                    rotated={viewportRotated}
                    onSelectPreset={handleSelectPreset}
                    onToggleRotate={handleToggleRotate}
                />
            )}
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
