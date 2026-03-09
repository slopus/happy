import { useEffect, useRef } from 'react';
import type { DooTaskDialogMsg } from '@/sync/dootask/types';
import { dootaskWS } from '@/sync/dootask/dootaskWebSocket';

/**
 * WebSocket hook for DooTask real-time chat.
 *
 * Subscribes to the global dootaskWS singleton for 'dialog' messages
 * filtered by dialogId, dispatching add/chat, update, and delete events.
 *
 * No longer creates its own WebSocket connection — relies on the global
 * connection managed by useDootaskGlobalWebSocket in _layout.tsx.
 */

type UseDootaskWebSocketParams = {
    dialogId: number;
    enabled?: boolean;
    onMessage: (msg: DooTaskDialogMsg) => void;
    onMessageUpdate?: (msg: DooTaskDialogMsg) => void;
    onMessageDelete?: (msgId: number) => void;
};

export function useDootaskWebSocket({
    dialogId,
    enabled = true,
    onMessage, onMessageUpdate, onMessageDelete,
}: UseDootaskWebSocketParams) {
    // Use refs for callbacks to avoid re-subscribing when callbacks change
    const onMessageRef = useRef(onMessage);
    const onMessageUpdateRef = useRef(onMessageUpdate);
    const onMessageDeleteRef = useRef(onMessageDelete);
    onMessageRef.current = onMessage;
    onMessageUpdateRef.current = onMessageUpdate;
    onMessageDeleteRef.current = onMessageDelete;

    useEffect(() => {
        if (!enabled) return;

        const unsub = dootaskWS.onMessage('dialog', (parsed) => {
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
        });

        return unsub;
    }, [dialogId, enabled]);
}
