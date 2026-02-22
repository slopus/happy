import { useEffect, useRef, useCallback } from 'react';
import type { DooTaskDialogMsg } from '@/sync/dootask/types';

/**
 * WebSocket hook for DooTask real-time chat.
 *
 * Connects to DooTask's Swoole WebSocket server and dispatches incoming
 * dialog messages (add/chat, update, delete) filtered by dialogId.
 *
 * - Heartbeat every 30 seconds with { type: 'handshake' }
 * - Auto-reconnect after 3 seconds on close or error
 * - Callback refs prevent unnecessary reconnections when callback
 *   identities change between renders
 */

type UseDootaskWebSocketParams = {
    serverUrl: string;
    token: string;
    dialogId: number;
    onMessage: (msg: DooTaskDialogMsg) => void;
    onMessageUpdate?: (msg: DooTaskDialogMsg) => void;
    onMessageDelete?: (msgId: number) => void;
};

export function useDootaskWebSocket({
    serverUrl, token, dialogId,
    onMessage, onMessageUpdate, onMessageDelete,
}: UseDootaskWebSocketParams) {
    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const heartbeatTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
    const unmountedRef = useRef(false);

    // Use refs for callbacks to avoid reconnecting when callbacks change
    const onMessageRef = useRef(onMessage);
    const onMessageUpdateRef = useRef(onMessageUpdate);
    const onMessageDeleteRef = useRef(onMessageDelete);
    onMessageRef.current = onMessage;
    onMessageUpdateRef.current = onMessageUpdate;
    onMessageDeleteRef.current = onMessageDelete;

    const connect = useCallback(() => {
        if (unmountedRef.current) return;

        const wsUrl = serverUrl
            .replace('https://', 'wss://')
            .replace('http://', 'ws://')
            .replace(/\/+$/, '');
        const ws = new WebSocket(`${wsUrl}/ws?action=web&token=${token}&language=zh&platform=web`);

        ws.onopen = () => {
            // Start heartbeat
            heartbeatTimer.current = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'handshake' }));
                }
            }, 30_000);
        };

        ws.onmessage = (event) => {
            try {
                const parsed = JSON.parse(event.data);
                if (parsed.type !== 'dialog') return;
                const msgData = parsed.data ?? parsed;
                if (msgData.dialog_id !== dialogId && msgData.data?.dialog_id !== dialogId) return;
                const payload = msgData.data ?? msgData;

                const mode = parsed.mode ?? msgData.mode;
                if (mode === 'add' || mode === 'chat') {
                    onMessageRef.current(payload);
                } else if (mode === 'update') {
                    onMessageUpdateRef.current?.(payload);
                } else if (mode === 'delete') {
                    onMessageDeleteRef.current?.(payload.id ?? payload.msg_id);
                }
            } catch { /* ignore parse errors */ }
        };

        ws.onclose = () => {
            if (heartbeatTimer.current !== undefined) clearInterval(heartbeatTimer.current);
            if (!unmountedRef.current) {
                reconnectTimer.current = setTimeout(connect, 3000);
            }
        };

        ws.onerror = () => {
            ws.close();
        };

        wsRef.current = ws;
    }, [serverUrl, token, dialogId]);

    useEffect(() => {
        unmountedRef.current = false;
        connect();
        return () => {
            unmountedRef.current = true;
            if (reconnectTimer.current !== undefined) clearTimeout(reconnectTimer.current);
            if (heartbeatTimer.current !== undefined) clearInterval(heartbeatTimer.current);
            wsRef.current?.close();
        };
    }, [connect]);
}
