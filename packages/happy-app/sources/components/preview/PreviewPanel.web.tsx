import * as React from 'react';
import { View, LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { storage, usePreviewState } from '@/sync/storage';
import { PreviewToolbar } from './PreviewToolbar';
import { DeviceBar } from './DeviceBar';
import { DevServerPicker } from './DevServerPicker';
import { type SelectedElement, VIEWPORT_PRESETS } from '@slopus/happy-wire';
import { useAutoRefresh } from './useAutoRefresh';
import { getInspectorScript } from './inspectorScript';
import { apiSocket } from '@/sync/apiSocket';
import html2canvas from 'html2canvas';

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
    const iframeRef = React.useRef<HTMLIFrameElement>(null);
    const [injected, setInjected] = React.useState(false);
    const [containerSize, setContainerSize] = React.useState<{ width: number; height: number } | null>(null);

    // Auto-refresh on code changes
    const handleAutoRefresh = React.useCallback((type: 'css' | 'full') => {
        if (previewState?.hasHMR) return;

        // Refresh local iframe
        if (iframeRef.current?.contentWindow) {
            try {
                iframeRef.current.contentWindow.postMessage(
                    JSON.stringify({ type: type === 'css' ? 'css-update' : 'full-reload' }),
                    '*'
                );
            } catch {
                if (type === 'full' && iframeRef.current) {
                    iframeRef.current.src = iframeRef.current.src;
                }
            }
        }

        // Broadcast to external monitors (BroadcastChannel + SSE)
        const event = { type: 'auto-refresh', refreshType: type };
        try {
            const ch = new BroadcastChannel('happy-monitor');
            ch.postMessage(event);
            ch.close();
        } catch {}
        fetch('/v1/preview/events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(event),
        }).catch(() => {});
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

    // Try to inject inspector script into iframe after it loads (same-origin only)
    const tryInjectInspector = React.useCallback(() => {
        if (!iframeRef.current) return;
        try {
            const doc = iframeRef.current.contentDocument;
            if (doc && !doc.querySelector('[data-happy-inspector]')) {
                const script = doc.createElement('script');
                script.setAttribute('data-happy-inspector', 'true');
                script.textContent = getInspectorScript();
                doc.head.appendChild(script);
                setInjected(true);
            }
        } catch {
            // Cross-origin — can't inject, that's OK
            setInjected(false);
        }
    }, []);

    const url = previewState?.url ?? null;
    const inspectMode = previewState?.inspectMode ?? false;
    const viewportPreset = previewState?.viewportPreset ?? 'auto';
    const viewportRotated = previewState?.viewportRotated ?? false;
    const deviceBarVisible = previewState?.deviceBarVisible ?? false;

    // ── Inspector hotkey: Left Option (Alt) ─────────────────────────────
    // Hold  → inspect ON while held
    // Double-tap → lock inspect ON until toggled off
    const lockedRef = React.useRef(false);
    const holdActiveRef = React.useRef(false);
    const lastMetaDownRef = React.useRef(0);
    const DOUBLE_TAP_MS = 300;

    const setInspect = React.useCallback((enabled: boolean) => {
        storage.getState().setPreviewState(sessionId, { inspectMode: enabled });
        try {
            iframeRef.current?.contentWindow?.postMessage(
                JSON.stringify({ type: 'set-inspect-mode', enabled }),
                '*'
            );
        } catch {}
    }, [sessionId]);

    const onMetaDown = React.useCallback(() => {
        const now = Date.now();
        if (now - lastMetaDownRef.current < DOUBLE_TAP_MS) {
            // Double-tap: toggle lock
            lockedRef.current = !lockedRef.current;
            setInspect(lockedRef.current);
            holdActiveRef.current = false;
            lastMetaDownRef.current = 0;
            return;
        }
        lastMetaDownRef.current = now;
        if (!lockedRef.current) {
            holdActiveRef.current = true;
            setInspect(true);
        }
    }, [setInspect]);

    const onMetaUp = React.useCallback(() => {
        if (holdActiveRef.current && !lockedRef.current) {
            holdActiveRef.current = false;
            setInspect(false);
        }
    }, [setInspect]);

    // Shared handler for inspector messages (from iframe postMessage or BroadcastChannel)
    const handleInspectorMessage = React.useCallback((data: Record<string, unknown>) => {
        switch (data.type) {
            case 'element-selected':
                storage.getState().setPreviewState(sessionId, {
                    selectedElement: data as unknown as SelectedElement,
                    selectedElements: [data as unknown as SelectedElement],
                });
                break;
            case 'element-added':
                storage.getState().addSelectedElement(sessionId, data as unknown as SelectedElement);
                break;
            case 'hmr-status':
                storage.getState().setPreviewState(sessionId, {
                    hasHMR: data.hasHMR as boolean,
                });
                break;
            case 'meta-key':
                if (data.state === 'down') onMetaDown();
                else if (data.state === 'up') onMetaUp();
                break;
            case 'cookies':
                if (cookieResolverRef.current) {
                    cookieResolverRef.current(data.cookies as string || '');
                }
                break;
            case 'scroll-position':
                if (scrollResolverRef.current) {
                    scrollResolverRef.current(data.scrollY as number || 0);
                }
                break;
        }
    }, [sessionId, onMetaDown, onMetaUp]);

    // Listen for postMessage from the iframe (inspector messages)
    React.useEffect(() => {
        const handler = (event: MessageEvent) => {
            let data = event.data;
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch { return; }
            }
            if (!data || typeof data !== 'object') return;
            handleInspectorMessage(data);
        };

        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [handleInspectorMessage]);

    // External monitor events (BroadcastChannel + SSE) are handled by the global
    // useMonitorRelay hook in _layout.tsx — no need to duplicate listeners here.

    // Resolve viewport dimensions from preset
    const activePreset = VIEWPORT_PRESETS.find((p) => p.id === viewportPreset);
    const vpWidth = activePreset?.width ?? null;
    const vpHeight = activePreset?.height ?? null;
    const iframeWidth = vpWidth ? (viewportRotated ? vpHeight! : vpWidth) : null;

    // Scale only by width — iframe gets full container height and scrolls vertically
    const scale = React.useMemo(() => {
        if (!iframeWidth || !containerSize) return 1;
        const scaleX = containerSize.width / iframeWidth;
        return Math.min(scaleX, 1); // never scale up
    }, [iframeWidth, containerSize]);

    // Height of iframe: fill the container at the scaled size
    const scaledIframeHeight = containerSize ? Math.ceil(containerSize.height / scale) : 10000;

    const isScaled = viewportPreset !== 'auto' && iframeWidth !== null;

    // Build the full-proxy URL: /v1/preview/<protocol>/<host>/<path>
    // Also supports local file paths: /opt/..., /tmp/...
    const getProxyUrl = React.useCallback((targetUrl: string) => {
        // Local file path — serve via file endpoint
        if (targetUrl.startsWith('/') && !targetUrl.startsWith('//')) {
            return `/v1/preview/file${targetUrl}`;
        }
        try {
            const parsed = new URL(targetUrl);
            const proto = parsed.protocol.replace(':', ''); // 'https'
            const host = parsed.host;
            const path = parsed.pathname.slice(1) + parsed.search + parsed.hash;
            return `/v1/preview/${proto}/${host}/${path}`;
        } catch {
            return targetUrl;
        }
    }, []);

    // ---- Handlers ----

    const handleUrlSubmit = React.useCallback(() => {
        const trimmed = urlInput.trim();
        if (!trimmed) return;
        // Local file paths stay as-is; URLs get normalized
        const normalized = trimmed.startsWith('/') ? trimmed
            : trimmed.startsWith('http') ? trimmed
            : `http://${trimmed}`;
        storage.getState().setPreviewState(sessionId, { url: normalized });
        setInjected(false);
    }, [urlInput, sessionId]);

    const handleServerSelect = React.useCallback((selectedUrl: string) => {
        setUrlInput(selectedUrl);
        storage.getState().setPreviewState(sessionId, { url: selectedUrl });
        setInjected(false);
    }, [sessionId]);

    const handleRefreshScan = React.useCallback(() => {
        doScan();
    }, [doScan]);

    const handleToggleInspect = React.useCallback(() => {
        const next = !inspectMode;
        lockedRef.current = next;
        holdActiveRef.current = false;
        setInspect(next);
    }, [inspectMode, setInspect]);

    // Keyboard: Left Option hold / double-tap (parent window — works when focus is outside iframe)
    React.useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.code === 'MetaLeft' && !e.repeat) onMetaDown();
        };
        const onKeyUp = (e: KeyboardEvent) => {
            if (e.code === 'MetaLeft') onMetaUp();
        };
        const onBlur = () => onMetaUp();

        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('blur', onBlur);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('blur', onBlur);
        };
    }, [onMetaDown, onMetaUp]);

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

    // Request cookies from iframe via postMessage
    const cookieResolverRef = React.useRef<((cookies: string) => void) | null>(null);
    const requestIframeCookies = React.useCallback((): Promise<string> => {
        return new Promise((resolve) => {
            if (!iframeRef.current?.contentWindow) {
                resolve('');
                return;
            }
            const timeout = setTimeout(() => {
                cookieResolverRef.current = null;
                resolve('');
            }, 2000);
            cookieResolverRef.current = (cookies: string) => {
                clearTimeout(timeout);
                cookieResolverRef.current = null;
                resolve(cookies);
            };
            try {
                iframeRef.current.contentWindow.postMessage(
                    JSON.stringify({ type: 'get-cookies' }),
                    '*'
                );
            } catch {
                clearTimeout(timeout);
                cookieResolverRef.current = null;
                resolve('');
            }
        });
    }, []);

    // Request scroll position from iframe via postMessage
    const scrollResolverRef = React.useRef<((scrollY: number) => void) | null>(null);
    const requestIframeScrollY = React.useCallback((): Promise<number> => {
        return new Promise((resolve) => {
            if (!iframeRef.current?.contentWindow) {
                resolve(0);
                return;
            }
            const timeout = setTimeout(() => {
                scrollResolverRef.current = null;
                resolve(0);
            }, 2000);
            scrollResolverRef.current = (scrollY: number) => {
                clearTimeout(timeout);
                scrollResolverRef.current = null;
                resolve(scrollY);
            };
            try {
                iframeRef.current.contentWindow.postMessage(
                    JSON.stringify({ type: 'get-scroll-position' }),
                    '*'
                );
            } catch {
                clearTimeout(timeout);
                scrollResolverRef.current = null;
                resolve(0);
            }
        });
    }, []);

    // Screenshot to chat — captures iframe content directly in browser via html2canvas
    const [screenshotLoading, setScreenshotLoading] = React.useState(false);
    const handleScreenshot = React.useCallback(async () => {
        if (!url || screenshotLoading || !onScreenshot) return;
        setScreenshotLoading(true);
        try {
            // Try browser-side capture first (same-origin iframes)
            let captured = false;
            try {
                const doc = iframeRef.current?.contentDocument;
                const win = iframeRef.current?.contentWindow;
                if (doc && win) {
                    const scrollY = win.scrollY || 0;
                    const viewportW = win.innerWidth;
                    const viewportH = win.innerHeight;
                    console.log('[preview-screenshot] html2canvas capture:', { scrollY, viewportW, viewportH });
                    const canvas = await html2canvas(doc.documentElement, {
                        width: viewportW,
                        height: viewportH,
                        x: 0,
                        y: scrollY,
                        scrollX: 0,
                        scrollY: 0,
                        windowWidth: viewportW,
                        windowHeight: viewportH,
                        useCORS: true,
                        allowTaint: true,
                        logging: false,
                    });
                    const base64 = canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
                    onScreenshot({
                        base64,
                        width: canvas.width,
                        height: canvas.height,
                    });
                    captured = true;
                }
            } catch (e) {
                console.warn('[preview-screenshot] html2canvas failed, falling back to RPC:', e);
            }

            // Fallback to Puppeteer RPC for cross-origin iframes
            if (!captured) {
                const cookieString = await requestIframeCookies();
                let scrollY = 0;
                scrollY = await requestIframeScrollY();
                const screenshotWidth = iframeWidth || (containerSize?.width ? Math.round(containerSize.width) : undefined);
                const screenshotHeight = containerSize?.height ? Math.round(containerSize.height / scale) : undefined;
                const result = await apiSocket.sessionRPC<
                    { success: boolean; base64?: string; width?: number; height?: number; error?: string },
                    { url: string; width?: number; height?: number; cookies?: string; scrollY?: number }
                >(sessionId, 'preview:screenshot', {
                    url,
                    width: screenshotWidth || undefined,
                    height: screenshotHeight || undefined,
                    cookies: cookieString || undefined,
                    scrollY: scrollY || undefined,
                });
                if (result.success && result.base64) {
                    onScreenshot({
                        base64: result.base64,
                        width: result.width || screenshotWidth || 1280,
                        height: result.height || screenshotHeight || 800,
                    });
                }
            }
        } catch (err: any) {
            console.error('[preview-screenshot] Failed:', err);
        } finally {
            setScreenshotLoading(false);
        }
    }, [url, sessionId, screenshotLoading, onScreenshot, requestIframeCookies, requestIframeScrollY, iframeWidth, containerSize, scale]);

    // Listen for keyboard shortcut screenshot event
    const handleScreenshotRef = React.useRef(handleScreenshot);
    handleScreenshotRef.current = handleScreenshot;
    React.useEffect(() => {
        const handler = () => handleScreenshotRef.current();
        window.addEventListener('preview-take-screenshot', handler);
        return () => window.removeEventListener('preview-take-screenshot', handler);
    }, []);

    const handleRefresh = React.useCallback(() => {
        if (iframeRef.current) {
            iframeRef.current.src = iframeRef.current.src;
            setInjected(false);
        }
    }, []);

    const buildMonitorUrl = React.useCallback(() => {
        if (!url) return null;
        const params = new URLSearchParams({ url });
        if (viewportPreset !== 'auto') params.set('preset', viewportPreset);
        if (deviceBarVisible) params.set('devices', '1');
        if (inspectMode) params.set('inspect', '1');
        return window.location.origin + '/monitor/?' + params.toString();
    }, [url, viewportPreset, deviceBarVisible, inspectMode]);

    const handlePopOut = React.useCallback(() => {
        const monitorUrl = buildMonitorUrl();
        if (monitorUrl) window.open(monitorUrl, '_blank');
    }, [buildMonitorUrl]);

    const handleCopyLink = React.useCallback(async () => {
        const monitorUrl = buildMonitorUrl();
        if (!monitorUrl) return;
        try {
            await navigator.clipboard.writeText(monitorUrl);
        } catch {
            // Fallback for older browsers
            const textarea = document.createElement('textarea');
            textarea.value = monitorUrl;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
        }
    }, [buildMonitorUrl]);

    const handleClose = React.useCallback(() => {
        // If a page is loaded, go back to server picker first
        if (url) {
            storage.getState().setPreviewState(sessionId, { url: null });
            setUrlInput('');
            setInjected(false);
            doScan(); // refresh server list
            return;
        }
        // If already on picker, close the panel
        storage.getState().setPreviewState(sessionId, { isVisible: false });
        onClose();
    }, [sessionId, onClose, url, doScan]);

    const handleIframeLoad = React.useCallback(() => {
        tryInjectInspector();
    }, [tryInjectInspector]);

    const handleContainerLayout = React.useCallback((e: LayoutChangeEvent) => {
        const { width, height } = e.nativeEvent.layout;
        setContainerSize({ width, height });
    }, []);

    // Load through full reverse proxy so inspector script is injected
    const iframeSrc = url ? getProxyUrl(url) : null;

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
                onPopOut={url ? handlePopOut : undefined}
                onCopyLink={url ? handleCopyLink : undefined}
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
            {iframeSrc ? (
                <View
                    style={{ flex: 1, position: 'relative' as const, overflow: 'hidden' as const }}
                    onLayout={handleContainerLayout}
                >
                    {isScaled ? (
                        <View
                            style={{
                                position: 'absolute' as const,
                                top: 0,
                                left: 0,
                                right: 0,
                                bottom: 0,
                                alignItems: 'center' as const,
                                justifyContent: 'flex-start' as const,
                            }}
                        >
                            {/* @ts-ignore -- iframe is a web-only element */}
                            <iframe
                                ref={iframeRef}
                                src={iframeSrc}
                                onLoad={handleIframeLoad}
                                style={{
                                    width: iframeWidth!,
                                    height: scaledIframeHeight,
                                    border: 'none',
                                    transformOrigin: 'top center',
                                    transform: `scale(${scale})`,
                                }}
                                allow="clipboard-read; clipboard-write"
                            />
                        </View>
                    ) : (
                        <>
                            {/* @ts-ignore -- iframe is a web-only element */}
                            <iframe
                                ref={iframeRef}
                                src={iframeSrc}
                                onLoad={handleIframeLoad}
                                style={{
                                    flex: 1,
                                    width: '100%',
                                    height: '100%',
                                    border: 'none',
                                }}
                                allow="clipboard-read; clipboard-write"
                            />
                        </>
                    )}
                </View>
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
