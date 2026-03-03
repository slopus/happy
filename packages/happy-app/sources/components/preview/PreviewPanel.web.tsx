import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { storage, usePreviewState, useSelectedElement } from '@/sync/storage';
import { PreviewToolbar } from './PreviewToolbar';
import { DevServerPicker } from './DevServerPicker';
import { type SelectedElement } from 'happy-wire';
import { useAutoRefresh } from './useAutoRefresh';

interface PreviewPanelProps {
    sessionId: string;
    onClose: () => void;
}

export const PreviewPanel = React.memo(({ sessionId, onClose }: PreviewPanelProps) => {
    const { theme } = useUnistyles();
    const previewState = usePreviewState(sessionId);
    const iframeRef = React.useRef<HTMLIFrameElement>(null);

    // Auto-refresh on code changes
    const handleAutoRefresh = React.useCallback((type: 'css' | 'full') => {
        if (!iframeRef.current?.contentWindow) return;
        if (previewState?.hasHMR) return; // Skip if HMR is active
        try {
            iframeRef.current.contentWindow.postMessage(
                JSON.stringify({ type: type === 'css' ? 'css-update' : 'full-reload' }),
                '*'
            );
        } catch {
            // Cross-origin — fallback to full reload via src reassign
            if (type === 'full' && iframeRef.current) {
                iframeRef.current.src = iframeRef.current.src;
            }
        }
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

    // Listen for postMessage from the iframe (inspector script messages)
    React.useEffect(() => {
        const handler = (event: MessageEvent) => {
            let data = event.data;
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch { return; }
            }
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
        };

        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [sessionId]);

    const url = previewState?.url ?? null;
    const proxyUrl = previewState?.proxyUrl ?? null;
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
        try {
            iframeRef.current?.contentWindow?.postMessage(
                JSON.stringify({ type: 'set-inspect-mode', enabled: next }),
                '*'
            );
        } catch {
            // Cross-origin -- proxy should handle inspector injection
        }
    }, [inspectMode, sessionId]);

    const handleRefresh = React.useCallback(() => {
        if (iframeRef.current) {
            try {
                iframeRef.current.src = iframeRef.current.src;
            } catch {
                // Cross-origin fallback
            }
        }
    }, []);

    const handleClose = React.useCallback(() => {
        storage.getState().setPreviewState(sessionId, { isVisible: false });
        onClose();
    }, [sessionId, onClose]);

    const iframeSrc = proxyUrl || url;

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
            {iframeSrc ? (
                // @ts-ignore -- iframe is a web-only element
                <iframe
                    ref={iframeRef}
                    src={iframeSrc}
                    style={{
                        flex: 1,
                        width: '100%',
                        height: '100%',
                        border: 'none',
                    }}
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                    allow="clipboard-read; clipboard-write"
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
