import * as React from 'react';
import { ClawdbotSocket, type ClawdbotConnectionStatus } from './ClawdbotSocket';
import { loadClawdbotConfig } from './clawdbotStorage';
import type { ClawdbotChatEvent, ClawdbotSession } from './clawdbotTypes';

// Track if we've already attempted auto-connect this session
let autoConnectAttempted = false;

/**
 * Hook to track Clawdbot gateway connection status.
 * Automatically attempts to connect if there's a saved config and no active connection.
 */
export function useClawdbotStatus() {
    const [status, setStatus] = React.useState<ClawdbotConnectionStatus>(
        ClawdbotSocket.getStatus()
    );
    const [error, setError] = React.useState<string | undefined>();
    const [pairingRequestId, setPairingRequestId] = React.useState<string | undefined>();

    React.useEffect(() => {
        return ClawdbotSocket.onStatusChange((newStatus, err, details) => {
            setStatus(newStatus);
            setError(err);
            setPairingRequestId(details?.pairingRequestId);
        });
    }, []);

    // Auto-connect on mount if saved config exists and not already connected/connecting
    React.useEffect(() => {
        if (autoConnectAttempted) return;
        autoConnectAttempted = true;

        const currentStatus = ClawdbotSocket.getStatus();
        if (currentStatus === 'connected' || currentStatus === 'connecting') {
            return;
        }

        const savedConfig = loadClawdbotConfig();
        if (savedConfig) {
            console.log('[Clawdbot] Auto-connecting with saved config...');
            ClawdbotSocket.connect(savedConfig);
        }
    }, []);

    return {
        status,
        error,
        isConnected: status === 'connected',
        isConnecting: status === 'connecting',
        isPairingRequired: status === 'pairing_required',
        pairingRequestId,
        deviceId: ClawdbotSocket.getDeviceId(),
        serverHost: ClawdbotSocket.getServerHost(),
        mainSessionKey: ClawdbotSocket.getMainSessionKey(),
        retryConnect: () => ClawdbotSocket.retryConnect(),
    };
}

/**
 * Hook to load and manage Clawdbot sessions list
 */
export function useClawdbotSessions() {
    const { isConnected } = useClawdbotStatus();
    const [sessions, setSessions] = React.useState<ClawdbotSession[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const loadSessions = React.useCallback(async () => {
        if (!ClawdbotSocket.isConnected()) {
            setError('Not connected');
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const list = await ClawdbotSocket.listSessions(100);
            setSessions(list);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load sessions');
        } finally {
            setLoading(false);
        }
    }, []);

    React.useEffect(() => {
        if (isConnected) {
            loadSessions();
        } else {
            setSessions([]);
        }
    }, [isConnected, loadSessions]);

    return {
        sessions,
        loading,
        error,
        refresh: loadSessions,
    };
}

/**
 * Hook to subscribe to chat events for a specific session
 */
export function useClawdbotChatEvents(sessionKey: string | null) {
    const [events, setEvents] = React.useState<ClawdbotChatEvent[]>([]);
    const [currentRunId, setCurrentRunId] = React.useState<string | null>(null);

    React.useEffect(() => {
        if (!sessionKey) return;

        // Listen for chat events
        return ClawdbotSocket.onEvent((event, payload) => {
            if (event === 'chat' && payload) {
                const chatEvent = payload as ClawdbotChatEvent;
                if (chatEvent.sessionKey === sessionKey) {
                    setEvents((prev) => [...prev, chatEvent]);
                    if (chatEvent.state === 'started') {
                        setCurrentRunId(chatEvent.runId);
                    } else if (chatEvent.state === 'final' || chatEvent.state === 'error') {
                        setCurrentRunId(null);
                    }
                }
            }
        });
    }, [sessionKey]);

    const clearEvents = React.useCallback(() => {
        setEvents([]);
        setCurrentRunId(null);
    }, []);

    return { events, currentRunId, clearEvents };
}
