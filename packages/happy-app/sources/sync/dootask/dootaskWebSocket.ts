/**
 * Global singleton WebSocket service for DooTask.
 *
 * Maintains a single WebSocket connection to the DooTask Swoole server,
 * dispatches incoming messages by `type` field to registered handlers.
 *
 * - 30-second heartbeat ({ type: 'handshake' })
 * - 3-second auto-reconnect on close/error
 * - connect(serverUrl, token) / disconnect() lifecycle
 * - onMessage(type, handler) subscription with unsubscribe return
 */

type MessageHandler = (msg: any) => void;

class DootaskWebSocket {
    private ws: WebSocket | null = null;
    private handlers: Map<string, Set<MessageHandler>> = new Map();
    private heartbeatTimer: ReturnType<typeof setInterval> | undefined = undefined;
    private reconnectTimer: ReturnType<typeof setTimeout> | undefined = undefined;
    private serverUrl: string | null = null;
    private token: string | null = null;
    private closed = true; // True when explicitly disconnected or not yet connected

    connect(serverUrl: string, token: string) {
        // If already connected with same credentials, skip
        if (this.serverUrl === serverUrl && this.token === token && this.ws && this.ws.readyState === WebSocket.OPEN) {
            return;
        }

        // Clean up any existing connection
        this.cleanup();

        this.serverUrl = serverUrl;
        this.token = token;
        this.closed = false;
        this.openSocket();
    }

    disconnect() {
        this.closed = true;
        this.serverUrl = null;
        this.token = null;
        this.cleanup();
    }

    /**
     * Subscribe to messages of a given type (e.g. 'dialog', 'projectTask').
     * Returns an unsubscribe function.
     */
    onMessage(type: string, handler: MessageHandler): () => void {
        let set = this.handlers.get(type);
        if (!set) {
            set = new Set();
            this.handlers.set(type, set);
        }
        set.add(handler);
        return () => {
            set!.delete(handler);
            if (set!.size === 0) {
                this.handlers.delete(type);
            }
        };
    }

    private openSocket() {
        if (!this.serverUrl || !this.token) return;

        const wsUrl = this.serverUrl
            .replace('https://', 'wss://')
            .replace('http://', 'ws://')
            .replace(/\/+$/, '');

        const ws = new WebSocket(`${wsUrl}/ws?action=web&token=${this.token}&language=zh&platform=web`);

        ws.onopen = () => {
            console.log('[DooTask WS] Connected');
            this.heartbeatTimer = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'handshake' }));
                }
            }, 30_000);
        };

        ws.onmessage = (event) => {
            try {
                const parsed = JSON.parse(event.data);
                const type = parsed.type as string | undefined;
                if (!type) return;

                const handlers = this.handlers.get(type);
                if (handlers) {
                    for (const handler of handlers) {
                        handler(parsed);
                    }
                }
            } catch { /* ignore parse errors */ }
        };

        ws.onclose = () => {
            console.log('[DooTask WS] Disconnected');
            this.clearTimers();
            if (!this.closed && this.ws === ws) {
                this.reconnectTimer = setTimeout(() => this.openSocket(), 3000);
            }
        };

        ws.onerror = () => {
            ws.close();
        };

        this.ws = ws;
    }

    private cleanup() {
        this.clearTimers();
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }
    }

    private clearTimers() {
        if (this.heartbeatTimer !== undefined) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
        if (this.reconnectTimer !== undefined) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
    }
}

export const dootaskWS = new DootaskWebSocket();
