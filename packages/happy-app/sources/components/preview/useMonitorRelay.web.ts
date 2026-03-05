import { useEffect, useCallback, useMemo } from 'react';
import { usePathname } from 'expo-router';
import { storage } from '@/sync/storage';
import { type SelectedElement } from '@slopus/happy-wire';

/**
 * Global hook that listens for inspector events from the external monitor page.
 * Works via BroadcastChannel (same device) and SSE relay (cross-device, e.g. iPad).
 * Events always go to the currently active session (determined by URL pathname).
 * Must be mounted at the app root level so it's always active.
 */
export function useMonitorRelay() {
    const pathname = usePathname();

    // Extract active session ID from current route
    const activeSessionId = useMemo(() => {
        const match = pathname.match(/\/session\/([^/]+)/);
        return match ? match[1] : null;
    }, [pathname]);

    const handleEvent = useCallback((data: Record<string, unknown>) => {
        if (!data || typeof data !== 'object') return;
        if (!activeSessionId) return;

        switch (data.type) {
            case 'element-selected':
                storage.getState().setPreviewState(activeSessionId, {
                    selectedElement: data as unknown as SelectedElement,
                    selectedElements: [data as unknown as SelectedElement],
                });
                break;
            case 'element-added':
                storage.getState().addSelectedElement(activeSessionId, data as unknown as SelectedElement);
                break;
            case 'hmr-status':
                storage.getState().setPreviewState(activeSessionId, {
                    hasHMR: data.hasHMR as boolean,
                });
                break;
        }
    }, [activeSessionId]);

    // BroadcastChannel (same device, different tab)
    useEffect(() => {
        const channel = new BroadcastChannel('happy-monitor');
        channel.onmessage = (event) => handleEvent(event.data);
        return () => channel.close();
    }, [handleEvent]);

    // SSE relay (cross-device)
    useEffect(() => {
        let eventSource: EventSource | null = null;
        let retryTimeout: ReturnType<typeof setTimeout>;

        function connect() {
            eventSource = new EventSource('/v1/preview/events');
            eventSource.onmessage = (event) => {
                try {
                    handleEvent(JSON.parse(event.data));
                } catch { /* ignore */ }
            };
            eventSource.onerror = () => {
                eventSource?.close();
                retryTimeout = setTimeout(connect, 3000);
            };
        }

        connect();

        return () => {
            clearTimeout(retryTimeout);
            eventSource?.close();
        };
    }, [handleEvent]);
}
